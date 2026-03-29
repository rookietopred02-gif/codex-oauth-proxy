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

test("Gemini native stream converts buffered JSON completion into SSE", async () => {
  const helpers = createHelpers({
    async openCodexConversationStreamViaOAuth() {
      return {
        authAccountId: "acct_123",
        upstream: null,
        bufferedCompletion: {
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
        },
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

  await helpers.handleGeminiNativeCompat(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.writes.join(""), /"text":"done"/);
  assert.match(res.writes.join(""), /"finishReason":"STOP"/);
  assert.deepEqual(res.locals.tokenUsage, {
    prompt_tokens: 4,
    completion_tokens: 5,
    total_tokens: 9
  });
});
