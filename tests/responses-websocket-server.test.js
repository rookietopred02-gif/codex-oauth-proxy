import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { attachResponsesWebSocketServer } from "../src/http/responses-websocket-server.js";
import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";

function createResponsesHelpers() {
  return createOpenAIResponsesCompatHelpers({
    config: {
      codex: {
        defaultModel: "gpt-5.4"
      }
    },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });
}

function createReadableStreamFromTextChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

function createControllableReadableStream() {
  const encoder = new TextEncoder();
  let controllerRef = null;

  return {
    stream: new ReadableStream({
      start(controller) {
        controllerRef = controller;
      }
    }),
    enqueue(chunk) {
      controllerRef.enqueue(encoder.encode(chunk));
    },
    close() {
      controllerRef.close();
    }
  };
}

function createDelayedCompletionResponsesStream({ firstEvent, terminalEvent, delayMs = 50 }) {
  const encoder = new TextEncoder();
  let completionTimer = null;
  let upstreamClosed = false;
  let completedEnqueued = false;

  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(firstEvent));
        completionTimer = setTimeout(() => {
          if (upstreamClosed) return;
          completedEnqueued = true;
          try {
            controller.enqueue(encoder.encode(terminalEvent));
            controller.close();
          } catch {}
        }, delayMs);
        completionTimer.unref?.();
      },
      cancel() {
        upstreamClosed = true;
        if (completionTimer) clearTimeout(completionTimer);
      }
    }),
    get completedEnqueued() {
      return completedEnqueued;
    }
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `ws://127.0.0.1:${address.port}`;
}

async function connectSocket(url, headers = {}) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function connectUnexpectedResponse(url, headers = {}) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers
    });
    ws.once("open", () => reject(new Error("Expected WebSocket handshake to fail.")));
    ws.once("unexpected-response", (_request, response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: raw
        });
      });
    });
    ws.once("error", () => {});
  });
}

async function nextJsonMessage(ws) {
  const queue = createJsonMessageQueue(ws);
  try {
    return await queue.next();
  } finally {
    queue.dispose();
  }
}

function createJsonMessageQueue(ws) {
  const pending = [];
  const waiters = [];

  const handleMessage = (data) => {
    const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(parsed);
      return;
    }
    pending.push(parsed);
  };
  const handleError = (err) => {
    while (waiters.length > 0) {
      waiters.shift().reject(err);
    }
  };

  ws.on("message", handleMessage);
  ws.on("error", handleError);

  return {
    async next() {
      if (pending.length > 0) return pending.shift();
      return await new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    dispose() {
      ws.off("message", handleMessage);
      ws.off("error", handleError);
    }
  };
}

async function withTimeout(promise, message, ms = 1000) {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
        timeout.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function createAuthContext(sharedApiKey = "test-proxy-key") {
  return {
    config: {
      codexOAuth: {
        sharedApiKey
      }
    },
    hasActiveManagedProxyApiKeys() {
      return false;
    },
    extractProxyApiKeyFromRequest(req) {
      const auth = String(req.headers?.authorization || "");
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1];
      const incoming = new URL(req.url || "/", "http://localhost");
      return String(incoming.searchParams.get("key") || "");
    },
    findManagedProxyApiKeyByValue() {
      return null;
    },
    recordManagedProxyApiKeyUsage() {}
  };
}

