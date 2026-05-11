import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTokenUsage } from "../src/http/token-usage.js";
import { createCodexOAuthResponsesHelpers } from "../src/protocols/codex/oauth-responses.js";
import { applyAdditionalResponsesCreateFields } from "../src/protocols/openai/responses-create-compat.js";

function createHelpers(overrides = {}) {
  let capturedRequest = null;
  let releaseCount = 0;
  const {
    fetchWithUpstreamRetry: fetchWithUpstreamRetryOverride,
    ...restOverrides
  } = overrides;
  const defaultResponse = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
    body: new ReadableStream({
      start() {}
    })
  };

  const helpers = createCodexOAuthResponsesHelpers({
    config: {
      upstreamBaseUrl: "https://example.test",
      upstreamStreamIdleTimeoutMs: 54321,
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "You are a helpful assistant."
      }
    },
    truncate(value) {
      return String(value || "");
    },
    async getValidAuthContext() {
      return {
        accessToken: "token",
        accountId: "acct_123",
        poolAccountId: "pool_123",
        releaseLease() {
          releaseCount += 1;
        }
      };
    },
    getCodexOriginator() {
      return "pi";
    },
    async fetchWithUpstreamRetry(url, init, options) {
      capturedRequest = {
        url,
        init,
        options,
        json: JSON.parse(String(init.body || "{}"))
      };
      if (typeof fetchWithUpstreamRetryOverride === "function") {
        return await fetchWithUpstreamRetryOverride(url, init, options);
      }
      return {
        response: defaultResponse,
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow() {
      return 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":22,"total_tokens":33},"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}\n\n';
    },
    parseResponsesResultFromSse() {
      return {
        completed: {
          status: "completed",
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            total_tokens: 33
          },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }
      };
    },
    extractCompletedResponseFromJson(raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return {
          status: "completed",
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            total_tokens: 33
          },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        };
      }
    },
    normalizeTokenUsage,
    extractAssistantTextFromResponse(response) {
      const item = Array.isArray(response?.output) ? response.output[0] : null;
      const part = Array.isArray(item?.content) ? item.content[0] : null;
      return typeof part?.text === "string" ? part.text : "";
    },
    mapResponsesStatusToChatFinishReason(status) {
      return status === "completed" ? "stop" : "length";
    },
    resolveReasoningEffort(value) {
      return value || null;
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model || "gpt-5.4"
      };
    },
    isCodexPoolRetryEnabled() {
      return false;
    },
    shouldRotateCodexAccountForStatus() {
      return false;
    },
    async maybeMarkCodexPoolFailure() {},
    async maybeMarkCodexPoolSuccess() {},
    async maybeCaptureCodexUsageFromHeaders() {},
    applyAdditionalResponsesCreateFields,
    toResponsesInputFromChatMessages(messages) {
      return messages.map((message) => ({
        role: message.role,
        content: [{ type: "input_text", text: String(message.content || "") }]
      }));
    },
    ...restOverrides
  });

  return {
    helpers,
    getCapturedRequest() {
      return capturedRequest;
    },
    getReleaseCount() {
      return releaseCount;
    },
    getDefaultResponse() {
      return defaultResponse;
    }
  };
}

test("runCodexConversationViaOAuth uses stream-first upstream requests with request timeout", async () => {
  const { helpers, getCapturedRequest } = createHelpers();

  const result = await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }],
    max_tokens: 777
  });

  const captured = getCapturedRequest();
  assert.equal(captured?.url, "https://example.test/codex/responses");
  assert.equal(captured?.init?.headers?.accept, "text/event-stream");
  assert.equal(captured?.json?.stream, true);
  assert.equal(captured?.json?.max_output_tokens, 777);
  assert.equal(captured?.options?.requestTimeoutMs, 54321);
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33
  });
});

test("runCodexConversationViaOAuth ignores decimal-form request timeout config", async () => {
  const { helpers, getCapturedRequest } = createHelpers({
    config: {
      upstreamBaseUrl: "https://example.test",
      upstreamStreamIdleTimeoutMs: "1.0",
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "You are a helpful assistant."
      }
    }
  });

  const result = await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  const captured = getCapturedRequest();
  assert.equal(captured?.options?.requestTimeoutMs, 0);
  assert.equal(result.text, "done");
});

