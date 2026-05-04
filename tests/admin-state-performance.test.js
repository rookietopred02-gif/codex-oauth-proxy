import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { registerAdminCoreRoutes } from "../src/routes/admin-core.js";
import { registerAdminSettingsRoutes } from "../src/routes/admin-settings.js";

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
      defaultServiceTier: "auto",
      defaultReasoningEffort: "medium"
    },
    codexOAuth: {
      sharedApiKey: "",
      multiAccountStrategy: "round-robin"
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
    }
  };
}

test("GET /admin/state does not block on slow auxiliary probes", async () => {
  const never = new Promise(() => {});
  let cloudflaredChecks = 0;
  const app = express();

  registerAdminCoreRoutes(app, {
    config: createConfig(),
    runtimeStats: {
      startedAt: Date.now() - 1000,
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      recentRequests: [
        {
          id: "req_summary",
          path: "/v1/responses",
          status: 200
        }
      ]
    },
    recentRequestsStore: {
      getById: async () => null
    },
    cloudflaredRuntime: {
      mode: "quick",
      useHttp2: true,
      localPort: 8787
    },
    expiredAccountCleanupController: {
      getState: () => ({ enabled: false })
    },
    getProxyApiKeyStore: () => ({ keys: [] }),
    getAuthStatus: async () => ({
      authenticated: false,
      accounts: [],
      enabledAccountCount: 0
    }),
    checkCloudflaredInstalled: async () => {
      cloudflaredChecks += 1;
      return await never;
    },
    buildApiKeySummary: () => ({
      enforced: false,
      keys: []
    }),
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => false,
    getCloudflaredStatus: () => ({
      installed: false,
      running: false,
      mode: "quick",
      useHttp2: true,
      localPort: 8787
    }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => "sk-test",
    hashProxyApiKey: () => "hash",
    sanitizeProxyApiKeyLabel: (value) => String(value || ""),
    persistProxyApiKeyStore: async () => {},
    readJsonBody: async () => ({}),
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: 8787, useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
  });

  const backend = await listen(app);
  try {
    const startedAt = Date.now();
    const response = await fetch(`${backend.url}/admin/state`, {
      signal: AbortSignal.timeout(1000)
    });
    const elapsedMs = Date.now() - startedAt;
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(cloudflaredChecks, 1);
    assert.equal(body.stats.recentRequests[0].requestPacket, undefined);
    assert.ok(elapsedMs < 500, `expected /admin/state to return quickly, got ${elapsedMs}ms`);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
test("GET /admin/requests/:id returns a lightweight request detail summary", async () => {
  const app = express();

  registerAdminCoreRoutes(app, {
    config: createConfig(),
    runtimeStats: {
      startedAt: Date.now() - 1000,
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      recentRequests: []
    },
    recentRequestsStore: {
      getById: async (requestId) =>
        requestId === "req_1"
          ? {
              id: "req_1",
              requestPacket: "request body",
              responsePacket: "response body",
              responseContentType: "application/json"
            }
          : null
    },
    cloudflaredRuntime: {
      mode: "quick",
      useHttp2: true,
      localPort: 8787
    },
    expiredAccountCleanupController: {
      getState: () => ({ enabled: false })
    },
    getProxyApiKeyStore: () => ({ keys: [] }),
    getAuthStatus: async () => ({ authenticated: false, accounts: [], enabledAccountCount: 0 }),
    checkCloudflaredInstalled: async () => ({ installed: false }),
    buildApiKeySummary: () => ({ enforced: false, keys: [] }),
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => false,
    getCloudflaredStatus: () => ({ installed: false, running: false, mode: "quick", useHttp2: true, localPort: 8787 }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => "sk-test",
    hashProxyApiKey: () => "hash",
    sanitizeProxyApiKeyLabel: (value) => String(value || ""),
    persistProxyApiKeyStore: async () => {},
    readJsonBody: async () => ({}),
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: 8787, useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/requests/req_1`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.request.id, "req_1");
    assert.equal(body.request.requestPacket, undefined);
    assert.equal(body.request.responsePacket, undefined);
    assert.equal(body.request.packetInfo.requestPacket.chars, "request body".length);
    assert.equal(body.request.packetInfo.responsePacket.chars, "response body".length);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
test("GET /admin/requests/:id/packet returns a packet preview slice", async () => {
  const app = express();

  registerAdminCoreRoutes(app, {
    config: createConfig(),
    runtimeStats: {
      startedAt: Date.now() - 1000,
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      recentRequests: []
    },
    recentRequestsStore: {
      getById: async () => null,
      getPacketSliceById: async (requestId, field, options = {}) =>
        requestId === "req_1" && field === "responsePacket"
          ? {
              field,
              offset: Number(options.offset || 0),
              limit: Number(options.limit || 0),
              text: "response preview",
              totalChars: 120000,
              totalBytes: 120000,
              returnedChars: "response preview".length,
              truncated: true
            }
          : null
    },
    cloudflaredRuntime: {
      mode: "quick",
      useHttp2: true,
      localPort: 8787
    },
    expiredAccountCleanupController: {
      getState: () => ({ enabled: false })
    },
    getProxyApiKeyStore: () => ({ keys: [] }),
    getAuthStatus: async () => ({ authenticated: false, accounts: [], enabledAccountCount: 0 }),
    checkCloudflaredInstalled: async () => ({ installed: false }),
    buildApiKeySummary: () => ({ enforced: false, keys: [] }),
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => false,
    getCloudflaredStatus: () => ({ installed: false, running: false, mode: "quick", useHttp2: true, localPort: 8787 }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => "sk-test",
    hashProxyApiKey: () => "hash",
    sanitizeProxyApiKeyLabel: (value) => String(value || ""),
    persistProxyApiKeyStore: async () => {},
    readJsonBody: async () => ({}),
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: 8787, useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/requests/req_1/packet?field=responsePacket&offset=0&limit=65536`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.packet.field, "responsePacket");
    assert.equal(body.packet.text, "response preview");
    assert.equal(body.packet.truncated, true);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
