import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";

function createHelpers() {
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

function createMockResponse() {
  const events = new EventEmitter();

  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    closed: false,
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
      this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
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

function createAbortingReadableStream(error) {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
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
    },
    error(err) {
      controllerRef.error(err);
    }
  };
}

function createRejectingReaderUpstream(error) {
  return {
    body: {
      getReader() {
        return {
          async read() {
            throw error;
          },
          async cancel() {}
        };
      }
    }
  };
}

test("pipeCodexSseAsChatCompletions leaves headers uncommitted on early upstream failure", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n'
    ])
  };

  await assert.rejects(
    () => helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4"),
    /boom/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

test("pipeSseAndCaptureTokenUsage does not arm heartbeats before the first upstream chunk", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.close();
      }
    })
  };

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let intervalCalls = 0;

  global.setInterval = ((handler, timeout, ...args) => {
    intervalCalls += 1;
    return { handler, timeout, args, unref() {} };
  });
  global.clearInterval = (() => {});

  try {
    const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);
    assert.deepEqual(result, { completed: null, usage: null });
    assert.equal(intervalCalls, 0);
    assert.deepEqual(res.writes, []);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test("pipeSseAndCaptureTokenUsage returns the completed response for raw responses streams", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeSseAndCaptureTokenUsage({ body: upstream.stream }, res);
  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n');
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  );
  upstream.close();

  const result = await pending;
  assert.equal(result.completed?.id, "resp_123");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
  assert.equal(res.headersSent, true);
  assert.equal(res.writes.length > 0, true);
});

test("pipeSseAndCaptureTokenUsage rejects pre-body upstream aborts", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createAbortingReadableStream(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
  };

  await assert.rejects(
    () => helpers.pipeSseAndCaptureTokenUsage(upstream, res),
    /socket hang up/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

test("pipeCodexSseAsChatCompletions rejects pre-body upstream aborts without emitting done", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createAbortingReadableStream(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
  };

  await assert.rejects(
    () => helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4"),
    /socket hang up/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

test("pipeSseAndCaptureTokenUsage rejects early upstream aborts before sending headers", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createRejectingReaderUpstream(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

  await assert.rejects(
    () => helpers.pipeSseAndCaptureTokenUsage(upstream, res),
    /socket hang up/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

test("pipeCodexSseAsChatCompletions rejects early upstream aborts before emitting success chunks", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createRejectingReaderUpstream(Object.assign(new Error("upstream aborted"), { code: "UND_ERR_ABORTED" }));

  await assert.rejects(
    () => helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4"),
    /upstream aborted/
  );

  assert.equal(res.headersSent, false);
  assert.deepEqual(res.writes, []);
});

test("pipeCodexSseAsChatCompletions streams text deltas before response.completed", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));

  const partialOutput = res.writes.join("");
  assert.match(partialOutput, /"role":"assistant"/);
  assert.match(partialOutput, /"content":"hel"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  );
  upstream.close();

  const result = await pending;
  const finalOutput = res.writes.join("");
  assert.match(finalOutput, /"content":"lo"/);
  assert.match(finalOutput, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("pipeCodexSseAsChatCompletions emits reasoning progress before final text", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  upstream.enqueue(
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"step 1"}\n\n'
  );
  await new Promise((resolve) => setImmediate(resolve));

  const partialOutput = res.writes.join("");
  assert.match(partialOutput, /"role":"assistant"/);
  assert.match(partialOutput, /"reasoning_content":"step 1"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
  );
  upstream.close();

  await pending;
  const finalOutput = res.writes.join("");
  assert.match(finalOutput, /"content":"done"/);
  assert.match(finalOutput, /\[DONE\]/);
});

test("pipeCodexSseAsChatCompletions rejects truncated streams after partial output", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"partial"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  upstream.close();

  await assert.rejects(
    () => pending,
    /Upstream SSE ended before response.completed event/
  );

  const output = res.writes.join("");
  assert.match(output, /"content":"partial"/);
  assert.doesNotMatch(output, /\[DONE\]/);
});

test("pipeCodexSseAsChatCompletions parses SSE events split across reader chunks", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"he');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(res.writes, []);

  upstream.enqueue('llo"}\n\n');
  await new Promise((resolve) => setImmediate(resolve));

  const partialOutput = res.writes.join("");
  assert.match(partialOutput, /"content":"hello"/);
  assert.equal(res.writableEnded, false);

  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  );
  upstream.close();

  await pending;
  assert.match(res.writes.join(""), /\[DONE\]/);
});