test("runCodexConversationViaOAuth normalizes malformed token usage", async () => {
  const { helpers } = createHelpers({
    parseResponsesResultFromSse() {
      return {
        completed: {
          status: "completed",
          usage: {
            input_tokens: -1,
            output_tokens: "2",
            total_tokens: "1e3"
          },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }
      };
    }
  });

  const result = await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  assert.deepEqual(result.usage, {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});

test("runCodexConversationViaOAuth tolerates malformed normalized token usage", async () => {
  const { helpers } = createHelpers({
    normalizeTokenUsage() {
      return {
        inputTokens: Symbol("input"),
        outputTokens: "4",
        totalTokens: Symbol("total")
      };
    }
  });

  const result = await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  assert.deepEqual(result.usage, {
    prompt_tokens: 0,
    completion_tokens: 4,
    total_tokens: 4
  });
});

test("runCodexConversationViaOAuth does not retry without an explicit max output cap", async () => {
  const requests = [];
  const { helpers } = createHelpers({
    async fetchWithUpstreamRetry(url, init, options) {
      requests.push({
        url,
        options,
        json: JSON.parse(String(init.body || "{}"))
      });
      return {
        response: new Response("unsupported max_output_tokens", {
          status: 400,
          headers: { "content-type": "text/plain" }
        }),
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow(response) {
      return await response.text();
    }
  });

  await assert.rejects(
    () =>
      helpers.runCodexConversationViaOAuth({
        model: "gpt-5.4",
        systemText: "system",
        conversation: [{ role: "user", text: "hello" }],
        max_tokens: 777
      }),
    /HTTP 400: unsupported max_output_tokens/
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.json?.max_output_tokens, 777);
});

test("runCodexConversationViaOAuth forwards the resolved upstream model to auth selection", async () => {
  const authOptions = [];
  const { helpers, getCapturedRequest } = createHelpers({
    async getValidAuthContext(options = {}) {
      authOptions.push(options);
      return {
        accessToken: "token",
        accountId: "acct_123",
        poolAccountId: "pool_123",
        releaseLease() {}
      };
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model === "gpt-alias" ? "gpt-5.5" : model || "gpt-5.4"
      };
    }
  });

  await helpers.runCodexConversationViaOAuth({
    model: "gpt-alias",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  assert.equal(authOptions[0]?.requestedModel, "gpt-5.5");
  assert.equal(getCapturedRequest()?.json?.model, "gpt-5.5");
});

test("openCodexResponsesStreamViaOAuth forwards the resolved upstream model to auth selection", async () => {
  const authOptions = [];
  const { helpers } = createHelpers({
    async getValidAuthContext(options = {}) {
      authOptions.push(options);
      return {
        accessToken: "token",
        accountId: "acct_123",
        poolAccountId: "pool_123",
        releaseLease() {}
      };
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model === "gpt-alias" ? "gpt-5.5" : model || "gpt-5.4"
      };
    }
  });

  const stream = await helpers.openCodexResponsesStreamViaOAuth({
    model: "gpt-alias",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });
  stream.release();

  assert.equal(authOptions[0]?.requestedModel, "gpt-5.5");
});

test("buildCodexResponsesRequestBody rejects explicit temperature for codex upstream", () => {
  const { helpers } = createHelpers();

  const built = helpers.buildCodexResponsesRequestBody({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    temperature: 0.25,
    top_p: 0.9
  });

  assert.equal(Object.hasOwn(built.body, "temperature"), false);
  assert.equal(Object.hasOwn(built.body, "top_p"), false);
});

test("runCodexConversationViaOAuth does not inject the configured default temperature when omitted", async () => {
  const { helpers, getCapturedRequest } = createHelpers();

  await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  const captured = getCapturedRequest();
  assert.equal(Object.hasOwn(captured?.json || {}, "temperature"), false);
});

test("runCodexConversationViaOAuth does not inject reasoning effort when the client omits it", async () => {
  const { helpers, getCapturedRequest } = createHelpers();

  await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }]
  });

  const captured = getCapturedRequest();
  assert.equal(Object.hasOwn(captured?.json || {}, "reasoning"), false);
});

test("buildCodexResponsesRequestBody preserves explicit client reasoning effort", () => {
  const { helpers } = createHelpers();

  const built = helpers.buildCodexResponsesRequestBody({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    reasoningEffort: "low"
  });

  assert.equal(built.body.reasoning?.effort, "low");
});

