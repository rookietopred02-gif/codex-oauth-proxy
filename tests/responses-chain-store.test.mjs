import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesChainEntry,
  createResponsesChainStore,
  expandResponsesRequestBodyFromChain
} from "../src/responses-chain-store.js";

test("buildResponsesChainEntry preserves replayable input and output history", () => {
  const entry = buildResponsesChainEntry(
    {
      model: "gpt-5.2-codex",
      instructions: "test instructions",
      tools: [{ type: "function", name: "shell_exec" }],
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "scan the target" }]
        }
      ]
    },
    {
      id: "resp_1",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell_exec",
          arguments: "{\"command\":\"printf READY\"}"
        }
      ]
    }
  );

  assert.equal(entry.responseId, "resp_1");
  assert.equal(entry.requestDefaults.instructions, "test instructions");
  assert.equal(entry.inputHistory.length, 2);
  assert.equal(entry.inputHistory[0].role, "user");
  assert.equal(entry.inputHistory[1].type, "function_call");
});

test("expandResponsesRequestBodyFromChain appends the current delta and removes previous_response_id", () => {
  const expanded = expandResponsesRequestBodyFromChain(
    {
      model: "gpt-5.2-codex",
      previous_response_id: "resp_1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"stdout\":\"READY\"}"
        }
      ]
    },
    {
      responseId: "resp_1",
      requestDefaults: {
        instructions: "test instructions",
        tools: [{ type: "function", name: "shell_exec" }]
      },
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "scan the target" }]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell_exec",
          arguments: "{\"command\":\"printf READY\"}"
        }
      ]
    }
  );

  assert.equal(expanded.previous_response_id, undefined);
  assert.equal(expanded.instructions, "test instructions");
  assert.equal(expanded.tools.length, 1);
  assert.equal(expanded.input.length, 3);
  assert.equal(expanded.input[2].type, "function_call_output");
});

test("expandResponsesRequestBodyFromChain summarizes older raw tool exchanges", () => {
  const expanded = expandResponsesRequestBodyFromChain(
    {
      model: "gpt-5.2-codex",
      previous_response_id: "resp_2",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "what do the previous results mean?" }]
        }
      ]
    },
    {
      responseId: "resp_2",
      requestDefaults: {
        instructions: "test instructions",
        tools: [{ type: "function", name: "read_file" }]
      },
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "read the report" }]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: "{\"path\":\"nmap_22_80.txt\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"summary\":\"Read nmap_22_80.txt (24 bytes)\",\"content\":\"22/tcp open ssh\\n80/tcp open http\\n\"}"
        }
      ]
    }
  );

  assert.equal(expanded.previous_response_id, undefined);
  assert.equal(expanded.input.length, 3);
  assert.equal(expanded.input[1].role, "assistant");
  assert.match(expanded.input[1].content[0].text, /Previous tool results:/);
  assert.match(expanded.input[1].content[0].text, /22\/tcp open ssh/);
  assert.equal(expanded.input.some((item) => item.type === "function_call"), false);
  assert.equal(expanded.input.some((item) => item.type === "function_call_output"), false);
});

test("expandResponsesRequestBodyFromChain preserves only the current raw tool context", () => {
  const expanded = expandResponsesRequestBodyFromChain(
    {
      model: "gpt-5.2-codex",
      previous_response_id: "resp_3",
      input: [
        {
          type: "function_call_output",
          call_id: "call_current",
          output: "{\"stdout\":\"LATEST\"}"
        }
      ]
    },
    {
      responseId: "resp_3",
      requestDefaults: {
        instructions: "test instructions",
        tools: [{ type: "function", name: "shell_exec" }]
      },
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "run the first probe" }]
        },
        {
          type: "function_call",
          call_id: "call_old",
          name: "shell_exec",
          arguments: "{\"command\":\"printf OLD\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_old",
          output: "{\"summary\":\"exit=0 | stdout=OLD\"}"
        },
        {
          type: "function_call",
          call_id: "call_current",
          name: "shell_exec",
          arguments: "{\"command\":\"printf NEW\"}"
        }
      ]
    }
  );

  const functionCalls = expanded.input.filter((item) => item.type === "function_call");
  const functionOutputs = expanded.input.filter((item) => item.type === "function_call_output");
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].call_id, "call_current");
  assert.equal(functionOutputs.length, 1);
  assert.equal(functionOutputs[0].call_id, "call_current");
  assert.match(JSON.stringify(expanded.input), /Previous tool results:/);
  assert.doesNotMatch(JSON.stringify(expanded.input), /call_old/);
});

test("responses chain store remembers, refreshes, and forgets entries", () => {
  const store = createResponsesChainStore({ ttlMs: 10_000, maxEntries: 4 });
  store.remember({
    responseId: "resp_1",
    requestDefaults: { instructions: "test" },
    inputHistory: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  }, 1_000);

  const refreshed = store.lookup("resp_1", 2_000);
  assert.equal(refreshed.responseId, "resp_1");
  assert.equal(refreshed.updatedAt, 2_000);
  assert.equal(store.forget("resp_1"), true);
  assert.equal(store.lookup("resp_1", 3_000), null);
});
