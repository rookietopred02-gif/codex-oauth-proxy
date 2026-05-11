import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";
import {
  buildResponsesChainEntry,
  createResponsesChainStore,
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

test("responses chain replay preserves streamed web search sources", () => {
  const helpers = createResponsesHelpers();
  const completed = helpers.parseResponsesResultFromSse(
    [
      'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"query":"latest docs","sources":[{"type":"url","title":"Docs","url":"https://example.test/docs"}]}}}',
      'data: {"type":"response.completed","response":{"id":"resp_web_search_chain","status":"completed","output":[{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"query":"latest docs","sources":[]}}]}}'
    ].join("\n\n") + "\n\n"
  ).completed;

  const entry = buildResponsesChainEntry(
    {
      model: "gpt-5.4",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Search for the latest docs." }]
        }
      ]
    },
    completed
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_web_search_chain",
      input: [{ role: "user", content: [{ type: "input_text", text: "Summarize the source." }] }]
    },
    entry
  );

  assert.deepEqual(
    expanded.input.find((item) => item.type === "web_search_call"),
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

test("responses chain replay tolerates non-JSON-safe metadata while de-duplicating", () => {
  const priorMessage = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Compare this payload." }],
    metadata: { trace: 1n }
  };

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_bigint_metadata",
      input: [
        structuredClone(priorMessage),
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue after the overlap." }]
        }
      ]
    },
    {
      responseId: "resp_bigint_metadata",
      inputHistory: [priorMessage]
    }
  );

  assert.deepEqual(expanded.input, [
    priorMessage,
    {
      role: "user",
      content: [{ type: "input_text", text: "Continue after the overlap." }]
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

test("responses chain replay does not lift messages alias instructions during continuation", () => {
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
  assert.equal(Object.hasOwn(expanded, "instructions"), false);
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
});

test("responses chain replay preserves current official input instruction roles during continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Old developer instructions." }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    },
    {
      id: "resp_current_input_instructions",
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
      previous_response_id: "resp_current_input_instructions",
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Use the developer instructions for this turn." }]
        },
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
      role: "developer",
      content: [{ type: "input_text", text: "Use the developer instructions for this turn." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Next turn." }]
    }
  ]);
});

test("responses chain replay does not carry an older prompt stack as instructions or input items", () => {
  const entry = buildResponsesChainEntry(
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Earlier request." }]
        }
      ]
    },
    {
      id: "resp_prompt_stack",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Earlier answer." }]
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_prompt_stack",
      messages: [
        {
          role: "developer",
          content: "Older prompt stack instruction A."
        },
        {
          role: "developer",
          content: "Older prompt stack instruction B."
        },
        {
          role: "system",
          content: "Older prompt stack instruction C."
        },
        {
          role: "user",
          content: "Current user request."
        }
      ]
    },
    entry
  );

  assert.equal(Object.hasOwn(expanded, "instructions"), false);
  assert.deepEqual(expanded.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "Earlier request." }]
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Earlier answer." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "Current user request." }]
    }
  ]);
});

test("responses chain replay does not inherit prior collaboration mode across previous_response_id continuation", () => {
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

  assert.equal(expanded.collaborationMode, undefined);
  assert.equal(expanded.settings?.developer_instructions, undefined);
});

test("responses chain replay ignores developer text collaboration envelope across continuation", () => {
  const entry = buildResponsesChainEntry(
    {
      instructions: "Base Codex instructions.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<collaboration_mode># Plan Mode (Conversational)\nUse request_user_input before finalizing a plan.</collaboration_mode>"
            }
          ]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Plan the change." }]
        }
      ]
    },
    {
      id: "resp_plan_envelope_chain",
      output: [
        {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_1",
          arguments: "{}"
        }
      ]
    }
  );

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_plan_envelope_chain",
      instructions: "Base Codex instructions.",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"answers\":{}}"
        }
      ]
    },
    entry
  );

  assert.equal(expanded.collaborationMode, undefined);
  assert.equal(expanded.settings?.developer_instructions, undefined);
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

