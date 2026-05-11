import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { readJsonBody } from "../src/http/request-body.js";
import { registerAdminPoolRoutes } from "../src/routes/admin-pool.js";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

function isFetchAllowedPort(port) {
  return Number.isInteger(port) && port > 0 && !FETCH_FORBIDDEN_PORTS.has(port);
}

async function listen(app) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? Number(address.port || 0) : 0;
    if (isFetchAllowedPort(port)) {
      return {
        server,
        url: `http://127.0.0.1:${port}`
      };
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  throw new Error("Could not reserve a fetch-compatible test port.");
}

async function waitFor(predicate, { timeoutMs = 300, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function assertNoStoreHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
}

test("admin pool overview/control/preheat responses use no-store headers", async () => {
  const app = express();
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        multiAccountPoolFilter: "all",
        sharedApiKey: ""
      }
    },
    async readJsonBody(req) {
      if (req.headers["x-malformed-status"]) {
        const err = new Error("malformed status");
        err.code = "invalid_request";
        err.statusCode = Symbol("status");
        throw err;
      }
      if (req.headers["x-fractional-status"]) {
        const err = new Error("fractional status");
        err.code = "invalid_request";
        err.statusCode = "401.9";
        throw err;
      }
      if (req.headers["x-decimal-status"]) {
        const err = new Error("decimal status");
        err.code = "invalid_request";
        err.statusCode = "401.0";
        throw err;
      }
      return readJsonBody(req);
    },
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: (accounts) => ({
      summary: { total: accounts.length },
      decorated: accounts.map((account) => ({
        account,
        entryId: String(account?.entry_id || account?.account_id || ""),
        healthScore: 1,
        healthStatus: "ok",
        primaryRemaining: null,
        secondaryRemaining: null,
        lowQuota: false,
        hardLimited: false
      }))
    }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: store.accounts.length, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({ started: true }),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const requests = [
      fetch(`${backend.url}/admin/auth-pool`),
      fetch(`${backend.url}/admin/auth-pool/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      fetch(`${backend.url}/admin/auth-pool/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      fetch(`${backend.url}/admin/auth-pool/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: [] })
      }),
      fetch(`${backend.url}/admin/preheat/state`),
      fetch(`${backend.url}/admin/preheat/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      })
    ];

    for (const response of await Promise.all(requests)) {
      assertNoStoreHeaders(response);
      await response.text();
    }

    const invalidBodyResponse = await fetch(`${backend.url}/admin/auth-pool/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"entryId\":"
    });
    const invalidBody = await invalidBodyResponse.json();
    assert.equal(invalidBodyResponse.status, 400);
    assertNoStoreHeaders(invalidBodyResponse);
    assert.equal(invalidBody.error, "invalid_json");

    const malformedStatusResponse = await fetch(`${backend.url}/admin/auth-pool/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-malformed-status": "1" },
      body: JSON.stringify({})
    });
    const malformedStatusBody = await malformedStatusResponse.json();
    assert.equal(malformedStatusResponse.status, 400);
    assertNoStoreHeaders(malformedStatusResponse);
    assert.equal(malformedStatusBody.error, "invalid_request");

    const fractionalStatusResponse = await fetch(`${backend.url}/admin/auth-pool/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fractional-status": "1" },
      body: JSON.stringify({})
    });
    const fractionalStatusBody = await fractionalStatusResponse.json();
    assert.equal(fractionalStatusResponse.status, 400);
    assertNoStoreHeaders(fractionalStatusResponse);
    assert.equal(fractionalStatusBody.error, "invalid_request");

    const decimalStatusResponse = await fetch(`${backend.url}/admin/auth-pool/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-decimal-status": "1" },
      body: JSON.stringify({})
    });
    const decimalStatusBody = await decimalStatusResponse.json();
    assert.equal(decimalStatusResponse.status, 400);
    assertNoStoreHeaders(decimalStatusResponse);
    assert.equal(decimalStatusBody.error, "invalid_request");
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("GET /admin/auth-pool normalizes malformed numeric account metadata", async () => {
  const app = express();
  const throwingNumber = {
    valueOf() {
      throw new Error("bad number");
    }
  };
  const store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        slot: Symbol("slot"),
        token: {
          access_token: "token_a",
          expires_at: Symbol("expires")
        },
        last_used_at: throwingNumber,
        failure_count: "not-a-number",
        cooldown_until: Infinity,
        usage_updated_at: -5
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        slot: "9.9",
        token: {
          access_token: "token_b",
          expires_at: "1777777777.0"
        },
        last_used_at: "12.0",
        failure_count: "3.9",
        cooldown_until: "999.0",
        usage_updated_at: "456.0"
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        multiAccountPoolFilter: "all",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: () => {},
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: (accounts) => ({
      summary: { total: accounts.length },
      decorated: accounts.map((account) => ({
        account,
        entryId: String(account?.entry_id || account?.account_id || ""),
        healthScore: 1,
        healthStatus: "ok",
        primaryRemaining: null,
        secondaryRemaining: null,
        lowQuota: false,
        hardLimited: false
      }))
    }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: () => null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.accounts[0].slot, 1);
    assert.equal(body.accounts[0].expiresAt, null);
    assert.equal(body.accounts[0].lastUsedAt, 0);
    assert.equal(body.accounts[0].failureCount, 0);
    assert.equal(body.accounts[0].cooldownUntil, 0);
    assert.equal(body.accounts[0].usageUpdatedAt, 0);
    assert.equal(body.accounts[1].slot, 2);
    assert.equal(body.accounts[1].expiresAt, null);
    assert.equal(body.accounts[1].lastUsedAt, 0);
    assert.equal(body.accounts[1].failureCount, 0);
    assert.equal(body.accounts[1].cooldownUntil, 0);
    assert.equal(body.accounts[1].usageUpdatedAt, 0);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/activate force-switches a disabled account back to active health", async () => {
  const app = express();
  let clearAuthContextCacheCalls = 0;
  let savedStore = null;
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: false,
        failure_count: 7,
        cooldown_until: 999999,
        last_error: "token_invalidated",
        last_status_code: 401,
        token_invalidated_at: 123456,
        token: {
          access_token: "token_b"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async (_path, nextStore) => {
      savedStore = structuredClone(nextStore);
    },
    clearAuthContextCache: () => {
      clearAuthContextCacheCalls += 1;
    },
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4", "gpt-5-codex"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry_b" })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.entryId, "entry_b");
    assert.equal(store.active_account_id, "entry_b");
    assert.equal(store.token?.access_token, "token_b");
    assert.equal(store.accounts[1].enabled, true);
    assert.equal(store.accounts[1].failure_count, 0);
    assert.equal(store.accounts[1].cooldown_until, 0);
    assert.equal(store.accounts[1].last_error, "");
    assert.equal(store.accounts[1].last_status_code, 0);
    assert.equal(store.accounts[1].token_invalidated_at, 0);
    assert.equal(savedStore?.active_account_id, "entry_b");
    assert.equal(savedStore?.token?.access_token, "token_b");
    assert.equal(clearAuthContextCacheCalls, 1);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/remove refuses to remove leased accounts without persisting", async () => {
  const app = express();
  let setStoreCalls = 0;
  let saveTokenStoreCalls = 0;
  let clearAuthContextCacheCalls = 0;
  const store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: () => {
      setStoreCalls += 1;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {
      saveTokenStoreCalls += 1;
    },
    clearAuthContextCache: () => {
      clearAuthContextCacheCalls += 1;
    },
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: () => null,
    removeCodexPoolAccountFromStore: () => ({
      removed: false,
      blocked: "leased",
      blockedEntryId: "entry_a",
      blockedAccountId: "acct_a"
    }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4", "gpt-5-codex"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry_a" })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assertNoStoreHeaders(response);
    assert.deepEqual(body, {
      error: "account_in_use",
      message: "Account is currently serving an in-flight request.",
      entryId: "entry_a",
      accountId: "acct_a"
    });
    assert.equal(setStoreCalls, 0);
    assert.equal(saveTokenStoreCalls, 0);
    assert.equal(clearAuthContextCacheCalls, 0);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/refresh-tokens refreshes every pooled token and persists the store", async () => {
  const app = express();
  let clearAuthContextCacheCalls = 0;
  let savedStore = null;
  let capturedOptions = null;
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a",
          refresh_token: "refresh_a"
        }
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: false,
        token: {
          access_token: "token_b",
          refresh_token: "refresh_b"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async (_path, nextStore) => {
      savedStore = structuredClone(nextStore);
    },
    clearAuthContextCache: () => {
      clearAuthContextCacheCalls += 1;
    },
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4", "gpt-5-codex"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async (nextStore, _oauthConfig, options = {}) => {
      capturedOptions = { ...options };
      nextStore.accounts[0].token.access_token = "token_a_new";
      nextStore.accounts[1].token.access_token = "token_b_new";
      nextStore.token = nextStore.accounts[0].token;
      return {
        ok: true,
        refreshed: 2,
        total: 2,
        changed: true,
        results: [
          { entryId: "entry_a", accountId: "acct_a", ok: true, expiresAt: 1001 },
          { entryId: "entry_b", accountId: "acct_b", ok: true, expiresAt: 1002 }
        ]
      };
    },
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/refresh-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.refreshed, 2);
    assert.equal(body.total, 2);
    assert.equal(capturedOptions?.includeDisabled, true);
    assert.equal(savedStore?.accounts?.[0]?.token?.access_token, "token_a_new");
    assert.equal(savedStore?.accounts?.[1]?.token?.access_token, "token_b_new");
    assert.equal(clearAuthContextCacheCalls, 1);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/refresh-usage forwards shared codex model candidates so every account can probe with fallbacks", async () => {
  const app = express();
  const capturedOptions = [];
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4", "gpt-5-codex", "codex-mini-latest"],
    refreshCodexUsageSnapshotInStore: async (_store, _ref, _oauthConfig, options = {}) => {
      capturedOptions.push(structuredClone(options));
      return { ok: true, snapshot: { plan_type: "team" } };
    },
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/refresh-usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(capturedOptions.length, 2);
    assert.deepEqual(capturedOptions[0]?.modelCandidates, ["gpt-5.4", "gpt-5-codex", "codex-mini-latest"]);
    assert.deepEqual(capturedOptions[1]?.modelCandidates, ["gpt-5.4", "gpt-5-codex", "codex-mini-latest"]);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/refresh-usage preserves the active account token pointer", async () => {
  const app = express();
  let savedStore = null;
  let store = {
    active_account_id: "entry_b",
    token: {
      access_token: "token_b"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async (_path, nextStore) => {
      savedStore = structuredClone(nextStore);
    },
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async (_store, ref) => {
      if (ref === "entry_b") {
        store.accounts[1].token.access_token = "token_b_refreshed";
      }
      return {
        ok: true,
        entryId: ref,
        accountId: ref === "entry_b" ? "acct_b" : "acct_a",
        snapshot: { plan_type: "team" },
        model: "gpt-5.4"
      };
    },
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/refresh-usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(store.active_account_id, "entry_b");
    assert.equal(store.token?.access_token, "token_b_refreshed");
    assert.equal(savedStore?.active_account_id, "entry_b");
    assert.equal(savedStore?.token?.access_token, "token_b_refreshed");
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/refresh-usage starts all usage probes in parallel", async () => {
  const app = express();
  const startedRefs = [];
  let releaseProbes;
  const releasePromise = new Promise((resolve) => {
    releaseProbes = resolve;
  });
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a"
        }
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async (_store, ref) => {
      startedRefs.push(String(ref || ""));
      await releasePromise;
      return { ok: true, entryId: ref, accountId: `acct:${ref}`, snapshot: { plan_type: "team" } };
    },
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const responsePromise = fetch(`${backend.url}/admin/auth-pool/refresh-usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    await waitFor(() => startedRefs.length === 2);
    assert.deepEqual(startedRefs, ["entry_a", "entry_b"]);

    releaseProbes();

    const response = await responsePromise;
    const body = await response.json();
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.refreshed, 2);
    assert.equal(body.total, 2);
  } finally {
    releaseProbes?.();
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("GET /admin/auth-pool/export returns a single importable json bundle", async () => {
  const app = express();
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        label: "Alpha",
        enabled: true,
        token: {
          access_token: "token_a",
          refresh_token: "refresh_a",
          id_token: "id_a",
          token_type: "Bearer",
          scope: "openid profile email offline_access",
          expires_at: 123
        },
        usage_snapshot: {
          plan_type: "team"
        },
        usage_updated_at: 456,
        slot: 1
      },
      {
        entry_id: "entry_b",
        account_id: "acct_b",
        enabled: true,
        token: {
          access_token: "token_b",
          expires_at: Symbol("expires")
        },
        usage_updated_at: Symbol("usage_updated_at"),
        slot: Symbol("slot")
      },
      {
        entry_id: "entry_c",
        account_id: "acct_c",
        enabled: true,
        token: {
          access_token: "token_c",
          expires_at: "1234.0"
        },
        usage_updated_at: "789.0",
        slot: "9.9"
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: () => null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: (value) => String(value || "").trim().toLowerCase() || "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async () => ({ ok: true }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/export`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.exported, 3);
    assert.match(String(body.fileName || ""), /^codex-oauth-account-pool-.*\.json$/);
    assert.equal(body.payload?.type, "codex-pro-max-auth-pool-export");
    assert.equal(body.payload?.exported, 3);
    assert.equal(Array.isArray(body.payload?.accounts), true);
    for (const tokenKey of ["access_token", "id_token", "refresh_token", "token_type", "scope", "expires_at"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(body, tokenKey), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body.payload || {}, tokenKey), false);
    }
    const envelopeMetadata = {
      ok: body.ok,
      exported: body.exported,
      generatedAt: body.generatedAt,
      fileName: body.fileName,
      payloadType: body.payload?.type,
      payloadGeneratedAt: body.payload?.generated_at,
      payloadExported: body.payload?.exported
    };
    for (const tokenValue of ["token_a", "id_a", "refresh_a"]) {
      assert.equal(JSON.stringify(envelopeMetadata).includes(tokenValue), false);
    }
    assert.deepEqual(body.payload.accounts[0], {
      label: "Alpha",
      slot: 1,
      enabled: true,
      entry_id: "entry_a",
      account_id: "acct_a",
      plan_type: "team",
      usage_snapshot: {
        plan_type: "team"
      },
      usage_updated_at: 456,
      access_token: "token_a",
      id_token: "id_a",
      refresh_token: "refresh_a",
      token_type: "Bearer",
      scope: "openid profile email offline_access",
      expires_at: 123
    });
    assert.equal(body.payload.accounts[1]?.slot, 2);
    assert.equal(body.payload.accounts[1]?.usage_updated_at, 0);
    assert.equal(body.payload.accounts[1]?.expires_at, 0);
    assert.equal(body.payload.accounts[2]?.slot, 3);
    assert.equal(body.payload.accounts[2]?.usage_updated_at, 0);
    assert.equal(body.payload.accounts[2]?.expires_at, 0);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/switch-local verifies the pooled account and rewrites local Codex auth", async () => {
  const app = express();
  let capturedSwitchPayload = null;
  let clearAuthContextCacheCalls = 0;
  let store = {
    active_account_id: "entry_a",
    token: {
      access_token: "token_a"
    },
    accounts: [
      {
        entry_id: "entry_a",
        account_id: "acct_a",
        enabled: true,
        token: {
          access_token: "token_a",
          refresh_token: "refresh_a",
          id_token: "id_a"
        }
      }
    ],
    rotation: { next_index: 0 }
  };

  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => store,
    setCodexOAuthStore: (nextStore) => {
      store = nextStore;
    },
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {
      clearAuthContextCacheCalls += 1;
    },
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async () => ({
      ok: true,
      entryId: "entry_a",
      accountId: "acct_a",
      snapshot: { plan_type: "team" }
    }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    switchLocalCodexToChatgptAccount: async (payload) => {
      capturedSwitchPayload = structuredClone(payload);
      return {
        ok: true,
        authJsonPath: "C:/Users/fi/.codex/auth.json",
        configTomlPath: "C:/Users/fi/.codex/config.toml",
        usedExistingIdTokenFallback: false
      };
    },
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/switch-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry_a" })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.entryId, "entry_a");
    assert.equal(body.accountId, "acct_a");
    assert.equal(capturedSwitchPayload?.accountId, "acct_a");
    assert.equal(capturedSwitchPayload?.token?.access_token, "token_a");
    assert.equal(capturedSwitchPayload?.token?.id_token, "id_a");
    assert.equal(clearAuthContextCacheCalls, 1);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /admin/auth-pool/switch-local returns 409 when the account has no usable local id_token", async () => {
  const app = express();
  registerAdminPoolRoutes(app, {
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        tokenStorePath: "store.json",
        multiAccountEnabled: true,
        multiAccountStrategy: "smart",
        sharedApiKey: ""
      }
    },
    readJsonBody,
    getCodexOAuthStore: () => ({
      active_account_id: "entry_a",
      token: null,
      accounts: [
        {
          entry_id: "entry_a",
          account_id: "acct_a",
          enabled: true,
          token: {
            access_token: "token_a",
            refresh_token: "refresh_a"
          }
        }
      ],
      rotation: { next_index: 0 }
    }),
    setCodexOAuthStore: () => {},
    ensureCodexOAuthStoreShape: (nextStore) => ({ store: nextStore, changed: false }),
    saveTokenStore: async () => {},
    clearAuthContextCache: () => {},
    buildCodexPoolMetrics: () => ({ summary: {}, decorated: [] }),
    isCodexMultiAccountEnabled: () => true,
    getCodexPoolEntryId: (account) => String(account?.entry_id || account?.account_id || ""),
    findCodexPoolAccountByRef: (accounts, ref) =>
      (Array.isArray(accounts) ? accounts : []).find(
        (account) => String(account?.entry_id || account?.account_id || "") === String(ref || "").trim()
      ) || null,
    removeCodexPoolAccountFromStore: () => ({ removed: false }),
    importIntoCodexAuthPool: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: null }),
    extractCodexOAuthImportItems: () => [],
    normalizeOpenAICodexPlanType: () => "",
    getOfficialCodexModelCandidateIds: async () => ["gpt-5.4"],
    refreshCodexUsageSnapshotInStore: async () => ({
      ok: true,
      entryId: "entry_a",
      accountId: "acct_a",
      snapshot: { plan_type: "team" }
    }),
    refreshCodexTokensInStore: async () => ({ ok: true, refreshed: 0, total: 0, results: [] }),
    switchLocalCodexToChatgptAccount: async () => {
      const err = new Error("This account cannot be switched locally yet because the pool does not contain a reusable ChatGPT token bundle for it.");
      err.code = "missing_reusable_chatgpt_bundle";
      throw err;
    },
    runCodexPreheat: async () => ({}),
    getCodexPreheatState: () => ({ running: false })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/auth-pool/switch-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "entry_a" })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assertNoStoreHeaders(response);
    assert.equal(body.error, "missing_reusable_chatgpt_bundle");
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
