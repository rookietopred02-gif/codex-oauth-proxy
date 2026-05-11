import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import express from "express";

import { registerAdminCoreRoutes } from "../src/routes/admin-core.js";
import { registerAdminSettingsRoutes } from "../src/routes/admin-settings.js";

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
      defaultServiceTier: "auto"
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

function assertNoStoreHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
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
    assertNoStoreHeaders(response);
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
    assertNoStoreHeaders(response);
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
  const packetCalls = [];

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
      getPacketSliceById: async (requestId, field, options = {}) => {
        packetCalls.push({ requestId, field, options });
        return requestId === "req_1" && field === "responsePacket"
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
          : null;
      }
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
    let response = await fetch(`${backend.url}/admin/requests/req_1/packet?field=responsePacket&offset=0&limit=65536`);
    let body = await response.json();
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(body.packet.field, "responsePacket");
    assert.equal(body.packet.text, "response preview");
    assert.equal(body.packet.truncated, true);
    assert.deepEqual(packetCalls[0], {
      requestId: "req_1",
      field: "responsePacket",
      options: {
        offset: 0,
        limit: 65536
      }
    });

    response = await fetch(
      `${backend.url}/admin/requests/req_1/packet?field=responsePacket&offset=not-a-number&limit=not-a-number`
    );
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(packetCalls[1], {
      requestId: "req_1",
      field: "responsePacket",
      options: {
        offset: 0,
        limit: 65536
      }
    });

    response = await fetch(
      `${backend.url}/admin/requests/req_1/packet?field=responsePacket&offset=1.9&limit=100.0`
    );
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(packetCalls[2], {
      requestId: "req_1",
      field: "responsePacket",
      options: {
        offset: 0,
        limit: 65536
      }
    });
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("public access admin routes keep tunnel tokens out of responses", async () => {
  const app = express();
  app.use(express.json());
  const config = createConfig();
  config.publicAccess.defaultTunnelToken = "saved-token";
  config.publicAccess.defaultUseHttp2 = true;
  config.publicAccess.localPort = 8787;
  const cloudflaredRuntime = {
    mode: "auth",
    useHttp2: true,
    localPort: 8787,
    tunnelToken: "stale-runtime-token"
  };
  let startOptions = null;

  registerAdminCoreRoutes(app, {
    config,
    runtimeStats: {
      startedAt: Date.now() - 1000,
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      recentRequests: []
    },
    recentRequestsStore: {
      getById: async () => null
    },
    cloudflaredRuntime,
    expiredAccountCleanupController: {
      getState: () => ({ enabled: false })
    },
    getProxyApiKeyStore: () => ({ keys: [] }),
    getAuthStatus: async () => ({ authenticated: false, accounts: [], enabledAccountCount: 0 }),
    checkCloudflaredInstalled: async () => ({ installed: true }),
    buildApiKeySummary: () => ({ enforced: false, keys: [] }),
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => false,
    getCloudflaredStatus: () => ({
      installed: true,
      running: false,
      mode: cloudflaredRuntime.mode,
      useHttp2: true,
      localPort: 8787,
      error: "failed with saved-token and status-token",
      installMessage: "retrying stale-runtime-token with status-tunnel-token",
      outputTail: [
        "cloudflared tunnel run --token saved-token",
        "runtime stale-runtime-token",
        "plain status-default-token",
        "inline --token inline-token"
      ],
      token: "status-token",
      tunnelToken: "status-tunnel-token",
      defaultTunnelToken: "status-default-token"
    }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => "sk-test",
    hashProxyApiKey: () => "hash",
    sanitizeProxyApiKeyLabel: (value) => String(value || ""),
    persistProxyApiKeyStore: async () => {},
    readJsonBody: async (req) => req.body || {},
    startCloudflaredTunnel: async (options) => {
      startOptions = options;
      cloudflaredRuntime.mode = options.mode;
      return {
        installed: true,
        running: true,
        mode: options.mode,
        useHttp2: true,
        localPort: 8787,
        error: "start failed with saved-token and start-token",
        installMessage: "start install saw start-tunnel-token",
        outputTail: [
          "start --token saved-token",
          "runtime stale-runtime-token",
          "plain start-default-token",
          "inline --token inline-token"
        ],
        token: "start-token",
        tunnelToken: "start-tunnel-token",
        defaultTunnelToken: "start-default-token"
      };
    },
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
  });

  const backend = await listen(app);
  try {
    let response = await fetch(`${backend.url}/admin/state`);
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(body).includes("status-token"), false);
    assert.equal(JSON.stringify(body).includes("status-tunnel-token"), false);
    assert.equal(JSON.stringify(body).includes("status-default-token"), false);
    assert.equal(JSON.stringify(body).includes("saved-token"), false);
    assert.equal(JSON.stringify(body).includes("stale-runtime-token"), false);
    assert.equal(JSON.stringify(body).includes("inline-token"), false);

    response = await fetch(`${backend.url}/admin/public-access/status`);
    body = await response.json();
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(JSON.stringify(body).includes("status-token"), false);
    assert.equal(JSON.stringify(body).includes("status-tunnel-token"), false);
    assert.equal(JSON.stringify(body).includes("status-default-token"), false);
    assert.equal(JSON.stringify(body).includes("saved-token"), false);
    assert.equal(JSON.stringify(body).includes("stale-runtime-token"), false);
    assert.equal(JSON.stringify(body).includes("inline-token"), false);

    response = await fetch(`${backend.url}/admin/public-access/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "quick", useHttp2: true })
    });
    body = await response.json();
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.deepEqual(startOptions, { mode: "quick", token: undefined, useHttp2: true, autoInstall: undefined });
    assert.equal(config.publicAccess.defaultTunnelToken, "saved-token");
    assert.equal(JSON.stringify(body).includes("start-token"), false);
    assert.equal(JSON.stringify(body).includes("start-tunnel-token"), false);
    assert.equal(JSON.stringify(body).includes("start-default-token"), false);
    assert.equal(JSON.stringify(body).includes("saved-token"), false);
    assert.equal(JSON.stringify(body).includes("stale-runtime-token"), false);
    assert.equal(JSON.stringify(body).includes("inline-token"), false);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("public access start keeps a valid configured port when tunnel status has a malformed port", async () => {
  const app = express();
  app.use(express.json());
  const config = createConfig();

  registerAdminCoreRoutes(app, {
    config,
    runtimeStats: {
      startedAt: Date.now() - 1000,
      totalRequests: 0,
      okRequests: 0,
      errorRequests: 0,
      recentRequests: []
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
    getAuthStatus: async () => ({ authenticated: false, accounts: [], enabledAccountCount: 0 }),
    checkCloudflaredInstalled: async () => ({ installed: true }),
    buildApiKeySummary: () => ({ enforced: false, keys: [] }),
    getActiveUpstreamBaseUrl: () => "https://example.invalid",
    isCodexMultiAccountEnabled: () => false,
    getCloudflaredStatus: () => ({ installed: true, running: false, mode: "quick", useHttp2: true, localPort: 8787 }),
    getCodexPreheatState: () => ({ running: false }),
    createProxyApiKey: () => "sk-test",
    hashProxyApiKey: () => "hash",
    sanitizeProxyApiKeyLabel: (value) => String(value || ""),
    persistProxyApiKeyStore: async () => {},
    readJsonBody: async (req) => req.body || {},
    startCloudflaredTunnel: async () => ({ mode: "quick", localPort: "not-a-port", useHttp2: true }),
    stopCloudflaredTunnel: async () => ({ running: false }),
    validCloudflaredModes: new Set(["quick", "auth"]),
    getOfficialModelCandidateIds: async () => [],
    getOfficialCodexModelCandidateIds: async () => []
  });

  const backend = await listen(app);
  try {
    const response = await fetch(`${backend.url}/admin/public-access/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "quick", useHttp2: true })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
    assert.equal(body.ok, true);
    assert.equal(config.publicAccess.localPort, 8787);
  } finally {
    await new Promise((resolve, reject) => backend.server.close((err) => (err ? reject(err) : resolve())));
  }
});
