import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";
import {
  RESPONSES_FAILURE_TERMINAL_EVENT_TYPES,
  RESPONSES_SUCCESS_TERMINAL_EVENT_TYPES
} from "../src/protocols/openai/responses-contract.js";
import {
  buildResponsesFailureResult,
  normalizeResponsesUsageObject
} from "../src/protocols/openai/responses-sse-state.js";

const responsesEventContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-events.json", import.meta.url), "utf8")
);

function getGroupedResponsesEventTypes() {
  return new Set([
    ...responsesEventContract.terminal_events.success.map((entry) => entry.type),
    ...responsesEventContract.terminal_events.failure,
    ...Object.values(responsesEventContract.text_events),
    ...responsesEventContract.content_part_events,
    ...responsesEventContract.annotation_events,
    ...responsesEventContract.reasoning_events,
    ...responsesEventContract.refusal_events,
    ...responsesEventContract.function_events
  ]);
}

function createHelpers(overrides = {}) {
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
    },
    ...overrides
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
      this.writes.push(Buffer.from(chunk).toString("utf8"));
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

function createDelayedReadableStreamFromTextChunks(chunks, delayMs = 30) {
  const encoder = new TextEncoder();
  let emittedCount = 0;
  let timer = null;

  return {
    stream: new ReadableStream({
      start(controller) {
        const emitNext = () => {
          if (emittedCount >= chunks.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunks[emittedCount]));
          emittedCount += 1;
          timer = setTimeout(emitNext, delayMs);
          timer.unref?.();
        };
        emitNext();
      },
      cancel() {
        if (timer) clearTimeout(timer);
      }
    }),
    get emittedCount() {
      return emittedCount;
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

function collectChatDeltaContent(writes) {
  let text = "";
  let reasoning = "";
  const toolArguments = [];

  for (const chunk of writes) {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta || {};
      if (typeof delta.content === "string") {
        text += delta.content;
      }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          const index = Number(toolCall?.index || 0);
          const nextArguments = typeof toolCall?.function?.arguments === "string" ? toolCall.function.arguments : "";
          toolArguments[index] = `${toolArguments[index] || ""}${nextArguments}`;
        }
      }
    }
  }

  return { text, reasoning, toolArguments };
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.equal(predicate(), true);
}

test("Responses event fixture matches the runtime terminal event contract", () => {
  assert.deepEqual(
    responsesEventContract.terminal_events.success.map((entry) => entry.type),
    RESPONSES_SUCCESS_TERMINAL_EVENT_TYPES
  );
  assert.deepEqual(
    responsesEventContract.terminal_events.failure,
    RESPONSES_FAILURE_TERMINAL_EVENT_TYPES
  );
});

test("Responses event fixture keeps grouped events covered by official or local compatibility inventory", () => {
  const officialStreamEvents = new Set(responsesEventContract.official_stream_events);
  const localCompatibilityEvents = new Set(responsesEventContract.local_compatibility_events);

  for (const eventType of getGroupedResponsesEventTypes()) {
    assert.equal(
      officialStreamEvents.has(eventType) || localCompatibilityEvents.has(eventType),
      true,
      `expected ${eventType} to be listed as an official or local compatibility Responses event`
    );
  }
});

test("Responses event fixture tracks current official stream event families", () => {
  const officialStreamEvents = responsesEventContract.official_stream_events;

  assert.deepEqual(officialStreamEvents, [...officialStreamEvents].sort());
  assert.equal(new Set(officialStreamEvents).size, officialStreamEvents.length);

  for (const eventType of [
    "response.audio.delta",
    "response.code_interpreter_call_code.delta",
    "response.created",
    "response.custom_tool_call_input.delta",
    "response.file_search_call.searching",
    "response.image_generation_call.partial_image",
    "response.mcp_call_arguments.delta",
    "response.output_item.done",
    "response.queued",
    "response.web_search_call.searching"
  ]) {
    assert.equal(
      officialStreamEvents.includes(eventType),
      true,
      `expected current official Responses stream event inventory to include ${eventType}`
    );
  }

  assert.equal(officialStreamEvents.includes("response.done"), false);
  assert.deepEqual(responsesEventContract.local_compatibility_events, ["response.done"]);
});

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

