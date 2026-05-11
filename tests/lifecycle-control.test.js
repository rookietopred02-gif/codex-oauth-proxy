import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";

import { stopAppServer } from "../src/app-server.js";
import { buildAdminConfigSnapshot } from "../src/routes/admin-shared.js";
import { registerAdminSettingsRoutes } from "../src/routes/admin-settings.js";
import { createSyncResolvedRuntimeAddress } from "../src/server/app-runtime.js";

function createRouteResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function assertNoStoreHeaders(response) {
  assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
  assert.equal(response.getHeader("pragma"), "no-cache");
  assert.equal(response.getHeader("expires"), "0");
}

test("admin config snapshot rejects decimal-form runtime port fields", () => {
  const snapshot = buildAdminConfigSnapshot({
    config: {
      authMode: "codex-oauth",
      host: "127.0.0.1",
      port: "8788.1",
      runtimePort: "9898.1",
      upstreamMode: "codex-chatgpt",
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "",
        defaultServiceTier: "default"
      },
      codexOAuth: {
        sharedApiKey: "",
        multiAccountStrategy: "smart",
        multiAccountPoolFilter: "all"
      },
      expiredAccountCleanup: {
        enabled: false
      },
      modelRouter: {
        enabled: true,
        customMappings: {}
      },
      requestAudit: {
        historyPath: "C:/tmp/recent-requests.json"
      },
      publicAccess: {
        defaultMode: "quick",
        autoInstall: true
      }
    },
    cloudflaredRuntime: {
      mode: "quick",
      useHttp2: true,
      localPort: "8080.9"
    },
    getActiveUpstreamBaseUrl: () => "https://example.test",
    isCodexMultiAccountEnabled: () => true
  });

  assert.equal(snapshot.activeRuntimePort, 8787);
  assert.equal(snapshot.runtimePort, 8787);
  assert.equal(snapshot.publicAccess.localPort, 8787);
});

test("runtime address sync rejects decimal-form cloudflared local ports", () => {
  const config = {
    host: "127.0.0.1",
    port: 6543,
    customOAuth: {
      redirectUri: ""
    },
    publicAccess: {
      localPort: "8787.0"
    }
  };
  const cloudflaredRuntime = {
    localPort: "8787.0"
  };
  const syncResolvedAddress = createSyncResolvedRuntimeAddress({
    config,
    hasExplicitCustomOAuthRedirectUri: false,
    hasExplicitCloudflaredLocalPort: true,
    cloudflaredRuntime
  });

  syncResolvedAddress({ port: 6543, requestedPort: 0 });

  assert.equal(config.customOAuth.redirectUri, "http://127.0.0.1:6543/auth/callback");
  assert.equal(config.publicAccess.localPort, 6543);
  assert.equal(cloudflaredRuntime.localPort, 6543);
});

test("stopAppServer is a no-op before the embedded server is started", async () => {
  const result = await stopAppServer("TEST");

  assert.deepEqual(result, {
    app: null,
    mainServer: null,
    stopped: true
  });
});

test("admin config accepts a live cloudflared process and persists autoInstall=false", async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const config = {
    host: "127.0.0.1",
    port: 8787,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "https://gemini.example.test" },
    anthropic: { baseUrl: "https://anthropic.example.test" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "all"
    },
    expiredAccountCleanup: {
      enabled: false,
      intervalSeconds: 30
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "C:/tmp/recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: "",
      localPort: 8787
    }
  };
  const cloudflaredRuntime = {
    process() {},
    mode: "quick",
    useHttp2: true,
    tunnelToken: "",
    localPort: 8787,
    outputTail: []
  };
  let persistedConfig = null;

  registerAdminSettingsRoutes(app, {
    config,
    cloudflaredRuntime,
    runtimeStats: { recentRequests: [] },
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {}
    },
    persistProxyConfigEnv: async (nextConfig) => {
      persistedConfig = structuredClone(nextConfig);
    },
    readJsonBody: async () => ({ publicAccessAutoInstall: false, defaultServiceTier: "priority" }),
    normalizeUpstreamMode: (value) => value,
    normalizeCodexServiceTier: (value) => value,
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart"]),
    multiAccountStrategyList: "smart",
    validMultiAccountPoolFilters: new Set(["all", "team-only"]),
    multiAccountPoolFilterList: "all, team-only",
    expiredAccountCleanupController: {
      configure() {},
      run() {
        return Promise.resolve();
      }
    },
    sanitizeModelMappings: (value) => value,
    getActiveUpstreamBaseUrl: () => config.upstreamBaseUrl,
    isCodexMultiAccountEnabled: () => true,
    runDirectChatCompletionTest: async () => ({}),
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = createRouteResponse();

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assertNoStoreHeaders(response);
  assert.equal(config.publicAccess.autoInstall, false);
  assert.equal(config.codex.defaultServiceTier, "priority");
  assert.equal(persistedConfig?.publicAccess?.autoInstall, false);
  assert.equal(persistedConfig?.codex?.defaultServiceTier, "priority");
});

