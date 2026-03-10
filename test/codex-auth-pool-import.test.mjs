import test from "node:test";
import assert from "node:assert/strict";

import { importCodexOAuthTokens } from "../src/codex-auth-pool-import.js";

test("importCodexOAuthTokens imports nested payloads and probes usage", async () => {
  const store = { token: null, accounts: [] };
  const result = await importCodexOAuthTokens({
    store,
    items: [
      { payload: { access_token: "tok-1", email: "one@example.com", slot: 3 } },
      { tokens: [{ access_token: "tok-2", email: "two@example.com", enabled: false }] }
    ],
    ensureStoreShape: (input) => ({ store: input }),
    normalizeToken: (token) => token,
    upsertAccount: (nextStore, token, options) => {
      const entryId = `entry-${nextStore.accounts.length + 1}`;
      nextStore.accounts.push({
        entry_id: entryId,
        token,
        label: options.label,
        slot: options.slot,
        enabled: true
      });
      return { entryId };
    },
    findAccountByRef: (accounts, ref) => accounts.find((account) => account.entry_id === ref) || null,
    refreshUsageSnapshot: async (_nextStore, ref) => ({ ok: true, entryId: ref }),
    normalizePlanType: (value) => (String(value || "").trim() ? String(value).trim() : null),
    parseSlotValue: (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.floor(n) : null;
    }
  });

  assert.equal(result.imported, 2);
  assert.equal(result.accountPoolSize, 2);
  assert.equal(result.usageProbe.probed, 1);
  assert.equal(store.accounts[0].label, "one@example.com");
  assert.equal(store.accounts[0].slot, 3);
  assert.equal(store.accounts[1].enabled, false);
});
