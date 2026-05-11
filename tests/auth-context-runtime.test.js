import assert from "node:assert/strict";
import test from "node:test";

import { createAuthContextRuntime } from "../src/server/auth-context-runtime.js";

function createRuntime({ strategy = "smart", pickCandidates, deriveEntryId, refreshAccessToken } = {}) {
  const savedStores = [];
  const runtime = createAuthContextRuntime({
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        multiAccountEnabled: true,
        multiAccountStrategy: strategy
      },
      expiredAccountCleanup: {
        enabled: false
      }
    },
    logger: console,
    ensureCodexOAuthStoreShape(store) {
      return { store, changed: false };
    },
    async saveTokenStore(_path, nextStore) {
      savedStores.push(structuredClone(nextStore));
    },
    normalizeToken(tokenResponse, currentToken = null) {
      return {
        ...(currentToken || {}),
        ...tokenResponse
      };
    },
    extractOpenAICodexAccountId(accessToken) {
      return accessToken ? `acct:${accessToken}` : null;
    },
    extractOpenAICodexPrincipalId(accessToken) {
      return accessToken ? `principal:${accessToken}` : null;
    },
    deriveCodexPoolEntryIdFromToken(tokenLike, extra = {}) {
      if (typeof deriveEntryId === "function") {
        return deriveEntryId(tokenLike, extra);
      }
      return tokenLike?.access_token ? `entry:${tokenLike.access_token}` : "";
    },
    upsertCodexOAuthAccount() {
      throw new Error("not used in these tests");
    },
    pickCodexAccountCandidates: pickCandidates,
    getCodexEnabledAccounts(store) {
      return Array.isArray(store?.accounts) ? store.accounts.filter((account) => account?.enabled !== false) : [];
    },
    getCodexPoolEntryId(account) {
      return String(account?.identity_id || account?.account_id || "");
    },
    clearAuthContextCache() {},
    expiredAccountCleanupController: {
      async run() {}
    },
    isCodexTokenInvalidatedError() {
      return false;
    },
    applyCodexInvalidatedAccountState(store, account, nowSec) {
      account.enabled = false;
      account.cooldown_until = 0;
      account.token_invalidated_at = nowSec;
      if (store.active_account_id === account.identity_id) {
        store.active_account_id = null;
      }
    },
    refreshAccessToken
  });

  return { runtime, savedStores };
}

test("smart strategy only attempts the top health-aware account per auth lookup", async () => {
  const { runtime, savedStores } = createRuntime({
    strategy: "smart",
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    }
  });

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
          expires_at: 0
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      },
      {
        identity_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: "",
        last_used_at: 0
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(store, {
        tokenStorePath: "store.json",
        tokenUrl: "https://example.test/token",
        clientId: "client"
      }),
    /Selected pooled OAuth account failed/
  );

  assert.equal(store.accounts[0].failure_count, 1);
  assert.match(String(store.accounts[0].last_error || ""), /no refresh token available/i);
  assert.equal(Number(store.accounts[1].failure_count || 0), 0);
  assert.equal(Number(store.accounts[1].last_used_at || 0), 0);
  assert.equal(savedStores.length, 1);
  assert.equal(savedStores[0]?.accounts?.[1]?.identity_id, "entry_b");
  assert.equal(Number(savedStores[0]?.accounts?.[1]?.last_used_at || 0), 0);
});