test("admin settings clear and direct test responses use no-store headers", async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const runtimeStats = { recentRequests: [{ id: "req_1" }] };
  let flushed = false;
  let receivedPrompt = "";

  registerAdminSettingsRoutes(app, {
    runtimeStats,
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {
        flushed = true;
      }
    },
    readJsonBody: async () => ({ prompt: "ping" }),
    runDirectChatCompletionTest: async (prompt) => {
      receivedPrompt = prompt;
      return { message: "pong" };
    }
  });

  const clearHandler = routes.get("POST /admin/requests/clear");
  const testHandler = routes.get("POST /admin/test");
  assert.equal(typeof clearHandler, "function");
  assert.equal(typeof testHandler, "function");

  const clearResponse = createRouteResponse();
  await clearHandler({}, clearResponse);

  assert.equal(clearResponse.statusCode, 200);
  assertNoStoreHeaders(clearResponse);
  assert.deepEqual(runtimeStats.recentRequests, []);
  assert.equal(flushed, true);

  const testResponse = createRouteResponse();
  await testHandler({}, testResponse);

  assert.equal(testResponse.statusCode, 200);
  assertNoStoreHeaders(testResponse);
  assert.equal(receivedPrompt, "ping");
  assert.deepEqual(testResponse.payload, { ok: true, result: { message: "pong" } });
});

test("admin config persists runtimePort without changing the active port", async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const config = {
    host: "127.0.0.1",
    port: 8787,
    runtimePort: 8787,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "https://gemini.example.test" },
    anthropic: { baseUrl: "https://anthropic.example.test" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "all"
    },
    expiredAccountCleanup: {
      enabled: false,
      intervalSeconds: 30
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "C:/tmp/recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: "",
      localPort: 8787
    }
  };
  const cloudflaredRuntime = {
    process: null,
    mode: "quick",
    useHttp2: true,
    tunnelToken: "",
    localPort: 8787,
    outputTail: []
  };
  let persistedConfig = null;

  registerAdminSettingsRoutes(app, {
    config,
    cloudflaredRuntime,
    runtimeStats: { recentRequests: [] },
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {}
    },
    persistProxyConfigEnv: async (nextConfig) => {
      persistedConfig = structuredClone(nextConfig);
    },
    readJsonBody: async () => ({ runtimePort: 8899 }),
    normalizeUpstreamMode: (value) => value,
    normalizeCodexServiceTier: (value) => value,
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart"]),
    multiAccountStrategyList: "smart",
    validMultiAccountPoolFilters: new Set(["all", "team-only"]),
    multiAccountPoolFilterList: "all, team-only",
    expiredAccountCleanupController: {
      configure() {},
      run() {
        return Promise.resolve();
      }
    },
    sanitizeModelMappings: (value) => value,
    getActiveUpstreamBaseUrl: () => config.upstreamBaseUrl,
    isCodexMultiAccountEnabled: () => true,
    runDirectChatCompletionTest: async () => ({}),
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = createRouteResponse();

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(config.port, 8787);
  assert.equal(config.runtimePort, 8899);
  assert.equal(cloudflaredRuntime.localPort, 8787);
  assert.equal(persistedConfig?.runtimePort, 8899);
  assert.equal(response.payload?.config?.activeRuntimePort, 8787);
  assert.equal(response.payload?.config?.runtimePort, 8899);
});

