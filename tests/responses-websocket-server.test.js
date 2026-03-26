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
      model: "gpt-5.4",
      input: "hello"
    });
    assert.equal(delta.type, "response.output_text.delta");
    assert.equal(completed.type, "response.completed");
    assert.equal(rememberedCompletion?.id, "resp_ws_1");
    assert.equal(successCount, 1);
    assert.equal(recordedRequest?.statusCode, 200);
    assert.equal(recordedRequest?.authAccountId, "acct_ws_1");
    assert.match(String(recordedRequest?.responseBody || ""), /response\.completed/);
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
