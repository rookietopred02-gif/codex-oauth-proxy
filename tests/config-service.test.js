import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildProxyConfigEnvEntries } from "../src/env-config-store.js";
import {
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
      defaultReasoningEffort: "medium"
    },
    codexOAuth: {
      multiAccountEnabled: true,
      multiAccountStrategy: "smart"
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

test("clampReasoningEffortForModel downgrades unsupported GPT-5 modes", () => {
  assert.equal(clampReasoningEffortForModel("xhigh", "gpt-5-pro"), "high");
  assert.equal(clampReasoningEffortForModel("none", "gpt-5-codex"), "low");
  assert.equal(clampReasoningEffortForModel("medium", "gpt-5.4"), "medium");
});
