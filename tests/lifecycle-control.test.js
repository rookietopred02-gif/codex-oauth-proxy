import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { stopAppServer } from "../src/app-server.js";
import { registerAdminSettingsRoutes } from "../src/routes/admin-settings.js";

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
      defaultServiceTier: "default",
      defaultReasoningEffort: "medium"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart"
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
    readJsonBody: async () => ({ publicAccessAutoInstall: false }),
    normalizeUpstreamMode: (value) => value,
    normalizeCodexServiceTier: (value) => value,
    parseReasoningEffortOrFallback: (value) => value,
    validMultiAccountStrategies: new Set(["smart"]),
    multiAccountStrategyList: "smart",
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
    tempMailController: {
      async start() {
        return {};
      },
      async stop() {
        return {};
      }
    },
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(config.publicAccess.autoInstall, false);
  assert.equal(persistedConfig?.publicAccess?.autoInstall, false);
});

test("admin config persists runtimePort without changing the active port", async () => {
  const routes = new Map();
  const app = {
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
      defaultServiceTier: "default",
      defaultReasoningEffort: "medium"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart"
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
    tempMailController: {
      async start() {
        return {};
      },
      async stop() {
        return {};
      }
    },
    parseNumberEnv: (value) => Number(value)
  });

  const handler = routes.get("POST /admin/config");
  assert.equal(typeof handler, "function");

  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(config.port, 8787);
  assert.equal(config.runtimePort, 8899);
  assert.equal(cloudflaredRuntime.localPort, 8787);
  assert.equal(persistedConfig?.runtimePort, 8899);
  assert.equal(response.payload?.config?.activeRuntimePort, 8787);
  assert.equal(response.payload?.config?.runtimePort, 8899);
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
