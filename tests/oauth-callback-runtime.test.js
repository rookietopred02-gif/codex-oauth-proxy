import assert from "node:assert/strict";
import test from "node:test";

import { createCodexAccountIdentityHelpers } from "../src/runtime/codex-account-identity.js";
import { createCodexAuthPoolCoreHelpers } from "../src/runtime/codex-auth-pool-core.js";
import { createCodexOAuthCallbackRuntime } from "../src/server/oauth-callback-runtime.js";
import { normalizeToken } from "../src/server/store-utils.js";

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.signature`;
}

test("completeOAuthCallback keeps a single canonical variant when organization ids are also present", async () => {
  const identity = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const poolCore = createCodexAuthPoolCoreHelpers({
    normalizeToken,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    normalizePlanType: identity.normalizeOpenAICodexPlanType,
    extractAccountId: identity.extractOpenAICodexAccountId,
    extractPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractPlanType: identity.extractOpenAICodexPlanType,
    extractEmail: identity.extractOpenAICodexEmail,
    getStrategy: () => "manual"
  });

  const store = {
    token: null,
    accounts: [],
    rotation: { next_index: 0 },
    active_account_id: null
  };
  const oauthRuntime = {
    store,
    oauth: {
      tokenStorePath: "memory-store.json"
    }
  };

  const accessToken = encodeJwt({
    sub: "sub_shared",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "user_shared__acct_team"
    },
    "https://api.openai.com/profile": {
      email: "multi-org@example.com"
    }
  });
  const idToken = encodeJwt({
    sub: "sub_shared",
    email: "multi-org@example.com",
    organizations: [{ id: "acct_team" }, { id: "acct_free" }]
  });

  const runtime = createCodexOAuthCallbackRuntime({
    config: {
      authMode: "codex-oauth"
    },
    OAUTH_CALLBACK_SUCCESS_HTML: "<html><body></body></html>",
    logger: {
      error() {}
    },
    getActiveOAuthRuntime() {
      return oauthRuntime;
    },
    normalizeToken,
    extractOpenAICodexAccountId: identity.extractOpenAICodexAccountId,
    extractOpenAICodexPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractOpenAICodexEmail: identity.extractOpenAICodexEmail,
    extractOpenAICodexOrganizationIds: identity.extractOpenAICodexOrganizationIds,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    ensureCodexOAuthStoreShape: poolCore.ensureCodexOAuthStoreShape,
    normalizeOpenAICodexPlanType: identity.normalizeOpenAICodexPlanType,
    extractOpenAICodexPlanType: identity.extractOpenAICodexPlanType,
    async withTimeout(promise) {
      return await promise;
    },
    async fetchCodexUsageSnapshotForAccount(account) {
      const planType = account?.account_id === "acct_free" ? "free" : "team";
      return {
        fetched_at: 1710000000,
        plan_type: planType,
        primary: {
          remaining_percent: 80
        }
      };
    },
    upsertCodexOAuthAccount: poolCore.upsertCodexOAuthAccount,
    async saveTokenStore() {},
    clearAuthContextCache() {},
    async exchangeCodeForToken() {
      return {
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "refresh_token"
      };
    }
  });

  runtime.pendingAuth.set("state_multi_org", {
    verifier: "verifier",
    createdAt: Date.now(),
    mode: "codex-oauth",
    label: "",
    slot: 2,
    force: false
  });

  const summary = await runtime.completeOAuthCallback({
    code: "code",
    state: "state_multi_org"
  });

  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0]?.identity_id, "user_shared__acct_team::plan:team");
  assert.equal(store.accounts[0]?.account_id, "acct_team");
  assert.equal(summary.accountId, "acct_team");
  assert.equal(summary.planType, "team");
});

test("completeOAuthCallback re-enables an existing plan variant when usage probe fails", async () => {
  const identity = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const poolCore = createCodexAuthPoolCoreHelpers({
    normalizeToken,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    normalizePlanType: identity.normalizeOpenAICodexPlanType,
    extractAccountId: identity.extractOpenAICodexAccountId,
    extractPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractPlanType: identity.extractOpenAICodexPlanType,
    extractEmail: identity.extractOpenAICodexEmail,
    getStrategy: () => "manual"
  });

  const accessToken = encodeJwt({
    sub: "sub_team",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "user_shared__acct_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "team@example.com"
    }
  });
  const store = {
    token: null,
    accounts: [
      {
        identity_id: "user_shared__acct_team::plan:team",
        account_id: "acct_team",
        label: "team@example.com",
        enabled: false,
        last_error: "Refresh failed: HTTP 401 Unauthorized",
        last_status_code: 401,
        token_invalidated_at: 1710000000,
        token: {
          access_token: accessToken,
          refresh_token: "old_refresh"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    rotation: { next_index: 0 },
    active_account_id: "user_shared__acct_team::plan:team"
  };
  const oauthRuntime = {
    store,
    oauth: {
      tokenStorePath: "memory-store.json"
    }
  };

  const runtime = createCodexOAuthCallbackRuntime({
    config: {
      authMode: "codex-oauth"
    },
    OAUTH_CALLBACK_SUCCESS_HTML: "<html><body></body></html>",
    logger: {
      error() {}
    },
    getActiveOAuthRuntime() {
      return oauthRuntime;
    },
    normalizeToken,
    extractOpenAICodexAccountId: identity.extractOpenAICodexAccountId,
    extractOpenAICodexPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractOpenAICodexEmail: identity.extractOpenAICodexEmail,
    extractOpenAICodexOrganizationIds: identity.extractOpenAICodexOrganizationIds,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    ensureCodexOAuthStoreShape: poolCore.ensureCodexOAuthStoreShape,
    normalizeOpenAICodexPlanType: identity.normalizeOpenAICodexPlanType,
    extractOpenAICodexPlanType: identity.extractOpenAICodexPlanType,
    async withTimeout(promise) {
      return await promise;
    },
    async fetchCodexUsageSnapshotForAccount() {
      throw new Error("usage probe unavailable");
    },
    upsertCodexOAuthAccount: poolCore.upsertCodexOAuthAccount,
    async saveTokenStore() {},
    clearAuthContextCache() {},
    async exchangeCodeForToken() {
      return {
        access_token: accessToken,
        refresh_token: "new_refresh"
      };
    }
  });

  runtime.pendingAuth.set("state_team_probe_fail", {
    verifier: "verifier",
    createdAt: Date.now(),
    mode: "codex-oauth",
    label: "",
    slot: 2,
    force: false
  });

  const summary = await runtime.completeOAuthCallback({
    code: "code",
    state: "state_team_probe_fail"
  });

  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0]?.enabled, true);
  assert.equal(store.accounts[0]?.last_error, "");
  assert.equal(store.accounts[0]?.last_status_code, 0);
  assert.equal(store.accounts[0]?.token_invalidated_at, 0);
  assert.equal(store.accounts[0]?.token?.refresh_token, "new_refresh");
  assert.equal(summary.accountId, "acct_team");
  assert.equal(summary.planType, "team");
  assert.equal(summary.usageFetched, false);
  assert.equal(summary.usageFetchError, "usage probe unavailable");
});

test("completeOAuthCallback keeps shared team workspaces separate across different users", async () => {
  const identity = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const poolCore = createCodexAuthPoolCoreHelpers({
    normalizeToken,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    normalizePlanType: identity.normalizeOpenAICodexPlanType,
    extractAccountId: identity.extractOpenAICodexAccountId,
    extractPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractPlanType: identity.extractOpenAICodexPlanType,
    extractEmail: identity.extractOpenAICodexEmail,
    getStrategy: () => "manual"
  });

  const accessToken = encodeJwt({
    sub: "sub_shared_user_b",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "user_shared_b__acct_shared_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "shared-user-b@example.com"
    }
  });
  const idToken = encodeJwt({
    sub: "sub_shared_user_b",
    email: "shared-user-b@example.com",
    organizations: [{ id: "org-shared-team" }]
  });
  const existingAccessToken = encodeJwt({
    sub: "sub_shared_user_a",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "user_shared_a__acct_shared_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "shared-user-a@example.com"
    }
  });
  const store = {
    token: {
      access_token: existingAccessToken,
      refresh_token: "refresh_token_a"
    },
    accounts: [
      {
        identity_id: "user_shared_a__acct_shared_team::plan:team",
        account_id: "acct_shared_team",
        label: "shared-user-a@example.com",
        enabled: true,
        slot: 2,
        token: {
          access_token: existingAccessToken,
          refresh_token: "refresh_token_a"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    rotation: { next_index: 0 },
    active_account_id: "user_shared_a__acct_shared_team::plan:team"
  };
  const oauthRuntime = {
    store,
    oauth: {
      tokenStorePath: "memory-store.json"
    }
  };

  const runtime = createCodexOAuthCallbackRuntime({
    config: {
      authMode: "codex-oauth"
    },
    OAUTH_CALLBACK_SUCCESS_HTML: "<html><body></body></html>",
    logger: {
      error() {}
    },
    getActiveOAuthRuntime() {
      return oauthRuntime;
    },
    normalizeToken,
    extractOpenAICodexAccountId: identity.extractOpenAICodexAccountId,
    extractOpenAICodexPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractOpenAICodexEmail: identity.extractOpenAICodexEmail,
    extractOpenAICodexOrganizationIds: identity.extractOpenAICodexOrganizationIds,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    ensureCodexOAuthStoreShape: poolCore.ensureCodexOAuthStoreShape,
    normalizeOpenAICodexPlanType: identity.normalizeOpenAICodexPlanType,
    extractOpenAICodexPlanType: identity.extractOpenAICodexPlanType,
    async withTimeout(promise) {
      return await promise;
    },
    async fetchCodexUsageSnapshotForAccount() {
      return {
        fetched_at: 1710000000,
        plan_type: "team",
        primary: {
          remaining_percent: 80
        }
      };
    },
    upsertCodexOAuthAccount: poolCore.upsertCodexOAuthAccount,
    async saveTokenStore() {},
    clearAuthContextCache() {},
    async exchangeCodeForToken() {
      return {
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "refresh_token"
      };
    }
  });

  runtime.pendingAuth.set("state_existing_primary_new_org", {
    verifier: "verifier",
    createdAt: Date.now(),
    mode: "codex-oauth",
    label: "",
    slot: 16,
    force: false
  });

  const summary = await runtime.completeOAuthCallback({
    code: "code",
    state: "state_existing_primary_new_org"
  });

  assert.equal(store.accounts.length, 2);
  assert.deepEqual(
    store.accounts.map((account) => account.identity_id).sort(),
    ["user_shared_a__acct_shared_team::plan:team", "user_shared_b__acct_shared_team::plan:team"]
  );
  assert.equal(summary.accountId, "acct_shared_team");
  assert.equal(summary.action, "created");
  assert.equal(store.active_account_id, "user_shared_b__acct_shared_team::plan:team");
});

test("completeOAuthCallback rejects a login when the returned email does not match the requested email", async () => {
  const identity = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  const poolCore = createCodexAuthPoolCoreHelpers({
    normalizeToken,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    normalizePlanType: identity.normalizeOpenAICodexPlanType,
    extractAccountId: identity.extractOpenAICodexAccountId,
    extractPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractPlanType: identity.extractOpenAICodexPlanType,
    extractEmail: identity.extractOpenAICodexEmail,
    getStrategy: () => "manual"
  });

  const accessToken = encodeJwt({
    sub: "sub_team",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "user_shared__acct_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "imlegitarena@gmail.com"
    }
  });
  const store = {
    token: null,
    accounts: [],
    rotation: { next_index: 0 },
    active_account_id: null
  };
  const oauthRuntime = {
    store,
    oauth: {
      tokenStorePath: "memory-store.json"
    }
  };

  const runtime = createCodexOAuthCallbackRuntime({
    config: {
      authMode: "codex-oauth"
    },
    OAUTH_CALLBACK_SUCCESS_HTML: "<html><body></body></html>",
    logger: {
      error() {}
    },
    getActiveOAuthRuntime() {
      return oauthRuntime;
    },
    normalizeToken,
    extractOpenAICodexAccountId: identity.extractOpenAICodexAccountId,
    extractOpenAICodexPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractOpenAICodexEmail: identity.extractOpenAICodexEmail,
    extractOpenAICodexOrganizationIds: identity.extractOpenAICodexOrganizationIds,
    parseSlotValue(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    },
    ensureCodexOAuthStoreShape: poolCore.ensureCodexOAuthStoreShape,
    normalizeOpenAICodexPlanType: identity.normalizeOpenAICodexPlanType,
    extractOpenAICodexPlanType: identity.extractOpenAICodexPlanType,
    async withTimeout(promise) {
      return await promise;
    },
    async fetchCodexUsageSnapshotForAccount() {
      return {
        fetched_at: 1710000000,
        plan_type: "team",
        primary: {
          remaining_percent: 80
        }
      };
    },
    upsertCodexOAuthAccount: poolCore.upsertCodexOAuthAccount,
    async saveTokenStore() {},
    clearAuthContextCache() {},
    async exchangeCodeForToken() {
      return {
        access_token: accessToken,
        refresh_token: "refresh_token"
      };
    }
  });

  runtime.pendingAuth.set("state_email_mismatch", {
    verifier: "verifier",
    createdAt: Date.now(),
    mode: "codex-oauth",
    label: "",
    expectedEmail: "gifulin.tw@gmail.com",
    slot: 2,
    force: false
  });

  const summary = await runtime.completeOAuthCallback({
    code: "code",
    state: "state_email_mismatch"
  });

  assert.equal(store.accounts.length, 0);
  assert.equal(summary.action, "unexpected_account_email");
  assert.equal(summary.expectedEmail, "gifulin.tw@gmail.com");
  assert.equal(summary.actualEmail, "imlegitarena@gmail.com");
});
