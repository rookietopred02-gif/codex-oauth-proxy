import assert from "node:assert/strict";
import test from "node:test";

import {
  captureActiveCodexAccountPointer,
  resetCodexAccountHealth,
  restoreActiveCodexAccountPointer
} from "../src/services/codex-account-state.js";

test("resetCodexAccountHealth clears failure markers without forcing enable when requested", () => {
  const account = {
    enabled: false,
    failure_count: 3,
    cooldown_until: 999,
    last_error: "token_revoked",
    last_status_code: 401,
    token_invalidated_at: 123
  };

  assert.equal(resetCodexAccountHealth(account, { enable: false }), true);

  assert.equal(account.enabled, false);
  assert.equal(account.failure_count, 0);
  assert.equal(account.cooldown_until, 0);
  assert.equal(account.last_error, "");
  assert.equal(account.last_status_code, 0);
  assert.equal(account.token_invalidated_at, 0);
});

test("restoreActiveCodexAccountPointer keeps the active token on the originally active account", () => {
  const store = {
    active_account_id: "entry_b",
    token: { access_token: "token_b_old" },
    accounts: [
      {
        identity_id: "entry_a",
        token: { access_token: "token_a" }
      },
      {
        identity_id: "entry_b",
        token: { access_token: "token_b_old" }
      }
    ]
  };
  const snapshot = captureActiveCodexAccountPointer(store);

  store.accounts[0].token = { access_token: "token_a_refreshed" };
  store.accounts[1].token = { access_token: "token_b_refreshed" };
  store.token = store.accounts[0].token;

  assert.equal(restoreActiveCodexAccountPointer(store, snapshot), true);
  assert.equal(store.active_account_id, "entry_b");
  assert.equal(store.token?.access_token, "token_b_refreshed");
});
