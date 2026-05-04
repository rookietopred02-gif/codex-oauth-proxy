import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOpenAIRequestNormalizationHelpers } from "../src/protocols/openai/request-normalization.js";

const responsesOpenApiContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-openapi.json", import.meta.url), "utf8")
);

function createHelpers() {
  function resolveReasoningEffortValue(value, context = null) {
    if (value) return value;
    if (context && typeof context === "object" && context.collaborationMode === "plan") {
      return context.planModeReasoningEffort || "high";
    }
    return "medium";
  }

  return createOpenAIRequestNormalizationHelpers({
    config: {
      upstreamMode: "codex-chatgpt",
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "Default instructions",
        defaultServiceTier: "priority",
        planModeReasoningEffort: "high"
      }
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model || "gpt-5.4"
      };
    },
    resolveReasoningEffort(value, context) {
      return resolveReasoningEffortValue(value, context);
    },
    applyReasoningEffortDefaults(target, reasoningEffort, context) {
      if (!target.reasoning || typeof target.reasoning !== "object") {
        target.reasoning = {};
      }
      if (!target.reasoning.effort) {
        target.reasoning.effort = resolveReasoningEffortValue(reasoningEffort, context);
      }
    }
  });
}

test("normalizeCodexResponsesRequestBody preserves typed responses input items", () => {
  const helpers = createHelpers();
  const request = {
    model: "gpt-5.4",
    stream: false,
    input: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done" }]
      },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"a.txt\"}"
      },
      {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "enc_123",
        summary: [{ type: "summary_text", text: "step" }]
      }
    ]
  };

  const normalized = helpers.normalizeCodexResponsesRequestBody(Buffer.from(JSON.stringify(request), "utf8"));

  assert.equal(normalized.collectCompletedResponseAsJson, true);
  assert.deepEqual(normalized.json.input, request.input);
});

test("normalizeCodexResponsesRequestBody adds encrypted reasoning include for store false", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      store: false,
      input: "hello"
    }), "utf8")
  );

  assert.deepEqual(normalized.json.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }
  ]);
  assert.deepEqual(normalized.json.include, ["reasoning.encrypted_content"]);
});

test("normalizeCodexResponsesRequestBody forces store false when client omits it", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.store, false);
  assert.deepEqual(normalized.json.include, ["reasoning.encrypted_content"]);
});

test("normalizeCodexResponsesRequestBody preserves explicit client create fields", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      store: true,
      include: ["message.output_text.logprobs"],
      input: "hello",
      temperature: 0.2,
      top_p: 0.9
    }), "utf8")
  );

  assert.equal(normalized.json.stream, false);
  assert.equal(normalized.json.store, true);
  assert.deepEqual(normalized.json.include, ["message.output_text.logprobs"]);
  assert.equal(normalized.json.temperature, 0.2);
  assert.equal(normalized.json.top_p, 0.9);
});

test("normalizeCodexResponsesRequestBody injects configured service tier when omitted", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.service_tier, "priority");
});

test("normalizeCodexResponsesRequestBody preserves explicit client service tier", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      service_tier: "default",
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.service_tier, "default");
});

test("normalizeCodexResponsesRequestBody strips the local generate flag before upstream", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      generate: true
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "generate"), false);
  assert.equal(normalized.json.model, "gpt-5.4");
  assert.equal(normalized.json.stream, false);
  assert.deepEqual(normalized.json.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }
  ]);
});

test("normalizeCodexResponsesRequestBody rejects unsupported top-level create fields before upstream", () => {
  const helpers = createHelpers();

  assert.throws(
    () => helpers.normalizeCodexResponsesRequestBody(
      Buffer.from(JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "hello",
        definitely_not_supported: true
      }), "utf8")
    ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "unsupported_parameter");
      assert.equal(err.param, "definitely_not_supported");
      assert.match(err.message, /definitely_not_supported/);
      return true;
    }
  );
});

