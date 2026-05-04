import assert from "node:assert/strict";
import test from "node:test";

test("usage refresh falls back to alternate codex models when the default model is unavailable for an account", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    const probeBodies = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init?.body || "{}"));
      probeBodies.push(body);
      if (body.model === "gpt-5.4") {
        return new Response("model access denied", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      if (body.model === "codex-mini-latest") {
        return new Response("", {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-codex-plan-type": "team",
            "x-codex-primary-used-percent": "20",
            "x-codex-primary-window-minutes": "300",
            "x-codex-secondary-used-percent": "35",
            "x-codex-secondary-window-minutes": "10080"
          }
        });
      }
      throw new Error(`unexpected model probe: ${body.model}`);
    };

    const serverModule = await import(`../src/server.js?usage-fallback=${Date.now()}`);
    const testing = serverModule.__testing;
    const previousDefaultModel = testing.config.codex.defaultModel;

    try {
      testing.config.codex.defaultModel = "gpt-5.4";

      const store = {
        token: null,
        active_account_id: "entry_a",
        rotation: { next_index: 0 },
        accounts: [
          {
            identity_id: "entry_a",
            account_id: "acct_a",
            enabled: true,
            token: {
              access_token: "token_a",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            },
            usage_snapshot: null,
            usage_updated_at: 0
          }
        ]
      };

      const result = await testing.refreshCodexUsageSnapshotInStore(
        store,
        "entry_a",
        testing.config.codexOAuth,
        {
          includeDisabled: true,
          modelCandidates: ["codex-mini-latest"]
        }
      );

      assert.equal(result.ok, true);
      assert.equal(result.model, "codex-mini-latest");
      assert.deepEqual(result.modelAttempts, ["gpt-5.4", "codex-mini-latest"]);
      assert.equal(probeBodies.length, 2);
      assert.equal(probeBodies[0]?.max_output_tokens, 1);
      assert.equal(probeBodies[1]?.max_output_tokens, 1);
      assert.equal(probeBodies[0]?.reasoning?.effort, "none");
      assert.equal(probeBodies[1]?.reasoning?.effort, "none");
      assert.equal(probeBodies[0]?.instructions, "Return one character.");
      assert.equal(probeBodies[1]?.instructions, "Return one character.");
      assert.equal(store.accounts[0]?.usage_snapshot?.plan_type, "team");
      assert.equal(store.accounts[0]?.usage_snapshot?.primary?.remaining_percent, 80);
      assert.equal(store.accounts[0]?.usage_snapshot?.secondary?.remaining_percent, 65);
    } finally {
      testing.config.codex.defaultModel = previousDefaultModel;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage refresh probe drops max_output_tokens when upstream rejects that field", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    const probeBodies = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init?.body || "{}"));
      probeBodies.push(body);
      if (Object.hasOwn(body, "max_output_tokens")) {
        return new Response("unsupported parameter: max_output_tokens", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "x-codex-plan-type": "team",
          "x-codex-primary-used-percent": "10",
          "x-codex-primary-window-minutes": "300"
        }
      });
    };

    const serverModule = await import(`../src/server.js?usage-max-output-fallback=${Date.now()}`);
    const testing = serverModule.__testing;
    const store = {
      token: null,
      active_account_id: "entry_a",
      rotation: { next_index: 0 },
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: {
            access_token: "token_a",
            expires_at: Math.floor(Date.now() / 1000) + 3600
          },
          usage_snapshot: null,
          usage_updated_at: 0
        }
      ]
    };

    const result = await testing.refreshCodexUsageSnapshotInStore(
      store,
      "entry_a",
      testing.config.codexOAuth,
      { includeDisabled: true }
    );

    assert.equal(result.ok, true);
    assert.equal(probeBodies.length, 2);
    assert.equal(probeBodies[0]?.max_output_tokens, 1);
    assert.equal(Object.hasOwn(probeBodies[1], "max_output_tokens"), false);
    assert.equal(probeBodies[0]?.reasoning?.effort, "none");
    assert.equal(probeBodies[1]?.reasoning?.effort, "none");
    assert.equal(typeof probeBodies[0]?.instructions, "string");
    assert.equal(typeof probeBodies[1]?.instructions, "string");
    assert.equal(store.accounts[0]?.usage_snapshot?.primary?.remaining_percent, 90);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage refresh probe includes instructions so codex upstream returns usage headers", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    const probeBodies = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init?.body || "{}"));
      probeBodies.push(body);
      if (!String(body?.instructions || "").trim()) {
        return new Response('{\"detail\":\"Instructions are required\"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "x-codex-plan-type": "team",
          "x-codex-primary-used-percent": "1",
          "x-codex-primary-window-minutes": "300",
          "x-codex-secondary-used-percent": "85",
          "x-codex-secondary-window-minutes": "10080"
        }
      });
    };

    const serverModule = await import(`../src/server.js?usage-instructions-required=${Date.now()}`);
    const testing = serverModule.__testing;
    const store = {
      token: null,
      active_account_id: "entry_a",
      rotation: { next_index: 0 },
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: {
            access_token: "token_a",
            expires_at: Math.floor(Date.now() / 1000) + 3600
          },
          usage_snapshot: null,
          usage_updated_at: 0
        }
      ]
    };

    const result = await testing.refreshCodexUsageSnapshotInStore(
      store,
      "entry_a",
      testing.config.codexOAuth,
      { includeDisabled: true }
    );

    assert.equal(result.ok, true);
    assert.equal(probeBodies.length, 1);
    assert.ok(String(probeBodies[0]?.instructions || "").trim().length > 0);
    assert.equal(store.accounts[0]?.usage_snapshot?.primary?.remaining_percent, 99);
    assert.equal(store.accounts[0]?.usage_snapshot?.secondary?.remaining_percent, 15);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage refresh invalidates token_revoked accounts instead of leaving them selectable", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("auth error code: token_revoked", {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "text/plain; charset=utf-8" }
      });

    const serverModule = await import(`../src/server.js?usage-token-revoked=${Date.now()}`);
    const testing = serverModule.__testing;
    const previousConfig = {
      authMode: testing.config.authMode,
      multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
      multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy,
      multiAccountPoolFilter: testing.config.codexOAuth.multiAccountPoolFilter
    };

    testing.config.authMode = "codex-oauth";
    testing.config.codexOAuth.multiAccountEnabled = true;
    testing.config.codexOAuth.multiAccountStrategy = "smart";
    testing.config.codexOAuth.multiAccountPoolFilter = "all";

    try {
      const store = {
        token: {
          access_token: "token_a"
        },
        active_account_id: "entry_a",
        rotation: { next_index: 0 },
        accounts: [
          {
            identity_id: "entry_a",
            account_id: "acct_a",
            enabled: true,
            token: {
              access_token: "token_a",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            },
            usage_snapshot: null,
            usage_updated_at: 0
          },
          {
            identity_id: "entry_b",
            account_id: "acct_b",
            enabled: true,
            token: {
              access_token: "token_b",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            }
          }
        ]
      };

      const result = await testing.refreshCodexUsageSnapshotInStore(
        store,
        "entry_a",
        testing.config.codexOAuth,
        { includeDisabled: true }
      );

      assert.equal(result.ok, false);
      assert.equal(result.tokenInvalidated, true);
      assert.equal(store.accounts[0].enabled, false);
      assert.ok(Number(store.accounts[0].token_invalidated_at || 0) > 0);
      assert.equal(store.token?.access_token, "token_b");
      assert.deepEqual(
        testing.pickCodexAccountCandidates(store).map((account) => account.identity_id),
        ["entry_b"]
      );
    } finally {
      testing.config.authMode = previousConfig.authMode;
      testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
      testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
      testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage refresh keeps active store token aligned when the active probe refreshes OAuth", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    let tokenRefreshCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes("/token")) {
        tokenRefreshCalls += 1;
        return new Response(JSON.stringify({ access_token: "token_a_refreshed", refresh_token: "refresh_a" }), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "x-codex-plan-type": "team",
          "x-codex-primary-used-percent": "5",
          "x-codex-primary-window-minutes": "300"
        }
      });
    };

    const serverModule = await import(`../src/server.js?usage-active-token-sync=${Date.now()}`);
    const testing = serverModule.__testing;
    const store = {
      token: {
        access_token: "token_a",
        refresh_token: "refresh_a"
      },
      active_account_id: "entry_a",
      rotation: { next_index: 0 },
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: {
            access_token: "token_a",
            refresh_token: "refresh_a",
            expires_at: 0
          },
          usage_snapshot: null,
          usage_updated_at: 0
        }
      ]
    };

    const result = await testing.refreshCodexUsageSnapshotInStore(
      store,
      "entry_a",
      {
        ...testing.config.codexOAuth,
        tokenUrl: "https://auth.example.test/token",
        clientId: "client"
      },
      { includeDisabled: true }
    );

    assert.equal(result.ok, true);
    assert.equal(tokenRefreshCalls, 1);
    assert.equal(store.accounts[0]?.token?.access_token, "token_a_refreshed");
    assert.equal(store.token?.access_token, "token_a_refreshed");
    assert.equal(store.active_account_id, store.accounts[0]?.identity_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scoped executable model candidates do not fall back to the global catalog when eligible account catalogs fail", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url || "");
      if (href.includes("/codex/models")) {
        return new Response("catalog unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const serverModule = await import(`../src/server.js?scoped-model-candidates=${Date.now()}`);
    const testing = serverModule.__testing;
    const previousConfig = {
      authMode: testing.config.authMode,
      multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
      multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy,
      multiAccountPoolFilter: testing.config.codexOAuth.multiAccountPoolFilter
    };

    try {
      testing.config.authMode = "codex-oauth";
      testing.config.codexOAuth.multiAccountEnabled = true;
      testing.config.codexOAuth.multiAccountStrategy = "manual";
      testing.config.codexOAuth.multiAccountPoolFilter = "all";
      testing.setCodexOAuthStore({
        token: null,
        active_account_id: "entry_free",
        rotation: { next_index: 0 },
        accounts: [
          {
            identity_id: "entry_free",
            account_id: "acct_free",
            enabled: true,
            token: {
              access_token: "token_free",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            }
          }
        ]
      });

      const modelIds = await testing.getExecutableModelCandidateIds({ forceRefresh: true });

      assert.deepEqual(modelIds, []);
    } finally {
      testing.config.authMode = previousConfig.authMode;
      testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
      testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
      testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
