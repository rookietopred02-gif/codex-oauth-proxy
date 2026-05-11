import assert from "node:assert/strict";
import test, { after } from "node:test";

import { createCodexPoolSelectionHelpers } from "../src/runtime/codex-pool-selection.js";

const originalPoolFilterEnv = process.env.CODEX_MULTI_ACCOUNT_POOL_FILTER;
process.env.CODEX_MULTI_ACCOUNT_POOL_FILTER = "all";
after(() => {
  if (originalPoolFilterEnv === undefined) {
    delete process.env.CODEX_MULTI_ACCOUNT_POOL_FILTER;
  } else {
    process.env.CODEX_MULTI_ACCOUNT_POOL_FILTER = originalPoolFilterEnv;
  }
});

function createPoolSelectionHelpers({ strategy = "sticky", poolFilter = "all" } = {}) {
  return createCodexPoolSelectionHelpers({
    getEntryId(account) {
      return String(account?.identity_id || "");
    },
    isAccountLeased() {
      return false;
    },
    normalizePlanType(value) {
      return String(value || "").trim().toLowerCase() || null;
    },
    getStrategy() {
      return strategy;
    },
    getPoolFilter() {
      return poolFilter;
    },
    lowQuotaThresholdDualWindow: 20,
    lowQuotaThresholdSingleWindow: 20
  });
}

