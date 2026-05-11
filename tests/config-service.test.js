import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildProxyConfigEnvEntries } from "../src/env-config-store.js";
import {
  OFFICIAL_CODEX_MODELS,
  clampReasoningEffortForModel,
  createServerConfig,
  normalizeUpstreamMode,
  parseBooleanEnv,
  parseNumberEnv,
  parseSlotValue,
  resolveServerRuntimePaths,
  sanitizeModelMappings
} from "../src/services/config-service.js";

function createRuntimePaths(rootName = "config-service-fixture") {
  return resolveServerRuntimePaths({
    rootDir: path.join("C:/tmp", rootName),
    env: {}
  });
}

test("normalize helpers preserve backward-compatible upstream aliases", () => {
  assert.equal(normalizeUpstreamMode("openai-v1"), "codex-chatgpt");
  assert.equal(parseBooleanEnv("on", false), true);
  assert.equal(parseBooleanEnv("off", true), false);
  assert.equal(parseSlotValue("8"), 8);
  assert.equal(parseSlotValue("0"), null);
  assert.deepEqual(
    sanitizeModelMappings({
      " gpt-5 ": " gpt-5.4 ",
      empty: "",
      bad: 42
    }),
    { "gpt-5": "gpt-5.4" }
  );
});

test("integer config parsers reject decimal-form values", () => {
  assert.equal(parseSlotValue("8.0"), null);
  assert.equal(parseSlotValue(8.5), null);
  assert.equal(parseNumberEnv("42", 7, { min: 1, max: 100, integer: true }), 42);
  assert.equal(parseNumberEnv("42.0", 7, { min: 1, max: 100, integer: true }), 7);
  assert.equal(parseNumberEnv(42.5, 7, { min: 1, max: 100, integer: true }), 7);
});

test("createServerConfig rejects decimal-form integer env values", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      PORT: "8899.0",
      CODEX_OAUTH_CALLBACK_PORT: "1456.0",
      CODEX_AUTO_LOGOUT_EXPIRED_INTERVAL_SECONDS: "90.0",
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "120000.0",
      RECENT_REQUESTS_MAX_ENTRIES: "240.0",
      RECENT_REQUESTS_MAX_PACKET_CHARS: "1024.0",
      DASHBOARD_AUTH_SESSION_TTL_SECONDS: "600.0",
      DASHBOARD_AUTH_LOGIN_MAX_ATTEMPTS: "5.0"
    },
    runtimePaths: createRuntimePaths("decimal-integer-env")
  });

  assert.equal(config.port, 8787);
  assert.equal(config.runtimePort, 8787);
  assert.equal(config.publicAccess.localPort, 8787);
  assert.equal(config.codexOAuth.callbackPort, 1455);
  assert.equal(config.codexOAuth.redirectUri, "http://localhost:1455/auth/callback");
  assert.equal(config.expiredAccountCleanup.intervalSeconds, 30);
  assert.equal(config.upstreamStreamIdleTimeoutMs, 900_000);
  assert.equal(config.requestAudit.maxEntries, 120);
  assert.equal(config.requestAudit.maxPacketChars, 65536);
  assert.equal(config.dashboardAuth.sessionTtlSeconds, 12 * 60 * 60);
  assert.equal(config.dashboardAuth.loginMaxAttempts, 10);
});

test("createServerConfig normalizes invalid strategy and tunnel mode", () => {
  const warnings = [];
  const { config, flags } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      CODEX_MULTI_ACCOUNT_STRATEGY: "broken",
      CLOUDFLARED_MODE: "invalid",
      MODEL_ROUTER_MAPPINGS: JSON.stringify({
        " gpt-5 ": " gpt-5.4 ",
        empty: ""
      })
    },
    runtimePaths: createRuntimePaths(),
    logger: {
      warn(message) {
        warnings.push(String(message || ""));
      }
    }
  });

  assert.equal(config.codexOAuth.multiAccountStrategy, "smart");
  assert.equal(config.publicAccess.defaultMode, "quick");
  assert.deepEqual(config.modelRouter.customMappings, { "gpt-5": "gpt-5.4" });
  assert.equal(flags.hasExplicitCustomOAuthRedirectUri, false);
  assert.equal(flags.hasExplicitCloudflaredLocalPort, false);
  assert.equal(warnings.length, 1);
});

