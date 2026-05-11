import assert from "node:assert/strict";
import test from "node:test";

import { createCodexAccountIdentityHelpers } from "../src/runtime/codex-account-identity.js";
import { createCodexAuthPoolCoreHelpers } from "../src/runtime/codex-auth-pool-core.js";

function encodeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.signature`;
}

function createHelpers({ strategy = "smart" } = {}) {
  const identity = createCodexAccountIdentityHelpers({
    jwtClaimPath: "https://api.openai.com/auth"
  });
  return createCodexAuthPoolCoreHelpers({
    normalizeToken(tokenResponse, currentToken = null) {
      return {
        ...(currentToken || {}),
        ...tokenResponse
      };
    },
    parseSlotValue(value) {
      if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
      }
      if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      }
      return null;
    },
    normalizePlanType: identity.normalizeOpenAICodexPlanType,
    extractAccountId: identity.extractOpenAICodexAccountId,
    extractPrincipalId: identity.extractOpenAICodexPrincipalId,
    extractPlanType: identity.extractOpenAICodexPlanType,
    extractEmail: identity.extractOpenAICodexEmail,
    getStrategy: () => strategy
  });
}

test("ensureCodexOAuthStoreShape hydrates blank pooled account labels from access token profile email", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "principal_team",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "team-user@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_team::plan:team",
        account_id: "acct_team",
        label: "",
        enabled: true,
        token: {
          access_token: accessToken
        }
      }
    ],
    active_account_id: "principal_team::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts[0]?.label, "team-user@example.com");
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape replaces generated account labels with profile email", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_generated_label",
      chatgpt_account_user_id: "principal_generated_label",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "named-user@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_generated_label::plan:team",
        account_id: "acct_generated_label",
        label: "acc16",
        enabled: true,
        token: {
          access_token: accessToken
        }
      }
    ],
    active_account_id: "principal_generated_label::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts[0]?.label, "named-user@example.com");
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape corrects polluted email labels to the token email", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team_polluted",
      chatgpt_account_user_id: "principal_team_polluted",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "real-owner@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_team_polluted::plan:team",
        account_id: "acct_team_polluted",
        label: "wrong-owner@example.com",
        enabled: true,
        token: {
          access_token: accessToken
        }
      }
    ],
    active_account_id: "principal_team_polluted::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts[0]?.label, "real-owner@example.com");
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape removes generated labels when no profile name exists", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_no_label",
      chatgpt_account_user_id: "principal_no_label",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {}
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_no_label::plan:team",
        account_id: "acct_no_label",
        label: "acc16",
        enabled: true,
        token: {
          access_token: accessToken
        }
      },
      {
        identity_id: "principal_no_label_2::plan:team",
        account_id: "acct_no_label_2",
        label: "acct_no_label_2",
        enabled: true,
        token: {
          access_token: encodeJwt({
            sub: "fallback_sub_2",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_no_label_2",
              chatgpt_account_user_id: "principal_no_label_2",
              chatgpt_plan_type: "Team"
            },
            "https://api.openai.com/profile": {}
          })
        }
      }
    ],
    active_account_id: "principal_no_label::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts[0]?.label, "");
  assert.equal(normalized.store.accounts[1]?.label, "");
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape falls back to id_token email when access token profile has no email", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_id_email",
      chatgpt_account_user_id: "principal_id_email",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {}
  });
  const idToken = encodeJwt({
    sub: "id_sub",
    email: "id-email@example.com"
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_id_email::plan:team",
        account_id: "acct_id_email",
        enabled: true,
        token: {
          access_token: accessToken,
          id_token: idToken
        }
      }
    ],
    active_account_id: "principal_id_email::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts[0]?.label, "id-email@example.com");
  assert.equal(normalized.changed, true);
});

test("upsertCodexOAuthAccount applies an incoming user label to an existing blank account", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_incoming",
      chatgpt_account_user_id: "principal_incoming",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {}
  });
  const store = {
    accounts: [
      {
        identity_id: "principal_incoming::plan:team",
        account_id: "acct_incoming",
        label: "",
        enabled: true,
        token: {
          access_token: accessToken
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  const upsert = helpers.upsertCodexOAuthAccount(
    store,
    {
      access_token: accessToken,
      refresh_token: "refresh"
    },
    {
      label: "Team workspace"
    }
  );

  assert.equal(upsert.action, "updated_existing_account");
  assert.equal(upsert.account?.label, "Team workspace");
});

test("upsertCodexOAuthAccount ignores generated incoming account labels", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_generated_incoming",
      chatgpt_account_user_id: "principal_generated_incoming",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "incoming-email@example.com"
    }
  });
  const store = {
    accounts: [],
    rotation: { next_index: 0 }
  };

  const upsert = helpers.upsertCodexOAuthAccount(
    store,
    {
      access_token: accessToken,
      refresh_token: "refresh"
    },
    {
      label: "acc7"
    }
  );

  assert.equal(upsert.action, "created");
  assert.equal(upsert.account?.label, "incoming-email@example.com");
});

test("upsertCodexOAuthAccount keeps same ChatGPT account on different plans as separate entries", () => {
  const helpers = createHelpers();
  const teamAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_plan",
      chatgpt_account_user_id: "principal_shared_plan",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "shared-plan@example.com"
    }
  });
  const freeAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_plan",
      chatgpt_account_user_id: "principal_shared_plan",
      chatgpt_plan_type: "Free"
    },
    "https://api.openai.com/profile": {
      email: "shared-plan@example.com"
    }
  });

  const store = {
    accounts: [
      {
        identity_id: "principal_shared_plan::plan:team",
        account_id: "acct_shared_plan",
        label: "team variant",
        enabled: true,
        token: {
          access_token: teamAccessToken,
          refresh_token: "refresh-team"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    active_account_id: "principal_shared_plan::plan:team",
    rotation: { next_index: 0 }
  };

  const upsert = helpers.upsertCodexOAuthAccount(
    store,
    {
      access_token: freeAccessToken,
      refresh_token: "refresh-free"
    },
    {
      label: "free variant",
      planType: "free"
    }
  );

  assert.equal(upsert.action, "created");
  assert.equal(store.accounts.length, 2);
  assert.deepEqual(
    store.accounts.map((account) => account.identity_id).sort(),
    ["principal_shared_plan::plan:free", "principal_shared_plan::plan:team"]
  );
  assert.equal(store.active_account_id, "principal_shared_plan::plan:free");
});

test("ensureCodexOAuthStoreShape keeps distinct plan variants for the same ChatGPT account", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const teamAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_multi_plan",
      chatgpt_account_user_id: "principal_multi_plan",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "multi-plan@example.com"
    }
  });
  const freeAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_multi_plan",
      chatgpt_account_user_id: "principal_multi_plan",
      chatgpt_plan_type: "Free"
    },
    "https://api.openai.com/profile": {
      email: "multi-plan@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_multi_plan::plan:team",
        account_id: "acct_multi_plan",
        enabled: true,
        token: {
          access_token: teamAccessToken,
          refresh_token: "refresh-team"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      },
      {
        identity_id: "principal_multi_plan::plan:free",
        account_id: "acct_multi_plan",
        enabled: true,
        token: {
          access_token: freeAccessToken,
          refresh_token: "refresh-free"
        },
        usage_snapshot: {
          plan_type: "free"
        }
      }
    ],
    active_account_id: "principal_multi_plan::plan:free",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 2);
  assert.deepEqual(
    normalized.store.accounts.map((account) => account.identity_id).sort(),
    ["principal_multi_plan::plan:free", "principal_multi_plan::plan:team"]
  );
  assert.equal(normalized.store.active_account_id, "principal_multi_plan::plan:free");
});

test("ensureCodexOAuthStoreShape keeps shared team workspace variants separate across different users", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const sharedTeamAccessTokenA = encodeJwt({
    sub: "fallback_sub_a",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "principal_user_a__acct_shared_team",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "user-a@example.com"
    }
  });
  const sharedTeamAccessTokenB = encodeJwt({
    sub: "fallback_sub_b",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_shared_team",
      chatgpt_account_user_id: "principal_user_b__acct_shared_team",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "user-b@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_user_a__acct_shared_team::plan:team",
        account_id: "acct_shared_team",
        enabled: true,
        token: {
          access_token: sharedTeamAccessTokenA,
          refresh_token: "refresh-a"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      },
      {
        identity_id: "principal_user_b__acct_shared_team::plan:team",
        account_id: "acct_shared_team",
        enabled: true,
        token: {
          access_token: sharedTeamAccessTokenB,
          refresh_token: "refresh-b"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    active_account_id: "principal_user_b__acct_shared_team::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 2);
  assert.deepEqual(
    normalized.store.accounts.map((account) => account.identity_id).sort(),
    ["principal_user_a__acct_shared_team::plan:team", "principal_user_b__acct_shared_team::plan:team"]
  );
});

test("ensureCodexOAuthStoreShape canonicalizes same-user same-plan org aliases back to the token account id", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team_canonical",
      chatgpt_account_user_id: "principal_same_user__acct_team_canonical",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "canonical@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_same_user__org_personal::plan:team",
        account_id: "org_personal",
        enabled: true,
        token: {
          access_token: accessToken,
          refresh_token: "refresh-team"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    active_account_id: "principal_same_user__org_personal::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 1);
  assert.equal(normalized.store.accounts[0]?.account_id, "acct_team_canonical");
  assert.equal(normalized.store.accounts[0]?.identity_id, "principal_same_user__acct_team_canonical::plan:team");
  assert.equal(normalized.store.active_account_id, "principal_same_user__acct_team_canonical::plan:team");
});

test("ensureCodexOAuthStoreShape keeps a planless top-level token aligned to the active plan variant", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const teamAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_top_level_planless",
      chatgpt_account_user_id: "principal_top_level_planless",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "planless-top-level@example.com"
    }
  });
  const freeAccessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_top_level_planless",
      chatgpt_account_user_id: "principal_top_level_planless",
      chatgpt_plan_type: "Free"
    },
    "https://api.openai.com/profile": {
      email: "planless-top-level@example.com"
    }
  });
  const planlessTopLevelToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_top_level_planless",
      chatgpt_account_user_id: "principal_top_level_planless"
    },
    "https://api.openai.com/profile": {
      email: "planless-top-level@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    token: {
      access_token: planlessTopLevelToken,
      refresh_token: "refresh-team"
    },
    accounts: [
      {
        identity_id: "principal_top_level_planless::plan:team",
        account_id: "acct_top_level_planless",
        enabled: true,
        token: {
          access_token: teamAccessToken,
          refresh_token: "refresh-team"
        },
        usage_snapshot: {
          plan_type: "team"
        }
      },
      {
        identity_id: "principal_top_level_planless::plan:free",
        account_id: "acct_top_level_planless",
        enabled: true,
        token: {
          access_token: freeAccessToken,
          refresh_token: "refresh-free"
        },
        usage_snapshot: {
          plan_type: "free"
        }
      }
    ],
    active_account_id: "principal_top_level_planless::plan:team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 2);
  assert.equal(normalized.store.active_account_id, "principal_top_level_planless::plan:team");
  assert.equal(normalized.store.token?.refresh_token, "refresh-team");
  assert.deepEqual(
    normalized.store.accounts.map((account) => account.identity_id).sort(),
    ["principal_top_level_planless::plan:free", "principal_top_level_planless::plan:team"]
  );
});

test("ensureCodexOAuthStoreShape deduplicates legacy planless entries and repoints manual active selection", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_team",
      chatgpt_account_user_id: "principal_team",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "team-user@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    token: {
      access_token: accessToken
    },
    accounts: [
      {
        identity_id: "principal_team",
        account_id: "acct_team",
        label: "legacy entry",
        enabled: true,
        token: {
          access_token: accessToken
        }
      },
      {
        identity_id: "principal_team::plan:team",
        account_id: "acct_team",
        label: "canonical entry",
        enabled: true,
        token: {
          access_token: accessToken
        },
        usage_snapshot: {
          plan_type: "team",
          primary: { remaining_percent: 88 }
        }
      }
    ],
    active_account_id: "principal_team",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 1);
  assert.equal(normalized.store.accounts[0]?.identity_id, "principal_team::plan:team");
  assert.equal(normalized.store.accounts[0]?.usage_snapshot?.plan_type, "team");
  assert.equal(normalized.store.active_account_id, "principal_team::plan:team");
  assert.equal(normalized.store.token?.access_token, accessToken);
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape does not recreate a planless duplicate from the top-level token store", () => {
  const helpers = createHelpers({ strategy: "manual" });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    token: {
      access_token: "token_plain"
    },
    accounts: [
      {
        identity_id: "acct:acct_plain::plan:team",
        account_id: "acct_plain",
        enabled: true,
        token: {
          access_token: "token_plain"
        },
        usage_snapshot: {
          plan_type: "team",
          primary: { remaining_percent: 91 }
        }
      },
      {
        identity_id: "acct:acct_plain",
        account_id: "acct_plain",
        enabled: true,
        token: {
          access_token: "token_plain"
        }
      }
    ],
    active_account_id: "acct:acct_plain",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.accounts.length, 1);
  assert.match(String(normalized.store.accounts[0]?.identity_id || ""), /::plan:team$/);
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape remaps manual active selection when the stored plan suffix is stale", () => {
  const helpers = createHelpers({ strategy: "manual" });
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_plan_shift",
      chatgpt_account_user_id: "principal_plan_shift",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "shifted-plan@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_plan_shift::plan:team",
        account_id: "acct_plan_shift",
        enabled: true,
        token: {
          access_token: accessToken
        },
        usage_snapshot: {
          plan_type: "team"
        }
      }
    ],
    active_account_id: "principal_plan_shift::plan:free",
    rotation: { next_index: 0 }
  });

  assert.equal(normalized.store.active_account_id, "principal_plan_shift::plan:team");
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape normalizes malformed numeric account fields", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_malformed_numbers",
      chatgpt_account_user_id: "principal_malformed_numbers",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "malformed-numbers@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_malformed_numbers::plan:team",
        account_id: "acct_malformed_numbers",
        enabled: true,
        token: {
          access_token: accessToken
        },
        slot: Symbol("slot"),
        created_at: Symbol("created"),
        last_used_at: "NaN",
        failure_count: Infinity,
        cooldown_until: "Infinity",
        last_status_code: Symbol("status"),
        token_invalidated_at: -10,
        usage_updated_at: "not-a-timestamp"
      }
    ],
    active_account_id: "principal_malformed_numbers::plan:team",
    rotation: { next_index: "Infinity" }
  });

  const account = normalized.store.accounts[0];
  assert.equal(account.slot, 1);
  assert.ok(Number.isFinite(account.created_at));
  assert.ok(account.created_at > 0);
  assert.equal(account.last_used_at, 0);
  assert.equal(account.failure_count, 0);
  assert.equal(account.cooldown_until, 0);
  assert.equal(account.last_status_code, 0);
  assert.equal(account.token_invalidated_at, 0);
  assert.equal(account.usage_updated_at, 0);
  assert.equal(normalized.store.rotation.next_index, 0);
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape rejects decimal-form integer account fields", () => {
  const helpers = createHelpers();
  const beforeSec = Math.floor(Date.now() / 1000);
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_decimal_numbers",
      chatgpt_account_user_id: "principal_decimal_numbers",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "decimal-numbers@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_decimal_numbers::plan:team",
        account_id: "acct_decimal_numbers",
        enabled: true,
        token: {
          access_token: accessToken
        },
        created_at: "12345.9",
        last_used_at: "10.9",
        failure_count: "2.9",
        cooldown_until: "77.7",
        token_invalidated_at: "88.8",
        usage_snapshot: {
          fetched_at: "99.9"
        },
        usage_updated_at: "66.6"
      }
    ],
    active_account_id: "principal_decimal_numbers::plan:team",
    rotation: { next_index: "1.9" }
  });

  const account = normalized.store.accounts[0];
  assert.ok(account.created_at >= beforeSec);
  assert.notEqual(account.created_at, 12345);
  assert.equal(account.last_used_at, 0);
  assert.equal(account.failure_count, 0);
  assert.equal(account.cooldown_until, 0);
  assert.equal(account.token_invalidated_at, 0);
  assert.equal(account.usage_updated_at, 0);
  assert.equal(normalized.store.rotation.next_index, 0);
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape drops out-of-range account status codes", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_bad_status",
      chatgpt_account_user_id: "principal_bad_status",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "bad-status@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_bad_status::plan:team",
        account_id: "acct_bad_status",
        enabled: true,
        token: {
          access_token: accessToken
        },
        last_status_code: 700
      }
    ],
    active_account_id: "principal_bad_status::plan:team"
  });

  assert.equal(normalized.store.accounts[0]?.last_status_code, 0);
  assert.equal(normalized.changed, true);
});

test("ensureCodexOAuthStoreShape drops decimal-form account status codes", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_decimal_status",
      chatgpt_account_user_id: "principal_decimal_status",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "decimal-status@example.com"
    }
  });

  const normalized = helpers.ensureCodexOAuthStoreShape({
    accounts: [
      {
        identity_id: "principal_decimal_status::plan:team",
        account_id: "acct_decimal_status",
        enabled: true,
        token: {
          access_token: accessToken
        },
        last_status_code: "401.0"
      }
    ],
    active_account_id: "principal_decimal_status::plan:team"
  });

  assert.equal(normalized.store.accounts[0]?.last_status_code, 0);
  assert.equal(normalized.changed, true);
});

test("upsertCodexOAuthAccount normalizes malformed existing numeric fields", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_upsert_numbers",
      chatgpt_account_user_id: "principal_upsert_numbers",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "upsert-numbers@example.com"
    }
  });
  const store = {
    accounts: [
      {
        identity_id: "principal_upsert_numbers::plan:team",
        account_id: "acct_upsert_numbers",
        enabled: true,
        token: {
          access_token: accessToken
        },
        slot: Symbol("slot"),
        last_status_code: 700,
        usage_updated_at: Symbol("usage")
      }
    ],
    active_account_id: "principal_upsert_numbers::plan:team",
    rotation: { next_index: Symbol("rotation") }
  };

  const upsert = helpers.upsertCodexOAuthAccount(store, { access_token: accessToken });
  const account = store.accounts[0];

  assert.equal(upsert.action, "updated_existing_account");
  assert.equal(upsert.slot, 1);
  assert.equal(account.slot, 1);
  assert.equal(account.last_status_code, 0);
  assert.equal(account.usage_updated_at, 0);
  assert.equal(store.rotation.next_index, 0);
});

test("upsertCodexOAuthAccount rejects decimal-form usage timestamps", () => {
  const helpers = createHelpers();
  const accessToken = encodeJwt({
    sub: "fallback_sub",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_upsert_decimal_numbers",
      chatgpt_account_user_id: "principal_upsert_decimal_numbers",
      chatgpt_plan_type: "Team"
    },
    "https://api.openai.com/profile": {
      email: "upsert-decimal-numbers@example.com"
    }
  });
  const store = {
    accounts: [],
    rotation: { next_index: "1.9" }
  };

  const beforeSec = Math.floor(Date.now() / 1000);
  const upsert = helpers.upsertCodexOAuthAccount(
    store,
    { access_token: accessToken },
    {
      usageSnapshot: {
        fetched_at: "12345.9"
      }
    }
  );
  const afterSec = Math.floor(Date.now() / 1000);
  const account = store.accounts[0];

  assert.equal(upsert.action, "created");
  assert.ok(account.usage_updated_at >= beforeSec);
  assert.ok(account.usage_updated_at <= afterSec);
  assert.notEqual(account.usage_updated_at, 12345);
  assert.equal(store.rotation.next_index, 0);
});