test("registerServerApp forwards pool filter validation settings into admin config routes", async () => {
  const source = await fs.readFile(new URL("../src/server/app-runtime.js", import.meta.url), "utf8");

  assert.match(source, /validMultiAccountPoolFilters,/);
  assert.match(source, /multiAccountPoolFilterList,/);
  assert.match(source, /settings:\s*\{[\s\S]*validMultiAccountPoolFilters,[\s\S]*multiAccountPoolFilterList,[\s\S]*\}/);
});

test("admin config persists multiAccountPoolFilter", async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const config = {
    host: "127.0.0.1",
    port: 8787,
    runtimePort: 8787,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "https://gemini.example.test" },
    anthropic: { baseUrl: "https://anthropic.example.test" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "all"
    },
    expiredAccountCleanup: {
      enabled: false,
      intervalSeconds: 30
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "C:/tmp/recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: "",
      localPort: 8787
    }
  };
  let persistedConfig = null;

  registerAdminSettingsRoutes(app, {
    config,
    cloudflaredRuntime: {
      process: null,
      mode: "quick",
      useHttp2: true,
      tunnelToken: "",
      localPort: 8787,
      outputTail: []
    },
    runtimeStats: { recentRequests: [] },
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {}
    },
    persistProxyConfigEnv: async (nextConfig) => {
      persistedConfig = structuredClone(nextConfig);
    },
    readJsonBody: async () => ({ multiAccountPoolFilter: "team-only" }),
    normalizeUpstreamMode: (value) => value,
    normalizeCodexServiceTier: (value) => value,
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart"]),
    multiAccountStrategyList: "smart",
    validMultiAccountPoolFilters: new Set(["all", "team-only"]),
    multiAccountPoolFilterList: "all, team-only",
    expiredAccountCleanupController: {
      configure() {},
      run() {
        return Promise.resolve();
      }
    },
    sanitizeModelMappings: (value) => value,
    getActiveUpstreamBaseUrl: () => config.upstreamBaseUrl,
    isCodexMultiAccountEnabled: () => true,
    runDirectChatCompletionTest: async () => ({}),
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = createRouteResponse();

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(config.codexOAuth.multiAccountPoolFilter, "team-only");
  assert.equal(persistedConfig?.codexOAuth?.multiAccountPoolFilter, "team-only");
  assert.equal(response.payload?.config?.multiAccountPoolFilter, "team-only");
});

function createAdminConfigValidationHarness({ readJsonBody }) {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const config = {
    host: "127.0.0.1",
    port: 8787,
    runtimePort: 8787,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "https://gemini.example.test" },
    anthropic: { baseUrl: "https://anthropic.example.test" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "all"
    },
    expiredAccountCleanup: {
      enabled: false,
      intervalSeconds: 30
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "C:/tmp/recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: "",
      localPort: 8787
    }
  };
  const cloudflaredRuntime = {
    process: null,
    mode: "quick",
    useHttp2: true,
    tunnelToken: "",
    localPort: 8787,
    outputTail: []
  };
  let persistCalls = 0;

  registerAdminSettingsRoutes(app, {
    config,
    cloudflaredRuntime,
    runtimeStats: { recentRequests: [] },
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {}
    },
    persistProxyConfigEnv: async () => {
      persistCalls += 1;
    },
    readJsonBody,
    normalizeUpstreamMode: (value) => value,
    normalizeCodexServiceTier: (value) => value,
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart", "manual"]),
    multiAccountStrategyList: "smart, manual",
    validMultiAccountPoolFilters: new Set(["all", "team-only"]),
    multiAccountPoolFilterList: "all, team-only",
    expiredAccountCleanupController: {
      configure() {
        assert.fail("expired account cleanup should not be reconfigured for invalid config");
      },
      run() {
        assert.fail("expired account cleanup should not run for invalid config");
      }
    },
    sanitizeModelMappings: (value) => value,
    getActiveUpstreamBaseUrl: () => config.upstreamBaseUrl,
    isCodexMultiAccountEnabled: () => true,
    runDirectChatCompletionTest: async () => ({}),
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = createRouteResponse();

  return {
    cloudflaredRuntime,
    config,
    handler,
    response,
    routes,
    get persistCalls() {
      return persistCalls;
    }
  };
}