test("pipeCodexSseAsChatCompletions ignores malformed idle timeout config", async () => {
  const helpers = createHelpers({
    upstreamStreamIdleTimeoutMs: Symbol("timeout")
  });
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_timeout","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");

  assert.match(res.writes.join(""), /"content":"hi"/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("pipeCodexSseAsChatCompletions ignores decimal-form idle timeout config", async () => {
  const helpers = createHelpers({
    upstreamStreamIdleTimeoutMs: "1.0"
  });
  const res = createMockResponse();
  const upstream = createDelayedReadableStreamFromTextChunks(
    [
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_timeout_decimal","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}}\n\n'
    ],
    10
  );

  const result = await helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  assert.equal(collectChatDeltaContent(res.writes).text, "hi");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

for (const { label, methodName } of [
  { label: "raw passthrough", methodName: "pipeSseAndCaptureTokenUsage" },
  { label: "event bridge", methodName: "pipeCodexSse" }
]) {
  test(`${methodName} honors configured idle timeout for ${label} streams`, async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const helpers = createHelpers({
      upstreamStreamIdleTimeoutMs: 7
    });
    const res = createMockResponse();
    const delays = [];
    let cancelReason = null;
    const reader = {
      read() {
        return new Promise(() => {});
      },
      async cancel(reason) {
        cancelReason = reason;
      },
      releaseLock() {}
    };
    const upstream = {
      body: {
        getReader() {
          return reader;
        }
      }
    };

    globalThis.setTimeout = (callback, delay) => {
      delays.push(delay);
      queueMicrotask(callback);
      return { unref() {} };
    };
    globalThis.clearTimeout = () => {};

    try {
      await assert.rejects(
        () => helpers[methodName](upstream, res),
        (err) => {
          assert.equal(err.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
          assert.match(err.message, /7ms/);
          return true;
        }
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    assert.deepEqual(delays, [7]);
    assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
  });
}

test("parseResponsesResultFromSse treats error as a failure terminal event", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    'data: {"type":"error","error":{"code":"server_error","message":"upstream exploded"}}\n\n'
  );

  assert.equal(parsed.completed, null);
  assert.deepEqual(parsed.failed, {
    code: "server_error",
    message: "upstream exploded",
    statusCode: 502
  });
});

test("Responses SSE failure results tolerate malformed status metadata", () => {
  const throwingStatus = {
    valueOf() {
      throw new Error("status should not be coerced");
    },
    toString() {
      throw new Error("status should not be stringified");
    }
  };

  assert.deepEqual(
    buildResponsesFailureResult({
      response: {
        error: {
          code: "bad_status",
          message: "upstream failed",
          status_code: throwingStatus
        }
      }
    }),
    {
      code: "bad_status",
      message: "upstream failed",
      statusCode: 502
    }
  );

  assert.deepEqual(
    buildResponsesFailureResult({
      error: {
        code: "rate_limited",
        message: "slow down",
        status_code: "429"
      }
    }),
    {
      code: "rate_limited",
      message: "slow down",
      statusCode: 429
    }
  );
});

test("Responses SSE usage normalization tolerates malformed normalized counts", () => {
  const throwingTokenCount = {
    valueOf() {
      throw new Error("token count should not be coerced");
    },
    toString() {
      throw new Error("token count should not be stringified");
    }
  };

  assert.deepEqual(
    normalizeResponsesUsageObject({}, () => ({
      inputTokens: Symbol("input"),
      outputTokens: "2",
      totalTokens: throwingTokenCount,
      cachedInputTokens: "3"
    })),
    {
      input_tokens: 0,
      output_tokens: 2,
      total_tokens: 0,
      input_tokens_details: {
        cached_tokens: 3
      }
    }
  );
});

test("parseResponsesResultFromSse preserves streamed function calls when response.completed output is empty", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":\\"REA"}',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"README.md\\"}"}',
      'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.equal(parsed.completed?.id, "resp_stream");
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}'
    }
  ]);
});

test("parseResponsesResultFromSse preserves streamed annotations and web_search_call items when response.completed output is empty", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"response.content_part.added","item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":"Look"}}',
      'data: {"type":"response.output_text.annotation.added","item_id":"msg_1","content_index":0,"annotation":{"type":"url_citation","title":"Docs","url":"https://example.test/docs"}}',
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_stream_annotations","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.equal(parsed.completed?.id, "resp_stream_annotations");
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Look",
          annotations: [
            {
              type: "url_citation",
              title: "Docs",
              url: "https://example.test/docs"
            }
          ]
        }
      ]
    },
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse applies web_search_call status events to streamed output items", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.web_search_call.completed","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_status","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse keeps web_search_call terminal status when item details arrive later", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.web_search_call.completed","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_status_late_item","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse merges indexed web_search_call placeholders with later item details", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.web_search_call.searching","output_index":0}',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_indexed_placeholder","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse keeps nonzero web_search_call placeholders in output order", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.web_search_call.searching","output_index":1}',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Before search.","annotations":[]}]}}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_nonzero_indexed_placeholder","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Before search.",
          annotations: []
        }
      ]
    },
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse preserves streamed web_search_call sources when terminal output is partial", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_terminal_partial","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"query":"latest docs"}}]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse preserves streamed web_search_call sources when terminal output reports none", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_terminal_empty_sources","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"query":"latest docs","sources":[]}}]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

