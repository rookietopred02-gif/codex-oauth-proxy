import assert from "node:assert/strict";

import { createCodexAccountIdentityHelpers } from "./src/runtime/codex-account-identity.js";
import { createCodexAuthPoolCoreHelpers } from "./src/runtime/codex-auth-pool-core.js";
import { createCodexOAuthCallbackRuntime } from "./src/server/oauth-callback-runtime.js";
import { normalizeToken } from "./src/server/store-utils.js";

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.signature`;
}

function createHelpers({ strategy = "manual" } = {}) {
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
    getStrategy: () => strategy
  });
  return { identity, poolCore };
}

function logPass(name) {
  console.log(`PASS ${name}`);
}

async function smokeSameUserDifferentPlansStaySeparate() {
  const { poolCore } = createHelpers();
  const freeAccessToken = encodeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_free",
      chatgpt_account_user_id: "user_same__acct_free",
      chatgpt_plan_type: "free"
    },
    "https://api.openai.com/profile": {
      email: "same-user@example.com"
    }
  });
  const teamAccessToken = encodeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "user_same__acct_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "same-user@example.com"
    }
  });

  const normalized = poolCore.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "user_same__acct_free::plan:free",
        account_id: "acct_free",
        token: { access_token: freeAccessToken, refresh_token: "refresh-free" },
        usage_snapshot: { plan_type: "free" },
        enabled: true
      },
      {
        identity_id: "user_same__acct_team::plan:team",
        account_id: "acct_team",
        token: { access_token: teamAccessToken, refresh_token: "refresh-team" },
        usage_snapshot: { plan_type: "team" },
        enabled: true
      }
    ],
    active_account_id: "user_same__acct_team::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 2);
  assert.deepEqual(
    normalized.store.accounts.map((account) => account.identity_id).sort(),
    ["user_same__acct_free::plan:free", "user_same__acct_team::plan:team"]
  );
  logPass("same user free/team variants stay separate");
}

async function smokeSharedTeamWorkspaceUsersStaySeparate() {
  const { poolCore } = createHelpers();
  const accessTokenA = encodeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "user_a__acct_shared_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "user-a@example.com"
    }
  });
  const accessTokenB = encodeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "user_b__acct_shared_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "user-b@example.com"
    }
  });

  const normalized = poolCore.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "user_a__acct_shared_team::plan:team",
        account_id: "acct_shared_team",
        token: { access_token: accessTokenA, refresh_token: "refresh-a" },
        usage_snapshot: { plan_type: "team" },
        enabled: true
      },
      {
        identity_id: "user_b__acct_shared_team::plan:team",
        account_id: "acct_shared_team",
        token: { access_token: accessTokenB, refresh_token: "refresh-b" },
        usage_snapshot: { plan_type: "team" },
        enabled: true
      }
    ],
    active_account_id: "user_b__acct_shared_team::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 2);
  assert.deepEqual(
    normalized.store.accounts.map((account) => account.identity_id).sort(),
    ["user_a__acct_shared_team::plan:team", "user_b__acct_shared_team::plan:team"]
  );
  logPass("different users sharing one team workspace stay separate");
}

async function smokeCallbackCanonicalizesSamePlanOrgCandidate() {
  const { identity, poolCore } = createHelpers();
  const accessToken = encodeJwt({
    sub: "sub_shared",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "user_shared__acct_team",
      chatgpt_plan_type: "team"
    },
    "https://api.openai.com/profile": {
      email: "canonical@example.com"
    }
  });
  const idToken = encodeJwt({
    sub: "sub_shared",
    email: "canonical@example.com",
    organizations: [{ id: "org_personal" }]
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
    logger: { error() {} },
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
      return {
        fetched_at: 1710000000,
        plan_type: account?.account_id === "org_personal" ? "team" : "team",
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

  runtime.pendingAuth.set("state_canonical", {
    verifier: "verifier",
    createdAt: Date.now(),
    mode: "codex-oauth",
    label: "",
    slot: 2,
    force: false
  });

  await runtime.completeOAuthCallback({
    code: "code",
    state: "state_canonical"
  });

  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0]?.account_id, "acct_team");
  assert.equal(store.accounts[0]?.identity_id, "user_shared__acct_team::plan:team");
  logPass("callback stores one canonical team variant instead of an org alias");
}

async function main() {
  await smokeSameUserDifferentPlansStaySeparate();
  await smokeSharedTeamWorkspaceUsersStaySeparate();
  await smokeCallbackCanonicalizesSamePlanOrgCandidate();
  console.log("Smoke test completed");
}

main().catch((error) => {
  console.error("Smoke test failed");
  console.error(error);
  process.exitCode = 1;
});
