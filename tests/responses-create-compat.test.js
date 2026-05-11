import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OFFICIAL_RESPONSES_CREATE_FIELDS,
  RESPONSES_CREATE_ALIAS_FIELDS,
  RESPONSES_CREATE_FIELD_MATRIX,
  getResponsesCreateFieldPolicy
} from "../src/protocols/openai/responses-create-compat.js";

const responsesOpenApiContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-openapi.json", import.meta.url), "utf8")
);

function getOfficialCreateFixtureFields() {
  const expectedFields = new Set([
    "model",
    "stream",
    "input",
    "instructions",
    ...Object.keys(responsesOpenApiContract.create.sample_create_request),
    ...responsesOpenApiContract.create.covered_passthrough_cases.flatMap((entry) => Object.keys(entry.sample || {}))
  ]);
  expectedFields.delete("messages");
  expectedFields.delete("reasoning_effort");
  return expectedFields;
}

test("responses create compat matrix covers the official create fields used by fixtures", () => {
  const expectedFields = getOfficialCreateFixtureFields();

  for (const fieldName of expectedFields) {
    assert.equal(
      OFFICIAL_RESPONSES_CREATE_FIELDS.includes(fieldName),
      true,
      `expected official Responses create field coverage for ${fieldName}`
    );
    assert.equal(
      typeof RESPONSES_CREATE_FIELD_MATRIX[fieldName]?.codexResponses,
      "string",
      `expected codexResponses policy for ${fieldName}`
    );
  }
});

test("responses create fixture covers every official codex passthrough field", () => {
  const fixtureFields = getOfficialCreateFixtureFields();

  for (const [fieldName, descriptor] of Object.entries(RESPONSES_CREATE_FIELD_MATRIX)) {
    if (descriptor?.official !== true || descriptor?.codexResponses !== "passthrough") continue;
    assert.equal(
      fixtureFields.has(fieldName),
      true,
      `expected fixture passthrough coverage for official Responses create field ${fieldName}`
    );
  }
});

test("responses create compat matrix keeps local alias fields separate from official fields", () => {
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("messages"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("reasoning_effort"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("client_metadata"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("collaborationMode"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("collaboration_mode"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("generate"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("settings"), true);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("messages"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("reasoning_effort"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("client_metadata"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("collaborationMode"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("collaboration_mode"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("generate"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("settings"), false);
});

test("responses create compat matrix preserves official client create fields for codex-backed compat paths", () => {
  assert.equal(getResponsesCreateFieldPolicy("store", "codexResponses"), "passthrough");
  assert.equal(getResponsesCreateFieldPolicy("stream", "codexResponses"), "passthrough");
  assert.equal(getResponsesCreateFieldPolicy("temperature", "codexResponses"), "passthrough");
  assert.equal(getResponsesCreateFieldPolicy("top_p", "codexResponses"), "passthrough");
  assert.equal(getResponsesCreateFieldPolicy("previous_response_id", "codexResponses"), "local_transform");
  assert.equal(getResponsesCreateFieldPolicy("generate", "codexResponses"), "local_transform");
  assert.equal(getResponsesCreateFieldPolicy("temperature", "anthropicNativeCompat"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("top_p", "anthropicNativeCompat"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("metadata", "anthropicNativeCompat"), "mapped");
});