test("fresh second-based model capability caches filter requested models", () => {
  const helpers = createPoolSelectionHelpers();
  const nowSec = Math.floor(Date.now() / 1000);

  const candidates = helpers.pickCodexAccountCandidates(
    {
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          model_capabilities: {
            codex: {
              supported_models: ["gpt-5.4"],
              fetched_at: nowSec
            }
          }
        },
        {
          identity_id: "entry_b",
          enabled: true,
          model_capabilities: {
            codex: {
              supported_models: ["gpt-5.5"],
              fetched_at: nowSec
            }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_b"]
  );
});

test("stale model capability caches are treated as unknown support", () => {
  const helpers = createPoolSelectionHelpers();
  const staleFetchedAt = Date.now() - 10 * 60 * 1000;

  const candidates = helpers.pickCodexAccountCandidates(
    {
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          model_capabilities: {
            codex: {
              supported_models: ["gpt-5.4"],
              fetched_at: staleFetchedAt
            }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_a"]
  );
});

test("decimal-form model capability cache timestamps are treated as unknown support", () => {
  const helpers = createPoolSelectionHelpers();
  const nowMs = Date.now();

  const candidates = helpers.pickCodexAccountCandidates(
    {
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          model_capabilities: {
            codex: {
              supported_models: ["gpt-5.4"],
              fetched_at: `${nowMs}.9`
            }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_a"]
  );
});

test("blank and malformed quota metadata stays neutral for pool selection", () => {
  const helpers = createPoolSelectionHelpers();

  assert.equal(helpers.parsePercentOrNull(""), null);
  assert.equal(helpers.parsePercentOrNull("   "), null);
  assert.equal(helpers.parsePercentOrNull(Symbol("percent")), null);
  assert.equal(helpers.parsePercentOrNull(true), null);
  assert.equal(helpers.parsePercentOrNull("1e2"), null);
  assert.equal(helpers.parsePercentOrNull("0x10"), null);
  assert.equal(helpers.parsePercentOrNull({ valueOf: () => 50 }), null);
  assert.equal(helpers.parsePercentOrNull("12.5"), 12.5);

  const candidates = helpers.pickCodexAccountCandidates(
    {
      accounts: [
        {
          identity_id: "entry_blank_usage",
          enabled: true,
          token_invalidated_at: Symbol("invalidated"),
          cooldown_until: Symbol("cooldown"),
          usage_updated_at: Symbol("usage"),
          usage_snapshot: {
            fetched_at: Symbol("fetched"),
            primary: {
              remaining_percent: "",
              used_percent: "   ",
              window_minutes: Symbol("window"),
              reset_after_seconds: Symbol("reset")
            },
            secondary: {
              remaining_percent: "   ",
              used_percent: Symbol("used")
            }
          },
          model_capabilities: {
            codex: {
              supported_models: ["gpt-5.5"],
              fetched_at: Symbol("capability-fetched")
            }
          }
        }
      ],
      active_account_id: "entry_blank_usage",
      rotation: { next_index: Symbol("rotation") }
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_blank_usage"]
  );
});

test("decimal-form account health metadata stays neutral for pool selection", () => {
  const helpers = createPoolSelectionHelpers();
  const nowSec = Math.floor(Date.now() / 1000);

  const candidates = helpers.pickCodexAccountCandidates(
    {
      accounts: [
        {
          identity_id: "entry_decimal_health",
          enabled: true,
          token_invalidated_at: "1.5",
          cooldown_until: `${nowSec + 3600}.9`,
          token: {
            expires_at: `${nowSec - 60}.1`
          }
        }
      ],
      active_account_id: "entry_decimal_health",
      rotation: { next_index: "2.5" }
    },
    { requestedModel: "gpt-5.5" }
  );

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_decimal_health"]
  );
});

test("leased Codex accounts are deprioritized for new candidate selection", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?lease-selection=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  const releaseLease = testing.acquireCodexAccountLease({ poolEntryId: "entry_a" });
  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        { identity_id: "entry_a", enabled: true },
        { identity_id: "entry_b", enabled: true }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b", "entry_a"]
    );
  } finally {
    releaseLease();
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("preferred previous_response affinity can still pin a leased account", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?lease-affinity=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  const releaseLease = testing.acquireCodexAccountLease({ poolEntryId: "entry_a" });
  try {
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          { identity_id: "entry_a", enabled: true },
          { identity_id: "entry_b", enabled: true }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      { preferredPoolEntryId: "entry_a" }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_a", "entry_b"]
    );
  } finally {
    releaseLease();
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("cached model capabilities exclude accounts that do not support the requested model", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?model-capability-preference=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const nowMs = Date.now();
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.4"],
                fetched_at: nowMs
              }
            }
          },
          {
            identity_id: "entry_b",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.5"],
                fetched_at: nowMs
              }
            }
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      { requestedModel: "gpt-5.5" }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("cached model capabilities keep unknown accounts while excluding known unsupported accounts", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?model-capability-unknown=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.4"],
                fetched_at: Date.now()
              }
            }
          },
          {
            identity_id: "entry_b",
            enabled: true
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      { requestedModel: "gpt-5.5" }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("cached model capabilities return no candidates when every eligible account lacks the requested model", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?model-capability-none=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const nowMs = Date.now();
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.4"],
                fetched_at: nowMs
              }
            }
          },
          {
            identity_id: "entry_b",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["codex-mini-latest"],
                fetched_at: nowMs
              }
            }
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      { requestedModel: "gpt-5.5" }
    );

    assert.deepEqual(candidates, []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("manual strategy refuses a fresh known-unsupported active model", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?manual-model-capability-none=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "manual";

  try {
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.4"],
                fetched_at: Date.now()
              }
            }
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      { requestedModel: "gpt-5.5" }
    );

    assert.deepEqual(candidates, []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("preferred previous_response affinity does not reinsert a known unsupported model account", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?model-capability-affinity=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const nowMs = Date.now();
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.4"],
                fetched_at: nowMs
              }
            }
          },
          {
            identity_id: "entry_b",
            enabled: true,
            model_capabilities: {
              codex: {
                supported_models: ["gpt-5.5"],
                fetched_at: nowMs
              }
            }
          }
        ],
        active_account_id: "entry_a",
        rotation: { next_index: 0 }
      },
      {
        preferredPoolEntryId: "entry_a",
        requestedModel: "gpt-5.5"
      }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("preferred previous_response affinity does not resurrect invalidated accounts", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?invalidated-affinity=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            token_invalidated_at: 12345
          },
          {
            identity_id: "entry_b",
            enabled: true,
            token_invalidated_at: 0
          }
        ],
        active_account_id: "entry_b",
        rotation: { next_index: 0 }
      },
      { preferredPoolEntryId: "entry_a" }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("preferred previous_response affinity does not resurrect cooldown accounts", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?cooldown-affinity=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "sticky";

  try {
    const candidates = testing.pickCodexAccountCandidates(
      {
        accounts: [
          {
            identity_id: "entry_a",
            enabled: true,
            cooldown_until: Math.floor(Date.now() / 1000) + 3600
          },
          {
            identity_id: "entry_b",
            enabled: true,
            cooldown_until: 0
          }
        ],
        active_account_id: "entry_b",
        rotation: { next_index: 0 }
      },
      { preferredPoolEntryId: "entry_a" }
    );

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy prefers higher weekly remaining before 5h remaining", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-active=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 95 },
            secondary: { remaining_percent: 30 }
          }
        },
        {
          identity_id: "entry_b",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 60 },
            secondary: { remaining_percent: 80 }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b", "entry_a"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy rotates away from repeatedly failing active accounts when healthy alternatives exist", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-failures=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        { identity_id: "entry_a", enabled: true, failure_count: 5, last_used_at: 0 },
        { identity_id: "entry_b", enabled: true, failure_count: 0, last_used_at: 100 }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b", "entry_a"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy uses 5h remaining as the tie-breaker when weekly remaining matches", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-window-tiebreak=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 40 },
            secondary: { remaining_percent: 75 }
          }
        },
        {
          identity_id: "entry_b",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 85 },
            secondary: { remaining_percent: 75 }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_b", "entry_a"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy keeps the active account when quota differences stay within the sticky margin", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-sticky-active=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_active",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 72 },
            secondary: { remaining_percent: 70 }
          }
        },
        {
          identity_id: "entry_other",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 80 },
            secondary: { remaining_percent: 76 }
          }
        }
      ],
      active_account_id: "entry_active",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_active", "entry_other"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy still switches away from the active account when another account is clearly healthier", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-sticky-threshold=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_active",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 60 },
            secondary: { remaining_percent: 60 }
          }
        },
        {
          identity_id: "entry_other",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 90 },
            secondary: { remaining_percent: 90 }
          }
        }
      ],
      active_account_id: "entry_active",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_other", "entry_active"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy temporarily avoids low-quota accounts while a healthier option exists", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-limited-rotation=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_healthy",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec,
            primary: { remaining_percent: 80 },
            secondary: { remaining_percent: 80 }
          }
        },
        {
          identity_id: "entry_limited",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec,
            primary: { remaining_percent: 75 },
            secondary: {
              remaining_percent: 10,
              reset_at: nowSec + 900,
              window_minutes: 10080
            }
          }
        }
      ],
      active_account_id: "entry_healthy",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_healthy"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy still pauses low-quota accounts when usage_updated_at is malformed", () => {
  const helpers = createPoolSelectionHelpers({ strategy: "smart" });
  const nowSec = Math.floor(Date.now() / 1000);

  const candidates = helpers.pickCodexAccountCandidates({
    accounts: [
      {
        identity_id: "entry_healthy",
        enabled: true,
        usage_snapshot: {
          fetched_at: nowSec,
          primary: { remaining_percent: 80 },
          secondary: { remaining_percent: 80 }
        }
      },
      {
        identity_id: "entry_limited",
        enabled: true,
        usage_updated_at: "1e3",
        usage_snapshot: {
          fetched_at: nowSec,
          primary: { remaining_percent: 75 },
          secondary: {
            remaining_percent: 10,
            reset_at: nowSec + 900,
            window_minutes: 10080
          }
        }
      }
    ],
    active_account_id: "entry_healthy",
    rotation: { next_index: 0 }
  });

  assert.deepEqual(
    candidates.map((account) => account.identity_id),
    ["entry_healthy"]
  );
});

