import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createOpenAIChatCompletionStreamEmitter } from "../src/protocols/openai/chat-stream-emitter.js";

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
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {},
    flushHeaders() {},
    flush() {},
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

test("chat stream emitter fallback rejects malformed token usage counts", () => {
  const res = createMockResponse();
  const emitter = createOpenAIChatCompletionStreamEmitter({
    res,
    model: "gpt-5.4",
    heartbeatMs: 0,
    mapResponsesStatusToChatFinishReason: () => "stop",
    extractAssistantTextFromResponse: () => "done",
    extractAssistantToolCallsFromResponse: () => []
  });

  emitter.emitEvent({
    type: "response.completed",
    response: {
      id: "resp_bad_usage",
      status: "completed",
      usage: {
        input_tokens: -1,
        output_tokens: "2",
        total_tokens: "1e3"
      }
    }
  });

  assert.match(res.writes.join(""), /\[DONE\]/);
  assert.deepEqual(emitter.getUsage(), {
    prompt_tokens: 0,
    completion_tokens: 2,
    total_tokens: 2
  });
});
