import assert from "node:assert/strict";
import test from "node:test";

process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";

const { __testing } = await import("../src/server.js");

test("normalizeCodexServiceTier falls back to default for unsupported values", () => {
  assert.equal(__testing.normalizeCodexServiceTier("priority"), "priority");
  assert.equal(__testing.normalizeCodexServiceTier("DEFAULT"), "default");
  assert.equal(__testing.normalizeCodexServiceTier("fast-lane"), "default");
  assert.equal(__testing.normalizeCodexServiceTier("", "priority"), "priority");
});

test("normalizeCodexResponsesRequestBody injects priority service tier only when caller omits it", () => {
  const originalTier = __testing.config.codex.defaultServiceTier;
  try {
    __testing.config.codex.defaultServiceTier = "priority";

    const injected = __testing.normalizeCodexResponsesRequestBody(
      Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "hello" }), "utf8")
    );
    assert.equal(JSON.parse(injected.body.toString("utf8")).service_tier, "priority");

    const preserved = __testing.normalizeCodexResponsesRequestBody(
      Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "hello", service_tier: "default" }), "utf8")
    );
    assert.equal(JSON.parse(preserved.body.toString("utf8")).service_tier, "default");

    const fallback = __testing.normalizeCodexResponsesRequestBody(Buffer.alloc(0));
    assert.equal(JSON.parse(fallback.body.toString("utf8")).service_tier, "priority");
  } finally {
    __testing.config.codex.defaultServiceTier = originalTier;
  }
});

test("normalizeChatCompletionsRequestBody forwards or injects service tier correctly", () => {
  const originalTier = __testing.config.codex.defaultServiceTier;
  try {
    __testing.config.codex.defaultServiceTier = "priority";

    const injected = __testing.normalizeChatCompletionsRequestBody(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }]
        }),
        "utf8"
      )
    );
    assert.equal(JSON.parse(injected.body.toString("utf8")).service_tier, "priority");

    const preserved = __testing.normalizeChatCompletionsRequestBody(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }],
          service_tier: "default"
        }),
        "utf8"
      )
    );
    assert.equal(JSON.parse(preserved.body.toString("utf8")).service_tier, "default");

    __testing.config.codex.defaultServiceTier = "default";
    const omitted = __testing.normalizeChatCompletionsRequestBody(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }]
        }),
        "utf8"
      )
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(JSON.parse(omitted.body.toString("utf8")), "service_tier"),
      false
    );
  } finally {
    __testing.config.codex.defaultServiceTier = originalTier;
  }
});
