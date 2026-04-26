import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";
import {
  buildResponsesChainEntry,
  expandResponsesRequestBodyFromChain
} from "../src/responses-chain-store.js";

function createResponsesHelpers() {
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

test("responses chain replay keeps streamed function calls even when terminal completion output is empty", () => {
  const helpers = createResponsesHelpers();
  const completed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"read_file"}}',
      'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"README.md\\"}"}',
      'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","output":[]}}'
    ].join("\n\n") + "\n\n"
  ).completed;

  const entry = buildResponsesChainEntry(
    {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Read the file." }]
        }
      ]
    },
    completed
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_stream",
      input: [{ type: "function_call_output", call_id: "call_1", output: '{"content":"hello"}' }]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Read the file." }]
    },
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}'
    },
    { type: "function_call_output", call_id: "call_1", output: '{"content":"hello"}' }
  ]);
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

test("responses chain replay does not carry over prior developer or system messages", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "You are in Plan Mode." }]
        },
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "Use request_user_input." }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    {
      id: "resp_plan_mode",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Working on it." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_mode",
      instructions: "New turn instructions",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Next turn." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Working on it." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Next turn." }]
    }
  ]);
  assert.equal(expanded.instructions, "New turn instructions");
});

test("responses chain replay preserves current developer and system messages during continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Old developer instructions." }]
        },
        {
          role: "system",
          content: [{ type: "input_text", text: "Old system instructions." }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    {
      id: "resp_current_turn_instructions",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Working on it." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_current_turn_instructions",
      messages: [
        {
          role: "developer",
          content: "Use the explicit developer instructions for this turn."
        },
        {
          role: "system",
          content: "Keep the current system guidance."
        },
        {
          role: "user",
          content: "Next turn."
        }
      ]
    },
    entry
  );

  assert.equal(Object.hasOwn(expanded, "messages"), false);
  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Working on it." }]
    },
    {
      role: "developer",
      content: "Use the explicit developer instructions for this turn."
    },
    {
      role: "system",
      content: "Keep the current system guidance."
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Next turn." }]
    }
  ]);
});

test("responses chain replay preserves explicit collaboration mode across previous_response_id continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      collaborationMode: "plan",
      settings: {
        developer_instructions: null
      },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan the change." }]
        }
      ]
    },
    {
      id: "resp_plan_chain",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Plan drafted." }],
          phase: "final_answer"
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_chain",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    entry
  );

  assert.equal(expanded.collaborationMode, "plan");
  assert.equal(expanded.settings?.developer_instructions, null);
});

test("responses chain replay does not let prior mode-default instructions override current explicit instructions", () => {
  const entry = buildResponsesChainEntry(
    {
      collaborationMode: "plan",
      settings: {
        developer_instructions: null
      },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan the change." }]
        }
      ]
    },
    {
      id: "resp_plan_chain_with_default_instructions",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Plan drafted." }],
          phase: "final_answer"
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_chain_with_default_instructions",
      instructions: "Use normal execution instructions.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    entry
  );

  assert.equal(expanded.instructions, "Use normal execution instructions.");
  assert.equal(expanded.settings?.developer_instructions, undefined);
});

test("responses chain replay preserves explicit settings.developer_instructions during continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      collaborationMode: "plan",
      settings: {
        developer_instructions: null
      },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan the change." }]
        }
      ]
    },
    {
      id: "resp_plan_chain_with_explicit_setting",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Plan drafted." }],
          phase: "final_answer"
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_chain_with_explicit_setting",
      settings: {
        developer_instructions: "Use the explicit developer instructions for this turn."
      },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    entry
  );

  assert.equal(expanded.settings?.developer_instructions, "Use the explicit developer instructions for this turn.");
});

test("responses chain replay drops prior assistant commentary items by phase", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Ship the release." }]
        }
      ]
    },
    {
      id: "resp_commentary",
      output: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [
            {
              type: "output_text",
              text: "I am still thinking through the implementation details."
            }
          ]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_commentary",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue now." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Ship the release." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue now." }]
    }
  ]);
});

test("responses chain replay drops streamed assistant commentary after SSE reconstruction", () => {
  const helpers = createResponsesHelpers();
  const completed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"msg_commentary_stream","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"This commentary should stay out of replay."}]}}',
      'data: {"type":"response.completed","response":{"id":"resp_stream_commentary","status":"completed","output":[]}}'
    ].join("\n\n") + "\n\n"
  ).completed;

  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Think through the release." }]
        }
      ]
    },
    completed
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_stream_commentary",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue with final answer." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Think through the release." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue with final answer." }]
    }
  ]);
});
test("responses chain replay drops structured plan items", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan the rollout." }]
        }
      ]
    },
    {
      id: "resp_plan_item",
      output: [
        {
          type: "plan",
          id: "plan_1",
          text: "1. Inspect\n2. Patch\n3. Test"
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_item",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Execute it." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Plan the rollout." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Execute it." }]
    }
  ]);
});

test("responses chain replay keeps normal assistant replies in follow-up context", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize the fix." }]
        }
      ]
    },
    {
      id: "resp_normal_assistant",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The port restart flow is fixed." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_normal_assistant",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Add tests too." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Summarize the fix." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "The port restart flow is fixed." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Add tests too." }]
    }
  ]);
});

test("responses chain replay keeps final_answer assistant items", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Did the hardware flow pass?" }]
        }
      ]
    },
    {
      id: "resp_final_answer",
      output: [
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Yes, the end-to-end flow passed." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_final_answer",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize the risk." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Did the hardware flow pass?" }]
    },
    {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Yes, the end-to-end flow passed." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Summarize the risk." }]
    }
  ]);
});

test("responses chain replay keeps plain assistant mentions of request_user_input and proposed_plan text", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Quote the raw text literally." }]
        }
      ]
    },
    {
      id: "resp_plain_text",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "The literal strings request_user_input and <proposed_plan> are just examples here."
            }
          ]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plain_text",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Keep them in context." }]
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Quote the raw text literally." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "The literal strings request_user_input and <proposed_plan> are just examples here."
        }
      ]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Keep them in context." }]
    }
  ]);
});

test("responses chain replay de-duplicates prior chat-style assistant history during continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "1+1 等於幾？" }]
        }
      ]
    },
    {
      id: "resp_math",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "1+1 = 2" }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_math",
      input: [
        {
          role: "user",
          content: "1+1 等於幾？"
        },
        {
          role: "assistant",
          content: "1+1 = 2"
        },
        {
          role: "user",
          content: "你知道今天是幾號嗎？"
        }
      ]
    },
    entry
  );

  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "1+1 等於幾？" }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "1+1 = 2" }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "你知道今天是幾號嗎？" }]
    }
  ]);
});

test("responses chain replay preserves the current turn when continuation uses messages alias", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "1+1 等於幾？" }]
        }
      ]
    },
    {
      id: "resp_messages_alias",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "1+1 = 2" }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_messages_alias",
      messages: [
        {
          role: "user",
          content: "你知道今天是幾號嗎？"
        }
      ]
    },
    entry
  );

  assert.equal(Object.hasOwn(expanded, "messages"), false);
  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "1+1 等於幾？" }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "1+1 = 2" }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "你知道今天是幾號嗎？" }]
    }
  ]);
});

