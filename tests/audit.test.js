import assert from "node:assert/strict";
import test from "node:test";

import { inferProtocolType } from "../src/http/audit.js";

test("inferProtocolType maps Gemini alias paths to the Gemini protocol", () => {
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:generateContent"), "gemini-v1beta");
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:streamGenerateContent"), "gemini-v1beta");
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:countTokens"), "gemini-v1beta");
});

test("inferProtocolType preserves explicit protocol hints before path fallback", () => {
  assert.equal(inferProtocolType("/v1/chat/completions", "anthropic-v1-openai-compat"), "anthropic-v1-openai-compat");
});
