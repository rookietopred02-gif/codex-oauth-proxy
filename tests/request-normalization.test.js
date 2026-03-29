import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOpenAIRequestNormalizationHelpers } from "../src/protocols/openai/request-normalization.js";

const responsesOpenApiContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-openapi.json", import.meta.url), "utf8")
);

function createHelpers() {
  return createOpenAIRequestNormalizationHelpers({
    config: {
      upstreamMode: "codex-chatgpt",
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "Default instructions",
        defaultServiceTier: "default"
      }
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model || "gpt-5.4"
      };
    },
    resolveReasoningEffort(value) {
      return value || "medium";
    },
    applyReasoningEffortDefaults(target, reasoningEffort) {
      if (!target.reasoning || typeof target.reasoning !== "object") {
        target.reasoning = {};
      }
      if (!target.reasoning.effort) {
        target.reasoning.effort = reasoningEffort || "medium";
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

test("normalizeCodexResponsesRequestBody drops explicit sampling parameters for codex upstream", () => {
  const helpers = createHelpers();
  const normalized = helpers.normalizeCodexResponsesRequestBody(
    Buffer.from(JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: "hello",
      temperature: 0.2,
      top_p: 0.9
    }), "utf8")
  );

  assert.equal(Object.hasOwn(normalized.json, "temperature"), false);
  assert.equal(Object.hasOwn(normalized.json, "top_p"), false);
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
      if (fieldName === "store") {
        assert.equal(
          normalized.json[fieldName],
          false,
          `expected ${fieldName} to be coerced to false for codex upstream in case ${passthroughCase.id}`
        );
        continue;
      }
      if (fieldName === "include" && Array.isArray(fieldValue)) {
        assert.deepEqual(
          normalized.json[fieldName],
          [...fieldValue, "reasoning.encrypted_content"],
          `expected ${fieldName} to include codex-required encrypted reasoning for case ${passthroughCase.id}`
        );
        continue;
      }
      if (fieldName === "temperature" || fieldName === "top_p") {
        assert.equal(
          Object.hasOwn(normalized.json, fieldName),
          false,
          `expected ${fieldName} to be dropped for case ${passthroughCase.id}`
        );
        continue;
      }
      assert.deepEqual(
        normalized.json[fieldName],
        fieldValue,
        `expected ${fieldName} to be preserved for case ${passthroughCase.id}`
      );
    }
    assert.equal(normalized.json.stream, true);
    assert.equal(normalized.model, "gpt-5.4");
  }
});

test("normalizeCodexResponsesRequestBody applies only the documented create-path transforms", () => {
  const helpers = createHelpers();
  const request = structuredClone(responsesOpenApiContract.create.sample_create_request);

  const normalized = helpers.normalizeCodexResponsesRequestBody(Buffer.from(JSON.stringify(request), "utf8"));

  assert.equal(normalized.collectCompletedResponseAsJson, true);
  assert.equal(normalized.json.model, "gpt-5.4");
  assert.equal(normalized.json.stream, true);
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