test("auth context normalizes malformed failure counters after pooled account failures", async () => {
  const refreshError = new Error("refresh failed");
  refreshError.statusCode = Symbol("status");
  const { runtime, savedStores } = createRuntime({
    strategy: "smart",
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    },
    async refreshAccessToken() {
      throw refreshError;
    }
  });

  const store = {
    token: null,
    active_account_id: "entry_malformed",
    rotation: { next_index: 0 },
    accounts: [
      {
        identity_id: "entry_malformed",
        account_id: "acct_malformed",
        enabled: true,
        token: {
          access_token: "token_malformed",
          refresh_token: "refresh_malformed",
          expires_at: 0
        },
        failure_count: "1.9",
        cooldown_until: "not-a-time",
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(store, {
        tokenStorePath: "store.json",
        tokenUrl: "https://example.test/token",
        clientId: "client"
      }),
    /Selected pooled OAuth account failed/
  );

  assert.equal(store.accounts[0].failure_count, 1);
  assert.equal(store.accounts[0].last_status_code, 0);
  assert.ok(Number.isFinite(store.accounts[0].cooldown_until));
  assert.ok(store.accounts[0].cooldown_until > Math.floor(Date.now() / 1000));
  assert.equal(savedStores.length, 1);
  assert.equal(savedStores[0]?.accounts?.[0]?.failure_count, 1);
  assert.ok(Number.isFinite(savedStores[0]?.accounts?.[0]?.cooldown_until));
});

test("auth context drops out-of-range failed account status metadata", async () => {
  const refreshError = new Error("refresh failed");
  refreshError.statusCode = 700;
  const { runtime, savedStores } = createRuntime({
    strategy: "smart",
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    },
    async refreshAccessToken() {
      throw refreshError;
    }
  });

  const store = {
    token: null,
    active_account_id: "entry_bad_status",
    rotation: { next_index: 0 },
    accounts: [
      {
        identity_id: "entry_bad_status",
        account_id: "acct_bad_status",
        enabled: true,
        token: {
          access_token: "token_bad_status",
          refresh_token: "refresh_bad_status",
          expires_at: 0
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(store, {
        tokenStorePath: "store.json",
        tokenUrl: "https://example.test/token",
        clientId: "client"
      }),
    /Selected pooled OAuth account failed/
  );

  assert.equal(store.accounts[0].last_status_code, 0);
  assert.equal(savedStores[0]?.accounts?.[0]?.last_status_code, 0);
});

test("auth context drops decimal-form failed account status metadata", async () => {
  const refreshError = new Error("refresh failed");
  refreshError.statusCode = "401.0";
  const { runtime, savedStores } = createRuntime({
    strategy: "smart",
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    },
    async refreshAccessToken() {
      throw refreshError;
    }
  });

  const store = {
    token: null,
    active_account_id: "entry_decimal_status",
    rotation: { next_index: 0 },
    accounts: [
      {
        identity_id: "entry_decimal_status",
        account_id: "acct_decimal_status",
        enabled: true,
        token: {
          access_token: "token_decimal_status",
          refresh_token: "refresh_decimal_status",
          expires_at: 0
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(store, {
        tokenStorePath: "store.json",
        tokenUrl: "https://example.test/token",
        clientId: "client"
      }),
    /Selected pooled OAuth account failed/
  );

  assert.equal(store.accounts[0].last_status_code, 0);
  assert.equal(savedStores[0]?.accounts?.[0]?.last_status_code, 0);
});

test("non-smart strategies can still fall through to the next pooled account", async () => {
  const { runtime, savedStores } = createRuntime({
    strategy: "sticky",
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    }
  });

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
          expires_at: 0
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      },
      {
        identity_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: "",
        last_used_at: 0
      }
    ]
  };

  const context = await runtime.getValidAuthContextFromCodexOAuthStore(store, {
    tokenStorePath: "store.json",
    tokenUrl: "https://example.test/token",
    clientId: "client"
  });

  assert.equal(context.accessToken, "token_b");
  assert.equal(context.poolEntryId, "entry:token_b");
  assert.equal(store.active_account_id, "entry:token_b");
  assert.equal(store.token?.access_token, "token_b");
  assert.equal(store.accounts[0].failure_count, 1);
  assert.ok(Number(store.accounts[1].last_used_at || 0) > 0);
  assert.equal(savedStores.length, 1);
});

test("preferred pooled account selection fails before mutating fallback account state", async () => {
  const { runtime, savedStores } = createRuntime({
    strategy: "sticky",
    pickCandidates(store, options = {}) {
      assert.equal(options.preferredPoolEntryId, "entry_a");
      return Array.isArray(store?.accounts) ? [store.accounts[1]] : [];
    }
  });

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
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      },
      {
        identity_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: "",
        last_used_at: 0
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(
        store,
        {
          tokenStorePath: "store.json",
          tokenUrl: "https://example.test/token",
          clientId: "client"
        },
        { preferredPoolEntryId: "entry_a" }
      ),
    {
      statusCode: 409,
      error: "response_id_account_unavailable"
    }
  );

  assert.equal(store.active_account_id, "entry_a");
  assert.equal(store.token, null);
  assert.equal(Number(store.accounts[1].last_used_at || 0), 0);
  assert.equal(savedStores.length, 0);
});

