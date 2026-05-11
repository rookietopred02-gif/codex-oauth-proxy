import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { registerAdminCoreRoutes } from "../src/routes/admin-core.js";
import { createAuthService } from "../src/services/auth-service.js";

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

function createConfig() {
  return {
    authMode: "codex-oauth",
    host: "127.0.0.1",
    port: 8787,
    runtimePort: 8787,
    upstreamMode: "codex-chatgpt",
    codex: {
      defaultModel: "gpt-5",
      defaultInstructions: "",
      defaultServiceTier: "priority"
    },
    codexOAuth: {
      sharedApiKey: "",
      multiAccountStrategy: "manual"
    },
    expiredAccountCleanup: {
      enabled: false
    },
    modelRouter: {
      enabled: false,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      autoInstall: true
    },
    apiKeys: {
      storePath: "memory"
    }
  };
}

function createService(config) {
  return createAuthService({
    config,
    loadJsonStore: async () => ({ version: 1, keys: [] }),
    saveJsonStore: async () => {},
    extractBearerToken: () => "",
    readHeaderValue: () => ""
  });
}

function assertNoStoreHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
}

function registerTestAdminCoreRoutes(app, config, service, generatedKey, overrides = {}) {
  registerAdminCoreRoutes(app, {
    config,
    runtimeStats: {
      startedAt: Date.now(),
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      auditErrors: 0,
      lastAuditError: null,
      recentRequests: []
    },
    recentRequestsStore: {
      getById: async () => null,
      getDetailSummaryById: async () => null,
      getPacketSliceById: async () => null
    },
    cloudflaredRuntime: {
      mode: "quick",
      useHttp2: true,
      localPort: 8787
    },
    expiredAccountCleanupController: {
      getState: () => ({ enabled: false })
    },
    getProxyApiKeyStore: service.getProxyApiKeyStore,
    getAuthStatus: async () => ({ authenticated: false, accounts: [], enabledAccountCount: 0 }),
    checkCloudflaredInstalled: async () => false,
    buildApiKeySummary: service.buildApiKeySummary,
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => true,
    getCloudflaredStatus: () => ({ installed: false, running: false, mode: "quick", useHttp2: true, localPort: 8787 }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => generatedKey,
    hashProxyApiKey: service.hashProxyApiKey,
    sanitizeProxyApiKeyLabel: service.sanitizeProxyApiKeyLabel,
    persistProxyApiKeyStore: service.persistProxyApiKeyStore,
    readJsonBody: async (req) => req.body || {},
    installCloudflaredBinary: async () => ({ installed: true }),
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: 8787, useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => [],
    ...overrides
  });
}

test("admin API key routes only disclose generated keys in the one-time apiKey field", async () => {
  const config = createConfig();
  const service = createService(config);
  const generatedKey = "sk-testsecretapikeyvalue23456789";
  const app = express();
  app.use(express.json());
  registerTestAdminCoreRoutes(app, config, service, generatedKey);

  const backend = await listen(app);
  try {
    let response = await fetch(`${backend.url}/admin/api-keys/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ label: "runtime-dashboard" })
    });
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    let body = await response.json();

    assert.equal(body.apiKey, generatedKey);
    assert.equal(Object.prototype.hasOwnProperty.call(body.key, "value"), false);
    assert.equal(body.summary.keys.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(body.summary.keys[0], "value"), false);
    assert.equal(JSON.stringify(body.summary).includes(generatedKey), false);

    response = await fetch(`${backend.url}/admin/api-keys`);
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    body = await response.json();
    assert.equal(body.keys.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(body.keys[0], "value"), false);
    assert.equal(JSON.stringify(body).includes(generatedKey), false);

    response = await fetch(`${backend.url}/admin/api-keys/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ id: body.keys[0].id })
    });
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.summary.keys.length, 0);

    response = await fetch(`${backend.url}/admin/model-candidates`);
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("admin API key generation treats malformed expiration as non-expiring", async () => {
  const config = createConfig();
  const service = createService(config);
  const generatedKey = "sk-testsecretapikeyvalue23456789";
  const app = express();
  const malformedExpiresInDays = {
    valueOf() {
      throw new Error("bad expiration");
    }
  };

  registerTestAdminCoreRoutes(app, config, service, generatedKey, {
    readJsonBody: async () => ({
      label: "malformed-expiration",
      expiresInDays: malformedExpiresInDays
    })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/api-keys/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.key.expiresAt, null);
    assert.equal(body.summary.keys[0].expiresAt, null);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("admin API key generation treats decimal-form expiration as non-expiring", async () => {
  const config = createConfig();
  const service = createService(config);
  const generatedKey = "sk-testsecretapikeyvalue23456789";
  const app = express();

  registerTestAdminCoreRoutes(app, config, service, generatedKey, {
    readJsonBody: async () => ({
      label: "decimal-expiration",
      expiresInDays: "3.0"
    })
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/api-keys/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.key.expiresAt, null);
    assert.equal(body.summary.keys[0].expiresAt, null);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("admin core POST routes preserve request body errors without side effects", async () => {
  const config = createConfig();
  const service = createService(config);
  const app = express();
  const invalidJsonError = new Error("Body must be valid JSON.");
  invalidJsonError.code = "invalid_json";
  invalidJsonError.statusCode = 400;
  let createKeyCalls = 0;
  let persistKeyCalls = 0;
  let startTunnelCalls = 0;

  registerTestAdminCoreRoutes(app, config, service, "sk-should-not-be-created", {
    readJsonBody: async () => {
      throw invalidJsonError;
    },
    createProxyApiKey: () => {
      createKeyCalls += 1;
      return "sk-should-not-be-created";
    },
    persistProxyApiKeyStore: async () => {
      persistKeyCalls += 1;
    },
    startCloudflaredTunnel: async () => {
      startTunnelCalls += 1;
      return { mode: "quick", localPort: 8787, useHttp2: true };
    }
  });

  const backend = await listen(app);
  try {
    for (const route of ["/admin/api-keys/generate", "/admin/api-keys/revoke", "/admin/public-access/start"]) {
      const response = await fetch(`${backend.url}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{\"broken\":"
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assertNoStoreHeaders(response);
      assert.equal(body.error, "invalid_json");
      assert.equal(body.message, "Body must be valid JSON.");
    }

    assert.equal(createKeyCalls, 0);
    assert.equal(persistKeyCalls, 0);
    assert.equal(startTunnelCalls, 0);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("public access failure messages redact tunnel token material", async () => {
  const config = createConfig();
  config.publicAccess.defaultTunnelToken = "saved-token";
  const service = createService(config);
  const app = express();
  app.use(express.json());
  const cloudflaredRuntime = {
    mode: "auth",
    useHttp2: true,
    localPort: 8787,
    tunnelToken: "runtime-token"
  };

  registerTestAdminCoreRoutes(app, config, service, "sk-test", {
    cloudflaredRuntime,
    installCloudflaredBinary: async () => {
      throw new Error("install failed with saved-token runtime-token --token install-token");
    },
    startCloudflaredTunnel: async () => {
      throw new Error("start failed with saved-token runtime-token request-token --token inline-token");
    },
    stopCloudflaredTunnel: async () => {
      throw new Error("stop failed with saved-token runtime-token --token stop-token");
    }
  });

  const backend = await listen(app);
  try {
    const cases = [
      {
        path: "/admin/public-access/install",
        expectedError: "public_access_install_failed",
        secrets: ["saved-token", "runtime-token", "install-token"]
      },
      {
        path: "/admin/public-access/start",
        expectedError: "public_access_start_failed",
        body: { mode: "auth", token: "request-token" },
        secrets: ["saved-token", "runtime-token", "request-token", "inline-token"]
      },
      {
        path: "/admin/public-access/stop",
        expectedError: "public_access_stop_failed",
        secrets: ["saved-token", "runtime-token", "stop-token"]
      }
    ];

    for (const item of cases) {
      const response = await fetch(`${backend.url}${item.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: item.body ? JSON.stringify(item.body) : "{}"
      });
      const body = await response.json();
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 400);
      assertNoStoreHeaders(response);
      assert.equal(body.error, item.expectedError);
      for (const secret of item.secrets) {
        assert.equal(serialized.includes(secret), false);
      }
      assert.match(body.message, /\[redacted\]/);
    }
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
