import assert from "node:assert/strict";
import test from "node:test";

async function withTimeout(promise, message, ms = 200) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createStalledResponse(status = 200) {
  let cancelReason = null;
  const body = new ReadableStream({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  return {
    response: new Response(body, {
      status,
      headers: { "content-type": "application/json" }
    }),
    get cancelReason() {
      return cancelReason;
    }
  };
}

async function importServerTesting(label, envOverrides = {}) {
  const previousEnv = {
    CODEX_PRO_MAX_DISABLE_AUTOSTART: process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART
  };
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const serverModule = await import(`../src/server.js?codex-model-catalog=${label}-${Date.now()}`);
    return serverModule.__testing;
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("fetchCodexModelIdsForAccountToken bounds stalled model catalog response bodies", async () => {
  const originalFetch = globalThis.fetch;
  let upstream = null;
  let capturedUrl = "";
  let capturedInit = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url || "");
    capturedInit = init;
    upstream = createStalledResponse(200);
    return upstream.response;
  };

  try {
    const testing = await importServerTesting("stalled-body", {
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "7"
    });

    const modelIds = await withTimeout(
      testing.fetchCodexModelIdsForAccountToken("token_a", "acct_a"),
      "Codex model catalog body stalled"
    );

    assert.deepEqual(modelIds, []);
    assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    assert.match(capturedUrl, /\/codex\/models\?/);
    assert.equal(capturedInit?.method, "GET");
    assert.equal(capturedInit?.headers?.authorization, "Bearer token_a");
    assert.equal(capturedInit?.headers?.["chatgpt-account-id"], "acct_a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