test("responses chain replay drops chat-style assistant commentary before conversion", () => {
  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_chat_commentary",
      input: [
        {
          role: "user",
          content: "Continue now."
        }
      ]
    },
    {
      responseId: "resp_chat_commentary",
      inputHistory: [
        {
          role: "user",
          content: "Ship the release."
        },
        {
          role: "assistant",
          phase: "commentary",
          content: "I am still thinking through the implementation details."
        }
      ]
    }
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

test("responses chain store expires stale continuation entries", () => {
  const store = createResponsesChainStore({ ttlMs: 10, maxEntries: 4 });

  assert.equal(store.remember(null, 1000), null);
  assert.deepEqual(
    store.remember(
      {
        responseId: " resp_chain ",
        inputHistory: ["first turn"]
      },
      1000
    ),
    {
      responseId: "resp_chain",
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "first turn" }]
        }
      ],
      updatedAt: 1000
    }
  );

  assert.equal(store.lookup("resp_chain", 1005)?.updatedAt, 1005);
  assert.equal(store.lookup("resp_chain", 1016), null);
  assert.equal(store.size(), 0);
});

test("responses chain store ignores malformed numeric options and timestamps", () => {
  let store = null;
  const throwingNumber = {
    valueOf() {
      throw new Error("bad number");
    }
  };

  assert.doesNotThrow(() => {
    store = createResponsesChainStore({
      ttlMs: Symbol("ttl"),
      maxEntries: throwingNumber
    });
  });

  assert.deepEqual(
    store.remember(
      {
        responseId: "resp_bad_timestamp",
        inputHistory: ["turn"],
        updatedAt: Symbol("updated-at")
      },
      1000
    ),
    {
      responseId: "resp_bad_timestamp",
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "turn" }]
        }
      ],
      updatedAt: 1000
    }
  );
  assert.equal(store.lookup("resp_bad_timestamp", 1001)?.responseId, "resp_bad_timestamp");
});

test("responses chain store rejects decimal-form numeric options", () => {
  const ttlStore = createResponsesChainStore({ ttlMs: "10.9", maxEntries: 4 });
  ttlStore.remember({ responseId: "resp_ttl", inputHistory: ["ttl"] }, 1000);
  assert.equal(ttlStore.lookup("resp_ttl", 1012)?.responseId, "resp_ttl");

  const maxEntriesStore = createResponsesChainStore({ ttlMs: 1000, maxEntries: "1.9" });
  maxEntriesStore.remember({ responseId: "resp_a", inputHistory: ["a"] }, 1000);
  maxEntriesStore.remember({ responseId: "resp_b", inputHistory: ["b"] }, 1001);

  assert.equal(maxEntriesStore.lookup("resp_a", 1002)?.responseId, "resp_a");
  assert.equal(maxEntriesStore.lookup("resp_b", 1003)?.responseId, "resp_b");
});

test("responses chain store rejects decimal-form timestamps", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);

  assert.equal(
    buildResponsesChainEntry(
      {
        input: "hello"
      },
      {
        id: "resp_built",
        output: []
      },
      "1000.9"
    )?.updatedAt,
    2000
  );

  const store = createResponsesChainStore({ ttlMs: 10, maxEntries: 4 });

  assert.deepEqual(
    store.remember(
      {
        responseId: "resp_decimal",
        inputHistory: ["turn"]
      },
      "1000.9"
    ),
    {
      responseId: "resp_decimal",
      inputHistory: [
        {
          role: "user",
          content: [{ type: "input_text", text: "turn" }]
        }
      ],
      updatedAt: 2000
    }
  );

  now = 2005;
  assert.equal(store.lookup("resp_decimal", "2005.9")?.updatedAt, 2005);

  now = 2016;
  assert.equal(store.lookup("resp_decimal", "2016.9"), null);
});

test("responses chain store evicts least recently used continuation entries over the limit", () => {
  const store = createResponsesChainStore({ ttlMs: 1000, maxEntries: 2 });

  store.remember({ responseId: "resp_a", inputHistory: ["a"] }, 1000);
  store.remember({ responseId: "resp_b", inputHistory: ["b"] }, 1001);
  assert.equal(store.lookup("resp_a", 1002)?.responseId, "resp_a");
  store.remember({ responseId: "resp_c", inputHistory: ["c"] }, 1003);

  assert.equal(store.lookup("resp_b", 1004), null);
  assert.equal(store.lookup("resp_a", 1004)?.responseId, "resp_a");
  assert.equal(store.lookup("resp_c", 1004)?.responseId, "resp_c");
});

test("responses chain store can forget and clear continuation entries", () => {
  const store = createResponsesChainStore({ ttlMs: 1000, maxEntries: 4 });

  store.remember({ responseId: "resp_a", inputHistory: ["a"] }, 1000);
  store.remember({ responseId: "resp_b", inputHistory: ["b"] }, 1001);
  assert.equal(store.forget("resp_a"), true);
  assert.equal(store.forget("resp_missing"), false);
  assert.equal(store.lookup("resp_a", 1002), null);
  assert.equal(store.size(), 1);

  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.lookup("resp_b", 1003), null);
});

