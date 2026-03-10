import test from "node:test";
import assert from "node:assert/strict";

import {
  createExpiredAccountCleanupController,
  findExpiredAccountCleanupCandidates,
  normalizeExpiredAccountCleanupConfig,
  shouldAutoLogoutExpiredAccount
} from "../src/expired-account-cleanup.js";

test("normalizeExpiredAccountCleanupConfig clamps interval and keeps toggle", () => {
  const normalized = normalizeExpiredAccountCleanupConfig({
    enabled: true,
    intervalSeconds: 2
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.intervalSeconds, 10);
});

test("shouldAutoLogoutExpiredAccount only matches expired accounts without refresh token", () => {
  const nowSec = 1_700_000_000;
  assert.equal(
    shouldAutoLogoutExpiredAccount(
      {
        token: {
          expires_at: nowSec - 10,
          refresh_token: ""
        }
      },
      nowSec
    ),
    true
  );
  assert.equal(
    shouldAutoLogoutExpiredAccount(
      {
        token: {
          expires_at: nowSec - 10,
          refresh_token: "refresh-ok"
        }
      },
      nowSec
    ),
    false
  );
  assert.equal(
    shouldAutoLogoutExpiredAccount(
      {
        token: {
          expires_at: nowSec + 30,
          refresh_token: ""
        }
      },
      nowSec
    ),
    false
  );
});

test("findExpiredAccountCleanupCandidates returns removable refs only", () => {
  const nowSec = 1_700_000_000;
  const candidates = findExpiredAccountCleanupCandidates(
    [
      {
        entry_id: "expired-no-refresh",
        account_id: "acc-1",
        token: { expires_at: nowSec - 5, refresh_token: "" }
      },
      {
        entry_id: "expired-with-refresh",
        account_id: "acc-2",
        token: { expires_at: nowSec - 5, refresh_token: "refresh" }
      },
      {
        entry_id: "healthy",
        account_id: "acc-3",
        token: { expires_at: nowSec + 300, refresh_token: "" }
      }
    ],
    nowSec
  );
  assert.deepEqual(candidates.map((item) => item.ref), ["expired-no-refresh"]);
});

test("expired account cleanup controller removes expired entries and records state", async () => {
  let store = {
    accounts: [
      { entry_id: "expired-no-refresh", account_id: "acc-1", token: { expires_at: 1, refresh_token: "" } },
      { entry_id: "healthy", account_id: "acc-2", token: { expires_at: 4_000_000_000, refresh_token: "refresh" } }
    ]
  };
  const removedEvents = [];
  const controller = createExpiredAccountCleanupController({
    initialConfig: { enabled: true, intervalSeconds: 30 },
    isSupported: () => true,
    getStore: () => store,
    getAccounts: (input) => input.accounts,
    removeAccount: (input, ref) => {
      const next = {
        ...input,
        accounts: input.accounts.filter((account) => String(account.entry_id || "") !== String(ref || ""))
      };
      const removed = next.accounts.length !== input.accounts.length;
      return { removed, store: next };
    },
    saveStore: async (nextStore) => {
      store = nextStore;
    },
    onRemoved: async ({ removedRefs }) => {
      removedEvents.push(...removedRefs);
    }
  });

  const result = await controller.run("test");
  const state = controller.getState();

  assert.equal(result.ok, true);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(removedEvents, ["expired-no-refresh"]);
  assert.equal(store.accounts.length, 1);
  assert.equal(store.accounts[0].entry_id, "healthy");
  assert.equal(state.running, false);
  assert.equal(state.lastStatus, "ok");
  assert.equal(state.lastRemovedCount, 1);
});
