import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGeminiLocalCompatHelpers } from "../src/protocols/gemini/local-compat.js";

function createMockRequest(body) {
  return {
    method: "POST",
    originalUrl: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    rawBody: Buffer.from(JSON.stringify(body), "utf8")
  };
}

function createRawMockRequest(rawBody, originalUrl = "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse") {
  return {
    method: "POST",
    originalUrl,
    rawBody: Buffer.from(rawBody, "utf8")
  };
}

function createMockResponse() {
  const events = new EventEmitter();
  return {
    locals: {},
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    closed: false,
    statusCode: 200,
    writes: [],
    jsonPayload: null,
    headers: new Map(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    write(chunk) {
      this.headersSent = true;
      this.writes.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.closed = true;
      events.emit("close");
      return this;
    },
    json(payload) {
      this.headersSent = true;
      this.jsonPayload = payload;
      this.writableEnded = true;
      this.writableFinished = true;
      return this;
    },
    once(eventName, handler) {
      events.once(eventName, handler);
      return this;
    },
    off(eventName, handler) {
      events.off(eventName, handler);
      return this;
    }
  };
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

function collectGeminiText(writes) {
  let text = "";
  for (const chunk of writes) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      const parsed = JSON.parse(payload);
      const parts = parsed?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (typeof part?.text === "string") {
          text += part.text;
        }
      }
    }
  }
  return text;
}

function collectGeminiPayloads(writes) {
  const payloads = [];
  for (const chunk of writes) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      payloads.push(JSON.parse(payload));
    }
  }
  return payloads;
}

function createRequestBodyTooLargeError() {
  const err = new Error("Request body exceeds the 64 byte limit.");
  err.code = "request_body_too_large";
  err.statusCode = 413;
  return err;
}