test("parseResponsesResultFromSse ignores stale web_search_call progress events after completion", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_stale_progress","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        query: "latest docs",
        sources: [
          {
            type: "url",
            title: "Docs",
            url: "https://example.test/docs"
          }
        ]
      }
    }
  ]);
});

for (const status of ["failed", "incomplete"]) {
  test(`parseResponsesResultFromSse keeps late web_search_call ${status} status after searching`, () => {
    const helpers = createHelpers();
    const parsed = helpers.parseResponsesResultFromSse(
      [
        'data: {"type":"response.web_search_call.searching","item_id":"ws_1","output_index":0}',
        `data: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"${status}","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}`,
        `data: {"type":"response.completed","response":{"id":"resp_web_search_${status}","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}`
      ].join("\n\n") + "\n\n"
    );

    assert.equal(parsed.failed, null);
    assert.deepEqual(parsed.completed?.output, [
      {
        id: "ws_1",
        type: "web_search_call",
        status,
        action: {
          query: "latest docs",
          sources: [
            {
              type: "url",
              title: "Docs",
              url: "https://example.test/docs"
            }
          ]
        }
      }
    ]);
  });
}

test("parseResponsesResultFromSse preserves assistant message phase from streamed output items", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"msg_commentary","type":"message","role":"assistant","status":"completed","phase":"commentary","content":[{"type":"output_text","text":"Thinking through the approach."}]}}',
      'data: {"type":"response.completed","response":{"id":"resp_stream_phase","status":"completed","output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "msg_commentary",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "Thinking through the approach." }]
    }
  ]);
});

test("parseResponsesResultFromSse preserves reasoning summary parts when response.completed output is empty", () => {
  const helpers = createHelpers();
  const parsed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","summary":[],"content":[]}}',
      'data: {"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0,"part":{"type":"summary_text","text":"seed"}}',
      'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":" detail"}',
      'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_1","summary_index":0,"text":"seed detail"}',
      'data: {"type":"response.completed","response":{"id":"resp_stream_reasoning","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.equal(parsed.completed?.id, "resp_stream_reasoning");
  assert.deepEqual(parsed.completed?.output, [
    {
      id: "rs_1",
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "seed detail"
        }
      ],
      content: []
    }
  ]);
});

test("parseResponsesResultFromSse preserves newer official built-in tool output items when response.completed output is empty", () => {
  const helpers = createHelpers();
  const streamedItems = [
    { id: "fs_1", type: "file_search_call", status: "completed", queries: ["latest spec"] },
    { id: "ci_1", type: "code_interpreter_call", status: "completed", code: "print('hi')" },
    { id: "ig_1", type: "image_generation_call", status: "completed", result: { file_id: "file_img" } },
    { id: "sh_1", type: "shell_call", call_id: "call_shell", status: "completed" },
    { id: "cp_1", type: "computer_call", call_id: "call_computer", status: "completed" },
    { id: "mcp_1", type: "mcp_call", call_id: "call_mcp", name: "list_docs", arguments: "{}" },
    { id: "ct_1", type: "custom_tool_call", call_id: "call_custom", name: "internal_tool", input: "{}" }
  ];
  const parsed = helpers.parseResponsesResultFromSse(
    [
      ...streamedItems.map((item) => `data: ${JSON.stringify({ type: "response.output_item.added", item })}`),
      'data: {"type":"response.completed","response":{"id":"resp_stream_builtin_items","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}'
    ].join("\n\n") + "\n\n"
  );

  assert.equal(parsed.failed, null);
  assert.equal(parsed.completed?.id, "resp_stream_builtin_items");
  assert.deepEqual(parsed.completed?.output, streamedItems);
});

