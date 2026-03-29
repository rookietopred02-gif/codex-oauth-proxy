import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createAnthropicLocalCompatHelpers } from "../src/protocols/anthropic/local-compat.js";

function createMockRequest(body) {
  return {
    method: "POST",
    originalUrl: "/v1/messages",
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
      if (chunk !== undefined) {
        this.write(chunk);
      }
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
    },
    error(err) {
      controllerRef.error(err);
    }
  };
}

function createHelpers(overrides = {}) {
  return createAnthropicLocalCompatHelpers({
    config: {
      anthropic: {
        defaultModel: "claude-sonnet-4.5"
      },
      codex: {
        defaultInstructions: "You are a helpful assistant."
      }
    },
    async readJsonBody(req) {
      return JSON.parse(req.rawBody.toString("utf8"));
    },
    async readRawBody(req) {
      return req.rawBody;
    },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    truncate(value) {
      return String(value || "");
    },
    resolveReasoningEffort(value) {
      return value || "medium";
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "claude-sonnet-4.5",
        mappedModel: "gpt-5.4"
      };
    },
    async executeCodexResponsesViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        completed: {
          status: "completed",
          usage: {
            input_tokens: 3,
            output_tokens: 4
          },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }
      };
    },
    async openCodexResponsesStreamViaOAuth() {
      throw new Error("openCodexResponsesStreamViaOAuth must be stubbed for stream tests.");
    },
    resolveCompatErrorStatusCode(err, fallback = 502) {
      return Number(err?.statusCode || fallback);
    },
    mapHttpStatusToAnthropicErrorType(statusCode) {
      return statusCode === 401 ? "authentication_error" : "api_error";
    },
    mapResponsesStatusToChatFinishReason() {
      return "stop";
    },
    mapOpenAIFinishReasonToAnthropic() {
      return "end_turn";
    },
    ...overrides
  });
}

test("Anthropic native stream sends message_start before awaiting Codex completion", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        bufferedCompletion: null,
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  const pending = helpers.handleAnthropicNativeCompat(req, res);
  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"done"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.statusCode, 200);
  assert.match(res.writes.join(""), /event: message_start/);
  assert.match(res.writes.join(""), /event: content_block_delta/);
  assert.match(res.writes.join(""), /"text":"done"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const output = res.writes.join("");
  assert.match(output, /event: message_delta/);
  assert.match(output, /event: message_stop/);
  assert.equal(res.writableEnded, true);
});

test("Anthropic native stream falls back to JSON error when upstream fails before any delta", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        bufferedCompletion: null,
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  const pending = helpers.handleAnthropicNativeCompat(req, res);
  upstream.enqueue('data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n');
  upstream.close();
  await pending;

  assert.equal(res.writes.join(""), "");
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "upstream failed"
    }
  });
});

test("Anthropic native stream finalizes response.incomplete", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    mapResponsesStatusToChatFinishReason(status) {
      return status === "incomplete" ? "length" : "stop";
    },
    mapOpenAIFinishReasonToAnthropic(reason) {
      return reason === "length" ? "max_tokens" : "end_turn";
    },
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
        bufferedCompletion: null,
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  const pending = helpers.handleAnthropicNativeCompat(req, res);
  upstream.enqueue(
    'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const output = res.writes.join("");
  assert.match(output, /event: message_stop/);
  assert.match(output, /"stop_reason":"max_tokens"/);
});

test("Anthropic native stream rejects sessions without an SSE body", async () => {
  let failureArgs = null;
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
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
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.writes.join(""), "");
  assert.deepEqual(failureArgs, {
    message: "Upstream stream request did not return an SSE body.",
    statusCode: 502
  });
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "Upstream stream request did not return an SSE body."
    }
  });
});

test("Anthropic native stream converts buffered JSON completion into SSE", async () => {
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
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
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.writes.join(""), /event: message_start/);
  assert.match(res.writes.join(""), /"text":"done"/);
  assert.match(res.writes.join(""), /event: message_stop/);
  assert.deepEqual(res.locals.tokenUsage, {
    prompt_tokens: 4,
    completion_tokens: 5,
    total_tokens: 9
  });
});

test("Anthropic native non-stream drops explicit sampling parameters for codex-backed local compat", async () => {
  let captured = null;
  const helpers = createHelpers({
    async executeCodexResponsesViaOAuth(options) {
      captured = options;
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        completed: {
          status: "completed",
          usage: {
            input_tokens: 3,
            output_tokens: 4
          },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }
      };
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    temperature: 0.25,
    top_p: 0.8,
    metadata: { trace_id: "trace_123" },
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(captured?.temperature, undefined);
  assert.equal(captured?.top_p, undefined);
  assert.deepEqual(captured?.additionalCreateFields, {
    metadata: { trace_id: "trace_123" }
  });
  assert.equal(res.statusCode, 200);
});

test("Anthropic native stream drops explicit sampling parameters for codex-backed local compat", async () => {
  let captured = null;
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth(options) {
      captured = options;
      return {
        model: "claude-sonnet-4.5",
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
    model: "claude-sonnet-4.5",
      stream: true,
    temperature: 0.25,
    top_p: 0.8,
    metadata: { trace_id: "trace_123" },
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(captured?.temperature, undefined);
  assert.equal(captured?.top_p, undefined);
  assert.deepEqual(captured?.additionalCreateFields, {
    metadata: { trace_id: "trace_123" }
  });
  assert.equal(res.statusCode, 200);
});

test("Anthropic native rejects unsupported documents with an explicit compatibility error", async () => {
  const helpers = createHelpers();
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    documents: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } }],
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message:
        'Anthropic field "documents" is not supported in local compatibility mode because it cannot be equivalently mapped to Codex/OpenAI Responses upstream.'
    }
  });
});
