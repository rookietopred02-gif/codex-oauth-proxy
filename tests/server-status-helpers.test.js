import assert from "node:assert/strict";
import test from "node:test";

async function importServerTesting(label) {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?server-status-helpers=${label}-${Date.now()}`);
  return serverModule.__testing;
}

test("server status helpers tolerate malformed status values", async () => {
  const testing = await importServerTesting("malformed-status");

  assert.equal(testing.mapHttpStatusToGeminiStatus(Symbol("status")), "INVALID_ARGUMENT");
  assert.equal(testing.mapHttpStatusToGeminiStatus("401.9"), "INVALID_ARGUMENT");
  assert.equal(testing.mapHttpStatusToGeminiStatus("401.0"), "INVALID_ARGUMENT");
  assert.equal(testing.mapHttpStatusToGeminiStatus("429"), "RESOURCE_EXHAUSTED");
  assert.equal(testing.mapHttpStatusToGeminiStatus(503), "INTERNAL");

  assert.equal(testing.mapHttpStatusToAnthropicErrorType(Symbol("status")), "invalid_request_error");
  assert.equal(testing.mapHttpStatusToAnthropicErrorType("401.9"), "invalid_request_error");
  assert.equal(testing.mapHttpStatusToAnthropicErrorType("401.0"), "invalid_request_error");
  assert.equal(testing.mapHttpStatusToAnthropicErrorType("429"), "rate_limit_error");
  assert.equal(testing.mapHttpStatusToAnthropicErrorType(503), "api_error");

  assert.equal(
    testing.resolveCompatErrorStatusCode({
      statusCode: Symbol("status"),
      message: "OAuth token missing"
    }),
    401
  );
  assert.equal(
    testing.resolveCompatErrorStatusCode({
      statusCode: "401.9",
      message: "plain upstream failure"
    }),
    502
  );
  assert.equal(
    testing.resolveCompatErrorStatusCode({
      statusCode: "401.0",
      message: "plain upstream failure"
    }),
    502
  );
  assert.equal(
    testing.resolveCompatErrorStatusCode({
      statusCode: Symbol("status"),
      message: "plain upstream failure"
    }),
    502
  );

  assert.equal(
    testing.isUnsupportedMaxOutputTokensError(Symbol("status"), "unsupported parameter: max_output_tokens"),
    false
  );
});

test("expired account cleanup timer tolerates malformed interval config", async () => {
  const testing = await importServerTesting("malformed-cleanup-interval");
  const previousConfig = testing.config.expiredAccountCleanup;
  testing.stopExpiredAccountCleanupTimer();

  try {
    testing.config.expiredAccountCleanup = {
      ...previousConfig,
      intervalSeconds: Symbol("interval")
    };

    const timer = testing.startExpiredAccountCleanupTimer();

    assert.equal(testing.getExpiredAccountCleanupTimer(), timer);
  } finally {
    testing.stopExpiredAccountCleanupTimer();
    testing.config.expiredAccountCleanup = previousConfig;
  }
});

test("preheat history counters reject malformed and decimal-form values", async () => {
  const testing = await importServerTesting("preheat-history-counters");

  assert.equal(testing.incrementPreheatHistoryCount(2), 3);
  assert.equal(testing.incrementPreheatHistoryCount("2"), 3);
  assert.equal(testing.incrementPreheatHistoryCount(0), 1);
  assert.equal(testing.incrementPreheatHistoryCount("2.0"), 1);
  assert.equal(testing.incrementPreheatHistoryCount(2.9), 1);
  assert.equal(testing.incrementPreheatHistoryCount(-1), 1);
  assert.equal(testing.incrementPreheatHistoryCount(Symbol("count")), 1);
});

test("token refresh result expiry rejects malformed and decimal-form values", async () => {
  const testing = await importServerTesting("refresh-result-expiry");

  assert.equal(testing.normalizeTokenRefreshResultExpiresAt(1770007200), 1770007200);
  assert.equal(testing.normalizeTokenRefreshResultExpiresAt("1770007200"), 1770007200);
  assert.equal(testing.normalizeTokenRefreshResultExpiresAt("1770007200.0"), 0);
  assert.equal(testing.normalizeTokenRefreshResultExpiresAt(1770007200.5), 0);
  assert.equal(testing.normalizeTokenRefreshResultExpiresAt(-1), 0);
  assert.equal(testing.normalizeTokenRefreshResultExpiresAt(Symbol("expires")), 0);
});

test("server integer helpers reject decimal-form values", async () => {
  const testing = await importServerTesting("server-integer-helpers");

  assert.equal(testing.parseInteger(2, 0), 2);
  assert.equal(testing.parseInteger("2", 0), 2);
  assert.equal(testing.parseInteger("2.0", 0), 0);
  assert.equal(testing.parseInteger(2.9, 0), 0);
  assert.equal(testing.parseInteger(Symbol("count"), 7), 7);

  assert.equal(testing.parsePositiveInteger(4096, 1), 4096);
  assert.equal(testing.parsePositiveInteger("4096", 1), 4096);
  assert.equal(testing.parsePositiveInteger("2.9", 4096), 4096);
  assert.equal(testing.parsePositiveInteger(2.9, 4096), 4096);
  assert.equal(testing.parsePositiveInteger(0, 4096), 4096);
});

test("OpenAI chat token estimation tolerates non-JSON-safe parsed fields", async () => {
  const testing = await importServerTesting("malformed-token-estimate-fields");

  const tokenCount = testing.estimateOpenAIChatCompletionTokens(Buffer.alloc(0), {
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { limit: 1n }
        }
      }
    ],
    tool_choice: { type: "function", function: { name: "lookup" }, extra: 1n },
    response_format: {
      toJSON() {
        throw new Error("response_format should not break estimation");
      }
    },
    metadata: { traceId: 1n }
  });

  assert.equal(Number.isInteger(tokenCount), true);
  assert.ok(tokenCount > 0);
});