test("normalizeCodexResponsesRequestBody preserves Codex client metadata while rejecting unknown fields", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      client_metadata: {
        "x-codex-turn-metadata": "{\"session_id\":\"sess_1\",\"turn_id\":\"turn_1\"}"
      }
    }), "utf8")
  );

  assert.deepEqual(normalized.json.client_metadata, {
    "x-codex-turn-metadata": "{\"session_id\":\"sess_1\",\"turn_id\":\"turn_1\"}"
  });
});

test("normalizeCodexResponsesRequestBody preserves covered official create fields", () => {
  const helpers = createHelpers();
  for (const passthroughCase of responsesOpenApiContract.create.covered_passthrough_cases) {
    const request = {
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      ...(passthroughCase.request_overrides || {}),
      ...passthroughCase.sample
    };

    const normalized = helpers.normalizeCodexResponsesRequestBody(Buffer.from(JSON.stringify(request), "utf8"));

    for (const [fieldName, fieldValue] of Object.entries(passthroughCase.sample)) {
      assert.deepEqual(
        normalized.json[fieldName],
        fieldValue,
        `expected ${fieldName} to be preserved for case ${passthroughCase.id}`
      );
    }
    assert.equal(normalized.json.stream, request.stream);
    assert.equal(normalized.model, "gpt-5.4");
  }
});

test("normalizeCodexResponsesRequestBody applies only the documented create-path transforms", () => {
  const helpers = createHelpers();
  const request = structuredClone(responsesOpenApiContract.create.sample_create_request);

  const normalized = helpers.normalizeCodexResponsesRequestBody(Buffer.from(JSON.stringify(request), "utf8"));

  assert.equal(normalized.collectCompletedResponseAsJson, true);
  assert.equal(normalized.json.model, "gpt-5.4");
  assert.equal(normalized.json.stream, false);
  assert.deepEqual(normalized.json.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }
  ]);
  assert.equal(normalized.json.reasoning?.effort, "high");
  assert.equal(normalized.json.background, true);
  assert.equal(normalized.json.prompt_cache_key, "prompt-cache-key");
  assert.equal(normalized.json.safety_identifier, "user_hash_123");
  assert.deepEqual(normalized.json.include, ["reasoning.encrypted_content"]);
  for (const fieldName of responsesOpenApiContract.create.removed_fields) {
    assert.equal(Object.hasOwn(normalized.json, fieldName), false, `expected ${fieldName} to be removed`);
  }
});

test("normalizeCodexResponsesRequestBody does not inject configured plan-mode reasoning effort", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      input: "hello"
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.match(String(normalized.json.instructions || ""), /Plan Mode/i);
  assert.equal(Object.hasOwn(normalized.json, "collaborationMode"), false);
  assert.equal(Object.hasOwn(normalized.json, "settings"), false);
});

test("normalizeCodexResponsesRequestBody uses built-in plan instructions when settings.developer_instructions is null", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      settings: {
        developer_instructions: null
      },
      input: "hello",
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.match(String(normalized.json.instructions || ""), /Plan Mode/i);
  assert.equal(Object.hasOwn(normalized.json, "collaborationMode"), false);
  assert.equal(Object.hasOwn(normalized.json, "settings"), false);
});

test("normalizeCodexResponsesRequestBody uses resolved official mode instructions when provided locally", () => {
  const helpers = createHelpers();
  const officialPlanInstructions = "# Plan Mode (Conversational)\nUse the plan-only flow before implementation.";
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      instructions: "Base Codex instructions",
      settings: {
        developer_instructions: null,
        _codex_resolved_developer_instructions: officialPlanInstructions
      },
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.instructions, `Base Codex instructions\n\n${officialPlanInstructions}`);
  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.equal(Object.hasOwn(normalized.json, "collaborationMode"), false);
  assert.equal(Object.hasOwn(normalized.json, "settings"), false);
});

test("normalizeCodexResponsesRequestBody preserves developer and system semantics from the messages alias", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      messages: [
        { role: "system", content: "System guidance" },
        { role: "developer", content: [{ type: "text", text: "Developer guidance" }] },
        { role: "user", content: "hello" }
      ]
    }), "utf8")
  );

  assert.equal(normalized.json.instructions, "System guidance\n\nDeveloper guidance");
  assert.deepEqual(normalized.json.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }
  ]);
});