test("auth context forwards requested model into pooled account selection", async () => {
  let capturedRequestedModel = "";
  const { runtime, savedStores } = createRuntime({
    strategy: "sticky",
    pickCandidates(store, options = {}) {
      capturedRequestedModel = options.requestedModel || "";
      return Array.isArray(store?.accounts) ? [store.accounts[0]] : [];
    }
  });

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
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  const context = await runtime.getValidAuthContextFromCodexOAuthStore(
    store,
    {
      tokenStorePath: "store.json",
      tokenUrl: "https://example.test/token",
      clientId: "client"
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.equal(capturedRequestedModel, "gpt-5.5");
  assert.equal(context.accessToken, "token_a");
  assert.equal(savedStores.length, 1);
});

test("auth context reports a model-specific pool selection failure", async () => {
  const pickCalls = [];
  const { runtime, savedStores } = createRuntime({
    strategy: "sticky",
    pickCandidates(store, options = {}) {
      pickCalls.push({ ...options });
      if (options.requestedModel) return [];
      return Array.isArray(store?.accounts) ? [store.accounts[0]] : [];
    }
  });

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
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(
        store,
        {
          tokenStorePath: "store.json",
          tokenUrl: "https://example.test/token",
          clientId: "client"
        },
        { requestedModel: "gpt-5.5" }
      ),
    {
      statusCode: 409,
      error: "model_account_unavailable",
      requestedModel: "gpt-5.5"
    }
  );

  assert.deepEqual(
    pickCalls.map((options) => options.requestedModel || ""),
    ["gpt-5.5", ""]
  );
  assert.equal(savedStores.length, 0);
});

test("manual auth context reports a model-specific failure instead of using fallback accounts", async () => {
  const pickCalls = [];
  const { runtime, savedStores } = createRuntime({
    strategy: "manual",
    pickCandidates(store, options = {}) {
      pickCalls.push({ ...options });
      if (options.requestedModel) return [];
      return Array.isArray(store?.accounts) ? [store.accounts[0]] : [];
    }
  });

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
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      },
      {
        identity_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtime.getValidAuthContextFromCodexOAuthStore(
        store,
        {
          tokenStorePath: "store.json",
          tokenUrl: "https://example.test/token",
          clientId: "client"
        },
        { requestedModel: "gpt-5.5" }
      ),
    {
      statusCode: 409,
      error: "model_account_unavailable",
      requestedModel: "gpt-5.5"
    }
  );

  assert.deepEqual(
    pickCalls.map((options) => options.requestedModel || ""),
    ["gpt-5.5", ""]
  );
  assert.equal(Number(store.accounts[1].last_used_at || 0), 0);
  assert.equal(savedStores.length, 0);
});