test("createServerConfig normalizes an invalid pool filter", () => {
  const warnings = [];
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      CODEX_MULTI_ACCOUNT_POOL_FILTER: "broken"
    },
    runtimePaths: createRuntimePaths("pool-filter"),
    logger: {
      warn(message) {
        warnings.push(String(message || ""));
      }
    }
  });

  assert.equal(config.codexOAuth.multiAccountPoolFilter, "all");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CODEX_MULTI_ACCOUNT_POOL_FILTER/);
});

test("createServerConfig preserves every supported account pool filter", () => {
  for (const filter of ["all", "exclude-free", "standard-only", "team-only", "free-only"]) {
    const { config } = createServerConfig({
      env: {
        AUTH_MODE: "codex-oauth",
        CODEX_MULTI_ACCOUNT_POOL_FILTER: filter
      },
      runtimePaths: createRuntimePaths(`pool-filter-${filter}`)
    });

    assert.equal(config.codexOAuth.multiAccountPoolFilter, filter);
  }
});

test("createServerConfig binds public access to the runtime port", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      PORT: "8899",
      CLOUDFLARED_LOCAL_PORT: "7788"
    },
    runtimePaths: createRuntimePaths("runtime-port")
  });

  assert.equal(config.port, 8899);
  assert.equal(config.runtimePort, 8899);
  assert.equal(config.publicAccess.localPort, 8899);
});

test("createServerConfig defaults Codex to GPT-5.5", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth"
    },
    runtimePaths: createRuntimePaths("default-model")
  });

  assert.equal(config.codex.defaultModel, "gpt-5.5");
  assert.equal(config.codex.defaultServiceTier, "priority");
  assert.equal(OFFICIAL_CODEX_MODELS[0], "gpt-5.5");
});

test("createServerConfig defaults recent request packets to bounded capture", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth"
    },
    runtimePaths: createRuntimePaths("audit-defaults")
  });

  assert.equal(config.requestAudit.capturePackets, true);
  assert.equal(config.requestAudit.maxPacketChars, 65536);
});

test("createServerConfig can explicitly disable recent request packet capture", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      RECENT_REQUESTS_CAPTURE_PACKETS: "false"
    },
    runtimePaths: createRuntimePaths("audit-disabled")
  });

  assert.equal(config.requestAudit.capturePackets, false);
  assert.equal(config.requestAudit.maxPacketChars, 65536);
});

test("createServerConfig bounds explicit recent request packet capture limits", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      RECENT_REQUESTS_CAPTURE_PACKETS: "true",
      RECENT_REQUESTS_MAX_PACKET_CHARS: "999999999"
    },
    runtimePaths: createRuntimePaths("audit-env")
  });

  assert.equal(config.requestAudit.capturePackets, true);
  assert.equal(config.requestAudit.maxPacketChars, 1024 * 1024);
});

