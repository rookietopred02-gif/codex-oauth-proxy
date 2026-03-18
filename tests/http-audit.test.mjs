import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPayloadForAudit,
  inferProtocolType,
  sanitizeAuditPath
} from "../src/http/audit.js";

test("formatPayloadForAudit pretty-prints JSON, redacts secrets, and truncates", () => {
  const body = JSON.stringify({
    access_token: "secret-token",
    nested: { api_key: "secret-key" },
    text: "x".repeat(32)
  });
  const formatted = formatPayloadForAudit(body, "application/json", 80);

  assert.match(formatted, /\[REDACTED\]/);
  assert.ok(formatted.includes('"nested": {'));
  assert.ok(formatted.includes("... [truncated "));
});

test("inferProtocolType prefers explicit hint then path shape then fallback", () => {
  assert.equal(inferProtocolType("/v1/messages", "", "openai-v1"), "anthropic-v1");
  assert.equal(inferProtocolType("/unknown", "gemini-v1beta", "openai-v1"), "gemini-v1beta");
  assert.equal(inferProtocolType("/unknown", "", "openai-v1"), "openai-v1");
});

test("sanitizeAuditPath removes API key query parameters", () => {
  assert.equal(
    sanitizeAuditPath("/v1/messages?key=secret&x-api-key=also-secret&foo=bar"),
    "/v1/messages?foo=bar"
  );
});
