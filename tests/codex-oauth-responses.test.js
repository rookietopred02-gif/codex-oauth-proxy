import assert from "node:assert/strict";
import test from "node:test";

import { createCodexOAuthResponsesHelpers } from "../src/protocols/codex/oauth-responses.js";

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
    extractCompletedResponseFromJson() {
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
    max_tokens: 777,
    temperature: 0.25,
    top_p: 0.9
  });

  const captured = getCapturedRequest();
  assert.equal(captured?.url, "https://example.test/codex/responses");
  assert.equal(captured?.init?.headers?.accept, "text/event-stream");
  assert.equal(captured?.json?.stream, true);
  assert.equal(captured?.json?.max_output_tokens, 777);
  assert.equal(captured?.json?.temperature, 0.25);
  assert.equal(captured?.json?.top_p, 0.9);
  assert.equal(captured?.options?.requestTimeoutMs, 54321);
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33
  });
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
  assert.equal(captured?.json?.stream, true);
  assert.equal(captured?.options?.requestTimeoutMs, 54321);
  assert.equal(opened.authAccountId, "pool_123");
  assert.equal(opened.bufferedCompletion, null);
  assert.equal(opened.upstream, getDefaultResponse());
  assert.equal(getReleaseCount(), 0);
  opened.release();
  assert.equal(getReleaseCount(), 1);
});

test("openCodexResponsesStreamViaOAuth rejects non-SSE upstream stream responses", async () => {
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

  await assert.rejects(
    () =>
      helpers.openCodexResponsesStreamViaOAuth({
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
      }),
    /non-SSE content-type: application\/json; charset=utf-8/i
  );

  const captured = getCapturedRequest();
  assert.equal(captured?.init?.headers?.accept, "text/event-stream");
  assert.equal(captured?.json?.stream, true);
  assert.equal(getReleaseCount(), 1);
});