test("admin settings preserve request body errors without mutating runtime state", async () => {
  const invalidJsonError = new Error("Body must be valid JSON.");
  invalidJsonError.code = "invalid_json";
  invalidJsonError.statusCode = 400;
  const harness = createAdminConfigValidationHarness({
    readJsonBody: async () => {
      throw invalidJsonError;
    }
  });

  await harness.handler({}, harness.response);

  assert.equal(harness.response.statusCode, 400);
  assertNoStoreHeaders(harness.response);
  assert.equal(harness.response.payload?.error, "invalid_json");
  assert.equal(harness.response.payload?.message, "Body must be valid JSON.");
  assert.equal(harness.config.codex.defaultModel, "gpt-5.4");
  assert.equal(harness.config.codexOAuth.multiAccountStrategy, "smart");
  assert.equal(harness.persistCalls, 0);

  const testHandler = harness.routes.get("POST /admin/test");
  assert.equal(typeof testHandler, "function");
  const testResponse = createRouteResponse();
  await testHandler({}, testResponse);

  assert.equal(testResponse.statusCode, 400);
  assertNoStoreHeaders(testResponse);
  assert.equal(testResponse.payload?.error, "invalid_json");
  assert.equal(testResponse.payload?.message, "Body must be valid JSON.");
});

test("admin config rejects invalid multiAccountPoolFilter without mutating runtime config", async () => {
  const harness = createAdminConfigValidationHarness({
    readJsonBody: async () => ({
      defaultModel: "gpt-5.5",
      multiAccountStrategy: "manual",
      multiAccountPoolFilter: "not-real"
    })
  });

  await harness.handler({}, harness.response);

  assert.equal(harness.response.statusCode, 400);
  assertNoStoreHeaders(harness.response);
  assert.equal(harness.response.payload?.error, "invalid_config");
  assert.match(harness.response.payload?.message, /multiAccountPoolFilter must be one of: all, team-only/);
  assert.equal(harness.config.codex.defaultModel, "gpt-5.4");
  assert.equal(harness.config.codexOAuth.multiAccountStrategy, "smart");
  assert.equal(harness.config.codexOAuth.multiAccountPoolFilter, "all");
  assert.equal(harness.persistCalls, 0);
});

test("admin config rejects invalid multiAccountStrategy without mutating runtime config", async () => {
  const harness = createAdminConfigValidationHarness({
    readJsonBody: async () => ({
      multiAccountStrategy: "roulette",
      multiAccountPoolFilter: "team-only"
    })
  });

  await harness.handler({}, harness.response);

  assert.equal(harness.response.statusCode, 400);
  assertNoStoreHeaders(harness.response);
  assert.equal(harness.response.payload?.error, "invalid_config");
  assert.match(harness.response.payload?.message, /multiAccountStrategy must be one of: smart, manual/);
  assert.equal(harness.config.codexOAuth.multiAccountStrategy, "smart");
  assert.equal(harness.config.codexOAuth.multiAccountPoolFilter, "all");
  assert.equal(harness.persistCalls, 0);
});

