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

test("responses chain replay does not duplicate already-expanded history prefixes", () => {
  const priorEntry = {
    responseId: "resp_existing",
    inputHistory: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Create the debug file." }]
      },
      {
        type: "function_call",
        call_id: "call_read",
        name: "read_file",
        arguments: "{\"path\":\"debug_camoufox_test.go\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_read",
        output: "{\"content\":\"package main\"}"
      }
    ]
  };

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_existing",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Create the debug file." }]
        },
        {
          type: "function_call",
          call_id: "call_read",
          name: "read_file",
          arguments: "{\"path\":\"debug_camoufox_test.go\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_read",
          output: "{\"content\":\"package main\"}"
        },
        {
          type: "function_call",
          call_id: "call_edit",
          name: "apply_patch",
          arguments: "{\"patch\":\"*** Begin Patch\"}"
        }
      ]
    },
    priorEntry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Create the debug file." }]
    },
    {
      type: "function_call",
      call_id: "call_read",
      name: "read_file",
      arguments: "{\"path\":\"debug_camoufox_test.go\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_read",
      output: "{\"content\":\"package main\"}"
    },
    {
      type: "function_call",
      call_id: "call_edit",
      name: "apply_patch",
      arguments: "{\"patch\":\"*** Begin Patch\"}"
    }
  ]);
});

test("responses chain replay preserves reasoning items untouched", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Use the prior reasoning." }]
        }
      ]
    },
    {
      id: "resp_reasoning",
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          encrypted_content: "enc_123",
          summary: [{ type: "summary_text", text: "first pass" }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_reasoning",
      input: [{ type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" }]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Use the prior reasoning." }]
    },
    {
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "enc_123",
      summary: [{ type: "summary_text", text: "first pass" }]
    },
    { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" }
  ]);
});

test("responses chain replay does not inherit prior request defaults", () => {
  const entry = buildResponsesChainEntry(
    {
      model: "gpt-5.4",
      instructions: "First turn instructions",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "First turn." }]
        }
      ]
    },
    {
      id: "resp_defaults",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_defaults",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Second turn." }]
        }
      ]
    },
    entry
  );

  assert.equal(Object.hasOwn(expanded, "instructions"), false);
  assert.equal(expanded.previous_response_id, undefined);
  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "First turn." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Second turn." }]
    }
  ]);
});
