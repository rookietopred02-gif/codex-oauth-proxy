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

function createStalledResponse(status = 400) {
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
    const serverModule = await import(`../src/server.js?oauth-code-exchange=${label}-${Date.now()}`);
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

test("exchangeCodeForToken bounds stalled token endpoint response bodies", async () => {
  const originalFetch = globalThis.fetch;
  let upstream = null;
  let capturedUrl = null;
  let capturedInit = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = url;
    capturedInit = init;
    upstream = createStalledResponse(400);
    return upstream.response;
  };

  try {
    const testing = await importServerTesting("stalled-body", {
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "7"
    });

    await assert.rejects(
      withTimeout(
        testing.exchangeCodeForToken("code_a", "verifier_a", {
          tokenUrl: "https://auth.example.invalid/oauth/token",
          redirectUri: "http://127.0.0.1:1455/auth/callback",
          clientId: "client_a",
          clientSecret: "secret_a"
        }),
        "exchangeCodeForToken stalled on token endpoint response body"
      ),
      /Upstream body read failed/
    );

    assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    assert.equal(capturedUrl, "https://auth.example.invalid/oauth/token");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.headers?.["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(capturedInit?.body || ""));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "code_a");
    assert.equal(form.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
    assert.equal(form.get("client_id"), "client_a");
    assert.equal(form.get("code_verifier"), "verifier_a");
    assert.equal(form.get("client_secret"), "secret_a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshOpenAICodexToken bounds stalled token endpoint response bodies", async () => {
  const originalFetch = globalThis.fetch;
  let upstream = null;
  let capturedInit = null;
  globalThis.fetch = async (_url, init = {}) => {
    capturedInit = init;
    upstream = createStalledResponse(401);
    return upstream.response;
  };

  try {
    const testing = await importServerTesting("refresh-stalled-body", {
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "7"
    });

    await assert.rejects(
      withTimeout(
        testing.refreshOpenAICodexToken("refresh_a"),
        "refreshOpenAICodexToken stalled on token endpoint response body"
      ),
      /Upstream body read failed/
    );

    assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.headers?.["Content-Type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(capturedInit?.body || ""));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh_a");
    assert.ok(form.get("client_id"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
