import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";
import {
  RESPONSES_FAILURE_TERMINAL_EVENT_TYPES,
  RESPONSES_SUCCESS_TERMINAL_EVENT_TYPES
} from "../src/protocols/openai/responses-contract.js";

const responsesEventContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-events.json", import.meta.url), "utf8")
);

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