test("runCodexConversationViaOAuth drops explicit sampling parameters for codex upstream", async () => {
  const { helpers, getCapturedRequest } = createHelpers();

  await helpers.runCodexConversationViaOAuth({
    model: "gpt-5.4",
    systemText: "system",
    conversation: [{ role: "user", text: "hello" }],
    temperature: 0.25,
    top_p: 0.9
  });

  const captured = getCapturedRequest();
  assert.equal(Object.hasOwn(captured?.json || {}, "temperature"), false);
  assert.equal(Object.hasOwn(captured?.json || {}, "top_p"), false);
});

test("openCodexResponsesStreamViaOAuth returns the upstream SSE response unchanged", async () => {
  const { helpers, getCapturedRequest, getDefaultResponse, getReleaseCount } = createHelpers();

  const opened = await helpers.openCodexResponsesStreamViaOAuth({
    model: "gpt-5.4",
    instructions: "system",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });

  const captured = getCapturedRequest();
  assert.equal(captured?.url, "https://example.test/codex/responses");
  assert.equal(captured?.init?.headers?.accept, "text/event-stream");
  assert.equal(captured?.init?.headers?.["accept-encoding"], "identity");
  assert.equal(captured?.json?.stream, true);
  assert.equal(captured?.options?.requestTimeoutMs, 54321);
  assert.equal(opened.authAccountId, "pool_123");
  assert.equal(opened.bufferedCompletion, null);
  assert.equal(opened.upstream, getDefaultResponse());
  assert.equal(getReleaseCount(), 0);
  opened.release();
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth streams upstream responses without content-type", async () => {
  let readBufferedBody = false;
  const upstreamResponse = new Response(new ReadableStream({
    start() {}
  }), {
    status: 200,
    headers: {}
  });
  const { helpers, getReleaseCount } = createHelpers({
    async fetchWithUpstreamRetry() {
      return {
        response: upstreamResponse,
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow() {
      readBufferedBody = true;
      return "";
    }
  });

  const opened = await helpers.openCodexResponsesStreamViaOAuth({
    model: "gpt-5.4",
    instructions: "system",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });

  assert.equal(opened.bufferedCompletion, null);
  assert.equal(opened.upstream, upstreamResponse);
  assert.equal(readBufferedBody, false);
  opened.release();
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth does not retry without an explicit max output cap", async () => {
  const requests = [];
  const { helpers, getReleaseCount } = createHelpers({
    async fetchWithUpstreamRetry(url, init, options) {
      requests.push({
        url,
        options,
        json: JSON.parse(String(init.body || "{}"))
      });
      return {
        response: new Response("unsupported max_output_tokens", {
          status: 400,
          headers: { "content-type": "text/plain" }
        }),
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow(response) {
      return await response.text();
    }
  });

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        max_tokens: 777
      }),
    /HTTP 400: unsupported max_output_tokens/
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.json?.max_output_tokens, 777);
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth buffers completed JSON responses on stream fallback", async () => {
  const { helpers, getCapturedRequest, getReleaseCount } = createHelpers({
    async fetchWithUpstreamRetry() {
      return {
        response: {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json; charset=utf-8" })
        },
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow() {
      return JSON.stringify({
        id: "resp_123",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2
        },
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }]
          }
        ]
      });
    }
  });

  const opened = await helpers.openCodexResponsesStreamViaOAuth({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });
  const captured = getCapturedRequest();
  assert.equal(captured?.init?.headers?.accept, "text/event-stream");
  assert.equal(captured?.init?.headers?.["accept-encoding"], "identity");
  assert.equal(captured?.json?.stream, true);
  assert.deepEqual(opened.bufferedCompletion, {
    id: "resp_123",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
    },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "done" }]
      }
    ]
  });
  assert.equal(opened.upstream, null);
  opened.release();
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth marks the final pool failure before throwing", async () => {
  const failureMarks = [];
  const releaseOrder = [];
  const authQueue = [
    {
      accessToken: "token-1",
      accountId: "acct_1",
      poolAccountId: "pool_1",
      releaseLease() {
        releaseOrder.push("pool_1");
      }
    },
    {
      accessToken: "token-2",
      accountId: "acct_2",
      poolAccountId: "pool_2",
      releaseLease() {
        releaseOrder.push("pool_2");
      }
    }
  ];

  const { helpers } = createHelpers({
    async getValidAuthContext() {
      return authQueue.shift();
    },
    isCodexPoolRetryEnabled() {
      return true;
    },
    shouldRotateCodexAccountForStatus(statusCode) {
      return Number(statusCode || 0) === 429;
    },
    async fetchWithUpstreamRetry() {
      return {
        response: new Response("rate limited", {
          status: 429,
          headers: {
            "content-type": "text/plain"
          }
        }),
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    async readUpstreamTextOrThrow(response) {
      return await response.text();
    },
    async maybeMarkCodexPoolFailure(auth, message, statusCode) {
      failureMarks.push({
        poolAccountId: auth?.poolAccountId || null,
        message,
        statusCode
      });
    }
  });

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }),
    /HTTP 429/
  );

  assert.deepEqual(
    failureMarks.map((entry) => entry.poolAccountId),
    ["pool_1", "pool_2"]
  );
  assert.deepEqual(
    failureMarks.map((entry) => entry.statusCode),
    [429, 429]
  );
  assert.deepEqual(releaseOrder, ["pool_1", "pool_2"]);
});