test("smart strategy reconsiders low-quota accounts after the temporary pause window expires", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-limited-retry=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_healthy",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec - 3600,
            primary: { remaining_percent: 80 },
            secondary: { remaining_percent: 80 }
          }
        },
        {
          identity_id: "entry_limited",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec - 3600,
            primary: { remaining_percent: 75 },
            secondary: {
              remaining_percent: 10,
              window_minutes: 10080
            }
          }
        }
      ],
      active_account_id: "entry_healthy",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_healthy", "entry_limited"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy does not fallback when every usable account is temporarily quota-paused", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-low-quota-only=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec,
            primary: {
              remaining_percent: 18,
              reset_at: nowSec + 3600
            },
            secondary: {
              remaining_percent: 23,
              reset_at: nowSec + 7200
            }
          }
        },
        {
          identity_id: "entry_b",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec,
            primary: {
              remaining_percent: 30,
              reset_at: nowSec + 3600
            },
            secondary: {
              remaining_percent: 20,
              reset_at: nowSec + 7200
            }
          }
        },
        {
          identity_id: "entry_hard_limited",
          enabled: true,
          usage_snapshot: {
            fetched_at: nowSec,
            primary: {
              remaining_percent: 0,
              reset_at: nowSec + 3600
            },
            secondary: {
              remaining_percent: 6,
              reset_at: nowSec + 7200
            }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(candidates, []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy does not fallback to hard-limited accounts when no usable accounts remain", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?smart-no-fallback=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_a",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 0 },
            secondary: { remaining_percent: 80 }
          }
        },
        {
          identity_id: "entry_b",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 50 },
            secondary: { remaining_percent: 0 }
          }
        }
      ],
      active_account_id: "entry_a",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(candidates, []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("smart strategy excludes free accounts when the pool filter is exclude-free", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?pool-filter-exclude-free=${Date.now()}`);
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
  testing.config.codexOAuth.multiAccountPoolFilter = "exclude-free";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_free",
          enabled: true,
          usage_snapshot: {
            plan_type: "free",
            primary: { remaining_percent: 98 }
          }
        },
        {
          identity_id: "entry_team",
          enabled: true,
          usage_snapshot: {
            plan_type: "pro-team",
            primary: { remaining_percent: 72 },
            secondary: { remaining_percent: 61 }
          }
        }
      ],
      active_account_id: "entry_free",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_team"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("smart strategy only keeps team accounts when the pool filter is team-only", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?pool-filter-team-only=${Date.now()}`);
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
  testing.config.codexOAuth.multiAccountPoolFilter = "team-only";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "entry_plus",
          enabled: true,
          usage_snapshot: {
            plan_type: "plus",
            primary: { remaining_percent: 95 },
            secondary: { remaining_percent: 88 }
          }
        },
        {
          identity_id: "entry_team_a",
          enabled: true,
          usage_snapshot: {
            plan_type: "team",
            primary: { remaining_percent: 60 },
            secondary: { remaining_percent: 70 }
          }
        },
        {
          identity_id: "entry_team_b",
          enabled: true,
          usage_snapshot: {
            plan_type: "pro-team",
            primary: { remaining_percent: 80 },
            secondary: { remaining_percent: 75 }
          }
        }
      ],
      active_account_id: "entry_plus",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["entry_team_b", "entry_team_a"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("team-only pool filter falls back to the entry identity plan suffix when usage snapshots are blank", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?pool-filter-entry-plan-fallback=${Date.now()}`);
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
  testing.config.codexOAuth.multiAccountPoolFilter = "team-only";

  try {
    const candidates = testing.pickCodexAccountCandidates({
      accounts: [
        {
          identity_id: "user_free__acct_free::plan:free",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 100 }
          }
        },
        {
          identity_id: "user_team__acct_team::plan:team",
          enabled: true,
          usage_snapshot: {
            primary: { remaining_percent: 85 },
            secondary: { remaining_percent: 70 }
          }
        }
      ],
      active_account_id: "user_free__acct_free::plan:free",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(
      candidates.map((account) => account.identity_id),
      ["user_team__acct_team::plan:team"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("smart strategy keeps only standard or free accounts for narrow pool filters", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?pool-filter-standard-free=${Date.now()}`);
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

  const accounts = [
    {
      identity_id: "entry_free",
      enabled: true,
      usage_snapshot: {
        plan_type: "free",
        primary: { remaining_percent: 99 }
      }
    },
    {
      identity_id: "entry_plus",
      enabled: true,
      usage_snapshot: {
        plan_type: "plus",
        primary: { remaining_percent: 82 },
        secondary: { remaining_percent: 77 }
      }
    },
    {
      identity_id: "entry_team",
      enabled: true,
      usage_snapshot: {
        plan_type: "team",
        primary: { remaining_percent: 96 },
        secondary: { remaining_percent: 91 }
      }
    }
  ];

  function pickForFilter(filter) {
    testing.config.codexOAuth.multiAccountPoolFilter = filter;
    return testing
      .pickCodexAccountCandidates({
        accounts,
        active_account_id: "entry_team",
        rotation: { next_index: 0 }
      })
      .map((account) => account.identity_id);
  }

  try {
    assert.deepEqual(pickForFilter("standard-only"), ["entry_plus"]);
    assert.deepEqual(pickForFilter("free-only"), ["entry_free"]);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("manual strategy respects the team-only pool filter and does not keep a pinned free account", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?manual-team-only-filter=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy,
    multiAccountPoolFilter: testing.config.codexOAuth.multiAccountPoolFilter
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "manual";
  testing.config.codexOAuth.multiAccountPoolFilter = "team-only";

  try {
    const normalized = testing.ensureCodexOAuthStoreShape({
      accounts: [
        {
          identity_id: "entry_team::plan:team",
          account_id: "acct_team",
          enabled: true,
          token: { access_token: "token_team" }
        },
        {
          identity_id: "entry_free::plan:free",
          account_id: "acct_free",
          enabled: true,
          token: { access_token: "token_free" }
        }
      ],
      active_account_id: "entry_free::plan:free",
      rotation: { next_index: 0 }
    });

    assert.deepEqual(testing.pickCodexAccountCandidates(normalized.store), []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("manual strategy does not auto-select a fallback active account", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?manual-no-fallback=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy,
    multiAccountPoolFilter: testing.config.codexOAuth.multiAccountPoolFilter
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "manual";
  testing.config.codexOAuth.multiAccountPoolFilter = "all";

  try {
    const normalized = testing.ensureCodexOAuthStoreShape({
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: { access_token: "token_a" }
        },
        {
          identity_id: "entry_b",
          account_id: "acct_b",
          enabled: true,
          token: { access_token: "token_b" }
        }
      ],
      active_account_id: null,
      rotation: { next_index: 0 }
    });

    assert.equal(normalized.store.active_account_id, null);
    assert.deepEqual(testing.pickCodexAccountCandidates(normalized.store), []);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
    testing.config.codexOAuth.multiAccountPoolFilter = previousConfig.multiAccountPoolFilter;
  }
});

test("manual removal keeps lease protection unless ignoreLease is set", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?lease-remove=${Date.now()}`);
  const testing = serverModule.__testing;

  const store = {
    accounts: [
      {
        identity_id: "entry_a",
        account_id: "acct_a",
        token: {
          access_token: "token_a"
        },
        enabled: true
      }
    ],
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    rotation: { next_index: 0 }
  };

  const blocked = testing.removeCodexPoolAccountFromStore(structuredClone(store), "entry_a", {
    isAccountLeased: () => true
  });
  assert.equal(blocked.removed, false);
  assert.equal(blocked.blocked, "leased");

  const forced = testing.removeCodexPoolAccountFromStore(structuredClone(store), "entry_a", {
    ignoreLease: true,
    isAccountLeased: () => true
  });
  assert.equal(forced.removed, true);
  assert.equal(forced.remainingAccounts, 0);
  assert.equal(forced.activeEntryId, null);
});

test("request-level pool retry is disabled for smart and manual, but remains enabled for sticky", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?retry-policy=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;

  try {
    testing.config.codexOAuth.multiAccountStrategy = "smart";
    assert.equal(testing.isCodexPoolRetryEnabled(), false);

    testing.config.codexOAuth.multiAccountStrategy = "manual";
    assert.equal(testing.isCodexPoolRetryEnabled(), false);

    testing.config.codexOAuth.multiAccountStrategy = "sticky";
    assert.equal(testing.isCodexPoolRetryEnabled(), true);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("invalidated account state disables the account and clears active token selection", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?invalidated-state=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "smart";

  try {
    const store = {
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          token: {
            access_token: "token_a"
          },
          enabled: true,
          cooldown_until: 999,
          token_invalidated_at: 0
        },
        {
          identity_id: "entry_b",
          account_id: "acct_b",
          token: {
            access_token: "token_b"
          },
          enabled: true,
          cooldown_until: 0,
          token_invalidated_at: 0
        }
      ],
      active_account_id: "entry_a",
      token: {
        access_token: "token_a"
      },
      rotation: { next_index: 0 }
    };

    const target = store.accounts[0];
    testing.applyCodexInvalidatedAccountState(store, target, 12345);

    assert.equal(target.enabled, false);
    assert.equal(target.cooldown_until, 0);
    assert.equal(target.token_invalidated_at, 12345);
    assert.equal(store.active_account_id, null);
    assert.equal(store.token, store.accounts[1].token);
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});

test("invalidated account markers are never eligible for pool selection", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?invalidated-selection=${Date.now()}`);
  const testing = serverModule.__testing;
  const previousConfig = {
    authMode: testing.config.authMode,
    multiAccountEnabled: testing.config.codexOAuth.multiAccountEnabled,
    multiAccountStrategy: testing.config.codexOAuth.multiAccountStrategy
  };

  testing.config.authMode = "codex-oauth";
  testing.config.codexOAuth.multiAccountEnabled = true;
  testing.config.codexOAuth.multiAccountStrategy = "manual";

  try {
    const manualCandidates = testing.pickCodexAccountCandidates({
      active_account_id: "entry_a",
      rotation: { next_index: 0 },
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token_invalidated_at: 12345
        }
      ]
    });
    assert.deepEqual(manualCandidates, []);

    testing.config.codexOAuth.multiAccountStrategy = "sticky";
    const stickyCandidates = testing.pickCodexAccountCandidates({
      active_account_id: "entry_a",
      rotation: { next_index: 0 },
      accounts: [
        {
          identity_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token_invalidated_at: 12345
        },
        {
          identity_id: "entry_b",
          account_id: "acct_b",
          enabled: true,
          token_invalidated_at: 0
        }
      ]
    });
    assert.deepEqual(
      stickyCandidates.map((account) => account.identity_id),
      ["entry_b"]
    );
  } finally {
    testing.config.authMode = previousConfig.authMode;
    testing.config.codexOAuth.multiAccountEnabled = previousConfig.multiAccountEnabled;
    testing.config.codexOAuth.multiAccountStrategy = previousConfig.multiAccountStrategy;
  }
});
