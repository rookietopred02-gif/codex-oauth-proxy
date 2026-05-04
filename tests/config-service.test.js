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

test("createServerConfig defaults recent request packets to metadata-only capture", () => {
  const { config } = createServerConfig({
    env: {
      AUTH_MODE: "codex-oauth"
    },
    runtimePaths: createRuntimePaths("audit-defaults")
  });

  assert.equal(config.requestAudit.capturePackets, false);
  assert.equal(config.requestAudit.maxPacketChars, 65536);
});

test("createServerConfig can explicitly enable bounded recent request packet capture", () => {
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

test("buildProxyConfigEnvEntries persists runtime port for proxy and cloudflared", () => {
  const entries = buildProxyConfigEnvEntries({
    port: 8787,
    runtimePort: 9988,
    upstreamMode: "codex-chatgpt",
    upstreamBaseUrl: "https://example.test",
    gemini: { baseUrl: "" },
    anthropic: { baseUrl: "" },
    codex: {
      defaultModel: "gpt-5.4",
      defaultInstructions: "",
      defaultServiceTier: "default",
      planModeReasoningEffort: "high"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart",
      multiAccountPoolFilter: "team-only"
    },
    expiredAccountCleanup: {
      enabled: false
    },
    modelRouter: {
      enabled: true,
      customMappings: {}
    },
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      autoInstall: true,
      defaultTunnelToken: ""
    }
  });

  assert.equal(entries.PORT, 9988);
  assert.equal(entries.CLOUDFLARED_LOCAL_PORT, 9988);
  assert.equal(entries.CODEX_DEFAULT_SERVICE_TIER, "default");
  assert.equal(Object.hasOwn(entries, "CODEX_DEFAULT_REASONING_EFFORT"), false);
  assert.equal(Object.hasOwn(entries, "CODEX_PLAN_MODE_REASONING_EFFORT"), false);
  assert.equal(entries.CODEX_MULTI_ACCOUNT_POOL_FILTER, "team-only");
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
