import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { registerAdminCoreRoutes } from "../src/routes/admin-core.js";
import { createAuthService } from "../src/services/auth-service.js";

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? Number(address.port || 0) : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`
  };
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

function registerTestAdminCoreRoutes(app, config, service, generatedKey) {
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
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: 8787, useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
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
    let body = await response.json();

    assert.equal(body.apiKey, generatedKey);
    assert.equal(Object.prototype.hasOwnProperty.call(body.key, "value"), false);
    assert.equal(body.summary.keys.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(body.summary.keys[0], "value"), false);
    assert.equal(JSON.stringify(body.summary).includes(generatedKey), false);

    response = await fetch(`${backend.url}/admin/api-keys`);
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.keys.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(body.keys[0], "value"), false);
    assert.equal(JSON.stringify(body).includes(generatedKey), false);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