test("normalizeCodexResponsesRequestBody does not inject default reasoning effort", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello"
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.equal(Object.hasOwn(normalized.json, "collaborationMode"), false);
});

test("normalizeCodexResponsesRequestBody does not treat plain user mentions of request_user_input as plan mode", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "Explain what request_user_input does."
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.equal(Object.hasOwn(normalized.json, "collaborationMode"), false);
});

test("normalizeCodexResponsesRequestBody does not enable plan mode from plain prompt scaffolding text", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      instructions: "You are in Plan Mode. Use request_user_input when blocked.",
      input: "hello"
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
});

test("normalizeCodexResponsesRequestBody does not enable plan mode from request_user_input tool names alone", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      tools: [
        {
          type: "function",
          name: "request_user_input",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string" }
            }
          }
        }
      ]
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
});

test("normalizeCodexResponsesRequestBody preserves explicit reasoning effort over the plan-mode config", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      reasoning_effort: "low",
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.reasoning?.effort, "low");
});

test("normalizeCodexResponsesRequestBody omits implicit default instructions on previous_response_id continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_prev_123",
      input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
    }), "utf8")
  );

  assert.equal(normalized.json.previous_response_id, "resp_prev_123");
  assert.equal(Object.hasOwn(normalized.json, "instructions"), false);
});

test("normalizeCodexResponsesRequestBody does not lift messages alias instructions on previous_response_id continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_prev_123",
      messages: [
        { role: "developer", content: "Older prompt stack instruction." },
        { role: "system", content: "Older system instruction." },
        { role: "user", content: "next turn" }
      ]
    }), "utf8")
  );

  assert.equal(normalized.json.previous_response_id, "resp_prev_123");
  assert.equal(Object.hasOwn(normalized.json, "instructions"), false);
  assert.deepEqual(normalized.json.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "next turn" }]
    }
  ]);
});

test("normalizeCodexResponsesRequestBody preserves current input instruction roles on previous_response_id continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_prev_123",
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Use this turn's developer instruction." }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "next turn" }]
        }
      ]
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "instructions"), false);
  assert.deepEqual(normalized.json.input, [
    {
      role: "developer",
      content: [{ type: "input_text", text: "Use this turn's developer instruction." }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "next turn" }]
    }
  ]);
});

test("normalizeCodexResponsesRequestBody omits implicit default instructions on locally emulated continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
    }), "utf8"),
    {
      previousResponseContinuation: true
    }
  );

  assert.equal(Object.hasOwn(normalized.json, "previous_response_id"), false);
  assert.equal(Object.hasOwn(normalized.json, "instructions"), false);
});

test("normalizeCodexResponsesRequestBody keeps explicit instructions on previous_response_id continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_prev_123",
      instructions: "Use concise answers for this turn.",
      input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
    }), "utf8")
  );

  assert.equal(normalized.json.previous_response_id, "resp_prev_123");
  assert.equal(normalized.json.instructions, "Use concise answers for this turn.");
});

test("normalizeCodexResponsesRequestBody respects an explicit empty instructions string", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      instructions: "",
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.instructions, "");
});

test("normalizeCodexResponsesRequestBody keeps explicit default-mode override instructions on previous_response_id continuation", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      previous_response_id: "resp_prev_123",
      collaborationMode: "default",
      input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
    }), "utf8")
  );

  assert.equal(normalized.json.previous_response_id, "resp_prev_123");
  assert.equal(normalized.json.instructions, "Default instructions");
});

test("normalizeCodexResponsesRequestBody preserves explicit nested reasoning effort over the plan-mode config", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      reasoning: {
        effort: "low"
      },
      input: "hello"
    }), "utf8")
  );

  assert.equal(normalized.json.reasoning?.effort, "low");
});

test("normalizeCodexResponsesRequestBody does not inject reasoning for explicit default mode", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "default",
      input: "hello"
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.equal(normalized.json.instructions, "Default instructions");
});