test("openCodexResponsesStreamViaOAuth normalizes malformed transport failure statuses", async () => {
  const rotationStatuses = [];
  const failureMarks = [];
  const { helpers, getReleaseCount } = createHelpers({
    isCodexPoolRetryEnabled() {
      return true;
    },
    shouldRotateCodexAccountForStatus(statusCode) {
      rotationStatuses.push(statusCode);
      return false;
    },
    async fetchWithUpstreamRetry() {
      const err = new Error("transport status malformed");
      err.statusCode = Symbol("status");
      throw err;
    },
    async maybeMarkCodexPoolFailure(auth, message, statusCode) {
      failureMarks.push({
        poolAccountId: auth?.poolAccountId || null,
        message,
        statusCode
      });
    }
  });

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }),
    /transport status malformed/
  );

  assert.deepEqual(rotationStatuses, [0]);
  assert.deepEqual(
    failureMarks.map((entry) => entry.statusCode),
    [0]
  );
  assert.equal(failureMarks[0]?.poolAccountId, "pool_123");
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth rejects decimal-form transport failure statuses", async () => {
  const rotationStatuses = [];
  const failureMarks = [];
  const { helpers, getReleaseCount } = createHelpers({
    isCodexPoolRetryEnabled() {
      return true;
    },
    shouldRotateCodexAccountForStatus(statusCode) {
      rotationStatuses.push(statusCode);
      return false;
    },
    async fetchWithUpstreamRetry() {
      const err = new Error("transport status decimal");
      err.statusCode = "429.0";
      throw err;
    },
    async maybeMarkCodexPoolFailure(auth, message, statusCode) {
      failureMarks.push({
        poolAccountId: auth?.poolAccountId || null,
        message,
        statusCode
      });
    }
  });

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }),
    /transport status decimal/
  );

  assert.deepEqual(rotationStatuses, [0]);
  assert.deepEqual(
    failureMarks.map((entry) => entry.statusCode),
    [0]
  );
  assert.equal(failureMarks[0]?.poolAccountId, "pool_123");
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth drops out-of-range transport failure statuses", async () => {
  const rotationStatuses = [];
  const failureMarks = [];
  const { helpers, getReleaseCount } = createHelpers({
    isCodexPoolRetryEnabled() {
      return true;
    },
    shouldRotateCodexAccountForStatus(statusCode) {
      rotationStatuses.push(statusCode);
      return false;
    },
    async fetchWithUpstreamRetry() {
      const err = new Error("transport status out of range");
      err.statusCode = 700;
      throw err;
    },
    async maybeMarkCodexPoolFailure(auth, message, statusCode) {
      failureMarks.push({
        poolAccountId: auth?.poolAccountId || null,
        message,
        statusCode
      });
    }
  });

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }),
    /transport status out of range/
  );

  assert.deepEqual(rotationStatuses, [0]);
  assert.deepEqual(
    failureMarks.map((entry) => entry.statusCode),
    [0]
  );
  assert.equal(failureMarks[0]?.poolAccountId, "pool_123");
  assert.equal(getReleaseCount(), 1);
});

test("buildCodexResponsesRequestBody preserves official additional create fields excluding unsupported sampling fields", () => {
  const { helpers } = createHelpers();

  const built = helpers.buildCodexResponsesRequestBody({
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    additionalCreateFields: {
      metadata: { trace_id: "trace_123" },
      truncation: "auto",
      text: {
        format: { type: "text" },
        verbosity: "low"
      }
    }
  });

  assert.deepEqual(built.body.metadata, { trace_id: "trace_123" });
  assert.equal(built.body.truncation, "auto");
  assert.deepEqual(built.body.text, {
    format: { type: "text" },
    verbosity: "low"
  });
});