function createHelpers(overrides = {}) {
  return createGeminiLocalCompatHelpers({
    config: {
      gemini: {
        defaultModel: "gemini-2.5-flash"
      }
    },
    async readJsonBody(req) {
      return JSON.parse(req.rawBody.toString("utf8"));
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gemini-2.5-flash",
        mappedModel: "gpt-5.4"
      };
    },
    resolveCompatErrorStatusCode(err, fallback = 502) {
      return Number(err?.statusCode || fallback);
    },
    parseOpenAIChatCompletionsLikeRequest() {
      throw new Error("Not used in Gemini native tests.");
    },
    splitSystemAndConversation() {
      return { systemText: "", conversation: [] };
    },
    buildOpenAIChatCompletion() {
      throw new Error("Not used in Gemini native tests.");
    },
    sendOpenAICompletionAsSse(res, completion) {
      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.write(
        `data: ${JSON.stringify({
          id: completion?.id || "chatcmpl_test",
          object: "chat.completion.chunk",
          created: completion?.created || 0,
          model: completion?.model || "",
          choices: [{ index: 0, delta: { role: "assistant", content: completion?.choices?.[0]?.message?.content || "" }, finish_reason: completion?.choices?.[0]?.finish_reason || "stop" }],
          usage: completion?.usage || null
        })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    },
    async openCodexConversationStreamViaOAuth() {
      throw new Error("openCodexConversationStreamViaOAuth must be stubbed for stream tests.");
    },
    mapOpenAIFinishReasonToGemini(reason) {
      return reason === "length" ? "MAX_TOKENS" : "STOP";
    },
    async runCodexConversationViaOAuth() {
      throw new Error("Not used in Gemini native tests.");
    },
    async pipeCodexSseAsChatCompletions() {
      throw new Error("Not used in Gemini native tests.");
    },
    getOpenAICompatibleModelIds() {
      return ["gemini-2.5-flash"];
    },
    ...overrides
  });
}

test("Gemini native rejects malformed JSON before Codex execution", async () => {
  let runCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      streamCalled = true;
      throw new Error("openCodexConversationStreamViaOAuth should not run");
    },
    async runCodexConversationViaOAuth() {
      runCalled = true;
      throw new Error("runCodexConversationViaOAuth should not run");
    }
  });
  const req = createRawMockRequest('{"contents":[');
  const res = createMockResponse();

  await helpers.handleGeminiNativeCompat(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonPayload, {
    error: {
      code: 400,
      message: "Invalid JSON body for Gemini endpoint.",
      status: "INVALID_ARGUMENT"
    }
  });
  assert.equal(runCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Gemini native rejects oversized JSON before Codex execution", async () => {
  let runCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    async readJsonBody() {
      throw createRequestBodyTooLargeError();
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
  const req = createRawMockRequest('{"contents":[]}');
  const res = createMockResponse();

  await helpers.handleGeminiNativeCompat(req, res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.jsonPayload, {
    error: {
      code: 413,
      message: "Request body exceeds the 64 byte limit.",
      status: "INVALID_ARGUMENT"
    }
  });
  assert.equal(runCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Gemini OpenAI compat rejects malformed JSON before Codex execution", async () => {
  let runCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    parseOpenAIChatCompletionsLikeRequest(rawBody, fallbackModel, parsedBody) {
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
  const req = createRawMockRequest('{"messages":[', "/v1/chat/completions");
  const res = createMockResponse();

  await helpers.handleGeminiOpenAICompatWithCodex(req, res);

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

test("Gemini OpenAI compat rejects oversized JSON before Codex execution", async () => {
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
  const req = createRawMockRequest('{"messages":[]}', "/v1/chat/completions");
  const res = createMockResponse();

  await helpers.handleGeminiOpenAICompatWithCodex(req, res);

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

test("Gemini OpenAI compat normalizes malformed upstream error statuses", async () => {
  const helpers = createHelpers({
    parseOpenAIChatCompletionsLikeRequest(rawBody) {
      return JSON.parse(rawBody.toString("utf8"));
    },
    splitSystemAndConversation(messages) {
      return {
        systemText: "",
        conversation: messages.map((message) => ({
          role: message.role,
          text: message.content
        }))
      };
    },
    async runCodexConversationViaOAuth() {
      const err = new Error("transport status malformed");
      err.statusCode = Symbol("status");
      throw err;
    }
  });
  const req = createRawMockRequest(
    JSON.stringify({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }]
    }),
    "/v1/chat/completions"
  );
  const res = createMockResponse();

  await helpers.handleGeminiOpenAICompatWithCodex(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "unauthorized",
    message: "transport status malformed",
    hint: null
  });
});

test("Gemini OpenAI compat rejects fractional upstream error statuses", async () => {
  const helpers = createHelpers({
    parseOpenAIChatCompletionsLikeRequest(rawBody) {
      return JSON.parse(rawBody.toString("utf8"));
    },
    splitSystemAndConversation(messages) {
      return {
        systemText: "",
        conversation: messages.map((message) => ({
          role: message.role,
          text: message.content
        }))
      };
    },
    async runCodexConversationViaOAuth() {
      const err = new Error("transport status fractional");
      err.statusCode = "401.9";
      throw err;
    }
  });
  const req = createRawMockRequest(
    JSON.stringify({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }]
    }),
    "/v1/chat/completions"
  );
  const res = createMockResponse();

  await helpers.handleGeminiOpenAICompatWithCodex(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "unauthorized",
    message: "transport status fractional",
    hint: null
  });
});

test("Gemini OpenAI compat rejects decimal-form upstream error statuses", async () => {
  const helpers = createHelpers({
    parseOpenAIChatCompletionsLikeRequest(rawBody) {
      return JSON.parse(rawBody.toString("utf8"));
    },
    splitSystemAndConversation(messages) {
      return {
        systemText: "",
        conversation: messages.map((message) => ({
          role: message.role,
          text: message.content
        }))
      };
    },
    async runCodexConversationViaOAuth() {
      const err = new Error("transport status decimal");
      err.statusCode = "401.0";
      throw err;
    }
  });
  const req = createRawMockRequest(
    JSON.stringify({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }]
    }),
    "/v1/chat/completions"
  );
  const res = createMockResponse();

  await helpers.handleGeminiOpenAICompatWithCodex(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "unauthorized",
    message: "transport status decimal",
    hint: null
  });
});

test("Gemini native stream sends SSE deltas before Codex completion", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"done"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));

  const partial = res.writes.join("");
  assert.match(partial, /"role":"model"/);
  assert.match(partial, /"text":"done"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const output = res.writes.join("");
  assert.match(output, /"finishReason":"STOP"/);
  assert.match(output, /"totalTokenCount":3/);
  assert.equal(res.writableEnded, true);
});

test("Gemini native stream ignores malformed terminal token usage", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":"1.5","output_tokens":-2,"total_tokens":"nope"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const payloads = collectGeminiPayloads(res.writes);
  assert.equal(collectGeminiText(res.writes), "done");
  assert.equal(payloads.at(-1)?.usageMetadata, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Gemini native stream ignores malformed idle timeout config", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    config: {
      gemini: {
        defaultModel: "gemini-2.5-flash"
      },
      upstreamStreamIdleTimeoutMs: Symbol("timeout")
    },
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  assert.equal(res.statusCode, 200);
  assert.equal(collectGeminiText(res.writes), "done");
});

test("Gemini native stream ignores decimal-form idle timeout config", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    config: {
      gemini: {
        defaultModel: "gemini-2.5-flash"
      },
      upstreamStreamIdleTimeoutMs: "1.0"
    },
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  await new Promise((resolve) => setTimeout(resolve, 10));
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  assert.equal(res.statusCode, 200);
  assert.equal(collectGeminiText(res.writes), "done");
});

test("Gemini native stream treats output_text.done as the final text value", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n');
  upstream.enqueue('data: {"type":"response.output_text.done","item_id":"msg_1","text":"hello"}\n\n');
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  assert.equal(collectGeminiText(res.writes), "hello");
});

test("Gemini native stream finalizes response.incomplete as MAX_TOKENS", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue(
    'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const output = res.writes.join("");
  assert.equal(collectGeminiText(res.writes), "partial");
  assert.match(output, /"finishReason":"MAX_TOKENS"/);
});

test("Gemini native stream falls back to JSON error when upstream fails before any delta", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  const pending = helpers.handleGeminiNativeCompat(req, res);
  upstream.enqueue('data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n');
  upstream.close();
  await pending;

  assert.equal(res.writes.join(""), "");
  assert.deepEqual(res.jsonPayload, {
    error: {
      code: 502,
      message: "upstream failed",
      status: "INTERNAL"
    }
  });
});

test("Gemini native stream normalizes malformed transport failure statuses", async () => {
  let failureArgs = null;
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: {
          body: {
            getReader() {
              return {
                async read() {
                  const err = new Error("transport status malformed");
                  err.statusCode = Symbol("status");
                  throw err;
                },
                async cancel() {},
                releaseLock() {}
              };
            }
          }
        },
        async markSuccess() {},
        async markFailure(message, statusCode) {
          failureArgs = { message, statusCode };
        },
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  await helpers.handleGeminiNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(failureArgs, {
    message: "transport status malformed",
    statusCode: 502
  });
  assert.deepEqual(res.jsonPayload, {
    error: {
      code: 502,
      message: "transport status malformed",
      status: "INTERNAL"
    }
  });
});

test("Gemini native stream rejects sessions without an SSE body", async () => {
  let failureArgs = null;
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: null,
        async markSuccess() {},
        async markFailure(message, statusCode) {
          failureArgs = { message, statusCode };
        },
        release() {}
      };
    }
  });
  const req = createMockRequest({
    contents: [{ role: "user", parts: [{ text: "hello" }] }]
  });
  const res = createMockResponse();

  await helpers.handleGeminiNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.writes.join(""), "");
  assert.deepEqual(failureArgs, {
    message: "Upstream stream request did not return an SSE body.",
    statusCode: 502
  });
  assert.deepEqual(res.jsonPayload, {
    error: {
      code: 502,
      message: "Upstream stream request did not return an SSE body.",
      status: "INTERNAL"
    }
  });
});