test("normalizeCodexResponsesRequestBody strips plan-mode user input tool when collaborationMode is not plan", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      tool_choice: { type: "function", name: "request_user_input" },
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "request_user_input", parameters: { type: "object" } },
        { type: "function", name: "keep_me", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "update_plan", parameters: { type: "object" } },
    { type: "function", name: "keep_me", parameters: { type: "object" } }
  ]);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeCodexResponsesRequestBody drops required tool_choice when default mode strips every plan-only user input tool", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      tool_choice: "required",
      tools: [
        { type: "function", name: "request_user_input", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, []);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeCodexResponsesRequestBody keeps request_user_input and blocks update_plan when collaborationMode is plan", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      input: "hello",
      tool_choice: { type: "function", name: "request_user_input" },
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "request_user_input", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "request_user_input", parameters: { type: "object" } }
  ]);
  assert.deepEqual(normalized.json.tool_choice, { type: "function", name: "request_user_input" });
});

test("normalizeCodexResponsesRequestBody drops update_plan tool_choice when collaborationMode is plan", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      collaborationMode: "plan",
      input: "hello",
      tool_choice: { type: "function", name: "update_plan" },
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "request_user_input", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "request_user_input", parameters: { type: "object" } }
  ]);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeCodexResponsesRequestBody ignores developer text collaboration envelope when filtering tools", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
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
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Plan a README change." }]
        }
      ],
      tool_choice: { type: "function", name: "request_user_input" },
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "request_user_input", parameters: { type: "object" } },
        { type: "function", name: "keep_me", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "update_plan", parameters: { type: "object" } },
    { type: "function", name: "keep_me", parameters: { type: "object" } }
  ]);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeCodexResponsesRequestBody ignores user text collaboration envelope when filtering tools", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Explain this literal text: <collaboration_mode># Plan Mode</collaboration_mode>"
            }
          ]
        }
      ],
      tool_choice: { type: "function", name: "request_user_input" },
      tools: [
        { type: "function", name: "update_plan", parameters: { type: "object" } },
        { type: "function", name: "request_user_input", parameters: { type: "object" } },
        { type: "function", name: "keep_me", parameters: { type: "object" } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "update_plan", parameters: { type: "object" } },
    { type: "function", name: "keep_me", parameters: { type: "object" } }
  ]);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeCodexResponsesRequestBody fills required summary on reasoning replay items", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: [
        {
          id: "rs_1",
          type: "reasoning",
          encrypted_content: "enc_123"
        }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.input, [
    {
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "enc_123",
      summary: []
    }
  ]);
});

test("normalizeCodexResponsesRequestBody flattens typed assistant refusal parts into output_text", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "refusal", refusal: "No." }
          ]
        }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.input, [
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "No." }
      ]
    }
  ]);
});

test("toResponsesInputFromChatMessages expands assistant tool calls and tool outputs into Responses items", () => {
  const helpers = createHelpers();

  const normalized = helpers.toResponsesInputFromChatMessages([
    {
      role: "assistant",
      content: "Checking the weather.",
      tool_calls: [
        {
          type: "function",
          id: "call_weather",
          function: {
            name: "lookup_weather",
            arguments: "{\"city\":\"Taipei\"}"
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_weather",
      content: [{ type: "output_text", text: "{\"temp_f\":72}" }]
    }
  ]);

  assert.deepEqual(normalized, [
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Checking the weather." }]
    },
    {
      type: "function_call",
      call_id: "call_weather",
      name: "lookup_weather",
      arguments: "{\"city\":\"Taipei\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_weather",
      output: "{\"temp_f\":72}"
    }
  ]);
});

test("normalizeChatCompletionsRequestBody flattens function tool_choice and preserves built-in Responses tools", () => {
  const helpers = createHelpers();
  const builtInTool = {
    type: "mcp",
    server_label: "docs",
    server_url: "https://example.test/mcp",
    require_approval: "never"
  };
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "function",
        function: {
          name: "lookup_weather"
        }
      },
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" }
              }
            }
          }
        },
        builtInTool
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tool_choice, {
    type: "function",
    name: "lookup_weather"
  });
  assert.deepEqual(normalized.json.tools, [
    {
      type: "function",
      name: "lookup_weather",
      description: "Look up weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" }
        }
      }
    },
    {
      type: "mcp",
      server_label: "docs",
      server_url: "https://example.test/mcp",
      require_approval: "never"
    }
  ]);
  assert.notEqual(normalized.json.tools[1], builtInTool);
});

