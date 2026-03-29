import assert from "node:assert/strict";
import test from "node:test";

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
    normalizeTokenUsage(usage) {
      if (!usage) return null;
      return {
        inputTokens: Number(usage.input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        totalTokens: Number(usage.total_tokens || 0)
      };
    },
    extractAssistantTextFromResponse(response) {
      const item = Array.isArray(response?.output) ? response.output[0] : null;
      const part = Array.isArray(item?.content) ? item.content[0] : null;
      return typeof part?.text === "string" ? part.text : "";
    },
    mapResponsesStatusToChatFinishReason(status) {
      return status === "completed" ? "stop" : "length";
    },
    resolveReasoningEffort(value) {
      return value || "medium";
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model || "gpt-5.4"
      };
    },
    isUnsupportedMaxOutputTokensError() {
      return false;
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