test("pipeSseAndCaptureTokenUsage accepts error as a terminal failure event", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"error","error":{"code":"server_error","message":"upstream exploded"}}\n\n'
    ])
  };

  const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);

  assert.equal(result.completed, null);
  assert.deepEqual(result.failed, {
    code: "server_error",
    message: "upstream exploded",
    statusCode: 502
  });
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
    await assert.rejects(
      () => helpers.pipeSseAndCaptureTokenUsage(upstream, res),
      /Upstream SSE ended before a terminal response event/
    );
    assert.equal(intervalCalls, 0);
    assert.deepEqual(res.writes, []);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test("pipeSseAndCaptureTokenUsage returns merged completed output when terminal response omits streamed items", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file"}}\n\n',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"README.md\\"}"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[]}}\n\n'
    ])
  };

  const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);

  assert.equal(result.failed, null);
  assert.equal(result.completed?.id, "resp_stream");
  assert.deepEqual(result.completed?.output, [
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}'
    }
  ]);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
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

test("pipeSseAndCaptureTokenUsage flushes delayed raw response chunks before completion", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createDelayedReadableStreamFromTextChunks(
    [
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_delayed_raw","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
    ],
    40
  );

  const pending = helpers.pipeSseAndCaptureTokenUsage({ body: upstream.stream }, res);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(upstream.emittedCount, 1);
  assert.match(res.writes.join(""), /response\.output_text\.delta/);
  assert.match(res.writes.join(""), /"delta":"hel"/);
  assert.equal(res.writableEnded, false);

  const result = await pending;
  assert.equal(result.completed?.id, "resp_delayed_raw");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("pipeSseAndCaptureTokenUsage ignores duplicated terminal SSE events", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const completedEvent =
    'data: {"type":"response.completed","response":{"id":"resp_dup","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n';
  const upstream = {
    body: createReadableStreamFromTextChunks([
      completedEvent,
      completedEvent
    ])
  };

  const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);

  assert.equal(result.completed?.id, "resp_dup");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
  assert.equal(
    res.writes.filter((chunk) => chunk.includes('"type":"response.completed"')).length,
    2
  );
});

test("pipeSseAndCaptureTokenUsage accepts response.incomplete as a terminal event", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete","status":"incomplete","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);

  assert.equal(result.failed, null);
  assert.equal(result.completed?.id, "resp_incomplete");
  assert.equal(result.completed?.status, "incomplete");
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

for (const scenario of responsesEventContract.terminal_events.success) {
  test(`parseResponsesResultFromSse accepts ${scenario.type} as a success terminal`, () => {
    const helpers = createHelpers();
    const parsed = helpers.parseResponsesResultFromSse(
      `data: ${JSON.stringify({
        type: scenario.type,
        response: {
          id: "resp_terminal",
          status: scenario.response_status,
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }
      })}\n\n`
    );

    assert.equal(parsed.failed, null);
    assert.equal(parsed.completed?.id, "resp_terminal");
    assert.equal(parsed.completed?.status, scenario.response_status);
  });
}

test("pipeSseAndCaptureTokenUsage captures response.done as a terminal event", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.done","response":{"id":"resp_done","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeSseAndCaptureTokenUsage(upstream, res);

  assert.equal(result.failed, null);
  assert.equal(result.completed?.id, "resp_done");
  assert.equal(result.completed?.status, "completed");
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
  const deltas = collectChatDeltaContent(res.writes);
  assert.equal(deltas.text, "hello");
  assert.match(finalOutput, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3
  });
});

test("pipeCodexSseAsChatCompletions flushes delayed stream deltas before completion", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createDelayedReadableStreamFromTextChunks(
    [
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
    ],
    50
  );

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  await waitFor(() => res.writes.join("").includes('"content":"hel"'));

  assert.equal(upstream.emittedCount, 1);
  assert.equal(res.writableEnded, false);
  assert.doesNotMatch(res.writes.join(""), /\[DONE\]/);

  await pending;

  assert.equal(collectChatDeltaContent(res.writes).text, "hello");
  assert.match(res.writes.join(""), /\[DONE\]/);
});

test("pipeCodexSseAsChatCompletions treats output_text.done as the final text value", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = createControllableReadableStream();

  const pending = helpers.pipeCodexSseAsChatCompletions({ body: upstream.stream }, res, "gpt-5.4");

  upstream.enqueue('data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"hel"}\n\n');
  upstream.enqueue('data: {"type":"response.output_text.done","item_id":"msg_1","content_index":0,"text":"hello"}\n\n');
  upstream.enqueue(
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
  );
  upstream.close();

  await pending;

  const deltas = collectChatDeltaContent(res.writes);
  assert.equal(deltas.text, "hello");
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
  const deltas = collectChatDeltaContent(res.writes);
  assert.equal(deltas.reasoning, "step 1");
  assert.equal(deltas.text, "done");
  assert.match(finalOutput, /\[DONE\]/);
});

