import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicOpenAICompatHelpers } from "../src/protocols/anthropic/openai-compat.js";

function createRequestBodyTooLargeError() {
  const err = new Error("Request body exceeds the 64 byte limit.");
  err.code = "request_body_too_large";
  err.statusCode = 413;
  return err;
}

function createMockRequest(rawBody = '{"messages":[]}') {
  return {
    method: "POST",
    originalUrl: "/v1/chat/completions",
    rawBody: Buffer.from(rawBody, "utf8")
  };
}

function createMockResponse() {
  return {
    locals: {},
    headersSent: false,
    statusCode: 200,
    jsonPayload: null,
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.headersSent = true;
      this.jsonPayload = payload;
      return this;
    },
    write(chunk) {
      this.headersSent = true;
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.headersSent = true;
      return this;
    }
  };
}

function createHelpers(overrides = {}) {
  return createAnthropicOpenAICompatHelpers({
    config: {
      anthropic: {
        defaultModel: "claude-sonnet-4.5"
      },
      authMode: "codex-oauth"
    },
    async readJsonBody(req) {
      return JSON.parse(req.rawBody.toString("utf8"));
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "claude-sonnet-4.5",
        mappedModel: "gpt-5.4"
      };
    },
    resolveCompatErrorStatusCode(err, fallback = 502) {
      return Number(err?.statusCode || fallback);
    },
    parseOpenAIChatCompletionsLikeRequest(rawBody, defaultModel, parsedBody) {
      const parsed = parsedBody ?? JSON.parse(rawBody.toString("utf8"));
      return {
        model: parsed.model || defaultModel,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        stream: parsed.stream === true
      };
    },
    splitSystemAndConversation() {
      return { systemText: "", conversation: [] };
    },
    buildOpenAIChatCompletion() {
      throw new Error("buildOpenAIChatCompletion should not run");
    },
    sendOpenAICompletionAsSse() {
      throw new Error("sendOpenAICompletionAsSse should not run");
    },
    async openCodexConversationStreamViaOAuth() {
      throw new Error("openCodexConversationStreamViaOAuth should not run");
    },
    async runCodexConversationViaOAuth() {
      throw new Error("runCodexConversationViaOAuth should not run");
    },
    async pipeCodexSseAsChatCompletions() {
      throw new Error("pipeCodexSseAsChatCompletions should not run");
    },
    ...overrides
  });
}

test("Anthropic OpenAI compat rejects oversized JSON before Codex execution", async () => {
  let parseCalled = false;
  let runCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    async readJsonBody() {
      throw createRequestBodyTooLargeError();
    },
    parseOpenAIChatCompletionsLikeRequest() {
      parseCalled = true;
      throw new Error("parseOpenAIChatCompletionsLikeRequest should not run");
    },
    async openCodexConversationStreamViaOAuth() {
      streamCalled = true;
      throw new Error("openCodexConversationStreamViaOAuth should not run");
    },
    async runCodexConversationViaOAuth() {
      runCalled = true;
      throw new Error("runCodexConversationViaOAuth should not run");
    }
  });
  const req = createMockRequest();
  const res = createMockResponse();

  await helpers.handleAnthropicOpenAICompatWithCodex(req, res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.jsonPayload, {
    error: "request_body_too_large",
    message: "Request body exceeds the 64 byte limit."
  });
  assert.equal(parseCalled, false);
  assert.equal(runCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic OpenAI compat rejects malformed JSON before Codex execution", async () => {
  let runCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    parseOpenAIChatCompletionsLikeRequest(rawBody, defaultModel, parsedBody) {
      assert.equal(parsedBody, undefined);
      throw new Error("Invalid JSON body for /v1/chat/completions.");
    },
    async openCodexConversationStreamViaOAuth() {
      streamCalled = true;
      throw new Error("openCodexConversationStreamViaOAuth should not run");
    },
    async runCodexConversationViaOAuth() {
      runCalled = true;
      throw new Error("runCodexConversationViaOAuth should not run");
    }
  });
  const req = createMockRequest('{"messages":[');
  const res = createMockResponse();

  await helpers.handleAnthropicOpenAICompatWithCodex(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonPayload, {
    error: "invalid_request",
    message: "Invalid JSON body for /v1/chat/completions."
  });
  assert.equal(runCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic OpenAI compat stream marks failures with a resolved fallback status", async () => {
  let failureStatusCode = null;
  const helpers = createHelpers({
    resolveCompatErrorStatusCode(_err, fallback = 502) {
      return fallback;
    },
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: new Response("event: response.output_text.delta\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }),
        async markSuccess() {
          throw new Error("markSuccess should not run after a stream failure.");
        },
        async markFailure(_message, statusCode) {
          failureStatusCode = statusCode;
        },
        release() {}
      };
    },
    async pipeCodexSseAsChatCompletions() {
      const err = new Error("stream failed");
      err.statusCode = Symbol("status");
      throw err;
    }
  });
  const req = createMockRequest('{"messages":[],"stream":true}');
  const res = createMockResponse();

  await helpers.handleAnthropicOpenAICompatWithCodex(req, res);

  assert.equal(failureStatusCode, 502);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "unauthorized",
    message: "stream failed",
    hint: null
  });
});
