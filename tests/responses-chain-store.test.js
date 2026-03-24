import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesChainEntry,
  expandResponsesRequestBodyFromChain
} from "../src/responses-chain-store.js";

test("responses chain replay preserves exact tool outputs across turns", () => {
  const toolOutput = JSON.stringify({ content: "A".repeat(500) });
  const request1 = {
    model: "gpt-5.4",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Fix the file." }]
      }
    ]
  };
  const response1 = {
    id: "resp_1",
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.txt"}'
      }
    ]
  };

  const entry1 = buildResponsesChainEntry(request1, response1);
  const request2 = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: toolOutput }]
    },
    entry1
  );

  assert.deepEqual(request2.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Fix the file." }]
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}'
    },
    { type: "function_call_output", call_id: "call_1", output: toolOutput }
  ]);

  const response2 = {
    id: "resp_2",
    output: [
      {
        type: "function_call",
        call_id: "call_2",
        name: "edit_file",
        arguments: '{"path":"a.txt","old_string":"AAA","new_string":"BBB"}'
      }
    ]
  };
  const entry2 = buildResponsesChainEntry(request2, response2);
  const request3 = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_2",
      input: [{ type: "function_call_output", call_id: "call_2", output: '{"ok":true}' }]
    },
    entry2
  );

  assert.equal(
    request3.input.find((item) => item.type === "function_call_output" && item.call_id === "call_1")?.output,
    toolOutput
  );
  assert.deepEqual(
    request3.input
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id),
    ["call_1", "call_2"]
  );
  assert.equal(
    request3.input.some(
      (item) =>
        item.role === "assistant" &&
        Array.isArray(item.content) &&
        item.content.some((block) => typeof block?.text === "string" && block.text.includes("Previous tool results"))
    ),
    false
  );
});