test("auth context preserves an explicit pooled account variant instead of collapsing it back to the token account id", async () => {
  const { runtime, savedStores } = createRuntime({
    strategy: "manual",
    deriveEntryId(tokenLike, extra = {}) {
      const accountId = String(extra?.accountId || "").trim();
      const planType = String(extra?.planType || "").trim();
      return `principal:${tokenLike?.access_token || ""}__${accountId}::plan:${planType}`;
    },
    pickCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    }
  });

  const store = {
    token: null,
    active_account_id: "principal:token_team__org_personal::plan:team",
    rotation: { next_index: 0 },
    accounts: [
      {
        identity_id: "principal:token_team__org_personal::plan:team",
        account_id: "org_personal",
        enabled: true,
        token: {
          access_token: "token_team",
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        usage_snapshot: {
          plan_type: "team"
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  const context = await runtime.getValidAuthContextFromCodexOAuthStore(store, {
    tokenStorePath: "store.json",
    tokenUrl: "https://example.test/token",
    clientId: "client"
  });

  assert.equal(context.accountId, "org_personal");
  assert.equal(context.poolEntryId, "principal:token_team__org_personal::plan:team");
  assert.equal(store.accounts[0].account_id, "org_personal");
  assert.equal(store.accounts[0].identity_id, "principal:token_team__org_personal::plan:team");
  assert.equal(savedStores.length, 1);
});

test("pooled refresh 401 token_revoked invalidates the selected account", async () => {
  let invalidated = false;
  const runtimeWithRefreshFailure = createAuthContextRuntime({
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        multiAccountEnabled: true,
        multiAccountStrategy: "smart"
      },
      expiredAccountCleanup: {
        enabled: false
      }
    },
    logger: console,
    ensureCodexOAuthStoreShape(store) {
      return { store, changed: false };
    },
    async saveTokenStore() {},
    normalizeToken(tokenResponse, currentToken = null) {
      return {
        ...(currentToken || {}),
        ...tokenResponse
      };
    },
    extractOpenAICodexAccountId(accessToken) {
      return accessToken ? `acct:${accessToken}` : null;
    },
    extractOpenAICodexPrincipalId(accessToken) {
      return accessToken ? `principal:${accessToken}` : null;
    },
    deriveCodexPoolEntryIdFromToken(tokenLike) {
      return tokenLike?.access_token ? `entry:${tokenLike.access_token}` : "";
    },
    upsertCodexOAuthAccount() {
      throw new Error("not used in these tests");
    },
    pickCodexAccountCandidates(store) {
      return Array.isArray(store?.accounts) ? store.accounts : [];
    },
    getCodexEnabledAccounts(store) {
      return Array.isArray(store?.accounts) ? store.accounts.filter((account) => account?.enabled !== false) : [];
    },
    getCodexPoolEntryId(account) {
      return String(account?.identity_id || account?.account_id || "");
    },
    clearAuthContextCache() {},
    expiredAccountCleanupController: {
      async run() {}
    },
    isCodexTokenInvalidatedError(statusCode, reason) {
      return Number(statusCode || 0) === 401 && String(reason || "").includes("token_revoked");
    },
    applyCodexInvalidatedAccountState(store, account, nowSec) {
      invalidated = true;
      account.enabled = false;
      account.token_invalidated_at = nowSec;
      store.active_account_id = null;
      store.token = null;
    },
    async refreshAccessToken() {
      const err = new Error("token_revoked");
      err.statusCode = 401;
      throw err;
    }
  });

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
          refresh_token: "refresh_a",
          expires_at: 0
        },
        failure_count: 0,
        cooldown_until: 0,
        last_error: ""
      }
    ]
  };

  await assert.rejects(
    () =>
      runtimeWithRefreshFailure.getValidAuthContextFromCodexOAuthStore(store, {
        tokenStorePath: "store.json",
        tokenUrl: "https://example.test/token",
        clientId: "client"
      }),
    /Selected pooled OAuth account failed/
  );

  assert.equal(invalidated, true);
  assert.equal(store.accounts[0].enabled, false);
  assert.ok(Number(store.accounts[0].token_invalidated_at || 0) > 0);
  assert.equal(store.active_account_id, null);
});
