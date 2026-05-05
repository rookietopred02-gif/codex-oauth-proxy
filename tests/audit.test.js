import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeIndexedByteAuditPayload,
  formatPayloadForAudit,
  inferProtocolType,
  sanitizeAuditPath,
  sanitizeAuditPayload,
  toChunkBuffer
} from "../src/http/audit.js";

test("inferProtocolType maps Gemini alias paths to the Gemini protocol", () => {
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:generateContent"), "gemini-v1beta");
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:streamGenerateContent"), "gemini-v1beta");
  assert.equal(inferProtocolType("/v1/models/gemini-2.5-pro:countTokens"), "gemini-v1beta");
});

test("inferProtocolType preserves explicit protocol hints before path fallback", () => {
  assert.equal(inferProtocolType("/v1/chat/completions", "anthropic-v1-openai-compat"), "anthropic-v1-openai-compat");
});

test("formatPayloadForAudit recursively redacts common secret fields", () => {
  const payload = {
    prompt: "safe prompt",
    password: "p@ssw0rd",
    nested: {
      client_secret: "client-secret-value",
      refresh_token: "refresh-secret-value",
      authorization: "Bearer token-secret"
    },
    array: [{ private_key: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }]
  };

  const formatted = formatPayloadForAudit(payload, "application/json");

  assert.match(formatted, /safe prompt/);
  assert.doesNotMatch(formatted, /p@ssw0rd|client-secret-value|refresh-secret-value|token-secret|BEGIN PRIVATE KEY/);
  assert.match(formatted, /\[REDACTED\]/);
});

test("formatPayloadForAudit decodes typed response bytes as text", () => {
  const packet =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const bytes = new Uint8Array(Buffer.from(packet, "utf8"));

  const formatted = formatPayloadForAudit(bytes, "text/event-stream");

  assert.equal(formatted, packet);
  assert.doesNotMatch(formatted, /"0"\s*:\s*101/);
});

test("decodeIndexedByteAuditPayload recovers legacy typed-array JSON packets", () => {
  const packet =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const legacyPacket = JSON.stringify(Object.fromEntries(Buffer.from(packet, "utf8").entries()), null, 2);

  const decoded = decodeIndexedByteAuditPayload(legacyPacket, "text/event-stream");

  assert.equal(decoded, packet);
});

test("toChunkBuffer preserves ArrayBuffer view slices", () => {
  const source = Buffer.from("xxevent: ok\n\nyy", "utf8");
  const view = new DataView(source.buffer, source.byteOffset + 2, "event: ok\n\n".length);

  assert.equal(toChunkBuffer(view).toString("utf8"), "event: ok\n\n");
});

test("sanitizeAuditPayload redacts bearer tokens and private key blocks in text", () => {
  const sanitized = sanitizeAuditPayload(
    "Authorization: Bearer sk-sensitive\ncookie: sid=secret\nclient_secret=form-secret&prompt=ok\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
  );

  assert.doesNotMatch(sanitized, /sk-sensitive|sid=secret|form-secret|BEGIN PRIVATE KEY|secret\n-----END/);
  assert.match(sanitized, /prompt=ok/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("sanitizeAuditPath strips secret-like query parameters from metadata paths", () => {
  const sanitized = sanitizeAuditPath(
    "/v1/responses?key=proxy-key&access_token=access&client_secret=secret&prompt=hello&x-goog-api-key=gemini"
  );

  assert.equal(sanitized, "/v1/responses?prompt=hello");
});