test("buildProxyConfigEnvEntries round-trips dashboard autosave settings", () => {
  const entries = buildProxyConfigEnvEntries({
    port: 8787,
    runtimePort: 9988,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "" },
    anthropic: { baseUrl: "" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "Keep it crisp.",
      defaultServiceTier: "default",
      planModeReasoningEffort: "high"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "manual",
      multiAccountPoolFilter: "team-only"
    },
    expiredAccountCleanup: {
      enabled: true
    },
    modelRouter: {
      enabled: false,
      customMappings: {
        "gpt-5": "gpt-5.4"
      }
    },
    publicAccess: {
      defaultMode: "auth",
      defaultUseHttp2: false,
      autoInstall: false,
      defaultTunnelToken: "tunnel-token"
    }
  });

  assert.equal(entries.PORT, 9988);
  assert.equal(entries.CLOUDFLARED_LOCAL_PORT, 9988);
  assert.equal(entries.CODEX_DEFAULT_INSTRUCTIONS, "Keep it crisp.");
  assert.equal(entries.CODEX_DEFAULT_SERVICE_TIER, "default");
  assert.equal(Object.hasOwn(entries, "CODEX_DEFAULT_REASONING_EFFORT"), false);
  assert.equal(Object.hasOwn(entries, "CODEX_PLAN_MODE_REASONING_EFFORT"), false);
  assert.equal(entries.CODEX_MULTI_ACCOUNT_STRATEGY, "manual");
  assert.equal(entries.CODEX_MULTI_ACCOUNT_POOL_FILTER, "team-only");
  assert.equal(entries.CODEX_AUTO_LOGOUT_EXPIRED_ACCOUNTS, true);
  assert.equal(entries.MODEL_ROUTER_ENABLED, false);
  assert.equal(entries.MODEL_ROUTER_MAPPINGS, "{\"gpt-5\":\"gpt-5.4\"}");
  assert.equal(entries.CLOUDFLARED_MODE, "auth");
  assert.equal(entries.CLOUDFLARED_USE_HTTP2, false);
  assert.equal(entries.CLOUDFLARED_AUTO_INSTALL, false);
  assert.equal(entries.CLOUDFLARED_TUNNEL_TOKEN, "tunnel-token");

  const { config } = createServerConfig({
    env: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, String(value)])),
    runtimePaths: createRuntimePaths("autosave-roundtrip")
  });

  assert.equal(config.runtimePort, 9988);
  assert.equal(config.publicAccess.localPort, 9988);
  assert.equal(config.codex.defaultInstructions, "Keep it crisp.");
  assert.equal(config.codex.defaultServiceTier, "default");
  assert.equal(config.codexOAuth.multiAccountStrategy, "manual");
  assert.equal(config.codexOAuth.multiAccountPoolFilter, "team-only");
  assert.equal(config.expiredAccountCleanup.enabled, true);
  assert.equal(config.modelRouter.enabled, false);
  assert.deepEqual(config.modelRouter.customMappings, { "gpt-5": "gpt-5.4" });
  assert.equal(config.publicAccess.defaultMode, "auth");
  assert.equal(config.publicAccess.defaultUseHttp2, false);
  assert.equal(config.publicAccess.autoInstall, false);
  assert.equal(config.publicAccess.defaultTunnelToken, "tunnel-token");
});

test("buildProxyConfigEnvEntries rejects decimal-form runtime ports", () => {
  const fallbackEntries = buildProxyConfigEnvEntries({
    port: "8788",
    runtimePort: "9988.1"
  });

  assert.equal(fallbackEntries.PORT, 8788);
  assert.equal(fallbackEntries.CLOUDFLARED_LOCAL_PORT, 8788);

  const defaultEntries = buildProxyConfigEnvEntries({
    port: "8788.1",
    runtimePort: "9988.1"
  });

  assert.equal(defaultEntries.PORT, 8787);
  assert.equal(defaultEntries.CLOUDFLARED_LOCAL_PORT, 8787);
});

test("createServerConfig does not expose a default reasoning effort", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      CODEX_DEFAULT_REASONING_EFFORT: "xhigh"
    },
    runtimePaths: createRuntimePaths("default-reasoning-removed")
  });

  assert.equal(Object.hasOwn(config.codex, "defaultReasoningEffort"), false);
});

test("createServerConfig rejects incomplete custom oauth config", () => {
  assert.throws(
    () =>
      createServerConfig({
        env: {
          AUTH_MODE: "custom-oauth",
          OAUTH_AUTHORIZE_URL: "https://auth.example.test/authorize"
        },
        runtimePaths: createRuntimePaths("custom-oauth")
      }),
    /Missing OAuth config/
  );
});

test("createServerConfig reads plan mode reasoning effort from env", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth",
      CODEX_PLAN_MODE_REASONING_EFFORT: "high"
    },
    runtimePaths: createRuntimePaths("plan-mode-reasoning")
  });

  assert.equal(config.codex.planModeReasoningEffort, "high");
});

test("clampReasoningEffortForModel downgrades unsupported GPT-5 modes", () => {
  assert.equal(clampReasoningEffortForModel("xhigh", "gpt-5-pro"), "high");
  assert.equal(clampReasoningEffortForModel("none", "gpt-5-codex"), "low");
  assert.equal(clampReasoningEffortForModel("medium", "gpt-5.4"), "medium");
});
