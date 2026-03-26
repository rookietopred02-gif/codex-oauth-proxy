// @ts-check

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS, MAX_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../upstream-timeouts.js";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OPENAI_CODEX_SCOPES = ["openid", "profile", "email", "offline_access"];
export const DEFAULT_CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_GEMINI_UPSTREAM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_CLOUDFLARED_BIN = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
export const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
export const VALID_REASONING_EFFORT_MODES = new Set(["none", "low", "medium", "high", "xhigh", "adaptive"]);
export const VALID_MULTI_ACCOUNT_STRATEGIES = new Set(["smart", "manual", "round-robin", "random", "sticky"]);
export const MULTI_ACCOUNT_STRATEGY_LIST = [...VALID_MULTI_ACCOUNT_STRATEGIES].join(", ");
export const VALID_CLOUDFLARED_MODES = new Set(["quick", "auth"]);
export const VALID_CODEX_SERVICE_TIERS = new Set(["default", "priority"]);
export const LOW_QUOTA_THRESHOLD_DUAL_WINDOW = 20;
export const LOW_QUOTA_THRESHOLD_SINGLE_WINDOW = 30;
export const OFFICIAL_CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5-codex",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "codex-mini-latest"
];
export const OFFICIAL_OPENAI_MODELS = [
  ...OFFICIAL_CODEX_MODELS,
  "gpt-5.4-pro",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "o3",
  "o4-mini"
];
export const OFFICIAL_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-pro",
  "gemini-1.5-flash"
];
export const OFFICIAL_ANTHROPIC_MODELS = [
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest"
];
export const OAUTH_CALLBACK_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your dashboard to continue.</p>
</body>
</html>`;

const DEFAULT_UPSTREAM_MODE = "codex-chatgpt";
const DEFAULT_PROFILE_STORE_PATH = path.join(os.homedir(), ".codex-pro-max", "auth-profiles.json");
const LEGACY_PROFILE_STORE_PATH = path.join(os.homedir(), ".codex-oauth-proxy", "auth-profiles.json");
const RESOLVED_PROFILE_STORE_PATH =
  fsSync.existsSync(DEFAULT_PROFILE_STORE_PATH) || !fsSync.existsSync(LEGACY_PROFILE_STORE_PATH)
    ? DEFAULT_PROFILE_STORE_PATH
    : LEGACY_PROFILE_STORE_PATH;

/**
 * @typedef {{
 *   appDataDir: string;
 *   runtimeDataDir: string;
 *   runtimeBinDir: string;
 *   bundledCloudflaredResourcesDir: string;
 *   publicDir: string;
 *   envFilePath: string;
 * }} RuntimePaths
 */

/**
 * @typedef {{
 *   rootDir?: string;
 *   env?: NodeJS.ProcessEnv;
 * }} ResolveServerRuntimePathsOptions
 */

/**
 * @typedef {{
 *   warn: (message: string) => void;
 * }} WarnLogger
 */

/**
 * @typedef {{
 *   env?: NodeJS.ProcessEnv;
 *   runtimePaths?: RuntimePaths;
 *   logger?: WarnLogger;
 * }} CreateServerConfigOptions
 */

export function getDefaultCodexClientVersion(env = process.env) {
  return env.CODEX_CLIENT_VERSION || "2026.2.26";
}

/**
 * @param {ResolveServerRuntimePathsOptions} [options]
 * @returns {RuntimePaths}
 */
export function resolveServerRuntimePaths(options = {}) {
  const { rootDir, env = process.env } = options;
  if (!rootDir) {
    throw new Error("rootDir is required");
  }

  const appDataDir = String(env.CODEX_PRO_MAX_APP_DATA_DIR || "").trim();
  const runtimeDataDir = path.resolve(
    env.CODEX_PRO_MAX_DATA_DIR || (appDataDir ? path.join(appDataDir, "data") : path.join(rootDir, "data"))
  );
  const runtimeBinDir = path.resolve(
    env.CODEX_PRO_MAX_RUNTIME_BIN_DIR || (appDataDir ? path.join(appDataDir, "bin") : path.join(rootDir, "bin"))
  );

  return {
    appDataDir,
    runtimeDataDir,
    runtimeBinDir,
    bundledCloudflaredResourcesDir: String(env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR || "").trim(),
    publicDir: path.resolve(env.CODEX_PRO_MAX_PUBLIC_DIR || path.join(rootDir, "public")),
    envFilePath: path.resolve(env.DOTENV_CONFIG_PATH || path.join(rootDir, ".env"))
  };
}

function resolveRuntimeDataPath(runtimeDataDir, env, envName, fileName) {
  return path.resolve(env[envName] || path.join(runtimeDataDir, fileName));
}

export function resolveBundledCloudflaredTargetNames(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return ["win32-x64"];
  if (platform === "linux" && arch === "x64") return ["linux-x64"];
  if (platform === "darwin" && arch === "arm64") return ["darwin-arm64", "darwin-x64"];
  if (platform === "darwin" && arch === "x64") return ["darwin-x64", "darwin-arm64"];
  return [];
}

export function resolveBundledCloudflaredBinaryName(platform = process.platform) {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

export function normalizeUpstreamMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai-v1") return "codex-chatgpt";
  return normalized;
}

export function normalizeCodexServiceTier(value, fallback = "default") {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_CODEX_SERVICE_TIERS.has(normalized)) return normalized;
  return VALID_CODEX_SERVICE_TIERS.has(fallback) ? fallback : "default";
}

export function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseSlotValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const slot = Math.floor(n);
  if (slot < 1 || slot > 64) return null;
  return slot;
}

export function parseNumberEnv(value, fallback, options = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (Number.isFinite(options.min)) out = Math.max(options.min, out);
  if (Number.isFinite(options.max)) out = Math.min(options.max, out);
  if (options.integer) out = Math.floor(out);
  return out;
}

export function sanitizeModelMappings(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (typeof rawKey !== "string" || typeof rawValue !== "string") continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {{ logger?: WarnLogger }} [options]
 */
export function parseModelMappingsEnv(value, { logger = console } = {}) {
  if (!value || typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return sanitizeModelMappings(parsed);
  } catch (err) {
    logger.warn(`[model-router] failed to parse MODEL_ROUTER_MAPPINGS JSON: ${err.message}`);
    return {};
  }
}

export function parseReasoningEffortOrFallback(value, fallback, options = {}) {
  const allowAdaptive = options.allowAdaptive === true;
  if (typeof value !== "string") return fallback;
  let normalized = value.trim().toLowerCase();
  if (normalized === "minimal") normalized = "low";
  const validSet = allowAdaptive ? VALID_REASONING_EFFORT_MODES : VALID_REASONING_EFFORTS;
  if (validSet.has(normalized)) return normalized;
  return fallback;
}

function getGpt5MinorVersionForReasoning(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (!normalized.startsWith("gpt-5")) return null;
  const match = normalized.match(/^gpt-5(?:\.(\d+))?(?:[-.].*)?$/);
  if (!match) return null;
  const minor = match[1] === undefined ? 0 : Number(match[1]);
  return Number.isFinite(minor) ? minor : null;
}

export function getSupportedReasoningEffortsForModel(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (!normalized) return null;

  const minor = getGpt5MinorVersionForReasoning(normalized);
  if (minor === null) return null;

  const isCodex = normalized.includes("-codex");
  const isPro = normalized.includes("-pro");
  const isGpt5Pro = normalized.startsWith("gpt-5-pro");
  const isGpt51CodexMax = normalized.startsWith("gpt-5.1-codex-max");

  if (isGpt5Pro) {
    return new Set(["high"]);
  }

  if (isPro) {
    return new Set(["medium", "high", "xhigh"]);
  }

  const supportsNone = !isCodex && minor >= 1;
  const supportsXhigh = minor >= 2 || isGpt51CodexMax;

  const supported = isGpt51CodexMax ? new Set(["none", "medium", "high"]) : new Set(["low", "medium", "high"]);
  if (supportsNone) supported.add("none");
  if (supportsXhigh) supported.add("xhigh");
  return supported;
}

export function clampReasoningEffortForModel(effort, modelId) {
  if (!VALID_REASONING_EFFORTS.has(effort)) return effort;

  const supported = getSupportedReasoningEffortsForModel(modelId);
  if (!supported || supported.has(effort)) return effort;

  const fallbackOrder = {
    none: ["low", "medium", "high", "xhigh"],
    low: ["medium", "high", "xhigh", "none"],
    medium: ["high", "low", "xhigh", "none"],
    high: ["medium", "low", "xhigh", "none"],
    xhigh: ["high", "medium", "low", "none"]
  };

  const candidates = fallbackOrder[effort] || ["medium"];
  for (const candidate of candidates) {
    if (supported.has(candidate)) return candidate;
  }
  return effort;
}

/**
 * @param {any} config
 * @param {{ logger?: WarnLogger }} [options]
 */
export function validateServerConfig(config, { logger = console } = {}) {
  if (config.authMode !== "profile-store" && config.authMode !== "codex-oauth" && config.authMode !== "custom-oauth") {
    throw new Error("AUTH_MODE must be one of: profile-store, codex-oauth, custom-oauth");
  }

  if (
    config.upstreamMode !== "codex-chatgpt" &&
    config.upstreamMode !== "gemini-v1beta" &&
    config.upstreamMode !== "anthropic-v1"
  ) {
    throw new Error("UPSTREAM_MODE must be one of: codex-chatgpt, gemini-v1beta, anthropic-v1");
  }

  if (config.authMode === "custom-oauth") {
    if (!config.customOAuth.authorizeUrl || !config.customOAuth.tokenUrl || !config.customOAuth.clientId) {
      throw new Error("Missing OAuth config. Set OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, OAUTH_CLIENT_ID.");
    }
  }

  if (!VALID_MULTI_ACCOUNT_STRATEGIES.has(config.codexOAuth.multiAccountStrategy)) {
    logger.warn(
      `Invalid CODEX_MULTI_ACCOUNT_STRATEGY="${config.codexOAuth.multiAccountStrategy}", fallback to smart. Supported: ${MULTI_ACCOUNT_STRATEGY_LIST}.`
    );
    config.codexOAuth.multiAccountStrategy = "smart";
  }

  if (!VALID_CLOUDFLARED_MODES.has(config.publicAccess.defaultMode)) {
    config.publicAccess.defaultMode = "quick";
  }

  return config;
}

/**
 * @param {CreateServerConfigOptions} [options]
 */
export function createServerConfig(options = {}) {
  const { env = process.env, runtimePaths, logger = console } = options;
  const paths = runtimePaths || resolveServerRuntimePaths({ rootDir: path.resolve("."), env });
  const authMode = String(env.AUTH_MODE || "codex-oauth").trim().toLowerCase();
  const hasExplicitCustomOAuthRedirectUri = String(env.OAUTH_REDIRECT_URI || "").trim().length > 0;
  const hasExplicitCloudflaredLocalPort = String(env.CLOUDFLARED_LOCAL_PORT || "").trim().length > 0;
  const resolvedRuntimePort = parseNumberEnv(env.PORT, 8787, {
    min: 1,
    max: 65535,
    integer: true
  });

  const config = {
    host: env.HOST || "127.0.0.1",
    port: resolvedRuntimePort,
    runtimePort: resolvedRuntimePort,
    authMode,
    upstreamMode: normalizeUpstreamMode(env.UPSTREAM_MODE || DEFAULT_UPSTREAM_MODE),
    upstreamBaseUrl: env.UPSTREAM_BASE_URL || DEFAULT_CODEX_UPSTREAM_BASE_URL,
    gemini: {
      baseUrl: env.GEMINI_BASE_URL || DEFAULT_GEMINI_UPSTREAM_BASE_URL,
      apiKey: env.GEMINI_API_KEY || "",
      defaultModel: env.GEMINI_DEFAULT_MODEL || "gemini-2.5-pro"
    },
    anthropic: {
      baseUrl: env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL,
      apiKey: env.ANTHROPIC_API_KEY || "",
      version: env.ANTHROPIC_API_VERSION || "2023-06-01",
      defaultModel: env.ANTHROPIC_DEFAULT_MODEL || "claude-sonnet-4-20250514"
    },
    providerUpstream: {
      allowRequestApiKeys: parseBooleanEnv(env.PROVIDER_UPSTREAM_ALLOW_REQUEST_KEYS, false)
    },
    profileStore: {
      authStorePath: path.resolve(env.PROFILE_AUTH_STORE_PATH || RESOLVED_PROFILE_STORE_PATH),
      profileId: env.PROFILE_AUTH_ID || "openai-codex:default"
    },
    customOAuth: {
      authorizeUrl: env.OAUTH_AUTHORIZE_URL || "",
      tokenUrl: env.OAUTH_TOKEN_URL || "",
      clientId: env.OAUTH_CLIENT_ID || "",
      clientSecret: env.OAUTH_CLIENT_SECRET || "",
      redirectUri: env.OAUTH_REDIRECT_URI || "http://127.0.0.1:8787/auth/callback",
      scopes: (env.OAUTH_SCOPES || "openid profile email offline_access")
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
      tokenStorePath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "TOKEN_STORE_PATH", "auth-store.json")
    },
    codexOAuth: {
      authorizeUrl: OPENAI_CODEX_AUTHORIZE_URL,
      tokenUrl: OPENAI_CODEX_TOKEN_URL,
      clientId: OPENAI_CODEX_CLIENT_ID,
      clientSecret: "",
      callbackBindHost: env.CODEX_OAUTH_CALLBACK_BIND_HOST || "127.0.0.1",
      callbackPort: Number(env.CODEX_OAUTH_CALLBACK_PORT || 1455),
      callbackPath: env.CODEX_OAUTH_CALLBACK_PATH || "/auth/callback",
      redirectUri:
        env.CODEX_OAUTH_REDIRECT_URI ||
        `http://localhost:${env.CODEX_OAUTH_CALLBACK_PORT || 1455}${env.CODEX_OAUTH_CALLBACK_PATH || "/auth/callback"}`,
      scopes: OPENAI_CODEX_SCOPES,
      originator: env.CODEX_OAUTH_ORIGINATOR || "pi",
      multiAccountEnabled: parseBooleanEnv(env.CODEX_MULTI_ACCOUNT_ENABLED, true),
      multiAccountStrategy: String(env.CODEX_MULTI_ACCOUNT_STRATEGY || "smart").trim().toLowerCase(),
      sharedApiKey: String(env.LOCAL_API_KEY || env.PROXY_API_KEY || "").trim(),
      usageBaseUrl: env.CODEX_USAGE_BASE_URL || DEFAULT_CODEX_UPSTREAM_BASE_URL,
      tokenStorePath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "CODEX_TOKEN_STORE_PATH", "codex-oauth-store.json")
    },
    codexPreheat: {
      historyPath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "CODEX_PREHEAT_HISTORY_PATH", "codex-preheat-history.json")
    },
    expiredAccountCleanup: {
      enabled: parseBooleanEnv(env.CODEX_AUTO_LOGOUT_EXPIRED_ACCOUNTS, false),
      intervalSeconds: parseNumberEnv(env.CODEX_AUTO_LOGOUT_EXPIRED_INTERVAL_SECONDS, 30, {
        min: 10,
        max: 3600,
        integer: true
      })
    },
    upstreamStreamIdleTimeoutMs: parseNumberEnv(
      env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
      DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
      {
        min: 0,
        max: MAX_UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
        integer: true
      }
    ),
    codex: {
      defaultModel: env.CODEX_DEFAULT_MODEL || "gpt-5.4",
      defaultInstructions: env.CODEX_DEFAULT_INSTRUCTIONS || "You are a helpful assistant.",
      defaultServiceTier: normalizeCodexServiceTier(env.CODEX_DEFAULT_SERVICE_TIER, "default"),
      defaultReasoningEffort: parseReasoningEffortOrFallback(env.CODEX_DEFAULT_REASONING_EFFORT, "medium", {
        allowAdaptive: true
      })
    },
    modelRouter: {
      enabled: parseBooleanEnv(env.MODEL_ROUTER_ENABLED, true),
      customMappings: parseModelMappingsEnv(env.MODEL_ROUTER_MAPPINGS || env.MODEL_MAPPINGS, { logger })
    },
    apiKeys: {
      storePath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "API_KEY_STORE_PATH", "api-keys.json"),
      bootstrapLegacySharedKey: parseBooleanEnv(env.API_KEY_BOOTSTRAP_LEGACY, true)
    },
    requestAudit: {
      historyPath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "RECENT_REQUESTS_PATH", "recent-requests.json"),
      maxEntries: parseNumberEnv(env.RECENT_REQUESTS_MAX_ENTRIES, 120, {
        min: 10,
        max: 1000,
        integer: true
      })
    },
    dashboardAuth: {
      storePath: resolveRuntimeDataPath(paths.runtimeDataDir, env, "DASHBOARD_AUTH_STORE_PATH", "dashboard-auth.json"),
      sessionTtlSeconds: parseNumberEnv(env.DASHBOARD_AUTH_SESSION_TTL_SECONDS, 12 * 60 * 60, {
        min: 300,
        max: 30 * 24 * 60 * 60,
        integer: true
      }),
      loginWindowSeconds: parseNumberEnv(env.DASHBOARD_AUTH_LOGIN_WINDOW_SECONDS, 15 * 60, {
        min: 60,
        max: 24 * 60 * 60,
        integer: true
      }),
      loginMaxAttempts: parseNumberEnv(env.DASHBOARD_AUTH_LOGIN_MAX_ATTEMPTS, 10, {
        min: 1,
        max: 100,
        integer: true
      }),
      minimumPasswordLength: parseNumberEnv(env.DASHBOARD_AUTH_MIN_PASSWORD_LENGTH, 8, {
        min: 6,
        max: 256,
        integer: true
      })
    },
    publicAccess: {
      cloudflaredBinPath: String(env.CLOUDFLARED_BIN_PATH || "").trim(),
      defaultMode: String(env.CLOUDFLARED_MODE || "quick").trim().toLowerCase(),
      defaultUseHttp2: parseBooleanEnv(env.CLOUDFLARED_USE_HTTP2, true),
      autoInstall: parseBooleanEnv(env.CLOUDFLARED_AUTO_INSTALL, true),
      defaultTunnelToken: String(env.CLOUDFLARED_TUNNEL_TOKEN || "").trim(),
      localPort: resolvedRuntimePort
    }
  };

  validateServerConfig(config, { logger });

  return {
    config,
    flags: {
      hasExplicitCustomOAuthRedirectUri,
      hasExplicitCloudflaredLocalPort
    }
  };
}
