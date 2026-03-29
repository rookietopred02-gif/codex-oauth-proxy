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

test("responses create compat matrix covers the official create fields used by fixtures", () => {
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

test("responses create compat matrix keeps local alias fields separate from official fields", () => {
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("messages"), true);
  assert.equal(RESPONSES_CREATE_ALIAS_FIELDS.includes("reasoning_effort"), true);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("messages"), false);
  assert.equal(OFFICIAL_RESPONSES_CREATE_FIELDS.includes("reasoning_effort"), false);
});

test("responses create compat matrix marks temperature and top_p as dropped for codex-backed compat paths", () => {
  assert.equal(getResponsesCreateFieldPolicy("temperature", "codexResponses"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("top_p", "codexResponses"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("temperature", "anthropicNativeCompat"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("top_p", "anthropicNativeCompat"), "drop");
  assert.equal(getResponsesCreateFieldPolicy("metadata", "anthropicNativeCompat"), "mapped");
});