test("normalizeChatCompletionsRequestBody preserves the official built-in Responses tool families", () => {
  const helpers = createHelpers();
  const builtInTools = [
    { type: "web_search", search_context_size: "low" },
    { type: "file_search", vector_store_ids: ["vs_123"] },
    { type: "mcp", server_label: "docs", server_url: "https://example.test/mcp", require_approval: "never" },
    { type: "image_generation", size: "1024x1024" },
    { type: "code_interpreter", container: { type: "auto" } },
    { type: "shell", environment: { type: "local" } },
    { type: "computer", display_width: 1024, display_height: 768, environment: "browser" }
  ];
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "run the tool chain" }],
      tool_choice: { type: "file_search", vector_store_ids: ["vs_123"] },
      tools: builtInTools
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tool_choice, { type: "file_search", vector_store_ids: ["vs_123"] });
  assert.deepEqual(normalized.json.tools, builtInTools);
  for (let index = 0; index < builtInTools.length; index += 1) {
    assert.notEqual(normalized.json.tools[index], builtInTools[index]);
  }
});

test("normalizeChatCompletionsRequestBody does not inject the configured default temperature for codex upstream", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }]
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "temperature"), false);
});

test("normalizeChatCompletionsRequestBody drops explicit sampling parameters for codex upstream", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      top_p: 0.9
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "temperature"), false);
  assert.equal(Object.hasOwn(normalized.json, "top_p"), false);
});

test("normalizeChatCompletionsRequestBody uses explicit plan collaboration mode instead of heuristics", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      collaborationMode: "plan",
      messages: [{ role: "user", content: "hello" }]
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.match(String(normalized.json.instructions || ""), /Plan Mode/i);
});

test("normalizeChatCompletionsRequestBody lets settings.developer_instructions null override system and developer messages", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      settings: {
        developer_instructions: null
      },
      messages: [
        { role: "system", content: "System guidance" },
        { role: "developer", content: "Developer guidance" },
        { role: "user", content: "hello" }
      ]
    }), "utf8")
  );

  assert.equal(normalized.json.instructions, "Default instructions");
});

test("normalizeChatCompletionsRequestBody lets explicit settings.developer_instructions override system and developer messages", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      settings: {
        developer_instructions: "Explicit developer instructions"
      },
      messages: [
        { role: "system", content: "System guidance" },
        { role: "developer", content: "Developer guidance" },
        { role: "user", content: "hello" }
      ]
    }), "utf8")
  );

  assert.equal(normalized.json.instructions, "Explicit developer instructions");
});

test("normalizeChatCompletionsRequestBody does not enable plan mode from plain plan scaffolding text", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Explain request_user_input and <proposed_plan>." }]
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "reasoning"), false);
  assert.equal(normalized.json.instructions, "Default instructions");
});

test("normalizeChatCompletionsRequestBody strips plan-mode user input tool when collaborationMode is not plan", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "function", function: { name: "request_user_input" } },
      tools: [
        { type: "function", function: { name: "update_plan", parameters: { type: "object" } } },
        { type: "function", function: { name: "request_user_input", parameters: { type: "object" } } },
        { type: "function", function: { name: "keep_me", parameters: { type: "object" } } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, [
    { type: "function", name: "update_plan", parameters: { type: "object" } },
    { type: "function", name: "keep_me", parameters: { type: "object" } }
  ]);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});

test("normalizeChatCompletionsRequestBody drops required tool_choice when default mode strips every plan-only user input tool", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeChatCompletionsRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: "required",
      tools: [
        { type: "function", function: { name: "request_user_input", parameters: { type: "object" } } }
      ]
    }), "utf8")
  );

  assert.deepEqual(normalized.json.tools, []);
  assert.equal(Object.hasOwn(normalized.json, "tool_choice"), false);
});
