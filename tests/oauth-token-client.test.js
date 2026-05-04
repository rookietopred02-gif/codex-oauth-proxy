import assert from "node:assert/strict";
import test from "node:test";

import { refreshAccessToken } from "../src/server/oauth-token-client.js";

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
