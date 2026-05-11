import assert from "node:assert/strict";
import test from "node:test";

import { refreshAccessToken } from "../src/server/oauth-token-client.js";

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
      statusText: "Bad Request",
      headers: { "content-type": "application/json" }
    }),
    get cancelReason() {
      return cancelReason;
    }
  };
}

test("refreshAccessToken posts the refresh grant and returns parsed token payload", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const payload = await refreshAccessToken(
    "refresh_a",
    {
      tokenUrl: "https://auth.example.test/token",
      clientId: "client_a",
      clientSecret: "secret_a"
    },
    {
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body || "");
        return new Response(JSON.stringify({ access_token: "access_a", expires_in: 3600 }), {
          status: 200,
          statusText: "OK"
        });
      }
    }
  );

  assert.equal(capturedUrl, "https://auth.example.test/token");
  assert.equal(payload.access_token, "access_a");
  assert.match(capturedBody, /grant_type=refresh_token/);
  assert.match(capturedBody, /refresh_token=refresh_a/);
  assert.match(capturedBody, /client_id=client_a/);
  assert.match(capturedBody, /client_secret=secret_a/);
});

test("refreshAccessToken bounds stalled token endpoint response bodies", async () => {
  let upstream = null;
  await assert.rejects(
    withTimeout(
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          responseBodyTimeoutMs: 5,
          fetchImpl: async () => {
            upstream = createStalledResponse(400);
            return upstream.response;
          }
        }
      ),
      "refreshAccessToken stalled on token endpoint response body"
    ),
    (err) => {
      assert.equal(err.code, "TOKEN_RESPONSE_BODY_TIMEOUT");
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /timed out/);
      assert.equal(upstream.cancelReason?.code, "TOKEN_RESPONSE_BODY_TIMEOUT");
      return true;
    }
  );
});

test("refreshAccessToken bounds stalled token endpoint text fallback bodies", async () => {
  let textCalled = false;

  await assert.rejects(
    withTimeout(
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          responseBodyTimeoutMs: 5,
          fetchImpl: async () => ({
            status: 400,
            statusText: "Bad Request",
            ok: false,
            async text() {
              textCalled = true;
              return await new Promise(() => {});
            }
          })
        }
      ),
      "refreshAccessToken stalled on token endpoint text fallback body"
    ),
    (err) => {
      assert.equal(err.code, "TOKEN_RESPONSE_BODY_TIMEOUT");
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /timed out/);
      return true;
    }
  );

  assert.equal(textCalled, true);
});

test("refreshAccessToken preserves upstream status and safe error detail", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "refresh token was already used"
              }),
              {
                status: 400,
                statusText: "Bad Request"
              }
            )
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.upstreamError, "invalid_grant");
      assert.match(err.message, /refresh token was already used/);
      return true;
    }
  );
});

test("refreshAccessToken normalizes malformed token endpoint status on invalid JSON", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () => ({
            status: Symbol("status"),
            statusText: "Bad Gateway",
            ok: false,
            async text() {
              return "not json";
            }
          })
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 0);
      assert.match(err.message, /HTTP 0/);
      return true;
    }
  );
});

test("refreshAccessToken rejects out-of-range token endpoint status on invalid JSON", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () => ({
            status: 700,
            statusText: "Bad Gateway",
            ok: false,
            async text() {
              return "not json";
            }
          })
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 0);
      assert.match(err.message, /HTTP 0/);
      return true;
    }
  );
});

test("refreshAccessToken normalizes malformed token endpoint status on upstream errors", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () => ({
            status: Symbol("status"),
            statusText: Symbol("statusText"),
            ok: false,
            async text() {
              return JSON.stringify({
                error: "temporarily_unavailable",
                error_description: "try later"
              });
            }
          })
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 0);
      assert.equal(err.upstreamError, "temporarily_unavailable");
      assert.match(err.message, /HTTP 0/);
      assert.match(err.message, /try later/);
      return true;
    }
  );
});

test("refreshAccessToken rejects fractional token endpoint status on upstream errors", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () => ({
            status: "401.9",
            statusText: "Unauthorized",
            ok: false,
            async text() {
              return JSON.stringify({
                error: "invalid_grant",
                error_description: "refresh token was already used"
              });
            }
          })
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 0);
      assert.equal(err.upstreamError, "invalid_grant");
      assert.match(err.message, /HTTP 0/);
      assert.match(err.message, /refresh token was already used/);
      return true;
    }
  );
});

test("refreshAccessToken rejects decimal-form token endpoint status on upstream errors", async () => {
  await assert.rejects(
    () =>
      refreshAccessToken(
        "refresh_a",
        {
          tokenUrl: "https://auth.example.test/token",
          clientId: "client_a"
        },
        {
          fetchImpl: async () => ({
            status: "401.0",
            statusText: "Unauthorized",
            ok: false,
            async text() {
              return JSON.stringify({
                error: "invalid_grant",
                error_description: "refresh token was already used"
              });
            }
          })
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 0);
      assert.equal(err.upstreamError, "invalid_grant");
      assert.match(err.message, /HTTP 0/);
      assert.match(err.message, /refresh token was already used/);
      return true;
    }
  );
});
