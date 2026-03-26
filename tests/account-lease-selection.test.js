import assert from "node:assert/strict";
import test from "node:test";

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
