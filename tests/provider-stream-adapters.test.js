import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  pipeAnthropicSseAsOpenAIChatCompletions,
  pipeGeminiSseAsOpenAIChatCompletions
} from "../src/http/provider-stream-adapters.js";

function createMockResponse() {
  const events = new EventEmitter();
  return {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    closed: false,
    statusCode: 200,
    writes: [],
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

function createAbortingReadableStream(error) {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
    }
  });
}

function createStalledReadableStream() {
  let cancelReason = null;
  return {
    stream: new ReadableStream({
      cancel(reason) {
        cancelReason = reason;
      }
    }),
    get cancelReason() {
      return cancelReason;
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Gemini provider SSE adapter streams deltas and final usage", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeGeminiSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapGeminiFinishReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]},"index":0}]}\n\n'
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(res.writes.join(""), /"role":"assistant"/);
  assert.match(res.writes.join(""), /"content":"hel"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}\n\n'
  );
  upstream.close();

  const result = await pending;
  const output = res.writes.join("");
  assert.match(output, /"content":"lo"/);
  assert.match(output, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("Gemini provider SSE adapter flushes deltas before delayed completion", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeGeminiSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapGeminiFinishReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"index":0}]}\n\n'
  );
  await delay(20);

  assert.match(res.writes.join(""), /"content":"partial"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"candidates":[{"content":{"parts":[{"text":"partial done"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}\n\n'
  );
  upstream.close();

  const result = await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("Gemini provider SSE adapter rejects malformed token usage counts", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeGeminiSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapGeminiFinishReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":-1,"candidatesTokenCount":"2","totalTokenCount":"1e3"}}\n\n'
  );
  upstream.close();

  const result = await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});

test("Gemini provider SSE adapter leaves headers uncommitted on early abort", async () => {
  const res = createMockResponse();
  const upstream = {
    body: createAbortingReadableStream(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
  };

  await assert.rejects(
    () =>
      pipeGeminiSseAsOpenAIChatCompletions(upstream, res, {
        model: "gpt-5.4",
        mapGeminiFinishReasonToOpenAI: () => "stop"
      }),
    /socket hang up/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

for (const { label, pipe, extraOptions } of [
  {
    label: "Gemini",
    pipe: pipeGeminiSseAsOpenAIChatCompletions,
    extraOptions: {
      mapGeminiFinishReasonToOpenAI: () => "stop"
    }
  },
  {
    label: "Anthropic",
    pipe: pipeAnthropicSseAsOpenAIChatCompletions,
    extraOptions: {
      mapAnthropicStopReasonToOpenAI: () => "stop"
    }
  }
]) {
  test(`${label} provider SSE adapter honors configured idle timeout`, async () => {
    const res = createMockResponse();
    const upstream = createStalledReadableStream();

    await assert.rejects(
      () =>
        pipe(
          { body: upstream.stream },
          res,
          {
            model: "gpt-5.4",
            upstreamStreamIdleTimeoutMs: 7,
            ...extraOptions
          }
        ),
      (err) => {
        assert.equal(err.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
        assert.match(err.message, /7ms/);
        return true;
      }
    );

    assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    assert.equal(res.headersSent, false);
    assert.deepEqual(res.writes, []);
  });
}

test("Anthropic provider SSE adapter streams reasoning and text", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeAnthropicSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapAnthropicStopReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}\n\n'
  );
  await new Promise((resolve) => setImmediate(resolve));

  const partial = res.writes.join("");
  assert.match(partial, /"reasoning_content":"plan"/);
  assert.match(partial, /"content":"done"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
  );
  upstream.enqueue('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  upstream.close();

  const result = await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("Anthropic provider SSE adapter flushes deltas before delayed message_stop", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeAnthropicSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapAnthropicStopReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
  );
  await delay(20);

  assert.match(res.writes.join(""), /"content":"partial"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
  );
  upstream.enqueue('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  upstream.close();

  const result = await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("Anthropic provider SSE adapter rejects malformed token usage counts", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeAnthropicSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapAnthropicStopReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":-1}}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"done"}}\n\n'
  );
  upstream.enqueue(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":"2"}}\n\n'
  );
  upstream.enqueue('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  upstream.close();

  const result = await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});

test("Anthropic provider SSE adapter maps tool use to OpenAI tool_calls", async () => {
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = pipeAnthropicSseAsOpenAIChatCompletions(
    { body: upstream.stream },
    res,
    {
      model: "gpt-5.4",
      mapAnthropicStopReasonToOpenAI: () => "stop"
    }
  );

  upstream.enqueue(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"weather","input":{}}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Tai"}}\n\n'
  );
  upstream.enqueue(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"pei\\"}"}}\n\n'
  );
  upstream.enqueue(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n'
  );
  upstream.enqueue('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  upstream.close();

  const result = await pending;
  const output = res.writes.join("");
  assert.match(output, /"tool_calls"/);
  assert.match(output, /"name":"weather"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.match(output, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});