test("pipeCodexSseAsChatCompletions emits reasoning_text deltas", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","summary":[],"content":[]}}\n\n',
      'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","output_index":0,"content_index":0,"delta":"think"}\n\n',
      'data: {"type":"response.reasoning_text.done","item_id":"rs_1","output_index":0,"content_index":0,"text":"thinking"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"rs_1","type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"thinking"}]},{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    ])
  };

  await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");

  const deltas = collectChatDeltaContent(res.writes);
  assert.equal(deltas.reasoning, "thinking");
  assert.equal(deltas.text, "done");
});

test("pipeCodexSseAsChatCompletions finalizes response.incomplete with finish_reason length", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"part"}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");
  const output = res.writes.join("");
  const deltas = collectChatDeltaContent(res.writes);

  assert.equal(deltas.text, "partial");
  assert.match(output, /"finish_reason":"length"/);
  assert.match(output, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2
  });
});

test("pipeCodexSseAsChatCompletions finalizes response.done with finish_reason stop", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"done"}\n\n',
      'data: {"type":"response.done","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");
  const output = res.writes.join("");
  const deltas = collectChatDeltaContent(res.writes);

  assert.equal(deltas.text, "done");
  assert.match(output, /"finish_reason":"stop"/);
  assert.match(output, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2
  });
});

test("pipeCodexSseAsChatCompletions emits the missing function arguments suffix on done", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"tool"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"a\\""}\n\n',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"a\\":1}"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"tool","arguments":"{\\"a\\":1}"}]}}\n\n'
    ])
  };

  await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");

  const deltas = collectChatDeltaContent(res.writes);
  assert.deepEqual(deltas.toolArguments, ['{"a":1}']);
});

test("pipeCodexSseAsChatCompletions maps refusal deltas to chat text chunks", async () => {
  const helpers = createHelpers();
  const res = createMockResponse();
  const upstream = {
    body: createReadableStreamFromTextChunks([
      'data: {"type":"response.output_item.added","item":{"id":"msg_ref","type":"message","role":"assistant","content":[]}}\n\n',
      'data: {"type":"response.content_part.added","item_id":"msg_ref","output_index":0,"content_index":0,"part":{"type":"refusal","refusal":""}}\n\n',
      'data: {"type":"response.refusal.delta","item_id":"msg_ref","output_index":0,"content_index":0,"delta":"No"}\n\n',
      'data: {"type":"response.refusal.done","item_id":"msg_ref","output_index":0,"content_index":0,"refusal":"Nope"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"id":"msg_ref","type":"message","role":"assistant","status":"completed","content":[{"type":"refusal","refusal":"Nope"}]}]}}\n\n'
    ])
  };

  const result = await helpers.pipeCodexSseAsChatCompletions(upstream, res, "gpt-5.4");
  const output = res.writes.join("");
  const deltas = collectChatDeltaContent(res.writes);

  assert.equal(deltas.text, "Nope");
  assert.match(output, /"content":"No"/);
  assert.match(output, /"finish_reason":"stop"/);
  assert.match(output, /\[DONE\]/);
  assert.deepEqual(result.usage, {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2
  });
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
    /Upstream SSE ended before a terminal response event/
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

test("convertResponsesToChatCompletion flattens refusal into content text", () => {
  const helpers = createHelpers();
  const response = {
    id: "resp_refusal",
    status: "completed",
    output: [
      {
        id: "msg_ref",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "refusal",
            refusal: "Policy says no."
          }
        ]
      },
      {
        id: "msg_text",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Annotated text",
            annotations: [{ type: "file_citation", file_id: "file_1", filename: "x.txt", index: 0 }]
          }
        ]
      }
    ],
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      total_tokens: 5
    }
  };

  const converted = helpers.convertResponsesToChatCompletion(response);
  assert.equal(converted.choices[0].message.content, "Policy says no.Annotated text");
  assert.equal(Object.hasOwn(converted.choices[0].message, "refusal"), false);
  assert.deepEqual(converted.choices[0].message.annotations, [
    { type: "file_citation", file_id: "file_1", filename: "x.txt", index: 0 }
  ]);
});

test("convertResponsesToChatCompletion rejects malformed token usage counts", () => {
  const helpers = createHelpers();
  const converted = helpers.convertResponsesToChatCompletion({
    id: "resp_bad_usage",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }]
      }
    ],
    usage: {
      input_tokens: -1,
      output_tokens: "2",
      total_tokens: "1e3"
    }
  });

  assert.deepEqual(converted.usage, {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});