test("admin config rejects invalid publicAccessMode without mutating runtime config", async () => {
  const harness = createAdminConfigValidationHarness({
    readJsonBody: async () => ({
      defaultModel: "gpt-5.5",
      multiAccountStrategy: "manual",
      multiAccountPoolFilter: "team-only",
      autoLogoutExpiredAccounts: true,
      publicAccessMode: "side-door",
      publicAccessUseHttp2: false,
      publicAccessToken: "tunnel-token"
    })
  });

  await harness.handler({}, harness.response);

  assert.equal(harness.response.statusCode, 400);
  assert.equal(harness.response.payload?.error, "invalid_config");
  assert.match(harness.response.payload?.message, /publicAccessMode must be one of: quick, auth\./);
  assert.equal(harness.config.codex.defaultModel, "gpt-5.4");
  assert.equal(harness.config.codexOAuth.multiAccountStrategy, "smart");
  assert.equal(harness.config.codexOAuth.multiAccountPoolFilter, "all");
  assert.equal(harness.config.expiredAccountCleanup.enabled, false);
  assert.equal(harness.config.publicAccess.defaultMode, "quick");
  assert.equal(harness.config.publicAccess.defaultUseHttp2, true);
  assert.equal(harness.config.publicAccess.defaultTunnelToken, "");
  assert.equal(harness.cloudflaredRuntime.mode, "quick");
  assert.equal(harness.cloudflaredRuntime.useHttp2, true);
  assert.equal(harness.cloudflaredRuntime.tunnelToken, "");
  assert.equal(harness.persistCalls, 0);
});

