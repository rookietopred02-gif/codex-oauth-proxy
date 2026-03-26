import assert from "node:assert/strict";
import test from "node:test";

import { isCodexTokenInvalidatedError } from "../src/codex-token-invalidated.js";
import {
  createExpiredAccountCleanupController,
  shouldAutoRemoveInvalidatedAccount
} from "../src/expired-account-cleanup.js";

const TOKEN_REVOKED_REASON =
  "unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: http://127.0.0.1:8787/v1/responses, cf-ray: 9e1681d73f46b011-NRT, request id: 92880069-ed0c-44f6-ae60-bd3073014659, auth error: 401, auth error code: token_revoked";
const ACCOUNT_DEACTIVATED_REASON =
  "unexpected status 401 Unauthorized: Your OpenAI account has been deactivated, please check your email for more information. If you feel this is an error, contact us through our help center at help.openai.com., url: http://127.0.0.1:8787/v1/responses, cf-ray: 9e20009788e0f248-KHH, request id: e8bebf22-9c78-41c3-81d9-5169feaaf808, auth error: 401, auth error code: account_deactivated";

test("token_revoked invalidated oauth failures are recognized for auto-rm", () => {
  assert.equal(isCodexTokenInvalidatedError(401, TOKEN_REVOKED_REASON), true);
  assert.equal(
    shouldAutoRemoveInvalidatedAccount({
      last_status_code: 401,
      last_error: TOKEN_REVOKED_REASON
    }),
    true
  );
});

test("account_deactivated failures are recognized for auto-rm", () => {
  assert.equal(isCodexTokenInvalidatedError(401, ACCOUNT_DEACTIVATED_REASON), true);
  assert.equal(
    shouldAutoRemoveInvalidatedAccount({
      last_status_code: 401,
      last_error: ACCOUNT_DEACTIVATED_REASON
    }),
    true
  );
});

test("expired account cleanup removes invalidated accounts even while leased", async () => {
  let store = {
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: false,
        last_status_code: 401,
        last_error: TOKEN_REVOKED_REASON
      }
    ]
  };
  const removeCalls = [];
  const savedStores = [];
  const controller = createExpiredAccountCleanupController({
    initialConfig: { enabled: true, intervalSeconds: 30 },
    getStore: () => store,
    getAccounts: (currentStore) => currentStore.accounts || [],
    isAccountLeased: () => true,
    removeAccount: async (currentStore, ref, options = {}) => {
      removeCalls.push({ ref, options });
      return {
        removed: true,
        store: {
          ...currentStore,
          accounts: (currentStore.accounts || []).filter((account) => account.entry_id !== ref)
        }
      };
    },
    saveStore: async (nextStore) => {
      store = nextStore;
      savedStores.push(nextStore);
    }
  });

  const result = await controller.run("token_invalidated");

  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.removedRefs, ["entry_a"]);
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], {
    ref: "entry_a",
    options: {
      ignoreLease: true,
      reason: "token_invalidated"
    }
  });
  assert.equal(savedStores.length, 1);
  assert.deepEqual(store.accounts, []);
});

test("expired account cleanup removes deactivated accounts even while leased", async () => {
  let store = {
    accounts: [
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: false,
        last_status_code: 401,
        last_error: ACCOUNT_DEACTIVATED_REASON
      }
    ]
  };
  const removeCalls = [];
  const controller = createExpiredAccountCleanupController({
    initialConfig: { enabled: true, intervalSeconds: 30 },
    getStore: () => store,
    getAccounts: (currentStore) => currentStore.accounts || [],
    isAccountLeased: () => true,
    removeAccount: async (currentStore, ref, options = {}) => {
      removeCalls.push({ ref, options });
      return {
        removed: true,
        store: {
          ...currentStore,
          accounts: (currentStore.accounts || []).filter((account) => account.entry_id !== ref)
        }
      };
    },
    saveStore: async (nextStore) => {
      store = nextStore;
    }
  });

  const result = await controller.run("token_invalidated");

  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.removedRefs, ["entry_b"]);
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(store.accounts, []);
});