test("Responses WebSocket handshake enforces the proxy API key", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext("secret-key"),
    openResponsesCreateProxySession: async () => {
      throw new Error("should not be called");
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async () => "",
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  try {
    const baseUrl = await listen(server);
    const rejection = await connectUnexpectedResponse(`${baseUrl}/v1/responses`);
    assert.equal(rejection.statusCode, 401);
    assert.match(rejection.body, /invalid_api_key/i);
  } finally {
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket forwards upstream response events and remembers completion", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  let capturedPayload = null;
  let rememberedCompletion = null;
  let successCount = 0;
  /** @type {any} */
  let recordedRequest = null;

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    recordRecentProxyRequest(entry) {
      recordedRequest = entry;
    },
    async openResponsesCreateProxySession(_req, _res, options) {
      capturedPayload = JSON.parse(options.requestBody.toString("utf8"));
      return {
        upstream: new Response(
          createReadableStreamFromTextChunks([
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_ws_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
          ]),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            }
          }
        ),
        release() {},
        async markFailure() {},
        async markSuccess() {
          successCount += 1;
        },
        authAccountId: "acct_ws_1",
        compatibilityHint: "",
        rememberCompletion(completed) {
          rememberedCompletion = completed;
        },
        modelRoute: {
          requestedModel: "gpt-5.4",
          mappedModel: "gpt-5.4"
        },
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (upstream) => await upstream.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        stream: true,
        background: true,
        model: "gpt-5.4",
        input: "hello"
      })
    );

    const delta = await queue.next();
    const completed = await queue.next();

    assert.deepEqual(capturedPayload, {
      stream: true,
      background: true,
      model: "gpt-5.4",
      input: "hello"
    });
    assert.equal(delta.type, "response.output_text.delta");
    assert.equal(completed.type, "response.completed");
    assert.equal(rememberedCompletion?.id, "resp_ws_1");
    assert.equal(successCount, 1);
    assert.equal(recordedRequest?.method, "WS");
    assert.equal(recordedRequest?.transportType, "websocket");
    assert.equal(recordedRequest?.statusCode, 200);
    assert.equal(recordedRequest?.authAccountId, "acct_ws_1");
    assert.equal(recordedRequest?.proxyApiKeyId, "legacy-local-api-key");
    assert.equal(recordedRequest?.proxyApiKeyLabel, "legacy env LOCAL_API_KEY");
    assert.match(String(recordedRequest?.responseBody || ""), /response\.completed/);
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket flushes official SSE events before upstream completion", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const upstream = createDelayedCompletionResponsesStream({
    firstEvent:
      'event: response.mcp_call_arguments.delta\n' +
      'data: {"type":"response.mcp_call_arguments.delta","item_id":"mcp_1","output_index":0,"sequence_number":1,"delta":"{\\"city\\""}\n\n',
    terminalEvent:
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_ws_stream","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  });
  let successCount = 0;

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(upstream.stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          }
        }),
        release() {},
        async markFailure() {},
        async markSuccess() {
          successCount += 1;
        },
        rememberCompletion() {},
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  let queue;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        stream: true,
        model: "gpt-5.4",
        input: "hello"
      })
    );

    const delta = await withTimeout(queue.next(), "Timed out waiting for WebSocket stream delta.");
    assert.equal(delta.type, "response.mcp_call_arguments.delta");
    assert.equal(delta.item_id, "mcp_1");
    assert.equal(delta.delta, "{\"city\"");
    assert.equal(upstream.completedEnqueued, false);
    assert.equal(successCount, 0);

    const completed = await withTimeout(queue.next(), "Timed out waiting for WebSocket stream completion.");
    assert.equal(completed.type, "response.completed");
    assert.equal(completed.response?.id, "resp_ws_stream");
    assert.equal(successCount, 1);
  } finally {
    queue?.dispose();
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket honors configured idle timeout for upstream SSE streams", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const authContext = createAuthContext();
  authContext.config.upstreamStreamIdleTimeoutMs = 7;
  let cancelReason = null;

  const runtime = attachResponsesWebSocketServer(server, {
    ...authContext,
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(
          new ReadableStream({
            cancel(reason) {
              cancelReason = reason;
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            }
          }
        ),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        rememberCompletion() {},
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  let queue;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        stream: true,
        model: "gpt-5.4",
        input: "hello"
      })
    );

    const failed = await withTimeout(
      queue.next(),
      "Timed out waiting for WebSocket upstream idle timeout.",
      500
    );
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response?.status, "failed");
    assert.equal(failed.response?.status_code, 502);
    assert.match(failed.response?.error?.message || "", /7ms/);
    assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
  } finally {
    queue?.dispose();
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket records audit_error without breaking streamed completions", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  let capturedAuditError = null;

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    recordRecentProxyRequest() {
      throw new Error("recent request store unavailable");
    },
    recordAuditError(err, details) {
      capturedAuditError = { err, details };
    },
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(
          createReadableStreamFromTextChunks([
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"ok"}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp_ws_audit","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n'
          ]),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
            }
          }
        ),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        rememberCompletion() {},
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (upstream) => await upstream.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        stream: true,
        model: "gpt-5.4",
        input: "hello"
      })
    );

    assert.equal((await queue.next()).type, "response.output_text.delta");
    assert.equal((await queue.next()).type, "response.completed");
    assert.match(capturedAuditError?.err?.message || "", /recent request store unavailable/);
    assert.equal(capturedAuditError?.details?.phase, "record_recent_request");
    assert.equal(capturedAuditError?.details?.transportType, "websocket");
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket rejects a second in-flight response.create on the same connection", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const upstream = createControllableReadableStream();

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(upstream.stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          }
        }),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        rememberCompletion() {},
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.4", input: "first" }));
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.4", input: "second" }));

    const failed = await queue.next();
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response?.status_code, 409);
    assert.match(failed.response?.error?.message || "", /one in-flight response\.create/i);

    upstream.enqueue(
      'data: {"type":"response.completed","response":{"id":"resp_ws_2","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    );
    upstream.close();
    await queue.next();
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket preserves non-JSON upstream error bodies without truncation", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const longErrorBody = "upstream-error-".repeat(80);

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(longErrorBody, {
          status: 500,
          headers: {
            "content-type": "text/plain"
          }
        }),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        rememberCompletion() {},
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        previous_response_id: "resp_missing",
        input: [{ role: "user", content: [{ type: "input_text", text: "next" }] }]
      })
    );

    const failed = await queue.next();
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response?.status_code, 500);
    assert.equal(failed.response?.error?.message, longErrorBody);
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket rejects completed JSON instead of falling back to HTTP-style replay", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  let rememberedCompletion = null;
  let failureCount = 0;
  let successCount = 0;
  let recordedRequest = null;

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(
          JSON.stringify({
            id: "resp_ws_json",
            status: "completed",
            usage: {
              input_tokens: 4,
              output_tokens: 5,
              total_tokens: 9
            },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }]
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          }
        ),
        release() {},
        async markFailure() {
          failureCount += 1;
        },
        async markSuccess() {
          successCount += 1;
        },
        authAccountId: "acct_ws_json",
        compatibilityHint: "",
        retryCount: "1.9",
        rememberCompletion(completed) {
          rememberedCompletion = completed;
        },
        modelRoute: {
          requestedModel: "gpt-5.4",
          mappedModel: "gpt-5.4"
        },
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    recordRecentProxyRequest(row) {
      recordedRequest = row;
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello"
      })
    );

    const failed = await queue.next();
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response?.status_code, 502);
    assert.equal(failed.response?.error?.code, "invalid_upstream_sse");
    assert.match(failed.response?.error?.message || "", /non-SSE responses are not replayed as HTTP fallbacks/i);
    assert.equal(rememberedCompletion, null);
    assert.equal(failureCount, 1);
    assert.equal(successCount, 0);
    assert.equal(recordedRequest?.method, "WS");
    assert.equal(recordedRequest?.transportType, "websocket");
    assert.equal(recordedRequest?.statusCode, 502);
    assert.equal(recordedRequest?.upstreamRetryCount, 0);
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const { label, statusCode } of [
  { label: "symbol", statusCode: Symbol("status") },
  { label: "decimal-form", statusCode: "500.0" },
  { label: "out-of-range", statusCode: 700 }
]) {
  test(`Responses WebSocket coerces ${label} session error statuses to failure responses`, async () => {
    const server = createServer();
    const helpers = createResponsesHelpers();
    let recordedRequest = null;

    const runtime = attachResponsesWebSocketServer(server, {
      ...createAuthContext(),
      async openResponsesCreateProxySession() {
        const err = new Error("Session setup failed.");
        err.statusCode = statusCode;
        err.failureCode = "session_setup_failed";
        throw err;
      },
      parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
      readUpstreamTextOrThrow: async (response) => await response.text(),
      parseJsonLoose(value) {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      },
      recordRecentProxyRequest(row) {
        recordedRequest = row;
      }
    });

    let ws;
    try {
      const baseUrl = await listen(server);
      ws = await connectSocket(`${baseUrl}/v1/responses`, {
        Authorization: "Bearer test-proxy-key"
      });
      const queue = createJsonMessageQueue(ws);

      ws.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.4",
          input: "hello"
        })
      );

      const failed = await withTimeout(queue.next(), "Timed out waiting for WebSocket setup failure.");
      assert.equal(failed.type, "response.failed");
      assert.equal(failed.response?.status_code, 502);
      assert.equal(failed.response?.error?.code, "session_setup_failed");
      assert.equal(failed.response?.error?.message, "Session setup failed.");
      assert.equal(recordedRequest?.statusCode, 502);
      assert.equal(recordedRequest?.transportType, "websocket");
    } finally {
      ws?.close();
      await runtime.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("Responses WebSocket accepts upstream SSE without content-type header", async () => {
  const server = createServer();
  const helpers = createResponsesHelpers();
  const upstream = createControllableReadableStream();
  let rememberedCompletion = null;

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(upstream.stream, {
          status: 200,
          headers: {}
        }),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        authAccountId: "acct_ws_json",
        compatibilityHint: "",
        rememberCompletion(completed) {
          rememberedCompletion = completed;
        },
        modelRoute: {
          requestedModel: "gpt-5.4",
          mappedModel: "gpt-5.4"
        },
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse: helpers.parseResponsesResultFromSse,
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello"
      })
    );

    upstream.enqueue(
      'event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n'
    );
    const delta = await queue.next();
    assert.equal(delta.type, "response.output_text.delta");
    upstream.enqueue(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"id":"resp_ws_sse_no_header","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    );
    upstream.close();
    const completed = await queue.next();
    assert.equal(completed.type, "response.completed");
    assert.equal(completed.response?.id, "resp_ws_sse_no_header");
    assert.equal(rememberedCompletion?.id, "resp_ws_sse_no_header");
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses WebSocket rejects truncated SSE without content-type header", async () => {
  const server = createServer();

  const runtime = attachResponsesWebSocketServer(server, {
    ...createAuthContext(),
    async openResponsesCreateProxySession() {
      return {
        upstream: new Response(createReadableStreamFromTextChunks([
          'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"hel"}\n\n'
        ]), {
          status: 200,
          headers: {}
        }),
        release() {},
        async markFailure() {},
        async markSuccess() {},
        authAccountId: "acct_ws_json",
        compatibilityHint: "",
        rememberCompletion() {},
        modelRoute: {
          requestedModel: "gpt-5.4",
          mappedModel: "gpt-5.4"
        },
        forgetPinnedAffinity() {}
      };
    },
    parseResponsesResultFromSse() {
      return {
        completed: null,
        failed: null
      };
    },
    readUpstreamTextOrThrow: async (response) => await response.text(),
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });

  let ws;
  try {
    const baseUrl = await listen(server);
    ws = await connectSocket(`${baseUrl}/v1/responses`, {
      Authorization: "Bearer test-proxy-key"
    });
    const queue = createJsonMessageQueue(ws);

    ws.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.4",
        input: "hello"
      })
    );

    const delta = await queue.next();
    assert.equal(delta.type, "response.output_text.delta");
    const failed = await queue.next();
    assert.equal(failed.type, "response.failed");
    assert.equal(failed.response?.status_code, 502);
    assert.equal(failed.response?.error?.code, "invalid_upstream_sse");
    assert.equal(failed.response?.error?.message, "Upstream SSE ended before a terminal response event.");
  } finally {
    ws?.close();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
