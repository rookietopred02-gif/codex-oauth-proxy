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

function createRawMockRequest(rawBody, originalUrl = "/v1/messages") {
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

function createCompletedResponsesSseStream({
  text = "done",
  usage = { input_tokens: 4, output_tokens: 5, total_tokens: 9 }
} = {}) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                status: "completed",
                usage,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text }]
                  }
                ]
              }
            })}\n\n`
          )
        );
        controller.close();
      }
    })
  };
}

function createRequestBodyTooLargeError() {
  const err = new Error("Request body exceeds the 64 byte limit.");
  err.code = "request_body_too_large";
  err.statusCode = 413;
  return err;
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

test("Anthropic native rejects malformed JSON before Codex execution", async () => {
  let executeCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    async executeCodexResponsesViaOAuth() {
      executeCalled = true;
      throw new Error("executeCodexResponsesViaOAuth should not run");
    },
    async openCodexResponsesStreamViaOAuth() {
      streamCalled = true;
      throw new Error("openCodexResponsesStreamViaOAuth should not run");
    }
  });
  const req = createRawMockRequest('{"messages":[');
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Invalid JSON body for Anthropic endpoint."
    }
  });
  assert.equal(executeCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic count_tokens rejects malformed JSON without token usage", async () => {
  const helpers = createHelpers();
  const req = createRawMockRequest('{"messages":[', "/v1/messages/count_tokens");
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Invalid JSON body for Anthropic endpoint."
    }
  });
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic count token estimation tolerates non-JSON-safe parsed fields", () => {
  const helpers = createHelpers();

  const tokenCount = helpers.estimateAnthropicCountTokens(Buffer.alloc(0), {
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "custom",
        name: "lookup",
        input_schema: { limit: 1n }
      }
    ],
    tool_choice: { type: "tool", name: "lookup", extra: 1n },
    metadata: { traceId: 1n },
    documents: [
      {
        toJSON() {
          throw new Error("documents should not break estimation");
        }
      }
    ]
  });

  assert.equal(Number.isInteger(tokenCount), true);
  assert.ok(tokenCount > 0);
});

test("Anthropic native body validation rejects malformed thinking budgets", () => {
  const helpers = createHelpers();

  assert.throws(
    () =>
      helpers.parseAnthropicNativeBody(Buffer.alloc(0), {
        messages: [{ role: "user", content: "hello" }],
        thinking: { budget_tokens: Symbol("budget") }
      }),
    {
      message: "Anthropic thinking.budget_tokens must be a non-negative number."
    }
  );
});

test("Anthropic pending tool batch pruning tolerates malformed timestamps", () => {
  const helpers = createHelpers();
  const originalDateNow = Date.now;

  try {
    Date.now = () => Symbol("now");
    assert.doesNotThrow(() => {
      helpers.rememberAnthropicPendingToolBatch(
        "call_trigger_1",
        [{ type: "function_call", name: "tool_one", arguments: "{}" }],
        "claude-sonnet-4.5"
      );
      helpers.rememberAnthropicPendingToolBatch(
        "call_trigger_2",
        [{ type: "function_call", name: "tool_two", arguments: "{}" }],
        "claude-sonnet-4.5"
      );
    });
  } finally {
    Date.now = originalDateNow;
  }

  const queued = helpers.maybeBuildQueuedAnthropicToolMessage(
    [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_trigger_2", content: "done" }]
      }
    ],
    "claude-sonnet-4.5"
  );
  assert.equal(queued, null);
});

test("Anthropic pending tool batch pruning rejects decimal-form timestamps", () => {
  const helpers = createHelpers();
  const originalDateNow = Date.now;

  try {
    Date.now = () => `${originalDateNow()}.5`;
    helpers.rememberAnthropicPendingToolBatch(
      "call_trigger_decimal",
      [{ type: "function_call", name: "tool_decimal", arguments: "{}" }],
      "claude-sonnet-4.5"
    );
  } finally {
    Date.now = originalDateNow;
  }

  const queued = helpers.maybeBuildQueuedAnthropicToolMessage(
    [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_trigger_decimal", content: "done" }]
      }
    ],
    "claude-sonnet-4.5"
  );
  assert.equal(queued, null);
});

test("Anthropic native rejects oversized JSON before Codex execution", async () => {
  let executeCalled = false;
  let streamCalled = false;
  const helpers = createHelpers({
    async readRawBody() {
      throw createRequestBodyTooLargeError();
    },
    async executeCodexResponsesViaOAuth() {
      executeCalled = true;
      throw new Error("executeCodexResponsesViaOAuth should not run");
    },
    async openCodexResponsesStreamViaOAuth() {
      streamCalled = true;
      throw new Error("openCodexResponsesStreamViaOAuth should not run");
    }
  });
  const req = createRawMockRequest('{"messages":[]}');
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Request body exceeds the 64 byte limit."
    }
  });
  assert.equal(executeCalled, false);
  assert.equal(streamCalled, false);
  assert.equal(res.locals.authAccountId, undefined);
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic count_tokens rejects oversized JSON without token usage", async () => {
  const helpers = createHelpers({
    async readRawBody() {
      throw createRequestBodyTooLargeError();
    }
  });
  const req = createRawMockRequest('{"messages":[]}', "/v1/messages/count_tokens");
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Request body exceeds the 64 byte limit."
    }
  });
  assert.equal(res.locals.tokenUsage, undefined);
});

test("Anthropic native response conversion normalizes malformed token usage", () => {
  const helpers = createHelpers();
  const message = helpers.buildAnthropicMessageFromResponsesResponse({
    status: "completed",
    usage: {
      input_tokens: -1,
      output_tokens: "2",
      total_tokens: "1e3"
    },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }]
      }
    ]
  });

  assert.deepEqual(message.usage, {
    input_tokens: 0,
    output_tokens: 2
  });

  const frames = helpers.renderAnthropicMessageSseEvents(message);
  assert.deepEqual(frames[0]?.data?.message?.usage, {
    input_tokens: 0,
    output_tokens: 0
  });
  assert.deepEqual(frames.find((frame) => frame.event === "message_delta")?.data?.usage, {
    output_tokens: 2
  });
});

test("Anthropic native non-stream normalizes malformed upstream error statuses", async () => {
  const helpers = createHelpers({
    async executeCodexResponsesViaOAuth() {
      const err = new Error("transport status malformed");
      err.statusCode = Symbol("status");
      throw err;
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "transport status malformed"
    }
  });
});

test("Anthropic native non-stream rejects fractional upstream error statuses", async () => {
  const helpers = createHelpers({
    async executeCodexResponsesViaOAuth() {
      const err = new Error("transport status fractional");
      err.statusCode = "401.9";
      throw err;
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "transport status fractional"
    }
  });
});

test("Anthropic native non-stream rejects decimal-form upstream error statuses", async () => {
  const helpers = createHelpers({
    async executeCodexResponsesViaOAuth() {
      const err = new Error("transport status decimal");
      err.statusCode = "401.0";
      throw err;
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "transport status decimal"
    }
  });
});

test("Anthropic native stream sends message_start before awaiting Codex completion", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
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

test("Anthropic native stream normalizes malformed terminal token usage", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
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
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":-1,"output_tokens":"2","total_tokens":"1e3"},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  const output = res.writes.join("");
  assert.match(output, /event: message_delta/);
  assert.match(output, /"output_tokens":2/);
  assert.deepEqual(res.locals.tokenUsage, {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});

test("Anthropic native stream ignores malformed idle timeout config", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    config: {
      anthropic: {
        defaultModel: "claude-sonnet-4.5"
      },
      codex: {
        defaultInstructions: "You are a helpful assistant."
      },
      upstreamStreamIdleTimeoutMs: Symbol("timeout")
    },
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
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
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  assert.equal(res.statusCode, 200);
  assert.match(res.writes.join(""), /event: message_stop/);
});

test("Anthropic native stream ignores decimal-form idle timeout config", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    config: {
      anthropic: {
        defaultModel: "claude-sonnet-4.5"
      },
      codex: {
        defaultInstructions: "You are a helpful assistant."
      },
      upstreamStreamIdleTimeoutMs: "1.0"
    },
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();
  await pending;

  assert.equal(res.statusCode, 200);
  assert.match(res.writes.join(""), /event: message_stop/);
});

test("Anthropic native stream falls back to JSON error when upstream fails before any delta", async () => {
  const upstream = createControllableReadableStream();
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: { body: upstream.stream },
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

test("Anthropic native stream normalizes malformed transport failure statuses", async () => {
  let failureArgs = null;
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth() {
      return {
        model: "claude-sonnet-4.5",
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
    model: "claude-sonnet-4.5",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(failureArgs, {
    message: "transport status malformed",
    statusCode: 502
  });
  assert.deepEqual(res.jsonPayload, {
    type: "error",
    error: {
      type: "api_error",
      message: "transport status malformed"
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
        upstream: createCompletedResponsesSseStream(),
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

test("Anthropic native non-stream forwards custom WebSearch and WebFetch as function tools", async () => {
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
    tool_choice: { type: "tool", name: "WebSearch" },
    tools: [
      {
        name: "WebSearch",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string" }
          }
        }
      },
      {
        name: "WebFetch",
        description: "Fetch a page",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" }
          }
        }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.deepEqual(captured?.tools, [
    {
      type: "function",
      name: "WebSearch",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        }
      }
    },
    {
      type: "function",
      name: "WebFetch",
      description: "Fetch a page",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" }
        }
      }
    }
  ]);
  assert.deepEqual(captured?.toolChoice, { type: "function", name: "WebSearch" });
  assert.equal(captured?.include, undefined);
  assert.equal(res.statusCode, 200);
});

test("Anthropic native stream keeps built-in web search on the native path", async () => {
  let captured = null;
  const helpers = createHelpers({
    async openCodexResponsesStreamViaOAuth(options) {
      captured = options;
      return {
        model: "claude-sonnet-4.5",
        authAccountId: "acct_123",
        upstream: createCompletedResponsesSseStream(),
        async markSuccess() {},
        async markFailure() {},
        release() {}
      };
    }
  });
  const req = createMockRequest({
    model: "claude-sonnet-4.5",
    stream: true,
    tools: [
      {
        type: "web_search_20250305",
        allowed_domains: ["example.com"],
        user_location: { type: "approximate", city: "Taipei" }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.deepEqual(captured?.tools, [
    {
      type: "web_search",
      filters: {
        allowed_domains: ["example.com"]
      },
      user_location: { type: "approximate", city: "Taipei" }
    }
  ]);
  assert.equal(captured?.toolChoice, "auto");
  assert.deepEqual(captured?.include, ["web_search_call.action.sources"]);
  assert.equal(res.statusCode, 200);
});

test("Anthropic native non-stream keeps mixed built-in and custom web tools split correctly", async () => {
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
    tool_choice: { type: "tool", name: "WebFetch" },
    tools: [
      {
        type: "web_search_20250305",
        blocked_domains: ["blocked.example"]
      },
      {
        name: "WebFetch",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" }
          }
        }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });
  const res = createMockResponse();

  await helpers.handleAnthropicNativeCompat(req, res);

  assert.deepEqual(captured?.tools, [
    {
      type: "web_search",
      filters: {
        blocked_domains: ["blocked.example"]
      }
    },
    {
      type: "function",
      name: "WebFetch",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" }
        }
      }
    }
  ]);
  assert.deepEqual(captured?.toolChoice, { type: "function", name: "WebFetch" });
  assert.deepEqual(captured?.include, ["web_search_call.action.sources"]);
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