test("admin config persists the dashboard autosave payload fields", async () => {
  const routes = new Map();
  const app = {
    get() {},
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    }
  };
  const config = {
    host: "127.0.0.1",
    port: 8787,
    runtimePort: 8787,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://codex.example.test",
    gemini: { baseUrl: "https://gemini.example.test" },
    anthropic: { baseUrl: "https://anthropic.example.test" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "all"
    },
    expiredAccountCleanup: {
      enabled: false,
      intervalSeconds: 30
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    requestAudit: {
      historyPath: "C:/tmp/recent-requests.json"
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: "",
      localPort: 8787
    }
  };
  const cloudflaredRuntime = {
    process: null,
    mode: "quick",
    useHttp2: true,
    tunnelToken: "",
    localPort: 8787,
    outputTail: []
  };
  const rawMappings = { "gpt-5": "gpt-5.4", "gpt-5-mini": "gpt-5.4-mini" };
  const sanitizedMappings = { "gpt-5": "gpt-5.4" };
  let persistedConfig = null;
  let cleanupConfigured = null;
  let cleanupRunReason = "";

  registerAdminSettingsRoutes(app, {
    config,
    cloudflaredRuntime,
    runtimeStats: { recentRequests: [] },
    recentRequestsStore: {
      clear() {
        return { recentRequests: [] };
      },
      async flush() {}
    },
    persistProxyConfigEnv: async (nextConfig) => {
      persistedConfig = structuredClone(nextConfig);
    },
    readJsonBody: async () => ({
      upstreamMode: "anthropic-v1",
      upstreamBaseUrl: "https://anthropic-new.example.test",
      defaultModel: "gpt-5.5",
      defaultInstructions: "Keep it crisp.",
      defaultServiceTier: "flex",
      multiAccountStrategy: "manual",
      multiAccountPoolFilter: "team-only",
      autoLogoutExpiredAccounts: true,
      publicAccessMode: "auth",
      publicAccessUseHttp2: false,
      publicAccessToken: "tunnel-token",
      modelRouterEnabled: false,
      modelMappings: rawMappings
    }),
    normalizeUpstreamMode: (value) => String(value || "").trim().toLowerCase(),
    normalizeCodexServiceTier: (value) => String(value || "").trim().toLowerCase(),
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart", "manual"]),
    multiAccountStrategyList: "smart, manual",
    validMultiAccountPoolFilters: new Set(["all", "team-only"]),
    multiAccountPoolFilterList: "all, team-only",
    expiredAccountCleanupController: {
      configure(settings) {
        cleanupConfigured = settings;
      },
      run(reason) {
        cleanupRunReason = reason;
        return Promise.resolve();
      }
    },
    sanitizeModelMappings(value) {
      assert.deepEqual(value, rawMappings);
      return sanitizedMappings;
    },
    getActiveUpstreamBaseUrl: () => config.anthropic.baseUrl,
    isCodexMultiAccountEnabled: () => true,
    runDirectChatCompletionTest: async () => ({}),
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = createRouteResponse();

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(config.upstreamMode, "anthropic-v1");
  assert.equal(config.anthropic.baseUrl, "https://anthropic-new.example.test");
  assert.equal(config.codex.defaultModel, "gpt-5.5");
  assert.equal(config.codex.defaultInstructions, "Keep it crisp.");
  assert.equal(config.codex.defaultServiceTier, "flex");
  assert.equal(config.codexOAuth.multiAccountStrategy, "manual");
  assert.equal(config.codexOAuth.multiAccountPoolFilter, "team-only");
  assert.equal(config.expiredAccountCleanup.enabled, true);
  assert.equal(config.publicAccess.defaultMode, "auth");
  assert.equal(config.publicAccess.defaultUseHttp2, false);
  assert.equal(config.publicAccess.defaultTunnelToken, "tunnel-token");
  assert.equal(config.modelRouter.enabled, false);
  assert.deepEqual(config.modelRouter.customMappings, sanitizedMappings);
  assert.equal(cloudflaredRuntime.mode, "auth");
  assert.equal(cloudflaredRuntime.useHttp2, false);
  assert.equal(cloudflaredRuntime.tunnelToken, "tunnel-token");
  assert.equal(persistedConfig?.publicAccess?.defaultMode, "auth");
  assert.equal(persistedConfig?.modelRouter?.enabled, false);
  assert.deepEqual(persistedConfig?.modelRouter?.customMappings, sanitizedMappings);
  assert.deepEqual(cleanupConfigured, { enabled: true, intervalSeconds: 30 });
  assert.equal(cleanupRunReason, "config_update");
  assert.equal(response.payload?.config?.upstreamMode, "anthropic-v1");
  assert.equal(response.payload?.config?.upstreamBaseUrl, "https://anthropic-new.example.test");
  assert.equal(response.payload?.config?.publicAccess?.mode, "auth");
  assert.equal(response.payload?.config?.publicAccess?.useHttp2, false);
  assert.equal(response.payload?.config?.modelRouterEnabled, false);
  assert.deepEqual(response.payload?.config?.modelMappings, sanitizedMappings);
});

test("stopCloudflaredTunnel waits for the child exit before resolving", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?lifecycle-control=${Date.now()}`);
  const runtime = serverModule.__testing.getCloudflaredRuntime();
  const child = new EventEmitter();
  let resolved = false;

  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4321;
  child.kill = () => true;
  child.once = child.once.bind(child);

  runtime.process = child;
  runtime.running = true;
  runtime.pid = child.pid;
  runtime.url = "https://example.trycloudflare.com";

  const stopPromise = serverModule.__testing.stopCloudflaredTunnel().then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(resolved, false);

  child.exitCode = 0;
  child.emit("exit", 0, null);
  await stopPromise;

  assert.equal(runtime.process, null);
  assert.equal(runtime.running, false);
  assert.equal(runtime.pid, null);
});

test("stopServer closes the Codex callback server during shutdown", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  process.env.AUTH_MODE = "codex-oauth";
  process.env.CODEX_OAUTH_CALLBACK_PORT = "0";

  const serverModule = await import(`../src/server.js?callback-shutdown=${Date.now()}`);

  await serverModule.__testing.ensureCodexOAuthCallbackServer();
  const callbackServer = serverModule.__testing.getCodexOAuthCallbackServer();

  assert.ok(callbackServer?.listening);

  await serverModule.stopServer("TEST");

  assert.equal(serverModule.__testing.getCodexOAuthCallbackServer(), null);
  assert.equal(callbackServer.listening, false);
});

test("stopServer does not hang forever when cloudflared shutdown stalls", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const serverModule = await import(`../src/server.js?shutdown-timeout=${Date.now()}`);
  const runtime = serverModule.__testing.getCloudflaredRuntime();
  const child = new EventEmitter();

  child.exitCode = null;
  child.signalCode = null;
  child.pid = 9876;
  child.kill = () => true;
  child.once = child.once.bind(child);

  runtime.process = child;
  runtime.running = true;
  runtime.pid = child.pid;

  const startedAt = Date.now();
  await serverModule.stopServer("TEST");
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 6000, `expected stopServer to remain bounded, got ${elapsedMs}ms`);
});
