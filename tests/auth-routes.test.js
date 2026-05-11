import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { readJsonBody } from "../src/http/request-body.js";
import { registerAuthRoutes } from "../src/routes/auth.js";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

function isFetchAllowedPort(port) {
  return Number.isInteger(port) && port > 0 && !FETCH_FORBIDDEN_PORTS.has(port);
}

async function listen(app) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? Number(address.port || 0) : 0;
    if (isFetchAllowedPort(port)) {
      return {
        server,
        url: `http://127.0.0.1:${port}`
      };
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  throw new Error("Could not reserve a fetch-compatible test port.");
}

function createAuthRouteContext(overrides = {}) {
  const oauthRuntime = {
    store: {
      active_account_id: "entry_a",
      accounts: [
        {
          entry_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: {
            access_token: "token_a"
          }
        }
      ],
      rotation: { next_index: 0 }
    },
    oauth: {
      authorizeUrl: "https://auth.example.invalid/oauth/authorize",
      clientId: "test-client",
      redirectUri: "http://127.0.0.1/auth/callback",
      scopes: ["openid"],
      tokenStorePath: "tokens.json"
    }
  };

  return {
    config: {
      authMode: "codex-oauth",
      profileStore: {
        authStorePath: "profile-auth.json"
      },
      codexOAuth: {
        originator: "codex-pro-max-test",
        redirectUri: "http://127.0.0.1/auth/callback"
      }
    },
    getAuthStatus: async () => ({ authenticated: true }),
    getActiveOAuthRuntime: () => oauthRuntime,
    ensureCodexOAuthCallbackServer: async () => {},
    randomBase64Url: () => "state",
    sha256base64url: () => "challenge",
    pendingAuth: new Map(),
    cleanupPendingStates: () => {},
    parseSlotValue: () => null,
    isCodexMultiAccountEnabled: () => false,
    completeOAuthCallback: async () => ({}),
    buildOAuthCallbackMessage: () => "",
    oauthCallbackSuccessHtml: "<html><body></body></html>",
    readJsonBody,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    replaceActiveOAuthStore: () => {},
    ...overrides
  };
}

function assertNoStoreHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
}

test("auth routes return no-store headers for status and login redirects", async () => {
  const app = express();
  registerAuthRoutes(app, createAuthRouteContext());

  const backend = await listen(app);
  try {
    const statusResponse = await fetch(`${backend.url}/auth/status`);
    assert.equal(statusResponse.status, 200);
    assertNoStoreHeaders(statusResponse);

    const loginResponse = await fetch(`${backend.url}/auth/login?email=user%40example.test`, {
      redirect: "manual"
    });
    assert.equal(loginResponse.status, 302);
    assertNoStoreHeaders(loginResponse);
    assert.match(loginResponse.headers.get("location") || "", /^https:\/\/auth\.example\.invalid\/oauth\/authorize\?/);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /auth/logout returns a controlled invalid_json error for malformed JSON", async () => {
  const app = express();
  let removeCalls = 0;
  let saveCalls = 0;
  let replaceCalls = 0;
  registerAuthRoutes(
    app,
    createAuthRouteContext({
      removeCodexPoolAccountFromStore: () => {
        removeCalls += 1;
        return { removed: false };
      },
      saveTokenStore: async () => {
        saveCalls += 1;
      },
      replaceActiveOAuthStore: () => {
        replaceCalls += 1;
      }
    })
  );

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/auth/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{\"entryId\":"
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assertNoStoreHeaders(response);
    assert.equal(body.error, "invalid_json");
    assert.equal(body.message, "Body must be valid JSON.");
    assert.equal(removeCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(replaceCalls, 0);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
