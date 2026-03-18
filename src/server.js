import "dotenv/config";

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { importCodexOAuthTokens } from "./codex-auth-pool-import.js";
import { startConfiguredServer } from "./bootstrap/lifecycle.js";
import { createExpiredAccountCleanupController } from "./expired-account-cleanup.js";
import { createResponseAffinityStore, extractPreviousResponseId } from "./response-affinity.js";
import {
  buildResponsesChainEntry,
  createResponsesChainStore,
  expandResponsesRequestBodyFromChain
} from "./responses-chain-store.js";
import { createTempMailController } from "./temp-mail-controller.js";
import {
  extractUpstreamTransportError,
  fetchWithUpstreamRetry,
  isPreviousResponseIdUnsupportedError
} from "./upstream-transport.js";
import { createRecentRequestsStore } from "./recent-requests-store.js";
import { registerAdminCoreRoutes } from "./routes/admin-core.js";
import { registerAdminPoolRoutes } from "./routes/admin-pool.js";
import { registerAdminSettingsRoutes } from "./routes/admin-settings.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { createProxyRouteHandlers } from "./routes/proxy-handlers.js";
import {
  formatPayloadForAudit,
  inferProtocolType,
  isProxyApiPath,
  parseContentType,
  sanitizeAuditPath,
  toChunkBuffer
} from "./http/audit.js";
import { createUpstreamRuntimeHelpers } from "./http/upstream-runtime.js";
import { createAnthropicLocalCompatHelpers } from "./protocols/anthropic/local-compat.js";
import { createAnthropicOpenAICompatHelpers } from "./protocols/anthropic/openai-compat.js";
import { createCodexOAuthResponsesHelpers } from "./protocols/codex/oauth-responses.js";
import { createGeminiLocalCompatHelpers } from "./protocols/gemini/local-compat.js";
import { createOpenAIRequestNormalizationHelpers } from "./protocols/openai/request-normalization.js";
import { createOpenAIResponsesCompatHelpers } from "./protocols/openai/responses-compat.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerCommonMiddleware, registerSystemRoutes } from "./routes/system.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_CODEX_SCOPES = ["openid", "profile", "email", "offline_access"];
const DEFAULT_CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_GEMINI_UPSTREAM_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_CLOUDFLARED_BIN = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const DEFAULT_CODEX_CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || "2026.2.26";
const DEFAULT_PROFILE_STORE_PATH = path.join(os.homedir(), ".codex-pro-max", "auth-profiles.json");
const LEGACY_PROFILE_STORE_PATH = path.join(os.homedir(), ".codex-oauth-proxy", "auth-profiles.json");
const RESOLVED_PROFILE_STORE_PATH =
  fsSync.existsSync(DEFAULT_PROFILE_STORE_PATH) || !fsSync.existsSync(LEGACY_PROFILE_STORE_PATH)
    ? DEFAULT_PROFILE_STORE_PATH
    : LEGACY_PROFILE_STORE_PATH;
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
const VALID_REASONING_EFFORT_MODES = new Set(["none", "low", "medium", "high", "xhigh", "adaptive"]);
const VALID_MULTI_ACCOUNT_STRATEGIES = new Set(["smart", "manual", "round-robin", "random", "sticky"]);
const MULTI_ACCOUNT_STRATEGY_LIST = [...VALID_MULTI_ACCOUNT_STRATEGIES].join(", ");
const VALID_CLOUDFLARED_MODES = new Set(["quick", "auth"]);
const VALID_CODEX_SERVICE_TIERS = new Set(["default", "priority"]);
const LOW_QUOTA_THRESHOLD_DUAL_WINDOW = 20;
const LOW_QUOTA_THRESHOLD_SINGLE_WINDOW = 30;
const OFFICIAL_OPENAI_MODELS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-codex",
  "gpt-5-codex",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "o3",
  "o4-mini"
];
const OFFICIAL_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-pro",
  "gemini-1.5-flash"
];
const OFFICIAL_ANTHROPIC_MODELS = [
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest"
];
const OAUTH_CALLBACK_SUCCESS_HTML = `<!doctype html>
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

const authMode = (process.env.AUTH_MODE || "codex-oauth").toLowerCase();
const defaultUpstreamMode = "codex-chatgpt";
const defaultUpstreamBaseUrl = DEFAULT_CODEX_UPSTREAM_BASE_URL;

function normalizeUpstreamMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  // Keep backward compatibility with previous UI naming.
  if (normalized === "openai-v1") return "codex-chatgpt";
  return normalized;
}

function normalizeCodexServiceTier(value, fallback = "default") {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_CODEX_SERVICE_TIERS.has(normalized)) return normalized;
  return VALID_CODEX_SERVICE_TIERS.has(fallback) ? fallback : "default";
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseSlotValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const slot = Math.floor(n);
  if (slot < 1 || slot > 64) return null;
  return slot;
}

function parseNumberEnv(value, fallback, options = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (Number.isFinite(options.min)) out = Math.max(options.min, out);
  if (Number.isFinite(options.max)) out = Math.min(options.max, out);
  if (options.integer) out = Math.floor(out);
  return out;
}

function sanitizeModelMappings(input) {
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

function parseModelMappingsEnv(value) {
  if (!value || typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return sanitizeModelMappings(parsed);
  } catch (err) {
    console.warn(`[model-router] failed to parse MODEL_ROUTER_MAPPINGS JSON: ${err.message}`);
    return {};
  }
}

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8787),
  authMode, // profile-store | codex-oauth | custom-oauth
  upstreamMode: normalizeUpstreamMode(process.env.UPSTREAM_MODE || defaultUpstreamMode), // codex-chatgpt | gemini-v1beta | anthropic-v1
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || defaultUpstreamBaseUrl,
  gemini: {
    baseUrl: process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_UPSTREAM_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY || "",
    defaultModel: process.env.GEMINI_DEFAULT_MODEL || "gemini-2.5-pro"
  },
  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL,
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    version: process.env.ANTHROPIC_API_VERSION || "2023-06-01",
    defaultModel: process.env.ANTHROPIC_DEFAULT_MODEL || "claude-sonnet-4-20250514"
  },
  providerUpstream: {
    // Keep native provider upstream opt-in for request-supplied keys.
    // Default false avoids accidental 403/Cloudflare challenge when clients send placeholder API keys.
    allowRequestApiKeys: parseBooleanEnv(process.env.PROVIDER_UPSTREAM_ALLOW_REQUEST_KEYS, false)
  },
  profileStore: {
    authStorePath: path.resolve(process.env.PROFILE_AUTH_STORE_PATH || RESOLVED_PROFILE_STORE_PATH),
    profileId: process.env.PROFILE_AUTH_ID || "openai-codex:default"
  },
  customOAuth: {
    authorizeUrl: process.env.OAUTH_AUTHORIZE_URL || "",
    tokenUrl: process.env.OAUTH_TOKEN_URL || "",
    clientId: process.env.OAUTH_CLIENT_ID || "",
    clientSecret: process.env.OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.OAUTH_REDIRECT_URI || "http://127.0.0.1:8787/auth/callback",
    scopes: (process.env.OAUTH_SCOPES || "openid profile email offline_access")
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    tokenStorePath: path.resolve(process.env.TOKEN_STORE_PATH || path.join(rootDir, "data", "auth-store.json"))
  },
  codexOAuth: {
    authorizeUrl: OPENAI_CODEX_AUTHORIZE_URL,
    tokenUrl: OPENAI_CODEX_TOKEN_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    clientSecret: "",
    callbackBindHost: process.env.CODEX_OAUTH_CALLBACK_BIND_HOST || "127.0.0.1",
    callbackPort: Number(process.env.CODEX_OAUTH_CALLBACK_PORT || 1455),
    callbackPath: process.env.CODEX_OAUTH_CALLBACK_PATH || "/auth/callback",
    redirectUri:
      process.env.CODEX_OAUTH_REDIRECT_URI ||
      `http://localhost:${process.env.CODEX_OAUTH_CALLBACK_PORT || 1455}${process.env.CODEX_OAUTH_CALLBACK_PATH || "/auth/callback"}`,
    scopes: OPENAI_CODEX_SCOPES,
    originator: process.env.CODEX_OAUTH_ORIGINATOR || "pi",
    multiAccountEnabled: parseBooleanEnv(process.env.CODEX_MULTI_ACCOUNT_ENABLED, true),
    multiAccountStrategy: String(process.env.CODEX_MULTI_ACCOUNT_STRATEGY || "smart").trim().toLowerCase(),
    sharedApiKey: String(process.env.LOCAL_API_KEY || process.env.PROXY_API_KEY || "").trim(),
    usageBaseUrl: process.env.CODEX_USAGE_BASE_URL || DEFAULT_CODEX_UPSTREAM_BASE_URL,
    tokenStorePath: path.resolve(
      process.env.CODEX_TOKEN_STORE_PATH || path.join(rootDir, "data", "codex-oauth-store.json")
    )
  },
  codexPreheat: {
    cooldownSeconds: parseNumberEnv(process.env.CODEX_PREHEAT_COOLDOWN_SECONDS, 1200, {
      min: 30,
      max: 86400,
      integer: true
    }),
    batchSize: parseNumberEnv(process.env.CODEX_PREHEAT_BATCH_SIZE, 2, {
      min: 1,
      max: 32,
      integer: true
    }),
    minPrimaryRemaining: parseNumberEnv(process.env.CODEX_PREHEAT_MIN_PRIMARY_REMAINING, 5, {
      min: 0,
      max: 100,
      integer: true
    }),
    minSecondaryRemaining: parseNumberEnv(process.env.CODEX_PREHEAT_MIN_SECONDARY_REMAINING, 5, {
      min: 0,
      max: 100,
      integer: true
    }),
    historyPath: path.resolve(
      process.env.CODEX_PREHEAT_HISTORY_PATH || path.join(rootDir, "data", "codex-preheat-history.json")
    )
  },
  expiredAccountCleanup: {
    enabled: parseBooleanEnv(process.env.CODEX_AUTO_LOGOUT_EXPIRED_ACCOUNTS, false),
    intervalSeconds: parseNumberEnv(process.env.CODEX_AUTO_LOGOUT_EXPIRED_INTERVAL_SECONDS, 30, {
      min: 10,
      max: 3600,
      integer: true
    })
  },
  codex: {
    defaultModel: process.env.CODEX_DEFAULT_MODEL || "gpt-5.4",
    defaultInstructions: process.env.CODEX_DEFAULT_INSTRUCTIONS || "You are a helpful assistant.",
    defaultServiceTier: normalizeCodexServiceTier(process.env.CODEX_DEFAULT_SERVICE_TIER, "default"),
    defaultReasoningEffort: parseReasoningEffortOrFallback(
      process.env.CODEX_DEFAULT_REASONING_EFFORT,
      "medium",
      { allowAdaptive: true }
    )
  },
  modelRouter: {
    enabled: parseBooleanEnv(process.env.MODEL_ROUTER_ENABLED, true),
    customMappings: parseModelMappingsEnv(process.env.MODEL_ROUTER_MAPPINGS || process.env.MODEL_MAPPINGS)
  },
  apiKeys: {
    storePath: path.resolve(process.env.API_KEY_STORE_PATH || path.join(rootDir, "data", "api-keys.json")),
    bootstrapLegacySharedKey: parseBooleanEnv(process.env.API_KEY_BOOTSTRAP_LEGACY, true)
  },
  requestAudit: {
    historyPath: path.resolve(process.env.RECENT_REQUESTS_PATH || path.join(rootDir, "data", "recent-requests.json")),
    maxEntries: parseNumberEnv(process.env.RECENT_REQUESTS_MAX_ENTRIES, 120, {
      min: 10,
      max: 1000,
      integer: true
    })
  },
  publicAccess: {
    cloudflaredBinPath: String(process.env.CLOUDFLARED_BIN_PATH || "").trim(),
    defaultMode: String(process.env.CLOUDFLARED_MODE || "quick").trim().toLowerCase(),
    defaultUseHttp2: parseBooleanEnv(process.env.CLOUDFLARED_USE_HTTP2, true),
    autoInstall: parseBooleanEnv(process.env.CLOUDFLARED_AUTO_INSTALL, true),
    defaultTunnelToken: String(process.env.CLOUDFLARED_TUNNEL_TOKEN || "").trim(),
    localPort: parseNumberEnv(process.env.CLOUDFLARED_LOCAL_PORT, Number(process.env.PORT || 8787), {
      min: 1,
      max: 65535,
      integer: true
    })
  }
};

if (config.authMode !== "profile-store" && config.authMode !== "codex-oauth" && config.authMode !== "custom-oauth") {
  console.error("AUTH_MODE must be one of: profile-store, codex-oauth, custom-oauth");
  process.exit(1);
}

if (
  config.upstreamMode !== "codex-chatgpt" &&
  config.upstreamMode !== "gemini-v1beta" &&
  config.upstreamMode !== "anthropic-v1"
) {
  console.error("UPSTREAM_MODE must be one of: codex-chatgpt, gemini-v1beta, anthropic-v1");
  process.exit(1);
}

if (config.authMode === "custom-oauth") {
  if (!config.customOAuth.authorizeUrl || !config.customOAuth.tokenUrl || !config.customOAuth.clientId) {
    console.error("Missing OAuth config. Set OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL, OAUTH_CLIENT_ID.");
    process.exit(1);
  }
}

if (!VALID_MULTI_ACCOUNT_STRATEGIES.has(config.codexOAuth.multiAccountStrategy)) {
  console.warn(
    `Invalid CODEX_MULTI_ACCOUNT_STRATEGY="${config.codexOAuth.multiAccountStrategy}", fallback to smart. Supported: ${MULTI_ACCOUNT_STRATEGY_LIST}.`
  );
  config.codexOAuth.multiAccountStrategy = "smart";
}
if (!VALID_CLOUDFLARED_MODES.has(config.publicAccess.defaultMode)) {
  config.publicAccess.defaultMode = "quick";
}
config.publicAccess.autoInstall = true;

const pendingAuth = new Map();
let codexCallbackServer = null;
let codexCallbackServerStartPromise = null;
const app = express();

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization"
]);

let customOAuthStore = { token: null };
let codexOAuthStore = { token: null };
if (config.authMode === "custom-oauth" || config.authMode === "codex-oauth") {
  customOAuthStore = await loadTokenStore(config.customOAuth.tokenStorePath);
  codexOAuthStore = await loadTokenStore(config.codexOAuth.tokenStorePath);
}
if (config.authMode === "codex-oauth") {
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  if (normalized.changed) {
    await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  }
}

let proxyApiKeyStore = await loadProxyApiKeyStore(config.apiKeys.storePath);
if (bootstrapLegacySharedApiKey(proxyApiKeyStore, config.codexOAuth.sharedApiKey, config.apiKeys.bootstrapLegacySharedKey)) {
  await saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore);
}

let cloudflaredInstallPromise = null;

const cloudflaredRuntime = {
  process: null,
  mode: config.publicAccess.defaultMode,
  useHttp2: config.publicAccess.defaultUseHttp2,
  tunnelToken: config.publicAccess.defaultTunnelToken,
  localPort: config.publicAccess.localPort,
  url: "",
  error: "",
  running: false,
  installed: false,
  version: "",
  lastCheckedAt: 0,
  installInProgress: false,
  installMessage: "",
  installUpdatedAt: 0,
  pid: null,
  startedAt: 0,
  outputTail: []
};

async function importIntoCodexAuthPool(items, options = {}) {
  const result = await importCodexOAuthTokens({
    store: codexOAuthStore,
    items,
    replace: options.replace === true,
    probeUsage: options.probeUsage !== false,
    ensureStoreShape: ensureCodexOAuthStoreShape,
    normalizeToken,
    upsertAccount: upsertCodexOAuthAccount,
    findAccountByRef: findCodexPoolAccountByRef,
    refreshUsageSnapshot: async (store, ref) =>
      await withTimeout(
        refreshCodexUsageSnapshotInStore(store, ref, config.codexOAuth, {
          includeDisabled: false
        }),
        12000,
        "Usage probe timed out."
      ),
    normalizePlanType: normalizeOpenAICodexPlanType,
    parseSlotValue
  });
  codexOAuthStore = result.store;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  return result;
}

const tempMailController = createTempMailController({
  rootDir,
  importTokens: async (items, options = {}) => await importIntoCodexAuthPool(items, options),
  isSupported: () => config.authMode === "codex-oauth"
});

const expiredAccountCleanupController = createExpiredAccountCleanupController({
  initialConfig: config.expiredAccountCleanup,
  isSupported: () => config.authMode === "codex-oauth",
  getStore: () => codexOAuthStore,
  getAccounts: (store) => store?.accounts || [],
  removeAccount: (store, ref) => removeCodexPoolAccountFromStore(store, ref),
  saveStore: async (store) => {
    codexOAuthStore = store;
    await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
    clearAuthContextCache();
  },
  onRemoved: async ({ reason, removedRefs }) => {
    if (!Array.isArray(removedRefs) || removedRefs.length === 0) return;
    console.log(`[auth-pool] ${reason}: removed ${removedRefs.length} expired account(s): ${removedRefs.join(", ")}`);
  }
});

const runtimeStats = {
  startedAt: Date.now(),
  totalRequests: 0,
  okRequests: 0,
  errorRequests: 0,
  recentRequests: []
};
let runtimeRequestSeq = 0;
const RUNTIME_AUDIT_MAX_BODY_BYTES = 96 * 1024;
const RUNTIME_AUDIT_MAX_TEXT_CHARS = 12000;
const recentRequestsStore = createRecentRequestsStore({
  filePath: config.requestAudit.historyPath,
  maxEntries: config.requestAudit.maxEntries
});
runtimeStats.recentRequests = (await recentRequestsStore.load()).recentRequests;

let codexPreheatHistory = { accounts: {} };
try {
  codexPreheatHistory = await loadJsonStore(config.codexPreheat.historyPath, { accounts: {} });
} catch {
  codexPreheatHistory = { accounts: {} };
}
if (!codexPreheatHistory || typeof codexPreheatHistory !== "object") {
  codexPreheatHistory = { accounts: {} };
}
if (!codexPreheatHistory.accounts || typeof codexPreheatHistory.accounts !== "object") {
  codexPreheatHistory.accounts = {};
}

const codexPreheatRuntime = {
  running: false,
  lastRunAt: 0,
  lastCompletedAt: 0,
  lastReason: "",
  lastStatus: "idle",
  lastError: "",
  lastDurationMs: 0,
  lastSummary: null
};

const authContextCache = {
  mode: "",
  accessToken: "",
  accountId: null,
  expiresAt: 0
};
const codexResponseAffinity = createResponseAffinityStore();
const codexResponsesChain = createResponsesChainStore();

let expiredAccountCleanupTimer = setInterval(() => {
  expiredAccountCleanupController.run("interval").catch((err) => {
    console.warn(`[auth-pool] expired account cleanup failed: ${err?.message || err}`);
  });
}, Math.max(10, Number(config.expiredAccountCleanup.intervalSeconds || 30)) * 1000);
expiredAccountCleanupTimer.unref?.();

function clearAuthContextCache() {
  authContextCache.mode = "";
  authContextCache.accessToken = "";
  authContextCache.accountId = null;
  authContextCache.expiresAt = 0;
}

function hashProxyApiKey(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeProxyApiKeyStore(raw) {
  const out = {
    version: 1,
    keys: []
  };
  let changed = false;
  const nowSec = Math.floor(Date.now() / 1000);
  const src = raw && typeof raw === "object" ? raw : {};
  const sourceKeys = Array.isArray(src.keys) ? src.keys : [];
  if (!Array.isArray(src.keys)) changed = true;

  for (const item of sourceKeys) {
    if (!item || typeof item !== "object") {
      changed = true;
      continue;
    }
    const id = String(item.id || "").trim() || `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const hash = String(item.hash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      changed = true;
      continue;
    }
    const label = String(item.label || "").trim() || "unnamed";
    const prefix = String(item.prefix || "").trim() || "sk-";
    const value = String(item.value || item.apiKey || "").trim();
    const createdAt = Number(item.created_at || item.createdAt || nowSec);
    const lastUsedAt = Number(item.last_used_at || item.lastUsedAt || 0);
    const useCount = Number(item.use_count || item.useCount || 0);
    const revokedAt = Number(item.revoked_at || item.revokedAt || 0);
    const expiresAt = Number(item.expires_at || item.expiresAt || 0);
    out.keys.push({
      id,
      label,
      prefix,
      value,
      hash,
      created_at: Number.isFinite(createdAt) ? createdAt : nowSec,
      last_used_at: Number.isFinite(lastUsedAt) ? Math.max(0, Math.floor(lastUsedAt)) : 0,
      use_count: Number.isFinite(useCount) ? Math.max(0, Math.floor(useCount)) : 0,
      revoked_at: Number.isFinite(revokedAt) ? Math.max(0, Math.floor(revokedAt)) : 0,
      expires_at: Number.isFinite(expiresAt) ? Math.max(0, Math.floor(expiresAt)) : 0
    });
  }
  return { store: out, changed };
}

async function loadProxyApiKeyStore(filePath) {
  const raw = await loadJsonStore(filePath, { version: 1, keys: [] });
  const normalized = normalizeProxyApiKeyStore(raw);
  const prunedRevoked = pruneRevokedProxyApiKeys(normalized.store);
  if (normalized.changed || prunedRevoked) {
    await saveProxyApiKeyStore(filePath, normalized.store);
  }
  return normalized.store;
}

async function saveProxyApiKeyStore(filePath, store) {
  const normalized = normalizeProxyApiKeyStore(store);
  await saveJsonStore(filePath, normalized.store);
}

let proxyApiKeyStoreFlushTimer = null;
function scheduleProxyApiKeyStoreFlush(delayMs = 2000) {
  if (proxyApiKeyStoreFlushTimer) clearTimeout(proxyApiKeyStoreFlushTimer);
  proxyApiKeyStoreFlushTimer = setTimeout(() => {
    proxyApiKeyStoreFlushTimer = null;
    saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore).catch((err) => {
      console.warn(`[api-keys] failed to persist usage: ${err.message}`);
    });
  }, Math.max(250, Number(delayMs) || 2000));
}

function createProxyApiKey() {
  const value = `sk-${crypto.randomBytes(24).toString("base64url")}`;
  return value;
}

function sanitizeProxyApiKeyLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "generated-key";
  return raw.slice(0, 80);
}

function listActiveProxyApiKeys(store, nowSec = Math.floor(Date.now() / 1000)) {
  const keys = Array.isArray(store?.keys) ? store.keys : [];
  return keys.filter((k) => {
    if (!k || typeof k !== "object") return false;
    if (Number(k.revoked_at || 0) > 0) return false;
    const expiresAt = Number(k.expires_at || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= nowSec) return false;
    return true;
  });
}

function pruneRevokedProxyApiKeys(store) {
  if (!store || typeof store !== "object") return false;
  if (!Array.isArray(store.keys)) {
    store.keys = [];
    return false;
  }
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => Number(k?.revoked_at || 0) <= 0);
  return store.keys.length !== before;
}

function hasActiveManagedProxyApiKeys() {
  return listActiveProxyApiKeys(proxyApiKeyStore).length > 0;
}

function bootstrapLegacySharedApiKey(store, legacyKey, enabled = true) {
  if (!enabled) return false;
  const key = String(legacyKey || "").trim();
  if (!key) return false;
  const hash = hashProxyApiKey(key);
  const exists = (Array.isArray(store?.keys) ? store.keys : []).some((k) => String(k?.hash || "") === hash);
  if (exists) return false;
  if (!Array.isArray(store.keys)) store.keys = [];
  const nowSec = Math.floor(Date.now() / 1000);
  store.keys.unshift({
    id: "legacy-local-api-key",
    label: "legacy env LOCAL_API_KEY",
    prefix: key.slice(0, 10),
    value: key,
    hash,
    created_at: nowSec,
    last_used_at: 0,
    use_count: 0,
    revoked_at: 0,
    expires_at: 0
  });
  return true;
}

function extractProxyApiKeyFromRequest(req) {
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  const xApiKey = readHeaderValue(req, "x-api-key");
  if (xApiKey) return xApiKey.trim();
  const xGoogApiKey = readHeaderValue(req, "x-goog-api-key");
  if (xGoogApiKey) return xGoogApiKey.trim();
  const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
  const queryKey = String(
    incoming.searchParams.get("key") ||
      incoming.searchParams.get("api_key") ||
      incoming.searchParams.get("x-api-key") ||
      ""
  ).trim();
  if (queryKey) return queryKey;
  return "";
}

function findManagedProxyApiKeyByValue(candidate) {
  const key = String(candidate || "").trim();
  if (!key) return null;
  const hash = hashProxyApiKey(key);
  const active = listActiveProxyApiKeys(proxyApiKeyStore);
  return active.find((entry) => String(entry.hash || "") === hash) || null;
}

function recordManagedProxyApiKeyUsage(entry) {
  if (!entry || typeof entry !== "object") return;
  entry.last_used_at = Math.floor(Date.now() / 1000);
  entry.use_count = Number(entry.use_count || 0) + 1;
  scheduleProxyApiKeyStoreFlush();
}

function buildApiKeySummary() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (pruneRevokedProxyApiKeys(proxyApiKeyStore)) {
    scheduleProxyApiKeyStoreFlush(400);
  }
  const keys = Array.isArray(proxyApiKeyStore?.keys) ? proxyApiKeyStore.keys : [];
  const activeKeys = listActiveProxyApiKeys(proxyApiKeyStore, nowSec);
  const activeIds = new Set(activeKeys.map((k) => String(k.id)));
  return {
    enforced: activeKeys.length > 0 || Boolean(String(config.codexOAuth.sharedApiKey || "").trim()),
    total: keys.length,
    active: activeKeys.length,
    keys: keys
      .map((entry) => {
        const expiresAt = Number(entry.expires_at || 0);
        const revokedAt = Number(entry.revoked_at || 0);
        return {
          id: String(entry.id || ""),
          label: String(entry.label || ""),
          prefix: String(entry.prefix || "sk-"),
          value: String(entry.value || ""),
          createdAt: Number(entry.created_at || 0) || null,
          lastUsedAt: Number(entry.last_used_at || 0) || null,
          useCount: Number(entry.use_count || 0) || 0,
          expiresAt: expiresAt > 0 ? expiresAt : null,
          revokedAt: revokedAt > 0 ? revokedAt : null,
          active: activeIds.has(String(entry.id || ""))
        };
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  };
}

function resolveCloudflaredBin() {
  const configured = String(config.publicAccess.cloudflaredBinPath || "").trim();
  if (configured && fsSync.existsSync(configured)) return configured;

  const binDir = path.join(rootDir, "bin");
  const bundledDefault = path.join(binDir, DEFAULT_CLOUDFLARED_BIN);
  if (fsSync.existsSync(bundledDefault)) return bundledDefault;

  try {
    const entries = fsSync
      .readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        const lower = name.toLowerCase();
        if (process.platform === "win32") {
          return /^cloudflared(?:-\d+)?\.exe$/.test(lower);
        }
        return /^cloudflared(?:-\d+)?$/.test(lower);
      })
      .map((name) => {
        const fullPath = path.join(binDir, name);
        const stat = fsSync.statSync(fullPath);
        return { fullPath, mtimeMs: Number(stat.mtimeMs || 0) };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (entries[0]?.fullPath) return entries[0].fullPath;
  } catch {
    // ignore local bin discovery failures and fall back to PATH resolution
  }

  return DEFAULT_CLOUDFLARED_BIN;
}

function resolveCloudflaredAssetMeta() {
  const archMap = {
    x64: "amd64",
    ia32: "386",
    arm64: "arm64",
    arm: "arm"
  };
  const arch = archMap[String(process.arch || "").toLowerCase()];
  if (!arch) {
    throw new Error(`Unsupported CPU architecture for cloudflared install: ${process.arch}`);
  }

  let platform = "";
  let ext = "";
  if (process.platform === "win32") {
    platform = "windows";
    ext = ".exe";
  } else if (process.platform === "linux") {
    platform = "linux";
  } else if (process.platform === "darwin") {
    platform = "darwin";
  } else {
    throw new Error(`Unsupported OS for cloudflared install: ${process.platform}`);
  }

  const assetName = `cloudflared-${platform}-${arch}${ext}`;
  const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
  const binaryName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return {
    assetName,
    downloadUrl,
    binaryName
  };
}

function isLikelyCloudflaredBinaryPayload(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) return false;
  if (process.platform === "win32") {
    return bytes[0] === 0x4d && bytes[1] === 0x5a;
  }
  if (process.platform === "linux") {
    return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  }
  if (process.platform === "darwin") {
    const magicBE = bytes.readUInt32BE(0);
    const magicLE = bytes.readUInt32LE(0);
    return (
      magicBE === 0xfeedface ||
      magicBE === 0xfeedfacf ||
      magicBE === 0xcafebabe ||
      magicLE === 0xcefaedfe ||
      magicLE === 0xcffaedfe ||
      magicLE === 0xbebafeca
    );
  }
  return true;
}

function resolveCloudflaredInstallPath(assetMeta) {
  const installDir = path.join(rootDir, "bin");
  const configuredPath = String(config.publicAccess.cloudflaredBinPath || "").trim();
  let installPath = configuredPath || path.join(installDir, assetMeta.binaryName);

  if (cloudflaredRuntime.running) {
    const activeBin = path.resolve(resolveCloudflaredBin());
    const targetBin = path.resolve(installPath);
    if (activeBin === targetBin) {
      const parsed = path.parse(assetMeta.binaryName);
      installPath = path.join(installDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
    }
  }

  return { installDir, installPath };
}

async function installCloudflaredBinary() {
  if (cloudflaredInstallPromise) {
    return cloudflaredInstallPromise;
  }

  cloudflaredInstallPromise = (async () => {
    cloudflaredRuntime.installInProgress = true;
    cloudflaredRuntime.installMessage = "installing";
    cloudflaredRuntime.installUpdatedAt = Math.floor(Date.now() / 1000);

    let tempPath = "";
    try {
      const assetMeta = resolveCloudflaredAssetMeta();
      const { installDir, installPath } = resolveCloudflaredInstallPath(assetMeta);
      await fs.mkdir(installDir, { recursive: true });

      const downloadAbort = new AbortController();
      const downloadTimeout = setTimeout(() => downloadAbort.abort(), 120000);
      let response;
      try {
        response = await fetch(assetMeta.downloadUrl, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": "codex-pro-max/0.1.0", accept: "application/octet-stream" },
          signal: downloadAbort.signal
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error("cloudflared download timed out after 120 seconds.");
        }
        throw err;
      } finally {
        clearTimeout(downloadTimeout);
      }
      if (!response.ok) {
        throw new Error(`cloudflared download failed: HTTP ${response.status} ${response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!Buffer.isBuffer(bytes) || bytes.length < 64 * 1024 || !isLikelyCloudflaredBinaryPayload(bytes)) {
        throw new Error("cloudflared download produced invalid payload.");
      }

      tempPath = `${installPath}.download-${Date.now()}`;
      await fs.writeFile(tempPath, bytes);
      if (process.platform !== "win32") {
        await fs.chmod(tempPath, 0o755);
      }

      if (fsSync.existsSync(installPath)) {
        await fs.unlink(installPath).catch(() => {});
      }
      await fs.rename(tempPath, installPath);
      tempPath = "";

      config.publicAccess.cloudflaredBinPath = installPath;
      cloudflaredRuntime.lastCheckedAt = 0;
      const probe = await checkCloudflaredInstalled(true);
      if (!probe.installed) {
        throw new Error("cloudflared install finished but binary check still failed.");
      }

      const message = `installed (${assetMeta.assetName})`;
      cloudflaredRuntime.installMessage = message;
      cloudflaredRuntime.installUpdatedAt = Math.floor(Date.now() / 1000);
      cloudflaredRuntime.error = "";
      updateCloudflaredOutput(`${message} -> ${installPath}`);
      return {
        installed: true,
        path: installPath,
        asset: assetMeta.assetName,
        version: probe.version || ""
      };
    } catch (err) {
      cloudflaredRuntime.installMessage = String(err?.message || err || "install_failed");
      cloudflaredRuntime.installUpdatedAt = Math.floor(Date.now() / 1000);
      cloudflaredRuntime.error = cloudflaredRuntime.installMessage;
      updateCloudflaredOutput(`install failed: ${cloudflaredRuntime.installMessage}`);
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => {});
      }
      throw err;
    } finally {
      cloudflaredRuntime.installInProgress = false;
      cloudflaredInstallPromise = null;
    }
  })();

  return cloudflaredInstallPromise;
}

function updateCloudflaredOutput(line) {
  const text = String(line || "").trim();
  if (!text) return;
  cloudflaredRuntime.outputTail.push(text);
  if (cloudflaredRuntime.outputTail.length > 120) {
    cloudflaredRuntime.outputTail.splice(0, cloudflaredRuntime.outputTail.length - 120);
  }
}

function extractCloudflaredUrlFromLine(line) {
  const text = String(line || "");
  const quick = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  if (quick && quick[0]) return quick[0];
  if (text.includes("Updated to new configuration") && text.includes("hostname")) {
    const m = text.match(/\\"hostname\\":\\"([^"\\]+)\\"/);
    if (m && m[1]) {
      return `https://${m[1]}`;
    }
  }
  const hostnameField = text.match(/(?:^|[\s{,])hostname["=: ]+["']?([a-z0-9.-]+\.[a-z]{2,})["']?/i);
  if (hostnameField && hostnameField[1]) {
    return `https://${hostnameField[1]}`;
  }
  return "";
}

function createCloudflaredLineReader(stream) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += Buffer.from(chunk).toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      updateCloudflaredOutput(line);
      const url = extractCloudflaredUrlFromLine(line);
      if (url) cloudflaredRuntime.url = url;
      idx = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const tail = buffer.replace(/\r$/, "").trim();
    if (!tail) return;
    updateCloudflaredOutput(tail);
    const url = extractCloudflaredUrlFromLine(tail);
    if (url) cloudflaredRuntime.url = url;
  });
}

async function checkCloudflaredInstalled(force = false) {
  const now = Date.now();
  if (!force && now - Number(cloudflaredRuntime.lastCheckedAt || 0) < 30000) {
    return {
      installed: cloudflaredRuntime.installed,
      version: cloudflaredRuntime.version
    };
  }
  const bin = resolveCloudflaredBin();
  const output = await new Promise((resolve) => {
    const child = spawn(bin, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr });
    }, 8000);
    child.stdout?.on("data", (d) => {
      stdout += Buffer.from(d).toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += Buffer.from(d).toString("utf8");
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
  cloudflaredRuntime.lastCheckedAt = now;
  cloudflaredRuntime.installed = output.ok === true;
  cloudflaredRuntime.version = output.ok
    ? String(output.stdout || output.stderr || "")
        .split(/\r?\n/)[0]
        .trim()
    : "";
  return {
    installed: cloudflaredRuntime.installed,
    version: cloudflaredRuntime.version
  };
}

function getCloudflaredStatus() {
  return {
    installed: Boolean(cloudflaredRuntime.installed),
    version: cloudflaredRuntime.version || null,
    installInProgress: Boolean(cloudflaredRuntime.installInProgress),
    installMessage: cloudflaredRuntime.installMessage || null,
    installUpdatedAt: Number(cloudflaredRuntime.installUpdatedAt || 0) || null,
    running: Boolean(cloudflaredRuntime.running),
    url: cloudflaredRuntime.url || null,
    error: cloudflaredRuntime.error || null,
    mode: cloudflaredRuntime.mode || "quick",
    useHttp2: cloudflaredRuntime.useHttp2 !== false,
    autoInstall: config.publicAccess.autoInstall !== false,
    localPort: Number(cloudflaredRuntime.localPort || config.port),
    pid: cloudflaredRuntime.pid || null,
    startedAt: Number(cloudflaredRuntime.startedAt || 0) || null,
    binaryPath: resolveCloudflaredBin(),
    outputTail: [...cloudflaredRuntime.outputTail]
  };
}

async function startCloudflaredTunnel({ mode, token, useHttp2, localPort, autoInstall } = {}) {
  if (cloudflaredRuntime.running && cloudflaredRuntime.process) {
    return getCloudflaredStatus();
  }

  const normalizedMode = VALID_CLOUDFLARED_MODES.has(String(mode || "").trim().toLowerCase())
    ? String(mode).trim().toLowerCase()
    : config.publicAccess.defaultMode;
  const normalizedAutoInstall =
    autoInstall === undefined ? config.publicAccess.autoInstall !== false : Boolean(autoInstall);
  const normalizedToken = String(token || cloudflaredRuntime.tunnelToken || config.publicAccess.defaultTunnelToken || "").trim();
  const normalizedUseHttp2 = useHttp2 === undefined ? cloudflaredRuntime.useHttp2 !== false : Boolean(useHttp2);
  const parsedPort = parseNumberEnv(localPort ?? cloudflaredRuntime.localPort ?? config.port, Number(config.port), {
    min: 1,
    max: 65535,
    integer: true
  });

  if (normalizedMode === "auth" && !normalizedToken) {
    throw new Error("Cloudflared token is required when mode=auth.");
  }

  let installed = await checkCloudflaredInstalled(true);
  if (!installed.installed && normalizedAutoInstall) {
    await installCloudflaredBinary();
    installed = await checkCloudflaredInstalled(true);
  }
  if (!installed.installed) {
    throw new Error(
      `cloudflared binary not found. Install cloudflared and ensure it is on PATH, or set CLOUDFLARED_BIN_PATH.`
    );
  }

  const bin = resolveCloudflaredBin();
  const args =
    normalizedMode === "auth"
      ? ["tunnel", "run", "--token", normalizedToken]
      : ["tunnel", "--url", `http://127.0.0.1:${parsedPort}`];
  if (normalizedUseHttp2) {
    args.push("--protocol", "http2");
  }

  const child = spawn(bin, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.once("error", (err) => {
    cloudflaredRuntime.running = false;
    cloudflaredRuntime.error = String(err?.message || err || "cloudflared_start_failed");
    cloudflaredRuntime.pid = null;
    cloudflaredRuntime.process = null;
  });
  child.once("exit", (code, signal) => {
    cloudflaredRuntime.running = false;
    cloudflaredRuntime.pid = null;
    cloudflaredRuntime.process = null;
    if (!cloudflaredRuntime.error && code !== 0) {
      cloudflaredRuntime.error = `cloudflared exited with code=${code ?? "?"} signal=${signal ?? "-"}`;
    }
  });
  if (child.stdout) createCloudflaredLineReader(child.stdout);
  if (child.stderr) createCloudflaredLineReader(child.stderr);

  cloudflaredRuntime.process = child;
  cloudflaredRuntime.running = true;
  cloudflaredRuntime.error = "";
  cloudflaredRuntime.mode = normalizedMode;
  cloudflaredRuntime.useHttp2 = normalizedUseHttp2;
  cloudflaredRuntime.tunnelToken = normalizedToken;
  cloudflaredRuntime.localPort = parsedPort;
  cloudflaredRuntime.startedAt = Math.floor(Date.now() / 1000);
  cloudflaredRuntime.pid = child.pid || null;
  return getCloudflaredStatus();
}

async function stopCloudflaredTunnel() {
  const child = cloudflaredRuntime.process;
  if (child) {
    try {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    } catch {
      // ignore process kill errors
    }
  }
  cloudflaredRuntime.process = null;
  cloudflaredRuntime.running = false;
  cloudflaredRuntime.pid = null;
  cloudflaredRuntime.url = "";
  cloudflaredRuntime.error = "";
  return getCloudflaredStatus();
}

function getCachedAuthContext() {
  if (!authContextCache.accessToken) return null;
  if (authContextCache.mode !== config.authMode) return null;
  if (Date.now() >= authContextCache.expiresAt) return null;
  return {
    accessToken: authContextCache.accessToken,
    accountId: authContextCache.accountId || null
  };
}

function cacheAuthContext(context, ttlMs = 15000) {
  if (!context || typeof context.accessToken !== "string" || context.accessToken.length === 0) return;
  authContextCache.mode = config.authMode;
  authContextCache.accessToken = context.accessToken;
  authContextCache.accountId = context.accountId || null;
  authContextCache.expiresAt = Date.now() + Math.max(1000, Math.floor(ttlMs));
}

function getActiveUpstreamBaseUrl() {
  if (config.upstreamMode === "gemini-v1beta") return config.gemini.baseUrl;
  if (config.upstreamMode === "anthropic-v1") return config.anthropic.baseUrl;
  return config.upstreamBaseUrl;
}

function setActiveUpstreamBaseUrl(nextBaseUrl) {
  if (config.upstreamMode === "gemini-v1beta") {
    config.gemini.baseUrl = nextBaseUrl;
    return;
  }
  if (config.upstreamMode === "anthropic-v1") {
    config.anthropic.baseUrl = nextBaseUrl;
    return;
  }
  config.upstreamBaseUrl = nextBaseUrl;
}

function isSelfProxyBaseUrl(urlValue) {
  try {
    const parsed = new URL(String(urlValue || ""));
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return false;

    const parsedPort = Number(parsed.port || (protocol === "https:" ? 443 : 80));
    if (parsedPort !== Number(config.port)) return false;

    const host = String(parsed.hostname || "").toLowerCase();
    const selfHosts = new Set([
      String(config.host || "").toLowerCase(),
      "127.0.0.1",
      "localhost",
      "::1",
      "0.0.0.0"
    ]);
    return selfHosts.has(host);
  } catch {
    return false;
  }
}

function getCodexUsageProbeBaseUrl() {
  const configured = String(config.codexOAuth.usageBaseUrl || "").trim();
  const selected = configured || DEFAULT_CODEX_UPSTREAM_BASE_URL;
  if (isSelfProxyBaseUrl(selected)) {
    return DEFAULT_CODEX_UPSTREAM_BASE_URL;
  }
  return selected;
}

function resolveAuditAccountLabel(accountRef = "") {
  const needle = String(accountRef || "").trim();
  if (!needle) return "";
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], needle);
  if (!target) return needle;
  const label = String(target.label || "").trim();
  return label || target.account_id || needle;
}

registerCommonMiddleware(app, {
  config,
  hasActiveManagedProxyApiKeys,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  recordManagedProxyApiKeyUsage
});

registerSystemRoutes(app, {
  publicDir,
  config,
  getAuthStatus,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled
});

function replaceActiveOAuthStore(nextStore) {
  if (config.authMode === "codex-oauth") {
    codexOAuthStore = nextStore;
    return;
  }
  if (config.authMode === "custom-oauth") {
    customOAuthStore = nextStore;
  }
}

registerAuthRoutes(app, {
  config,
  getAuthStatus,
  getActiveOAuthRuntime,
  ensureCodexOAuthCallbackServer,
  randomBase64Url,
  sha256base64url,
  pendingAuth,
  cleanupPendingStates,
  parseSlotValue,
  isCodexMultiAccountEnabled,
  completeOAuthCallback,
  buildOAuthCallbackMessage,
  oauthCallbackSuccessHtml: OAUTH_CALLBACK_SUCCESS_HTML,
  parseJsonBody,
  removeCodexPoolAccountFromStore,
  saveTokenStore,
  clearAuthContextCache,
  replaceActiveOAuthStore
});
registerAdminCoreRoutes(app, {
  config,
  runtimeStats,
  cloudflaredRuntime,
  tempMailController,
  expiredAccountCleanupController,
  proxyApiKeyStore,
  getAuthStatus,
  checkCloudflaredInstalled,
  buildApiKeySummary,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  getCloudflaredStatus,
  getCodexPreheatState,
  createProxyApiKey,
  hashProxyApiKey,
  sanitizeProxyApiKeyLabel,
  saveProxyApiKeyStore,
  parseJsonBody,
  startCloudflaredTunnel,
  stopCloudflaredTunnel,
  installCloudflaredBinary,
  validCloudflaredModes: VALID_CLOUDFLARED_MODES,
  parseNumberEnv,
  getOfficialModelCandidateIds
});
function getCodexOAuthStore() {
  return codexOAuthStore;
}

function setCodexOAuthStore(nextStore) {
  codexOAuthStore = nextStore;
}

registerAdminPoolRoutes(app, {
  config,
  parseJsonBody,
  getCodexOAuthStore,
  setCodexOAuthStore,
  ensureCodexOAuthStoreShape,
  saveTokenStore,
  clearAuthContextCache,
  buildCodexPoolMetrics,
  isCodexMultiAccountEnabled,
  getCodexPoolEntryId,
  findCodexPoolAccountByRef,
  removeCodexPoolAccountFromStore,
  importIntoCodexAuthPool,
  normalizeOpenAICodexPlanType,
  refreshCodexUsageSnapshotInStore,
  runCodexPreheat,
  getCodexPreheatState
});

registerAdminSettingsRoutes(app, {
  config,
  cloudflaredRuntime,
  runtimeStats,
  recentRequestsStore,
  parseJsonBody,
  normalizeUpstreamMode,
  setActiveUpstreamBaseUrl,
  normalizeCodexServiceTier,
  parseReasoningEffortOrFallback,
  validMultiAccountStrategies: VALID_MULTI_ACCOUNT_STRATEGIES,
  multiAccountStrategyList: MULTI_ACCOUNT_STRATEGY_LIST,
  expiredAccountCleanupController,
  sanitizeModelMappings,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  runDirectChatCompletionTest,
  tempMailController,
  parseNumberEnv
});
const upstreamRuntimeHelpers = createUpstreamRuntimeHelpers({
  maxAuditTextChars: RUNTIME_AUDIT_MAX_TEXT_CHARS,
  extractUpstreamTransportError,
  fetchWithUpstreamRetry,
  formatPayloadForAudit,
  parseContentType
});
const {
  noteUpstreamRetry,
  noteCompatibilityHint,
  noteUpstreamRequestAudit,
  fetchUpstreamWithRetry,
  pipeUpstreamBodyToResponse,
  readUpstreamTextOrThrow
} = upstreamRuntimeHelpers;
const openAIRequestNormalizationHelpers = createOpenAIRequestNormalizationHelpers({
  config,
  resolveCodexCompatibleRoute,
  resolveReasoningEffort,
  applyReasoningEffortDefaults
});
const {
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  toResponsesInputFromChatMessages
} = openAIRequestNormalizationHelpers;
const openAIResponsesCompatHelpers = createOpenAIResponsesCompatHelpers({
  config,
  parseJsonLoose
});
const {
  parseResponsesResultFromSse,
  extractCompletedResponseFromSse,
  extractCompletedResponseFromJson,
  pipeSseAndCaptureTokenUsage,
  pipeCodexSseAsChatCompletions,
  normalizeTokenUsage,
  mergeNormalizedTokenUsage,
  extractTokenUsageFromAuditResponse,
  convertResponsesToChatCompletion,
  extractAssistantTextFromResponse,
  extractAssistantToolCallsFromResponse,
  mapResponsesStatusToChatFinishReason
} = openAIResponsesCompatHelpers;
const codexOAuthResponsesHelpers = createCodexOAuthResponsesHelpers({
  config,
  truncate,
  getValidAuthContext,
  getCodexOriginator,
  parseResponsesResultFromSse,
  extractCompletedResponseFromJson,
  normalizeTokenUsage,
  extractAssistantTextFromResponse,
  mapResponsesStatusToChatFinishReason,
  resolveReasoningEffort,
  resolveCodexCompatibleRoute,
  isUnsupportedMaxOutputTokensError,
  isCodexPoolRetryEnabled,
  shouldRotateCodexAccountForStatus,
  maybeMarkCodexPoolFailure,
  maybeMarkCodexPoolSuccess,
  maybeCaptureCodexUsageFromHeaders,
  toResponsesInputFromChatMessages
});
const {
  buildCodexResponsesRequestBody,
  executeCodexResponsesViaOAuth,
  runCodexConversationViaOAuth
} = codexOAuthResponsesHelpers;
const anthropicLocalCompatHelpers = createAnthropicLocalCompatHelpers({
  config,
  parseJsonLoose,
  truncate,
  resolveReasoningEffort,
  resolveCodexCompatibleRoute,
  executeCodexResponsesViaOAuth,
  resolveCompatErrorStatusCode,
  mapHttpStatusToAnthropicErrorType,
  mapResponsesStatusToChatFinishReason,
  mapOpenAIFinishReasonToAnthropic
});
const geminiLocalCompatHelpers = createGeminiLocalCompatHelpers({
  config,
  resolveCodexCompatibleRoute,
  resolveCompatErrorStatusCode,
  parseOpenAIChatCompletionsLikeRequest,
  splitSystemAndConversation,
  buildOpenAIChatCompletion,
  sendOpenAICompletionAsSse,
  mapOpenAIFinishReasonToGemini,
  runCodexConversationViaOAuth,
  getOpenAICompatibleModelIds
});
const anthropicOpenAICompatHelpers = createAnthropicOpenAICompatHelpers({
  config,
  resolveCodexCompatibleRoute,
  resolveCompatErrorStatusCode,
  parseOpenAIChatCompletionsLikeRequest,
  splitSystemAndConversation,
  buildOpenAIChatCompletion,
  sendOpenAICompletionAsSse,
  runCodexConversationViaOAuth
});
const proxyRouteHandlers = createProxyRouteHandlers({
  config,
  runtimeStats,
  recentRequestsStore,
  hopByHop,
  runtimeAuditMaxBodyBytes: RUNTIME_AUDIT_MAX_BODY_BYTES,
  runtimeAuditMaxTextChars: RUNTIME_AUDIT_MAX_TEXT_CHARS,
  extractPreviousResponseId,
  extractUpstreamTransportError,
  isPreviousResponseIdUnsupportedError,
  formatPayloadForAudit,
  inferProtocolType,
  isProxyApiPath,
  parseContentType,
  sanitizeAuditPath,
  toChunkBuffer,
  normalizeCherryAnthropicAgentOriginalUrl: anthropicLocalCompatHelpers.normalizeCherryAnthropicAgentOriginalUrl,
  isGeminiNativeAliasPath,
  chooseProtocolForV1ChatCompletions,
  handleGeminiProtocol,
  handleAnthropicProtocol,
  getValidAuthContext,
  getCodexOriginator,
  noteUpstreamRetry,
  noteCompatibilityHint,
  noteUpstreamRequestAudit,
  fetchUpstreamWithRetry,
  pipeUpstreamBodyToResponse,
  readUpstreamTextOrThrow,
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  parseJsonLoose,
  buildResponsesChainEntry,
  codexResponsesChain,
  expandResponsesRequestBodyFromChain,
  isCodexMultiAccountEnabled,
  isCodexPoolRetryEnabled,
  shouldRotateCodexAccountForStatus,
  maybeMarkCodexPoolFailure,
  maybeCaptureCodexUsageFromHeaders,
  maybeMarkCodexPoolSuccess,
  truncate,
  extractCompletedResponseFromSse,
  convertResponsesToChatCompletion,
  pipeCodexSseAsChatCompletions,
  pipeSseAndCaptureTokenUsage,
  handleGeminiNativeProxy,
  handleAnthropicNativeProxy,
  normalizeTokenUsage,
  extractTokenUsageFromAuditResponse,
  estimateOpenAIChatCompletionTokens,
  mergeNormalizedTokenUsage,
  resolveAuditAccountLabel,
  handleAnthropicModelsList,
  isAnthropicNativeRequest,
  getOpenAICompatibleModelIds,
  isCodexTokenInvalidatedError,
  codexResponseAffinity,
  nextRuntimeRequestSeq: () => (runtimeRequestSeq += 1),
  getAuthModeHint: () =>
    config.authMode === "profile-store"
      ? "Run `your external auth tool login flow` first."
      : "Open /auth/login first."
});

registerProxyRoutes(app, { handlers: proxyRouteHandlers });

const shouldAutostartServer = !parseBooleanEnv(process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART, false);
const { mainServer } = startConfiguredServer({
  app,
  config,
  shouldAutostart: shouldAutostartServer,
  getActiveUpstreamBaseUrl,
  onStartup: () => {
    if (config.authMode === "profile-store") {
      console.log(`source: ${config.profileStore.authStorePath}`);
      console.log(`profile:${config.profileStore.profileId}`);
    } else if (config.authMode === "codex-oauth") {
      console.log(`oauth-authorize: ${config.codexOAuth.authorizeUrl}`);
      console.log(`oauth-store:     ${config.codexOAuth.tokenStorePath}`);
      console.log(`login:           http://${config.host}:${config.port}/auth/login`);
    } else {
      console.log(`oauth-authorize: ${config.customOAuth.authorizeUrl}`);
      console.log(`oauth-store:     ${config.customOAuth.tokenStorePath}`);
      console.log(`login:           http://${config.host}:${config.port}/auth/login`);
    }
    console.log(`status:          http://${config.host}:${config.port}/auth/status`);
    console.log(`dashboard:       http://${config.host}:${config.port}/dashboard/`);
    console.log(`proxy:           http://${config.host}:${config.port}/v1/*`);
    console.log(`preheat:         manual trigger only (dashboard button)`);
    console.log(
      `expired-cleanup: ${config.expiredAccountCleanup.enabled ? "enabled" : "disabled"} (${config.expiredAccountCleanup.intervalSeconds}s)`
    );
    if (config.expiredAccountCleanup.enabled) {
      expiredAccountCleanupController.run("startup").catch((err) => {
        console.warn(`[auth-pool] expired account cleanup failed on startup: ${err?.message || err}`);
      });
    }
  },
  onShutdown: async () => {
    if (proxyApiKeyStoreFlushTimer) {
      clearTimeout(proxyApiKeyStoreFlushTimer);
      proxyApiKeyStoreFlushTimer = null;
    }
    if (expiredAccountCleanupTimer) {
      clearInterval(expiredAccountCleanupTimer);
      expiredAccountCleanupTimer = null;
    }
    await tempMailController.shutdown().catch(() => {});
    await saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore).catch(() => {});
    await stopCloudflaredTunnel().catch(() => {});
  }
});

async function getAuthStatus() {
  if (config.authMode === "profile-store") {
    const { store, profileId, profile } = await loadProfileStoreProfile();
    return {
      mode: "profile-store",
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      authenticated: Boolean(profile?.access),
      profileId,
      provider: profile?.provider ?? null,
      expiresAt: profile?.expires ?? null,
      hasRefreshToken: Boolean(profile?.refresh),
      accountId: profile?.accountId || extractOpenAICodexAccountId(profile?.access || "") || null,
      authStorePath: config.profileStore.authStorePath,
      hasStore: Boolean(store)
    };
  }

  const token = customOAuthStore.token || null;
  if (config.authMode === "codex-oauth") {
    const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
    codexOAuthStore = normalized.store;
    const codexToken = codexOAuthStore.token || null;
    const accounts = Array.isArray(codexOAuthStore.accounts) ? codexOAuthStore.accounts : [];
    const enabledCount = accounts.filter((x) => x.enabled !== false).length;
    const activeEntryId = codexOAuthStore.active_account_id || null;
    const metrics = buildCodexPoolMetrics(accounts, activeEntryId || "");
    return {
      mode: "codex-oauth",
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      authenticated: Boolean(codexToken?.access_token),
      expiresAt: codexToken?.expires_at || null,
      hasRefreshToken: Boolean(codexToken?.refresh_token),
      accountId: extractOpenAICodexAccountId(codexToken?.access_token || "") || null,
      tokenStorePath: config.codexOAuth.tokenStorePath,
      sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
      multiAccountEnabled: isCodexMultiAccountEnabled(),
      multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
      accountPoolSize: accounts.length,
      enabledAccountCount: enabledCount,
      activeEntryId,
      activeAccountId:
        accounts.find((x) => getCodexPoolEntryId(x) === String(activeEntryId || ""))
          ?.account_id || null,
      poolMetrics: metrics.summary,
      accounts: (metrics.decorated || []).map((d, idx) => {
        const x = d.account;
        return {
          entryId: d.entryId,
          accountId: x.account_id,
          label: x.label || "",
          slot: Number(x.slot || 0) || idx + 1,
          enabled: x.enabled !== false,
          expiresAt: x.token?.expires_at || null,
          lastUsedAt: x.last_used_at || 0,
          failureCount: x.failure_count || 0,
          cooldownUntil: x.cooldown_until || 0,
          usageSnapshot: x.usage_snapshot || null,
          usageUpdatedAt: x.usage_updated_at || 0,
          healthScore: d.healthScore,
          healthStatus: d.healthStatus,
          primaryRemaining: d.primaryRemaining,
          secondaryRemaining: d.secondaryRemaining,
          lowQuota: d.lowQuota,
          hardLimited: d.hardLimited
        };
      })
    };
  }

  return {
    mode: "custom-oauth",
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl(),
    authenticated: Boolean(token?.access_token),
    expiresAt: token?.expires_at || null,
    hasRefreshToken: Boolean(token?.refresh_token),
    accountId: extractOpenAICodexAccountId(token?.access_token || "") || null
  };
}

async function getValidAuthContext(options = {}) {
  const preferredPoolEntryId =
    typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";
  const allowCache = !(
    config.authMode === "codex-oauth" &&
    (isCodexMultiAccountEnabled() || preferredPoolEntryId.length > 0)
  );
  if (allowCache) {
    const cached = getCachedAuthContext();
    if (cached) return cached;
  }

  let context;
  if (config.authMode === "profile-store") {
    context = await getValidAuthContextFromProfileStore();
  } else if (config.authMode === "codex-oauth") {
    context = await getValidAuthContextFromCodexOAuthStore(codexOAuthStore, config.codexOAuth, {
      preferredPoolEntryId
    });
  } else {
    context = await getValidAuthContextFromOAuthStore(customOAuthStore, config.customOAuth);
  }

  if (allowCache) {
    cacheAuthContext(context);
  }
  return context;
}

async function loadProfileStoreProfile() {
  let raw;
  try {
    raw = await fs.readFile(config.profileStore.authStorePath, "utf8");
  } catch {
    throw new Error(`Profile Store auth store not found: ${config.profileStore.authStorePath}`);
  }

  const store = JSON.parse(raw);
  const resolved = resolveProfileStoreProfile(store, config.profileStore.profileId);
  if (!resolved.profile) {
    throw new Error(
      `No usable oauth profile found. Run: your external auth tool login flow`
    );
  }
  return { store, profileId: resolved.profileId, profile: resolved.profile };
}

function resolveProfileStoreProfile(store, preferredProfileId) {
  const profiles = store?.profiles ?? {};
  let profileId = preferredProfileId;
  let profile = profiles[profileId];

  if (!isProfileStoreCodexOauthProfile(profile)) {
    const fallbackEntry = Object.entries(profiles).find(([, value]) => isProfileStoreCodexOauthProfile(value));
    if (fallbackEntry) {
      profileId = fallbackEntry[0];
      profile = fallbackEntry[1];
    }
  }

  return { profileId, profile };
}

function isProfileStoreCodexOauthProfile(profile) {
  return (
    profile &&
    profile.type === "oauth" &&
    profile.provider === "openai-codex" &&
    typeof profile.access === "string"
  );
}

function isExpiredOrNearExpiryMs(expiresAtMs) {
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - Date.now() < 60_000;
}

async function getValidAuthContextFromProfileStore() {
  const { store, profileId, profile } = await loadProfileStoreProfile();
  if (!profile.access) {
    throw new Error(`Profile ${profileId} has no access token.`);
  }

  const accountId = profile.accountId || extractOpenAICodexAccountId(profile.access) || null;
  if (!isExpiredOrNearExpiryMs(profile.expires)) {
    return {
      accessToken: profile.access,
      accountId
    };
  }

  if (!profile.refresh) {
    throw new Error(`Token expired and no refresh token found in profile ${profileId}.`);
  }

  const refreshed = await refreshOpenAICodexToken(profile.refresh);
  const nextProfile = {
    ...profile,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    ...(refreshed.accountId ? { accountId: refreshed.accountId } : {})
  };

  store.profiles = store.profiles || {};
  store.profiles[profileId] = nextProfile;
  store.lastGood = store.lastGood || {};
  store.lastGood["openai-codex"] = profileId;
  store.usageStats = store.usageStats || {};
  store.usageStats[profileId] = {
    ...(store.usageStats[profileId] || {}),
    lastUsed: Date.now(),
    errorCount: 0
  };

  await fs.writeFile(config.profileStore.authStorePath, JSON.stringify(store, null, 2), "utf8");
  return {
    accessToken: refreshed.access,
    accountId: refreshed.accountId || accountId
  };
}

async function refreshOpenAICodexToken(refreshToken) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex refresh failed: HTTP ${response.status} ${response.statusText}: ${truncate(bodyText, 500)}`
    );
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("OpenAI Codex refresh failed: invalid JSON response.");
  }

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI Codex refresh failed: missing required token fields.");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractOpenAICodexAccountId(json.access_token)
  };
}

function extractOpenAICodexAccountId(accessToken) {
  const authClaim = extractOpenAICodexAuthClaim(accessToken);
  const accountId = authClaim?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function extractOpenAICodexPrincipalId(accessToken) {
  const authClaim = extractOpenAICodexAuthClaim(accessToken);
  const payload = decodeJwtPayload(accessToken);
  const direct =
    authClaim?.chatgpt_account_user_id ||
    authClaim?.chatgpt_user_id ||
    payload?.sub ||
    null;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const email = extractOpenAICodexEmail(accessToken);
  if (typeof email === "string" && email.length > 0) return `email:${email.toLowerCase()}`;
  return null;
}

function normalizeOpenAICodexPlanType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[^a-z0-9_-]+/g, "-");
}

function extractOpenAICodexPlanType(accessToken) {
  const authClaim = extractOpenAICodexAuthClaim(accessToken);
  return normalizeOpenAICodexPlanType(authClaim?.chatgpt_plan_type || authClaim?.plan_type || "");
}

function extractOpenAICodexEmail(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const profileClaim = payload?.["https://api.openai.com/profile"];
  const email = profileClaim?.email;
  return typeof email === "string" && email.length > 0 ? email : null;
}

function extractOpenAICodexAuthClaim(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return payload?.[OPENAI_CODEX_JWT_CLAIM_PATH] || null;
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getActiveOAuthRuntime() {
  if (config.authMode === "codex-oauth") {
    return { oauth: config.codexOAuth, store: codexOAuthStore };
  }
  if (config.authMode === "custom-oauth") {
    return { oauth: config.customOAuth, store: customOAuthStore };
  }
  return null;
}

async function loadTokenStore(tokenStorePath) {
  try {
    const raw = await fs.readFile(tokenStorePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { token: null };
  }
}

async function saveTokenStore(tokenStorePath, nextStore) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  await fs.writeFile(tokenStorePath, JSON.stringify(nextStore, null, 2), "utf8");
}

async function loadJsonStore(filePath, fallbackValue = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function saveJsonStore(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function normalizeToken(tokenResponse, currentToken = null) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresIn = Number(tokenResponse.expires_in || 3600);
  const expiresAt = Number(tokenResponse.expires_at || nowSec + expiresIn);
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || currentToken?.refresh_token || null,
    token_type: tokenResponse.token_type || "Bearer",
    scope: tokenResponse.scope || null,
    expires_at: expiresAt
  };
}

function deriveCodexAccountIdFromToken(tokenLike) {
  const accessToken = tokenLike?.access_token || tokenLike?.access || "";
  const accountId = extractOpenAICodexAccountId(accessToken);
  if (accountId) return accountId;
  const fingerprintSource = `${accessToken.slice(0, 48)}|${tokenLike?.refresh_token || tokenLike?.refresh || ""}`;
  return `acct_${crypto.createHash("sha1").update(fingerprintSource).digest("hex").slice(0, 12)}`;
}

function buildCodexPoolEntryId(principalId, accountId, planType = null) {
  const normalizedPlanType = normalizeOpenAICodexPlanType(planType);
  if (principalId) {
    return normalizedPlanType ? `${principalId}::plan:${normalizedPlanType}` : principalId;
  }
  if (accountId) {
    return normalizedPlanType ? `acct:${accountId}::plan:${normalizedPlanType}` : `acct:${accountId}`;
  }
  return "";
}

function deriveCodexPoolEntryIdFromToken(tokenLike, options = {}) {
  const accessToken = tokenLike?.access_token || tokenLike?.access || "";
  const principalId = extractOpenAICodexPrincipalId(accessToken);
  const accountId = extractOpenAICodexAccountId(accessToken);
  const planType =
    normalizeOpenAICodexPlanType(options.planType) ||
    extractOpenAICodexPlanType(accessToken) ||
    normalizeOpenAICodexPlanType(tokenLike?.usage_snapshot?.plan_type) ||
    normalizeOpenAICodexPlanType(tokenLike?.plan_type);
  const structuredId = buildCodexPoolEntryId(principalId, accountId, planType);
  if (structuredId) return structuredId;
  const fingerprintSource = `${accessToken.slice(0, 48)}|${tokenLike?.refresh_token || tokenLike?.refresh || ""}`;
  const fallbackId = `entry_${crypto.createHash("sha1").update(fingerprintSource).digest("hex").slice(0, 16)}`;
  return planType ? `${fallbackId}::plan:${planType}` : fallbackId;
}

function getCodexPoolEntryId(accountEntry) {
  if (!accountEntry || typeof accountEntry !== "object") return "";
  const raw = accountEntry.identity_id || accountEntry.entry_id || accountEntry.account_id || "";
  return String(raw).trim();
}

function isCodexMultiAccountEnabled() {
  return config.authMode === "codex-oauth" && config.codexOAuth.multiAccountEnabled === true;
}

function createDefaultCodexAccountPoolStore() {
  return {
    token: null,
    accounts: [],
    rotation: {
      next_index: 0
    },
    active_account_id: null
  };
}

function sanitizeCodexAccountEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const token = raw.token && typeof raw.token === "object" ? raw.token : null;
  if (!token?.access_token) return null;

  const normalizedToken = normalizeToken(token, token);
  const tokenAccountId = extractOpenAICodexAccountId(normalizedToken.access_token || "");
  const persistedPlanType =
    normalizeOpenAICodexPlanType(raw?.usage_snapshot?.plan_type) ||
    normalizeOpenAICodexPlanType(raw?.plan_type);
  const tokenEntryId = deriveCodexPoolEntryIdFromToken(normalizedToken, { planType: persistedPlanType });
  const fallbackAccountId = String(raw.account_id || raw.accountId || "").trim();
  const fallbackEntryId = String(raw.identity_id || raw.entry_id || raw.account_id || "").trim();
  const accountId = tokenAccountId || fallbackAccountId;
  const entryId = tokenEntryId || fallbackEntryId;
  if (!accountId || !entryId) return null;
  return {
    identity_id: entryId,
    account_id: accountId,
    label: typeof raw.label === "string" ? raw.label : "",
    slot: parseSlotValue(raw.slot),
    enabled: raw.enabled !== false,
    token: normalizedToken,
    created_at: Number(raw.created_at || raw.createdAt || Math.floor(Date.now() / 1000)),
    last_used_at: Number(raw.last_used_at || raw.lastUsedAt || 0),
    failure_count: Number(raw.failure_count || raw.failureCount || 0),
    cooldown_until: Number(raw.cooldown_until || raw.cooldownUntil || 0),
    last_error: typeof raw.last_error === "string" ? raw.last_error : "",
    usage_snapshot:
      raw.usage_snapshot && typeof raw.usage_snapshot === "object" ? raw.usage_snapshot : null,
    usage_updated_at: Number(raw.usage_updated_at || raw.usageUpdatedAt || 0)
  };
}

function normalizeCodexAccountSlots(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return false;

  let changed = false;
  const used = new Set();
  const needsAssignment = [];

  for (const account of accounts) {
    const slot = parseSlotValue(account?.slot);
    if (slot && !used.has(slot)) {
      if (Number(account.slot || 0) !== slot) {
        account.slot = slot;
        changed = true;
      }
      used.add(slot);
      continue;
    }

    if (account.slot !== null) {
      account.slot = null;
      changed = true;
    }
    needsAssignment.push(account);
  }

  let cursor = 1;
  for (const account of needsAssignment) {
    while (cursor <= 64 && used.has(cursor)) cursor += 1;
    if (cursor > 64) break;
    account.slot = cursor;
    used.add(cursor);
    changed = true;
    cursor += 1;
  }

  return changed;
}

function ensureCodexOAuthStoreShape(store) {
  const src = store && typeof store === "object" ? store : {};
  const out = {
    ...createDefaultCodexAccountPoolStore(),
    ...src,
    rotation: {
      next_index: Number(src?.rotation?.next_index || src?.rotation?.nextIndex || 0)
    }
  };

  const originalAccounts = Array.isArray(src.accounts) ? src.accounts : [];
  out.accounts = originalAccounts.map(sanitizeCodexAccountEntry).filter(Boolean);

  let changed = !Array.isArray(src.accounts) || out.accounts.length !== originalAccounts.length;
  let tokenBackedEntryId = "";
  let tokenBackedAccountEnabled = false;

  if (src.token?.access_token) {
    const tokenNormalized = normalizeToken(src.token, src.token);
    const accountId = deriveCodexAccountIdFromToken(tokenNormalized);
    const activePlanType = normalizeOpenAICodexPlanType(src?.usage_snapshot?.plan_type);
    const entryId = deriveCodexPoolEntryIdFromToken(tokenNormalized, { planType: activePlanType });
    tokenBackedEntryId = entryId;
    const idx = out.accounts.findIndex((x) => getCodexPoolEntryId(x) === entryId);
    if (idx >= 0) {
      out.accounts[idx].identity_id = entryId;
      out.accounts[idx].account_id = accountId;
      out.accounts[idx].token = tokenNormalized;
      tokenBackedAccountEnabled = out.accounts[idx].enabled !== false;
    } else {
      out.accounts.push({
        identity_id: entryId,
        account_id: accountId,
        label: "",
        slot: null,
        enabled: true,
        token: tokenNormalized,
        created_at: Math.floor(Date.now() / 1000),
        last_used_at: 0,
        failure_count: 0,
        cooldown_until: 0,
        last_error: "",
        usage_snapshot: null,
        usage_updated_at: 0
      });
      tokenBackedAccountEnabled = true;
    }
    if (tokenBackedAccountEnabled && out.active_account_id !== entryId) {
      out.active_account_id = entryId;
      changed = true;
    }
  }

  const firstEnabledAccount = out.accounts.find((x) => x && x.enabled !== false) || null;

  if (out.accounts.length > 0 && !out.active_account_id && firstEnabledAccount) {
    out.active_account_id = getCodexPoolEntryId(firstEnabledAccount);
    changed = true;
  }
  if (out.active_account_id && out.accounts.length > 0) {
    const activeRef = String(out.active_account_id);
    const hasDirect = out.accounts.some((x) => getCodexPoolEntryId(x) === activeRef);
    if (!hasDirect) {
      const byLegacyPlanless = out.accounts.find((x) => getCodexPoolEntryId(x).startsWith(`${activeRef}::plan:`));
      if (byLegacyPlanless) {
        out.active_account_id = getCodexPoolEntryId(byLegacyPlanless);
        changed = true;
      } else {
      const byLegacyAccountId = out.accounts.find((x) => String(x.account_id || "") === activeRef);
      if (byLegacyAccountId) {
        out.active_account_id = getCodexPoolEntryId(byLegacyAccountId);
        changed = true;
        }
      }
    }

    const activeAccount = out.accounts.find((x) => getCodexPoolEntryId(x) === String(out.active_account_id || ""));
    if (!activeAccount || activeAccount.enabled === false) {
      const fallbackActiveId = firstEnabledAccount ? getCodexPoolEntryId(firstEnabledAccount) : null;
      if (out.active_account_id !== fallbackActiveId) {
        out.active_account_id = fallbackActiveId;
        changed = true;
      }
    }
  }

  if (out.accounts.length === 0) {
    out.rotation.next_index = 0;
    out.active_account_id = null;
  } else if (!Number.isFinite(out.rotation.next_index) || out.rotation.next_index < 0) {
    out.rotation.next_index = 0;
    changed = true;
  } else {
    out.rotation.next_index = out.rotation.next_index % out.accounts.length;
  }

  const preferredTokenAccount =
    out.accounts.find((x) => getCodexPoolEntryId(x) === String(out.active_account_id || "")) || firstEnabledAccount;
  const preferredToken = preferredTokenAccount?.enabled === false ? null : preferredTokenAccount?.token || null;
  const currentTokenEntryId = deriveCodexPoolEntryIdFromToken(out.token || null);
  if (preferredToken) {
    const preferredTokenEntryId = getCodexPoolEntryId(preferredTokenAccount);
    if (!out.token || currentTokenEntryId !== preferredTokenEntryId) {
      out.token = preferredToken;
      changed = true;
    }
  } else if (out.token) {
    out.token = null;
    changed = true;
  }

  if (tokenBackedEntryId && !tokenBackedAccountEnabled && currentTokenEntryId === tokenBackedEntryId) {
    out.token = preferredToken;
    changed = true;
  }

  if (normalizeCodexAccountSlots(out.accounts)) {
    changed = true;
  }

  return { store: out, changed };
}

function parsePercentOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function parseJsonLoose(rawText) {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function hasCodexUsageWindow(usageWindow) {
  if (!usageWindow || typeof usageWindow !== "object") return false;
  const windowMinutes = Number(usageWindow.window_minutes);
  if (Number.isFinite(windowMinutes) && windowMinutes > 0) return true;

  const resetAt = Number(usageWindow.reset_at);
  if (Number.isFinite(resetAt) && resetAt > 0) return true;

  const resetAfterSec = Number(usageWindow.reset_after_seconds);
  if (Number.isFinite(resetAfterSec) && resetAfterSec > 0) return true;

  const usedPercent = parsePercentOrNull(usageWindow.used_percent);
  if (usedPercent !== null && usedPercent > 0) return true;

  const remainingPercent = parsePercentOrNull(usageWindow.remaining_percent);
  if (remainingPercent !== null && remainingPercent < 100) return true;

  return false;
}

function readUsageRemainingPercent(usageWindow) {
  const direct = parsePercentOrNull(usageWindow?.remaining_percent);
  if (direct !== null) return direct;
  const used = parsePercentOrNull(usageWindow?.used_percent);
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function readUsageUsedPercent(usageWindow) {
  const direct = parsePercentOrNull(usageWindow?.used_percent);
  if (direct !== null) return direct;
  const remaining = parsePercentOrNull(usageWindow?.remaining_percent);
  if (remaining === null) return null;
  return Math.max(0, Math.min(100, 100 - remaining));
}

function getCodexUsageWindowStats(account) {
  const usage = account?.usage_snapshot || null;
  let primaryHasWindow = hasCodexUsageWindow(usage?.primary);
  let secondaryHasWindow = hasCodexUsageWindow(usage?.secondary);
  let primaryRemaining = primaryHasWindow ? readUsageRemainingPercent(usage?.primary) : null;
  let secondaryRemaining = secondaryHasWindow ? readUsageRemainingPercent(usage?.secondary) : null;
  let primaryUsed = primaryHasWindow ? readUsageUsedPercent(usage?.primary) : null;
  let secondaryUsed = secondaryHasWindow ? readUsageUsedPercent(usage?.secondary) : null;
  let primaryWindowMinutes = Number(usage?.primary?.window_minutes);
  let secondaryWindowMinutes = Number(usage?.secondary?.window_minutes);
  const planType = String(usage?.plan_type || "").trim().toLowerCase();

  // Free plans only expose one quota window. If legacy/bad snapshots contain both,
  // collapse to a single effective window so dashboard and health remain consistent.
  if (planType === "free") {
    const windows = [];
    if (primaryHasWindow) {
      windows.push({
        remaining: primaryRemaining,
        used: primaryUsed,
        minutes: Number.isFinite(primaryWindowMinutes) ? primaryWindowMinutes : null
      });
    }
    if (secondaryHasWindow) {
      windows.push({
        remaining: secondaryRemaining,
        used: secondaryUsed,
        minutes: Number.isFinite(secondaryWindowMinutes) ? secondaryWindowMinutes : null
      });
    }

    const pickScore = (w) => {
      const rem = Number.isFinite(w?.remaining) ? w.remaining : 100;
      const used = Number.isFinite(w?.used) ? w.used : 0;
      return used > 0 || rem < 100 ? 1000 - rem + used : 0;
    };
    const preferred = windows
      .map((w) => ({ w, s: pickScore(w) }))
      .sort((a, b) => b.s - a.s)[0]?.w;

    primaryHasWindow = Boolean(preferred);
    secondaryHasWindow = false;
    primaryRemaining = preferred?.remaining ?? null;
    primaryUsed = preferred?.used ?? null;
    primaryWindowMinutes = Number.isFinite(preferred?.minutes) ? preferred.minutes : 10080;
    secondaryRemaining = null;
    secondaryUsed = null;
    secondaryWindowMinutes = null;
  }

  const isSingleWindow = primaryHasWindow && !secondaryHasWindow;
  return {
    planType,
    isSingleWindow,
    primaryHasWindow,
    secondaryHasWindow,
    primaryWindowMinutes: Number.isFinite(primaryWindowMinutes) ? primaryWindowMinutes : null,
    secondaryWindowMinutes: Number.isFinite(secondaryWindowMinutes) ? secondaryWindowMinutes : null,
    primaryRemaining,
    secondaryRemaining,
    primaryUsed,
    secondaryUsed
  };
}

function resolveCodexLowQuotaThreshold(usageStats) {
  if (!usageStats || typeof usageStats !== "object") return LOW_QUOTA_THRESHOLD_DUAL_WINDOW;
  if (usageStats.isSingleWindow) return LOW_QUOTA_THRESHOLD_SINGLE_WINDOW;
  if (usageStats.planType === "free") return LOW_QUOTA_THRESHOLD_SINGLE_WINDOW;
  return LOW_QUOTA_THRESHOLD_DUAL_WINDOW;
}

function classifyCodexPoolHealth(account, nowSec = Math.floor(Date.now() / 1000), usage = null) {
  const enabled = account?.enabled !== false;
  const cooldownUntil = Number(account?.cooldown_until || 0);
  const expiresAt = Number(account?.token?.expires_at || 0);
  const inCooldown = cooldownUntil > nowSec;
  const expired = expiresAt > 0 && expiresAt <= nowSec;
  const expiringSoon = expiresAt > nowSec && expiresAt - nowSec < 180;
  const usageStats = usage || getCodexUsageWindowStats(account);
  const primaryRemaining = usageStats.primaryRemaining;
  const secondaryRemaining = usageStats.secondaryRemaining;
  const lowQuotaThreshold = resolveCodexLowQuotaThreshold(usageStats);
  // For dual-window plans, either window reaching 0 means the account is not usable now.
  // For single-window plans, only the primary window applies.
  const hardLimited = usageStats.isSingleWindow
    ? primaryRemaining !== null && primaryRemaining <= 0
    : (primaryRemaining !== null && primaryRemaining <= 0) ||
      (secondaryRemaining !== null && secondaryRemaining <= 0);
  const lowQuota =
    (primaryRemaining !== null && primaryRemaining <= lowQuotaThreshold) ||
    (secondaryRemaining !== null && secondaryRemaining <= LOW_QUOTA_THRESHOLD_DUAL_WINDOW);

  if (!enabled) return { status: "disabled", hardLimited, lowQuota };
  if (expired) return { status: "expired", hardLimited, lowQuota };
  if (inCooldown) return { status: "cooldown", hardLimited, lowQuota };
  if (hardLimited) return { status: "limited", hardLimited, lowQuota };
  if (expiringSoon) return { status: "expiring", hardLimited, lowQuota };
  if (lowQuota) return { status: "limited", hardLimited, lowQuota };
  return { status: "healthy", hardLimited, lowQuota };
}

function computeCodexPoolHealthScore(
  account,
  activeEntryId = "",
  nowSec = Math.floor(Date.now() / 1000),
  usage = null,
  health = null
) {
  const usageStats = usage || getCodexUsageWindowStats(account);
  const healthMeta = health || classifyCodexPoolHealth(account, nowSec, usageStats);
  const failureCount = Number(account?.failure_count || 0);
  const cooldownUntil = Number(account?.cooldown_until || 0);
  const expiresAt = Number(account?.token?.expires_at || 0);
  const isActive = getCodexPoolEntryId(account) === String(activeEntryId || "");

  let score = 100;
  if (account?.enabled === false) score -= 90;
  if (healthMeta.status === "expired") score -= 80;
  if (healthMeta.status === "cooldown") score -= 35;
  if (healthMeta.status === "expiring") score -= 15;
  if (healthMeta.status === "limited") {
    if (healthMeta.hardLimited) score -= 28;
    else score -= usageStats.isSingleWindow ? 20 : 12;
  }
  if (usageStats.primaryUsed !== null) score -= Math.round(usageStats.primaryUsed * 0.35);
  if (usageStats.secondaryUsed !== null) score -= Math.round(usageStats.secondaryUsed * 0.15);
  score -= Math.min(55, failureCount * 11);
  if (cooldownUntil > nowSec) {
    const remain = cooldownUntil - nowSec;
    score -= Math.min(18, Math.floor(remain / 20));
  }
  if (expiresAt > nowSec && expiresAt - nowSec < 180) {
    score -= 8;
  }
  if (isActive) score += 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function decorateCodexPoolAccount(account, activeEntryId = "", nowSec = Math.floor(Date.now() / 1000)) {
  const usage = getCodexUsageWindowStats(account);
  const health = classifyCodexPoolHealth(account, nowSec, usage);
  const healthScore = computeCodexPoolHealthScore(account, activeEntryId, nowSec, usage, health);
  return {
    account,
    entryId: getCodexPoolEntryId(account),
    healthStatus: health.status,
    healthScore,
    primaryRemaining: usage.primaryRemaining,
    secondaryRemaining: usage.secondaryRemaining,
    primaryUsed: usage.primaryUsed,
    secondaryUsed: usage.secondaryUsed,
    hardLimited: health.hardLimited,
    lowQuota: health.lowQuota
  };
}

function compareCodexSmartDecorated(a, b) {
  if (b.healthScore !== a.healthScore) return b.healthScore - a.healthScore;
  if ((b.primaryRemaining ?? -1) !== (a.primaryRemaining ?? -1)) {
    return (b.primaryRemaining ?? -1) - (a.primaryRemaining ?? -1);
  }
  if ((b.secondaryRemaining ?? -1) !== (a.secondaryRemaining ?? -1)) {
    return (b.secondaryRemaining ?? -1) - (a.secondaryRemaining ?? -1);
  }
  const aUsed = Number(a.account?.last_used_at || 0);
  const bUsed = Number(b.account?.last_used_at || 0);
  if (aUsed !== bUsed) return aUsed - bUsed;
  return String(a.entryId || "").localeCompare(String(b.entryId || ""));
}

function buildCodexPoolMetrics(accounts, activeEntryId = "") {
  const nowSec = Math.floor(Date.now() / 1000);
  const decorated = (Array.isArray(accounts) ? accounts : []).map((x) =>
    decorateCodexPoolAccount(x, activeEntryId, nowSec)
  );
  const primaryValues = decorated
    .map((x) => x.primaryRemaining)
    .filter((x) => Number.isFinite(x));
  const secondaryValues = decorated
    .map((x) => x.secondaryRemaining)
    .filter((x) => Number.isFinite(x));
  const enabled = decorated.filter((x) => x.account?.enabled !== false);
  const healthy = decorated.filter((x) => x.healthStatus === "healthy");
  const cooldown = decorated.filter((x) => x.healthStatus === "cooldown");
  const atRisk = decorated.filter((x) =>
    ["disabled", "expired", "cooldown", "expiring", "limited"].includes(x.healthStatus)
  );
  const lowQuotaCount = decorated.filter((x) => x.lowQuota).length;
  const hardLimitedCount = decorated.filter((x) => x.hardLimited).length;
  const recommended = [...enabled]
    .sort(compareCodexSmartDecorated)
    .slice(0, 3)
    .map((x) => x.entryId);
  return {
    decorated,
    summary: {
      totalAccounts: decorated.length,
      enabledAccounts: enabled.length,
      healthyRatio: enabled.length > 0 ? Math.round((healthy.length / enabled.length) * 100) : 0,
      cooldownCount: cooldown.length,
      atRiskCount: atRisk.length,
      lowQuotaCount,
      hardLimitedCount,
      avgPrimaryRemaining:
        primaryValues.length > 0
          ? Math.round(primaryValues.reduce((a, b) => a + b, 0) / primaryValues.length)
          : null,
      avgSecondaryRemaining:
        secondaryValues.length > 0
          ? Math.round(secondaryValues.reduce((a, b) => a + b, 0) / secondaryValues.length)
          : null,
      recommendedEntryIds: recommended
    }
  };
}

function getCodexEnabledAccounts(store) {
  if (!Array.isArray(store?.accounts)) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const enabledAccounts = store.accounts.filter((x) => x && x.enabled !== false);
  if (enabledAccounts.length === 0) return [];
  // If every account is cooling down, still allow fallback candidates instead of hard-failing
  // with "No enabled OAuth accounts".
  const eligible =
    enabledAccounts.filter((x) => Number(x.cooldown_until || 0) <= nowSec).length > 0
      ? enabledAccounts.filter((x) => Number(x.cooldown_until || 0) <= nowSec)
      : [...enabledAccounts];
  const preferred = eligible.filter((x) => {
    const health = classifyCodexPoolHealth(x, nowSec);
    return health.status !== "limited" && !health.hardLimited;
  });
  return preferred.length > 0 ? preferred : eligible;
}

function rotateListFromIndex(list, startIndex) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const safeStart = Math.max(0, Math.min(Number(startIndex || 0), list.length - 1));
  return list.slice(safeStart).concat(list.slice(0, safeStart));
}

function pickCodexAccountCandidates(store, options = {}) {
  const enabled = getCodexEnabledAccounts(store);
  if (enabled.length === 0) return [];
  const preferredPoolEntryId =
    typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";

  const strategy = config.codexOAuth.multiAccountStrategy;
  let candidates;
  if (strategy === "smart") {
    const decorated = enabled.map((x) => decorateCodexPoolAccount(x, store.active_account_id || ""));
    const preferred = decorated.filter((x) => x.healthStatus !== "limited" && !x.hardLimited);
    const ranked = (preferred.length > 0 ? preferred : decorated).sort(compareCodexSmartDecorated);
    candidates = ranked.map((x) => x.account);
  } else if (strategy === "manual") {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeRef = String(store.active_account_id || "").trim();
    const pool = Array.isArray(store.accounts) ? store.accounts : [];
    const activeReady = pool.find(
      (x) => x && x.enabled !== false && Number(x.cooldown_until || 0) <= nowSec && getCodexPoolEntryId(x) === activeRef
    );
    if (activeReady) candidates = [activeReady];
    else {
      const activeEnabled = pool.find((x) => x && x.enabled !== false && getCodexPoolEntryId(x) === activeRef);
      if (activeEnabled) candidates = [activeEnabled];
      else {
        const fallbackReady = pool.find((x) => x && x.enabled !== false && Number(x.cooldown_until || 0) <= nowSec);
        if (fallbackReady) candidates = [fallbackReady];
        else {
          const fallbackEnabled = pool.find((x) => x && x.enabled !== false);
          candidates = fallbackEnabled ? [fallbackEnabled] : [];
        }
      }
    }
  } else if (strategy === "sticky" && store.active_account_id) {
    const primary = enabled.find((x) => getCodexPoolEntryId(x) === String(store.active_account_id));
    if (primary) {
      const primaryId = getCodexPoolEntryId(primary);
      candidates = [primary, ...enabled.filter((x) => getCodexPoolEntryId(x) !== primaryId)];
    }
  } else if (strategy === "random") {
    const shuffled = [...enabled];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    candidates = shuffled;
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const start = Number(store?.rotation?.next_index || 0) % enabled.length;
    candidates = rotateListFromIndex(enabled, start);
  }

  if (!preferredPoolEntryId) return candidates;

  const preferredPool = (Array.isArray(store?.accounts) ? store.accounts : []).filter((x) => x && x.enabled !== false);
  const preferred = preferredPool.find((x) => getCodexPoolEntryId(x) === preferredPoolEntryId);
  if (!preferred) return candidates;

  const preferredId = getCodexPoolEntryId(preferred);
  return [preferred, ...candidates.filter((x) => getCodexPoolEntryId(x) !== preferredId)];
}

function upsertCodexOAuthAccount(store, normalizedToken, options = {}) {
  const accountId = deriveCodexAccountIdFromToken(normalizedToken);
  const planType =
    normalizeOpenAICodexPlanType(options.planType) || extractOpenAICodexPlanType(normalizedToken?.access_token || "");
  const entryId = deriveCodexPoolEntryIdFromToken(normalizedToken, { planType });
  const tokenEmail = extractOpenAICodexEmail(normalizedToken?.access_token || "");
  const label = typeof options.label === "string" ? options.label.trim() : "";
  const slot = parseSlotValue(options.slot);
  const forceReplaceSlot =
    options.force === true || options.force === 1 || String(options.force || "").trim() === "1";
  const nowSec = Math.floor(Date.now() / 1000);
  const usageSnapshot = options.usageSnapshot && typeof options.usageSnapshot === "object" ? options.usageSnapshot : null;
  if (!Array.isArray(store.accounts)) store.accounts = [];

  const existingIdx = store.accounts.findIndex((x) => getCodexPoolEntryId(x) === entryId);
  const slotIdx = slot ? store.accounts.findIndex((x) => Number(x.slot || 0) === slot) : -1;

  // Prefer updating existing account identity to avoid duplicate same-account entries.
  let targetIdx = existingIdx;
  if (targetIdx < 0 && slotIdx >= 0 && forceReplaceSlot) {
    targetIdx = slotIdx;
  }

  let action = "created";
  let resolvedIncomingSlot = slot;
  if (existingIdx < 0 && slotIdx >= 0 && !forceReplaceSlot) {
    // Keep existing slot owner; assign this new account to the next free slot.
    resolvedIncomingSlot = null;
    action = "created_reassigned_slot";
  }
  if (targetIdx >= 0) {
    const isSameAccountUpdate = existingIdx >= 0;
    if (isSameAccountUpdate) {
      const currentSlot = Number(store.accounts[targetIdx].slot || 0) || null;
      const requestedDifferentSlot =
        resolvedIncomingSlot !== null && currentSlot !== null && resolvedIncomingSlot !== currentSlot;
      action =
        requestedDifferentSlot && !forceReplaceSlot
          ? "already_exists_same_account"
          : "updated_existing_account";
    } else {
      action = "replaced_slot";
    }

    const currentLabel =
      typeof store.accounts[targetIdx].label === "string" && store.accounts[targetIdx].label.trim().length > 0
        ? store.accounts[targetIdx].label.trim()
        : "";
    const currentSlot = Number(store.accounts[targetIdx].slot || 0) || null;
    const keepSlotBecauseSameAccount =
      isSameAccountUpdate &&
      resolvedIncomingSlot !== null &&
      currentSlot !== null &&
      resolvedIncomingSlot !== currentSlot &&
      !forceReplaceSlot;
    const resolvedLabel = isSameAccountUpdate
      ? currentLabel || tokenEmail || accountId
      : label || currentLabel || tokenEmail || accountId;
    store.accounts[targetIdx] = {
      ...store.accounts[targetIdx],
      identity_id: entryId,
      account_id: accountId,
      token: normalizeToken(normalizedToken, store.accounts[targetIdx].token),
      enabled: true,
      label: resolvedLabel,
      slot: keepSlotBecauseSameAccount
        ? currentSlot
        : resolvedIncomingSlot ?? store.accounts[targetIdx].slot ?? null,
      last_error: "",
      cooldown_until: 0,
      usage_snapshot: usageSnapshot || store.accounts[targetIdx].usage_snapshot || null,
      usage_updated_at: usageSnapshot
        ? Number(usageSnapshot.fetched_at || nowSec) || nowSec
        : Number(store.accounts[targetIdx].usage_updated_at || 0)
    };
  } else {
    store.accounts.push({
      identity_id: entryId,
      account_id: accountId,
      label: label || tokenEmail || accountId,
      slot: resolvedIncomingSlot ?? null,
      enabled: true,
      token: normalizeToken(normalizedToken, normalizedToken),
      created_at: nowSec,
      last_used_at: 0,
      failure_count: 0,
      cooldown_until: 0,
      last_error: "",
      usage_snapshot: usageSnapshot,
      usage_updated_at: usageSnapshot ? Number(usageSnapshot.fetched_at || nowSec) || nowSec : 0
    });
  }

  store.active_account_id = entryId;
  store.token = normalizedToken;
  store.rotation = store.rotation || { next_index: 0 };
  if (!Number.isFinite(store.rotation.next_index)) store.rotation.next_index = 0;

  normalizeCodexAccountSlots(store.accounts);

  const resolvedAccount = store.accounts.find((x) => getCodexPoolEntryId(x) === entryId);
  const resolvedSlot = Number(resolvedAccount?.slot || 0) || null;

  return { accountId, entryId, slot: resolvedSlot, action, email: tokenEmail || null, planType };
}

function shouldRotateCodexAccountForStatus(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function getCodexPoolCooldownSeconds(statusCode, failureCount) {
  if (statusCode === 401 || statusCode === 403) return Math.min(1800, 120 * Math.max(1, failureCount));
  if (statusCode === 429) return Math.min(600, 30 * Math.max(1, failureCount));
  return Math.min(180, 15 * Math.max(1, failureCount));
}

function isCodexTokenInvalidatedError(statusCode, reason) {
  if (Number(statusCode || 0) !== 401) return false;
  const text = String(reason || "").toLowerCase();
  return (
    text.includes("token_invalidated") ||
    text.includes("authentication token has been invalidated") ||
    text.includes("please try signing in again")
  );
}

function findCodexPoolAccountByRef(accounts, ref) {
  const needle = String(ref || "").trim();
  if (!needle) return null;
  const byEntry = (accounts || []).find((x) => getCodexPoolEntryId(x) === needle);
  if (byEntry) return byEntry;
  return (accounts || []).find((x) => String(x.account_id || "") === needle) || null;
}

function selectCodexAccountForLogout(store, explicitRef = "") {
  const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
  if (accounts.length === 0) return null;

  const explicit = String(explicitRef || "").trim();
  if (explicit) {
    const byExplicit = findCodexPoolAccountByRef(accounts, explicit);
    if (byExplicit) return byExplicit;
  }

  const activeRef = String(store?.active_account_id || "").trim();
  if (activeRef) {
    const byActive = findCodexPoolAccountByRef(accounts, activeRef);
    if (byActive) return byActive;
  }

  const cacheAccountId = String(authContextCache.accountId || "").trim();
  if (cacheAccountId) {
    const byCache = findCodexPoolAccountByRef(accounts, cacheAccountId);
    if (byCache) return byCache;
  }

  const tokenRef = deriveCodexPoolEntryIdFromToken(store?.token || null);
  if (tokenRef) {
    const byToken = findCodexPoolAccountByRef(accounts, tokenRef);
    if (byToken) return byToken;
  }

  return accounts.find((x) => x && x.enabled !== false) || accounts[0] || null;
}

function removeCodexPoolAccountFromStore(storeInput, accountRef = "") {
  const normalized = ensureCodexOAuthStoreShape(storeInput);
  const store = normalized.store;
  const accounts = Array.isArray(store.accounts) ? store.accounts : [];
  const target = selectCodexAccountForLogout(store, accountRef);
  if (!target) {
    return {
      removed: false,
      removedEntryId: null,
      removedAccountId: null,
      remainingAccounts: accounts.length,
      activeEntryId: String(store.active_account_id || "").trim() || null,
      store
    };
  }

  const removedEntryId = getCodexPoolEntryId(target);
  const removedAccountId = String(target.account_id || "").trim() || null;
  const nextAccounts = accounts.filter((x) => getCodexPoolEntryId(x) !== removedEntryId);
  const removed = nextAccounts.length !== accounts.length;
  if (!removed) {
    return {
      removed: false,
      removedEntryId,
      removedAccountId,
      remainingAccounts: accounts.length,
      activeEntryId: String(store.active_account_id || "").trim() || null,
      store
    };
  }

  store.accounts = nextAccounts;
  if (nextAccounts.length === 0) {
    store.active_account_id = null;
    store.token = null;
    store.rotation = { next_index: 0 };
  } else {
    let nextActive = null;
    const currentActiveRef = String(store.active_account_id || "").trim();
    if (currentActiveRef && currentActiveRef !== removedEntryId) {
      nextActive = findCodexPoolAccountByRef(nextAccounts, currentActiveRef);
    }
    if (!nextActive || nextActive.enabled === false) {
      nextActive = nextAccounts.find((x) => x && x.enabled !== false) || nextAccounts[0];
    }

    const nextActiveEntryId = getCodexPoolEntryId(nextActive);
    const nextIdx = nextAccounts.findIndex((x) => getCodexPoolEntryId(x) === nextActiveEntryId);
    store.active_account_id = nextActiveEntryId || null;
    store.token = nextActive?.token || null;
    store.rotation = {
      next_index: nextIdx >= 0 && nextAccounts.length > 1 ? (nextIdx + 1) % nextAccounts.length : 0
    };
  }

  return {
    removed: true,
    removedEntryId,
    removedAccountId,
    remainingAccounts: store.accounts.length,
    activeEntryId: String(store.active_account_id || "").trim() || null,
    store
  };
}

async function markCodexPoolAccountFailure(accountRef, reason, statusCode = 0) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) return;
  target.failure_count = Number(target.failure_count || 0) + 1;
  target.last_error = String(reason || "request_failed");
  const cooldownSeconds = getCodexPoolCooldownSeconds(statusCode, target.failure_count);
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenInvalidated = isCodexTokenInvalidatedError(statusCode, target.last_error);
  const targetEntryId = getCodexPoolEntryId(target);
  if (tokenInvalidated) {
    // Hard-disable invalidated identities to stop poisoning account rotation.
    target.enabled = false;
    target.cooldown_until = 0;
  } else {
    target.cooldown_until = nowSec + cooldownSeconds;
  }
  if (Number(statusCode || 0) === 429) {
    const fallbackSnapshot = extractCodexUsageSnapshotFromLimitError(
      target.last_error,
      target.usage_snapshot || null,
      "request_error"
    );
    if (fallbackSnapshot) {
      target.usage_snapshot = fallbackSnapshot;
      target.usage_updated_at = Number(fallbackSnapshot.fetched_at || nowSec) || nowSec;
    }
  }
  const currentTokenEntryId = deriveCodexPoolEntryIdFromToken(codexOAuthStore.token || null);
  if (tokenInvalidated && currentTokenEntryId === targetEntryId) {
    const fallbackAccount =
      (codexOAuthStore.accounts || []).find((x) => x && x.enabled !== false && getCodexPoolEntryId(x) !== targetEntryId) ||
      null;
    codexOAuthStore.token = fallbackAccount?.token || null;
  }
  if (
    codexOAuthStore.active_account_id === targetEntryId &&
    (tokenInvalidated ||
      (config.codexOAuth.multiAccountStrategy !== "sticky" &&
        config.codexOAuth.multiAccountStrategy !== "manual"))
  ) {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
}

async function markCodexPoolAccountSuccess(accountRef) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) return;
  target.last_used_at = Math.floor(Date.now() / 1000);
  target.failure_count = 0;
  target.cooldown_until = 0;
  target.last_error = "";
  if (config.codexOAuth.multiAccountStrategy === "sticky") {
    codexOAuthStore.active_account_id = getCodexPoolEntryId(target);
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

function isCodexPoolRetryEnabled() {
  return config.authMode === "codex-oauth" && isCodexMultiAccountEnabled();
}

async function maybeMarkCodexPoolFailure(authContext, reason, statusCode = 0) {
  if (!isCodexPoolRetryEnabled()) return false;
  const poolRef = authContext?.poolEntryId || authContext?.poolAccountId || null;
  if (!poolRef) return false;
  const code = Number(statusCode || 0);
  if (!shouldRotateCodexAccountForStatus(code)) return false;
  await markCodexPoolAccountFailure(poolRef, reason, code);
  return true;
}

async function maybeMarkCodexPoolSuccess(authContext) {
  if (!isCodexPoolRetryEnabled()) return;
  const poolRef = authContext?.poolEntryId || authContext?.poolAccountId || null;
  if (!poolRef) return;
  await markCodexPoolAccountSuccess(poolRef);
}

function parseCodexHeaderNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCodexHeaderBoolean(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function extractCodexUsageSnapshotFromHeaders(headers, source = "response") {
  if (!headers || typeof headers.get !== "function") return null;

  const planType = headers.get("x-codex-plan-type") || null;
  const activeLimit = headers.get("x-codex-active-limit") || null;
  const primaryUsedPercent = parseCodexHeaderNumber(headers.get("x-codex-primary-used-percent"));
  const secondaryUsedPercent = parseCodexHeaderNumber(headers.get("x-codex-secondary-used-percent"));
  const hasCodexUsageSignals =
    Boolean(planType || activeLimit) ||
    primaryUsedPercent !== null ||
    secondaryUsedPercent !== null;
  if (!hasCodexUsageSignals) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const rawHeaders = {};
  for (const [k, v] of headers.entries()) {
    if (k.startsWith("x-codex-")) rawHeaders[k] = v;
  }

  const primaryRemainingPercent =
    primaryUsedPercent === null ? null : Math.max(0, Math.min(100, 100 - primaryUsedPercent));
  const secondaryRemainingPercent =
    secondaryUsedPercent === null ? null : Math.max(0, Math.min(100, 100 - secondaryUsedPercent));

  return {
    fetched_at: nowSec,
    source,
    plan_type: planType,
    active_limit: activeLimit,
    credits: {
      has_credits: parseCodexHeaderBoolean(headers.get("x-codex-credits-has-credits")),
      unlimited: parseCodexHeaderBoolean(headers.get("x-codex-credits-unlimited")),
      balance: headers.get("x-codex-credits-balance") || null
    },
    primary: {
      used_percent: primaryUsedPercent,
      remaining_percent: primaryRemainingPercent,
      reset_after_seconds: parseCodexHeaderNumber(headers.get("x-codex-primary-reset-after-seconds")),
      reset_at: parseCodexHeaderNumber(headers.get("x-codex-primary-reset-at")),
      window_minutes: parseCodexHeaderNumber(headers.get("x-codex-primary-window-minutes")),
      over_secondary_limit_percent: parseCodexHeaderNumber(
        headers.get("x-codex-primary-over-secondary-limit-percent")
      )
    },
    secondary: {
      used_percent: secondaryUsedPercent,
      remaining_percent: secondaryRemainingPercent,
      reset_after_seconds: parseCodexHeaderNumber(headers.get("x-codex-secondary-reset-after-seconds")),
      reset_at: parseCodexHeaderNumber(headers.get("x-codex-secondary-reset-at")),
      window_minutes: parseCodexHeaderNumber(headers.get("x-codex-secondary-window-minutes"))
    },
    raw_headers: rawHeaders
  };
}

function applyCodexUsageSnapshotToStore(store, accountRef, snapshot) {
  if (!store || !Array.isArray(store.accounts) || !accountRef || !snapshot) return false;
  const target = findCodexPoolAccountByRef(store.accounts, accountRef);
  if (!target) return false;
  target.usage_snapshot = snapshot;
  target.usage_updated_at = Number(snapshot.fetched_at || Math.floor(Date.now() / 1000));
  return true;
}

function extractCodexUsageSnapshotFromLimitError(rawText, previousSnapshot = null, source = "error") {
  const parsed = parseJsonLoose(rawText);
  const err = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  if (!err) return null;
  const errType = String(err.type || err.code || "").trim().toLowerCase();
  if (errType !== "usage_limit_reached") return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const planTypeRaw = String(err.plan_type || previousSnapshot?.plan_type || "").trim().toLowerCase();
  const planType = planTypeRaw || null;
  const resetAt = parseCodexHeaderNumber(err.resets_at);
  const resetInSeconds = parseCodexHeaderNumber(err.resets_in_seconds);
  const effectiveResetAt =
    resetAt ?? (Number.isFinite(resetInSeconds) ? nowSec + Math.max(0, resetInSeconds) : null);

  const prevPrimary = previousSnapshot?.primary && hasCodexUsageWindow(previousSnapshot.primary)
    ? {
        used_percent: parsePercentOrNull(previousSnapshot.primary.used_percent),
        remaining_percent: readUsageRemainingPercent(previousSnapshot.primary),
        reset_after_seconds: parseCodexHeaderNumber(previousSnapshot.primary.reset_after_seconds),
        reset_at: parseCodexHeaderNumber(previousSnapshot.primary.reset_at),
        window_minutes: parseCodexHeaderNumber(previousSnapshot.primary.window_minutes),
        over_secondary_limit_percent: parseCodexHeaderNumber(previousSnapshot.primary.over_secondary_limit_percent)
      }
    : null;
  const weeklyMinutes =
    parseCodexHeaderNumber(previousSnapshot?.secondary?.window_minutes) ||
    parseCodexHeaderNumber(previousSnapshot?.primary?.window_minutes) ||
    10080;
  const weeklyWindow = {
    used_percent: 100,
    remaining_percent: 0,
    reset_after_seconds: resetInSeconds,
    reset_at: effectiveResetAt,
    window_minutes: weeklyMinutes
  };

  // free plan => single weekly window only.
  if (planType === "free") {
    return {
      fetched_at: nowSec,
      source,
      plan_type: "free",
      active_limit: "weekly",
      credits: previousSnapshot?.credits || {
        has_credits: null,
        unlimited: null,
        balance: null
      },
      primary: {
        ...weeklyWindow,
        over_secondary_limit_percent: null
      },
      secondary: null,
      raw_headers:
        previousSnapshot?.raw_headers && typeof previousSnapshot.raw_headers === "object"
          ? previousSnapshot.raw_headers
          : {}
    };
  }

  return {
    fetched_at: nowSec,
    source,
    plan_type: planType,
    active_limit: "secondary",
    credits: previousSnapshot?.credits || {
      has_credits: null,
      unlimited: null,
      balance: null
    },
    primary: prevPrimary,
    secondary: weeklyWindow,
    raw_headers:
      previousSnapshot?.raw_headers && typeof previousSnapshot.raw_headers === "object"
        ? previousSnapshot.raw_headers
        : {}
  };
}

async function refreshCodexUsageSnapshotInStore(store, accountRef, oauthConfig, options = {}) {
  if (!store || !Array.isArray(store.accounts)) {
    return {
      ok: false,
      skipped: "invalid_store",
      error: "Account store is unavailable."
    };
  }

  const includeDisabled = options.includeDisabled === true;
  const target = findCodexPoolAccountByRef(store.accounts, accountRef);
  if (!target) {
    return {
      ok: false,
      skipped: "not_found",
      error: `Account not found: ${accountRef}`
    };
  }

  const entryId = getCodexPoolEntryId(target);
  const accountId = target.account_id || null;
  if (!includeDisabled && target.enabled === false) {
    return {
      ok: false,
      skipped: "disabled",
      entryId,
      accountId,
      error: "Account is disabled."
    };
  }

  try {
    const snapshot = await fetchCodexUsageSnapshotForAccount(target, oauthConfig);
    const applied = applyCodexUsageSnapshotToStore(store, entryId || accountId, snapshot);
    if (applied) {
      target.last_error = "";
    }
    return {
      ok: true,
      entryId,
      accountId,
      snapshot,
      applied,
      planType: String(snapshot?.plan_type || "").trim().toLowerCase() || null,
      usageUpdatedAt: Number(snapshot?.fetched_at || 0) || Math.floor(Date.now() / 1000)
    };
  } catch (err) {
    const message = String(err?.message || err || "usage_probe_failed");
    target.last_error = message;
    return {
      ok: false,
      entryId,
      accountId,
      error: message
    };
  }
}

async function maybeCaptureCodexUsageFromHeaders(authContext, headers, source = "response") {
  if (config.authMode !== "codex-oauth") return;
  const tokenPrincipalId =
    typeof authContext?.principalId === "string" && authContext.principalId.trim().length > 0
      ? authContext.principalId.trim()
      : null;
  const tokenAccountId =
    typeof authContext?.accountId === "string" && authContext.accountId.trim().length > 0
      ? authContext.accountId.trim()
      : null;
  const poolEntryId =
    typeof authContext?.poolEntryId === "string" && authContext.poolEntryId.trim().length > 0
      ? authContext.poolEntryId.trim()
      : null;
  const poolAccountId =
    typeof authContext?.poolAccountId === "string" && authContext.poolAccountId.trim().length > 0
      ? authContext.poolAccountId.trim()
      : null;
  if (!tokenPrincipalId && !tokenAccountId && !poolEntryId && !poolAccountId) return;
  const snapshot = extractCodexUsageSnapshotFromHeaders(headers, source);
  if (!snapshot) return;

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;

  const candidateIds = [];
  if (poolEntryId) candidateIds.push(poolEntryId);
  if (tokenPrincipalId && !candidateIds.includes(tokenPrincipalId)) candidateIds.push(tokenPrincipalId);
  if (tokenAccountId) candidateIds.push(tokenAccountId);
  if (poolAccountId && poolAccountId !== tokenAccountId) candidateIds.push(poolAccountId);

  let changed = false;
  for (const candidate of candidateIds) {
    if (applyCodexUsageSnapshotToStore(codexOAuthStore, candidate, snapshot)) {
      changed = true;
      break;
    }
  }

  if (!changed) return;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

async function fetchCodexUsageSnapshotForAccount(account, oauthConfig) {
  if (!account || !account.token?.access_token) {
    throw new Error("Missing access token.");
  }

  let accountIdFromToken = extractOpenAICodexAccountId(account.token.access_token || "") || account.account_id;
  let entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token) || getCodexPoolEntryId(account);

  if (isExpiredOrNearExpirySec(account.token.expires_at)) {
    if (!account.token.refresh_token) {
      throw new Error("Access token expired and no refresh token available.");
    }
    const refreshed = await refreshAccessToken(account.token.refresh_token, oauthConfig);
    account.token = normalizeToken(refreshed, account.token);
    accountIdFromToken = extractOpenAICodexAccountId(account.token.access_token || "") || accountIdFromToken;
    entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token) || entryIdFromToken;
  }
  if (!accountIdFromToken) {
    throw new Error("Could not resolve chatgpt account id from OAuth token.");
  }
  if (!entryIdFromToken) {
    throw new Error("Could not resolve principal identity from OAuth token.");
  }
  account.identity_id = entryIdFromToken;
  account.account_id = accountIdFromToken;

  const url = `${getCodexUsageProbeBaseUrl().replace(/\/+$/, "")}/codex/responses`;
  const body = {
    model: config.codex.defaultModel,
    stream: true,
    store: false,
    instructions: "Return one character.",
    reasoning: {
      effort: resolveReasoningEffort(
        undefined,
        {
          input: [{ role: "user", content: [{ type: "input_text", text: "." }] }],
          instructions: "Return one character."
        },
        config.codex.defaultModel
      )
    },
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "." }]
      }
    ]
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token.access_token}`,
      "chatgpt-account-id": accountIdFromToken,
      "openai-beta": "responses=experimental",
      originator: getCodexOriginator(),
      accept: "text/event-stream",
      "content-type": "application/json",
      "user-agent": "codex-pro-max-usage-probe"
    },
    body: JSON.stringify(body)
  });

  const snapshot = extractCodexUsageSnapshotFromHeaders(response.headers, "probe");
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const fallback = extractCodexUsageSnapshotFromLimitError(raw, account?.usage_snapshot || null, "probe_error");
    if (fallback) {
      return fallback;
    }
    throw new Error(`HTTP ${response.status}: ${truncate(raw, 180)}`);
  }
  if (response.body) {
    response.body.cancel().catch(() => {});
  }
  if (!snapshot) {
    throw new Error("Usage headers missing in upstream response.");
  }
  return snapshot;
}

function getCodexPreheatAccountHistory(entryId) {
  const key = String(entryId || "").trim();
  if (!key) return null;
  if (!codexPreheatHistory.accounts || typeof codexPreheatHistory.accounts !== "object") {
    codexPreheatHistory.accounts = {};
  }
  if (!codexPreheatHistory.accounts[key] || typeof codexPreheatHistory.accounts[key] !== "object") {
    codexPreheatHistory.accounts[key] = {
      run_count: 0,
      success_count: 0,
      failure_count: 0,
      last_run_at: 0,
      last_success_at: 0,
      last_failure_at: 0,
      next_eligible_at: 0,
      last_error: ""
    };
  }
  return codexPreheatHistory.accounts[key];
}

function getCodexPreheatState() {
  return {
    running: codexPreheatRuntime.running,
    cooldownSeconds: config.codexPreheat.cooldownSeconds,
    batchSize: config.codexPreheat.batchSize,
    minPrimaryRemaining: config.codexPreheat.minPrimaryRemaining,
    minSecondaryRemaining: config.codexPreheat.minSecondaryRemaining,
    lastRunAt: codexPreheatRuntime.lastRunAt,
    lastCompletedAt: codexPreheatRuntime.lastCompletedAt,
    lastReason: codexPreheatRuntime.lastReason,
    lastStatus: codexPreheatRuntime.lastStatus,
    lastError: codexPreheatRuntime.lastError,
    lastDurationMs: codexPreheatRuntime.lastDurationMs,
    lastSummary: codexPreheatRuntime.lastSummary
  };
}

function shouldSkipCodexPreheatAccount(account, nowSec, force = false) {
  if (!account || account.enabled === false) return "disabled";
  if (!account.token?.access_token) return "missing_token";
  if (!force && Number(account.cooldown_until || 0) > nowSec) return "account_cooldown";

  const entryId = getCodexPoolEntryId(account);
  const history = getCodexPreheatAccountHistory(entryId);
  if (!history) return "missing_identity";
  if (!force && Number(history.next_eligible_at || 0) > nowSec) return "preheat_cooldown";

  const usage = getCodexUsageWindowStats(account);
  if (
    Number.isFinite(usage.primaryRemaining) &&
    usage.primaryRemaining < Number(config.codexPreheat.minPrimaryRemaining || 0)
  ) {
    return "low_primary_remaining";
  }
  if (
    Number.isFinite(usage.secondaryRemaining) &&
    usage.secondaryRemaining < Number(config.codexPreheat.minSecondaryRemaining || 0)
  ) {
    return "low_secondary_remaining";
  }
  return "";
}

function pickCodexPreheatCandidates(store, options = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const force = options.force === true;
  const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
  const enabled = accounts.filter((x) => x && x.enabled !== false);
  const decorated = enabled
    .map((account) => {
      const entryId = getCodexPoolEntryId(account);
      const usage = getCodexUsageWindowStats(account);
      const health = classifyCodexPoolHealth(account, nowSec, usage);
      const score = decorateCodexPoolAccount(account, store.active_account_id || "", nowSec).healthScore;
      const skipReason = shouldSkipCodexPreheatAccount(account, nowSec, force);
      return {
        account,
        entryId,
        usage,
        health,
        score,
        skipReason
      };
    })
    .sort((a, b) => {
      if (a.skipReason && !b.skipReason) return 1;
      if (!a.skipReason && b.skipReason) return -1;
      if (b.score !== a.score) return b.score - a.score;
      const aUsed = Number(a.account?.last_used_at || 0);
      const bUsed = Number(b.account?.last_used_at || 0);
      if (aUsed !== bUsed) return aUsed - bUsed;
      return String(a.entryId || "").localeCompare(String(b.entryId || ""));
    });
  return decorated;
}

async function runCodexPreheat(reason = "manual", options = {}) {
  if (config.authMode !== "codex-oauth") {
    throw new Error("Preheat is only available in AUTH_MODE=codex-oauth.");
  }
  if (!isCodexMultiAccountEnabled()) {
    throw new Error("Preheat requires multi-account mode to be enabled.");
  }
  if (codexPreheatRuntime.running) {
    return {
      ok: true,
      busy: true,
      message: "Preheat is already running.",
      summary: codexPreheatRuntime.lastSummary
    };
  }

  const force = options.force === true;
  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1000);
  codexPreheatRuntime.running = true;
  codexPreheatRuntime.lastRunAt = nowSec;
  codexPreheatRuntime.lastReason = String(reason || "manual");
  codexPreheatRuntime.lastStatus = "running";
  codexPreheatRuntime.lastError = "";

  let saveStore = false;
  let saveHistory = false;
  try {
    const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
    codexOAuthStore = normalized.store;
    saveStore = saveStore || normalized.changed;

    const candidates = pickCodexPreheatCandidates(codexOAuthStore, { force });
    const targetCount = Math.max(1, Number(options.batchSize || config.codexPreheat.batchSize || 1));
    const selected = candidates.filter((x) => !x.skipReason).slice(0, targetCount);
    const skipped = candidates
      .filter((x) => x.skipReason)
      .slice(0, 20)
      .map((x) => ({
        entryId: x.entryId,
        accountId: x.account.account_id || null,
        reason: x.skipReason
      }));
    const results = [];

    for (let i = 0; i < selected.length; i += 1) {
      const { account, entryId } = selected[i];
      const accountId = String(account.account_id || "");
      const history = getCodexPreheatAccountHistory(entryId);
      if (!history) continue;
      history.run_count = Number(history.run_count || 0) + 1;
      history.last_run_at = nowSec;
      saveHistory = true;

      try {
        const snapshot = await fetchCodexUsageSnapshotForAccount(account, config.codexOAuth);
        const applied = applyCodexUsageSnapshotToStore(codexOAuthStore, entryId || accountId, snapshot);
        if (applied) saveStore = true;
        account.last_error = "";
        account.failure_count = 0;
        account.cooldown_until = 0;
        history.success_count = Number(history.success_count || 0) + 1;
        history.last_success_at = nowSec;
        history.last_error = "";
        history.next_eligible_at = nowSec + Number(config.codexPreheat.cooldownSeconds || 0);
        results.push({
          entryId,
          accountId,
          ok: true,
          primaryRemaining: readUsageRemainingPercent(snapshot?.primary),
          secondaryRemaining: readUsageRemainingPercent(snapshot?.secondary)
        });
        saveStore = true;
      } catch (err) {
        const message = String(err?.message || err || "preheat_failed");
        account.last_error = `preheat: ${message}`;
        account.failure_count = Number(account.failure_count || 0) + 1;
        account.cooldown_until = Math.max(
          Number(account.cooldown_until || 0),
          nowSec + Math.min(900, Math.max(30, Number(config.codexPreheat.cooldownSeconds || 1200) / 2))
        );
        history.failure_count = Number(history.failure_count || 0) + 1;
        history.last_failure_at = nowSec;
        history.last_error = message;
        history.next_eligible_at = nowSec + Math.min(1800, Math.max(60, Number(config.codexPreheat.cooldownSeconds || 1200)));
        results.push({
          entryId,
          accountId,
          ok: false,
          error: message
        });
        saveStore = true;
        saveHistory = true;
      }

      if (i < selected.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    if (saveStore) {
      const normalizedAfterPreheat = ensureCodexOAuthStoreShape(codexOAuthStore);
      codexOAuthStore = normalizedAfterPreheat.store;
      await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
      clearAuthContextCache();
    }
    if (saveHistory) {
      await saveJsonStore(config.codexPreheat.historyPath, codexPreheatHistory);
    }

    const completedAt = Date.now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const successCount = results.filter((x) => x.ok).length;
    const failureCount = results.length - successCount;
    const status = results.length === 0 ? "skipped" : failureCount > 0 ? "partial" : "ok";
    const summary = {
      ok: true,
      reason: String(reason || "manual"),
      status,
      startedAt: nowSec,
      completedAt: Math.floor(completedAt / 1000),
      durationMs,
      totalCandidates: candidates.length,
      selected: selected.length,
      success: successCount,
      failed: failureCount,
      skipped,
      results
    };

    codexPreheatRuntime.lastCompletedAt = Math.floor(completedAt / 1000);
    codexPreheatRuntime.lastDurationMs = durationMs;
    codexPreheatRuntime.lastSummary = summary;
    codexPreheatRuntime.lastStatus = status;
    codexPreheatRuntime.lastError = "";
    return summary;
  } catch (err) {
    const completedAt = Date.now();
    const message = String(err?.message || err || "preheat_failed");
    codexPreheatRuntime.lastCompletedAt = Math.floor(completedAt / 1000);
    codexPreheatRuntime.lastDurationMs = Math.max(0, completedAt - startedAt);
    codexPreheatRuntime.lastStatus = "failed";
    codexPreheatRuntime.lastError = message;
    codexPreheatRuntime.lastSummary = {
      ok: false,
      reason: String(reason || "manual"),
      status: "failed",
      startedAt: nowSec,
      completedAt: Math.floor(completedAt / 1000),
      durationMs: codexPreheatRuntime.lastDurationMs,
      error: message
    };
    throw err;
  } finally {
    codexPreheatRuntime.running = false;
  }
}

function isExpiredOrNearExpirySec(expiresAtSec) {
  if (!Number.isFinite(expiresAtSec)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAtSec - nowSec < 60;
}

async function getValidAuthContextFromCodexOAuthStore(store, oauthConfig, options = {}) {
  const normalized = ensureCodexOAuthStoreShape(store);
  if (normalized.changed) {
    Object.assign(store, normalized.store);
    await saveTokenStore(oauthConfig.tokenStorePath, store);
  } else {
    Object.assign(store, normalized.store);
  }

  if (!isCodexMultiAccountEnabled()) {
    const context = await getValidAuthContextFromOAuthStore(store, oauthConfig);
    const upsert = upsertCodexOAuthAccount(store, store.token, {
      label: context.principalId || context.accountId || ""
    });
    await saveTokenStore(oauthConfig.tokenStorePath, store);
    return {
      ...context,
      poolAccountId: upsert.entryId,
      poolEntryId: upsert.entryId
    };
  }

  const preferredPoolEntryId =
    typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";
  const candidates = pickCodexAccountCandidates(store, { preferredPoolEntryId });
  if (candidates.length === 0) {
    throw new Error("No enabled OAuth accounts available in account pool.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const errors = [];
  for (const account of candidates) {
    try {
      if (!account.token?.access_token) {
        throw new Error("Missing access token.");
      }

      if (isExpiredOrNearExpirySec(account.token.expires_at)) {
        if (!account.token.refresh_token) {
          throw new Error("Access token expired and no refresh token available.");
        }
        const refreshed = await refreshAccessToken(account.token.refresh_token, oauthConfig);
        account.token = normalizeToken(refreshed, account.token);
      }

      const accountIdFromToken =
        extractOpenAICodexAccountId(account.token.access_token) || account.account_id;
      const entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token);
      const principalIdFromToken =
        extractOpenAICodexPrincipalId(account.token.access_token) || entryIdFromToken;
      account.identity_id = entryIdFromToken;
      account.account_id = accountIdFromToken;
      account.enabled = true;
      account.last_used_at = nowSec;
      account.failure_count = 0;
      account.cooldown_until = 0;
      account.last_error = "";
      store.token = account.token;
      store.active_account_id = entryIdFromToken;
      store.rotation = store.rotation || { next_index: 0 };
      if (candidates.length > 1 && config.codexOAuth.multiAccountStrategy === "round-robin") {
        const enabled = getCodexEnabledAccounts(store);
        const idx = enabled.findIndex((x) => getCodexPoolEntryId(x) === entryIdFromToken);
        store.rotation.next_index = idx >= 0 ? (idx + 1) % enabled.length : 0;
      }
      await saveTokenStore(oauthConfig.tokenStorePath, store);
      return {
        accessToken: account.token.access_token,
        accountId: accountIdFromToken,
        principalId: principalIdFromToken,
        poolAccountId: entryIdFromToken,
        poolEntryId: entryIdFromToken
      };
    } catch (err) {
      account.failure_count = Number(account.failure_count || 0) + 1;
      account.last_error = String(err.message || err);
      const cooldownSeconds = Math.min(120, 10 * account.failure_count);
      account.cooldown_until = nowSec + cooldownSeconds;
      errors.push(`${getCodexPoolEntryId(account) || account.account_id}: ${account.last_error}`);
    }
  }

  await saveTokenStore(oauthConfig.tokenStorePath, store);
  throw new Error(`All pooled OAuth accounts failed. ${errors.join(" | ")}`);
}

async function getValidAuthContextFromOAuthStore(store, oauthConfig) {
  if (!store.token?.access_token) {
    throw new Error("No token in store. Login required.");
  }

  if (!isExpiredOrNearExpirySec(store.token.expires_at)) {
    return {
      accessToken: store.token.access_token,
      accountId: extractOpenAICodexAccountId(store.token.access_token) || null,
      principalId: extractOpenAICodexPrincipalId(store.token.access_token) || null
    };
  }

  if (!store.token.refresh_token) {
    throw new Error("Access token expired and no refresh token available.");
  }

  const refreshed = await refreshAccessToken(store.token.refresh_token, oauthConfig);
  store.token = normalizeToken(refreshed, store.token);
  await saveTokenStore(oauthConfig.tokenStorePath, store);
  return {
    accessToken: store.token.access_token,
    accountId: extractOpenAICodexAccountId(store.token.access_token) || null,
    principalId: extractOpenAICodexPrincipalId(store.token.access_token) || null
  };
}

async function exchangeCodeForToken(code, codeVerifier, oauthConfig) {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", oauthConfig.redirectUri);
  form.set("client_id", oauthConfig.clientId);
  form.set("code_verifier", codeVerifier);
  if (oauthConfig.clientSecret) {
    form.set("client_secret", oauthConfig.clientSecret);
  }

  const resp = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }
  return JSON.parse(text);
}

async function refreshAccessToken(refreshToken, oauthConfig) {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", oauthConfig.clientId);
  if (oauthConfig.clientSecret) {
    form.set("client_secret", oauthConfig.clientSecret);
  }

  const resp = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Refresh failed: HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }
  return JSON.parse(text);
}

function parseJsonBody(req) {
  if (!req.rawBody || req.rawBody.length === 0) return {};
  try {
    return JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    throw new Error("Body must be valid JSON.");
  }
}

function getModeDefaultModel(mode) {
  if (mode === "gemini-v1beta") return config.gemini.defaultModel;
  if (mode === "anthropic-v1") return config.anthropic.defaultModel;
  return config.codex.defaultModel;
}

function wildcardMatch(pattern, text) {
  const parts = String(pattern || "").split("*");
  if (parts.length === 1) return pattern === text;
  let textPos = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (i === 0) {
      if (!text.slice(textPos).startsWith(part)) return false;
      textPos += part.length;
      continue;
    }
    if (i === parts.length - 1) {
      return text.slice(textPos).endsWith(part);
    }
    const nextPos = text.slice(textPos).indexOf(part);
    if (nextPos < 0) return false;
    textPos += nextPos + part.length;
  }
  return true;
}

function resolveSystemModelRoute(originalModel, targetMode) {
  const model = typeof originalModel === "string" && originalModel.trim().length > 0
    ? originalModel.trim()
    : getModeDefaultModel(targetMode);
  const lower = model.toLowerCase();

  if (targetMode === "gemini-v1beta") {
    if (lower.startsWith("gemini-")) return model;
    if (lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("claude-")) {
      return config.gemini.defaultModel;
    }
    return model;
  }

  if (targetMode === "anthropic-v1") {
    if (lower.startsWith("claude-")) return model;
    if (lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("gemini-")) {
      return config.anthropic.defaultModel;
    }
    return model;
  }

  if (lower.startsWith("gpt-") || lower.includes("codex")) return model;
  return config.codex.defaultModel;
}

function resolveModelRoute(originalModel, targetMode = config.upstreamMode) {
  const requestedModel = typeof originalModel === "string" && originalModel.trim().length > 0
    ? originalModel.trim()
    : getModeDefaultModel(targetMode);

  if (!config.modelRouter.enabled) {
    return {
      requestedModel,
      mappedModel: requestedModel,
      routeType: "disabled",
      routeRule: null
    };
  }

  const customMappings = config.modelRouter.customMappings || {};
  if (customMappings[requestedModel]) {
    return {
      requestedModel,
      mappedModel: customMappings[requestedModel],
      routeType: "exact",
      routeRule: requestedModel
    };
  }

  let bestWildcard = null;
  for (const [pattern, target] of Object.entries(customMappings)) {
    if (!pattern.includes("*")) continue;
    if (!wildcardMatch(pattern, requestedModel)) continue;
    const specificity = pattern.length - (pattern.match(/\*/g)?.length || 0);
    if (!bestWildcard || specificity > bestWildcard.specificity) {
      bestWildcard = {
        pattern,
        target,
        specificity
      };
    }
  }

  if (bestWildcard) {
    return {
      requestedModel,
      mappedModel: bestWildcard.target,
      routeType: "wildcard",
      routeRule: bestWildcard.pattern
    };
  }

  const fallbackModel = resolveSystemModelRoute(requestedModel, targetMode);
  return {
    requestedModel,
    mappedModel: fallbackModel,
    routeType: fallbackModel === requestedModel ? "passthrough" : "system",
    routeRule: fallbackModel === requestedModel ? null : targetMode
  };
}

function detectModelFamily(modelId) {
  const value = String(modelId || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("gemini-")) return "gemini-v1beta";
  if (
    value.startsWith("claude-") ||
    value.includes("claude") ||
    value.includes("opus") ||
    value.includes("sonnet") ||
    value.includes("haiku")
  ) {
    return "anthropic-v1";
  }
  if (value.startsWith("gpt-") || value.includes("codex") || /^o\d/.test(value)) {
    return "codex-chatgpt";
  }
  return "";
}

function resolveCustomModelRouteOnly(originalModel) {
  const requestedModel =
    typeof originalModel === "string" && originalModel.trim().length > 0
      ? originalModel.trim()
      : "";
  if (!requestedModel || !config.modelRouter.enabled) return null;

  const customMappings = config.modelRouter.customMappings || {};
  if (customMappings[requestedModel]) {
    return {
      requestedModel,
      mappedModel: customMappings[requestedModel],
      routeType: "exact",
      routeRule: requestedModel
    };
  }

  let bestWildcard = null;
  for (const [pattern, target] of Object.entries(customMappings)) {
    if (!pattern.includes("*")) continue;
    if (!wildcardMatch(pattern, requestedModel)) continue;
    const specificity = pattern.length - (pattern.match(/\*/g)?.length || 0);
    if (!bestWildcard || specificity > bestWildcard.specificity) {
      bestWildcard = {
        pattern,
        target,
        specificity
      };
    }
  }

  if (!bestWildcard) return null;
  return {
    requestedModel,
    mappedModel: bestWildcard.target,
    routeType: "wildcard",
    routeRule: bestWildcard.pattern
  };
}

function resolveCodexCompatibleRoute(originalModel) {
  const route = resolveModelRoute(originalModel, "codex-chatgpt");
  const family = detectModelFamily(route.mappedModel);
  if (!family || family === "codex-chatgpt") return route;

  const fallbackModel = resolveSystemModelRoute(route.requestedModel, "codex-chatgpt");
  return {
    requestedModel: route.requestedModel,
    mappedModel: fallbackModel,
    routeType: "system",
    routeRule: "codex-chatgpt"
  };
}

function extractRequestedModelFromOpenAICompatBody(rawBody, fallbackModel = config.codex.defaultModel) {
  if (!rawBody || rawBody.length === 0) return fallbackModel;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
      if (model.length > 0) return model;
    }
  } catch {
    return fallbackModel;
  }
  return fallbackModel;
}

function chooseProtocolForV1ChatCompletions(req) {
  const requestedModel = extractRequestedModelFromOpenAICompatBody(req.rawBody, getModeDefaultModel(config.upstreamMode));
  const customRoute = resolveCustomModelRouteOnly(requestedModel);
  if (customRoute) {
    const customFamily = detectModelFamily(customRoute.mappedModel);
    if (customFamily) {
      return customFamily;
    }
  }

  if (config.upstreamMode === "codex-chatgpt") {
    const requestFamily = detectModelFamily(requestedModel);
    if (requestFamily === "gemini-v1beta" || requestFamily === "anthropic-v1") {
      return requestFamily;
    }
  }

  return config.upstreamMode;
}

function isGeminiNativeAliasPath(pathname) {
  return /^\/v1\/models\/[^/:]+:(generateContent|streamGenerateContent|countTokens)$/.test(
    String(pathname || "")
  );
}

function uniqueNonEmptyModelIds(values) {
  return [...new Set((values || []).filter((x) => typeof x === "string" && x.trim().length > 0))];
}

function getOpenAICompatibleModelIds() {
  const ids = [
    config.codex.defaultModel,
    config.gemini.defaultModel,
    config.anthropic.defaultModel,
    ...OFFICIAL_OPENAI_MODELS,
    ...OFFICIAL_GEMINI_MODELS,
    ...OFFICIAL_ANTHROPIC_MODELS
  ];
  for (const [sourceModel, targetModel] of Object.entries(config.modelRouter.customMappings || {})) {
    ids.push(sourceModel, targetModel);
  }
  return uniqueNonEmptyModelIds(ids);
}

function getModelCandidateIds() {
  const ids = [
    config.codex.defaultModel,
    config.gemini.defaultModel,
    config.anthropic.defaultModel,
    ...OFFICIAL_OPENAI_MODELS,
    ...OFFICIAL_GEMINI_MODELS,
    ...OFFICIAL_ANTHROPIC_MODELS
  ];
  ids.push(...getOpenAICompatibleModelIds());
  for (const [sourceModel, targetModel] of Object.entries(config.modelRouter.customMappings || {})) {
    ids.push(sourceModel, targetModel);
  }
  return uniqueNonEmptyModelIds(ids).sort();
}

const officialModelCache = {
  expiresAt: 0,
  ids: []
};

async function withTimeout(promise, timeoutMs, errorMessage) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchCodexOfficialModels() {
  let auth = null;
  try {
    auth = await getValidAuthContext();
  } catch {
    return [];
  }
  if (!auth?.accessToken || !auth?.accountId) return [];

  const url = new URL(`${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/models`);
  url.searchParams.set("client_version", DEFAULT_CODEX_CLIENT_VERSION);

  const resp = await withTimeout(
    fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        "openai-beta": "responses=experimental",
        originator: getCodexOriginator(),
        accept: "application/json",
        "user-agent": "codex-pro-max-model-catalog"
      }
    }),
    5000,
    "Codex model catalog request timed out."
  );
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => null);
  const models = Array.isArray(json?.models) ? json.models : [];
  return uniqueNonEmptyModelIds(models.map((m) => (typeof m?.slug === "string" ? m.slug : "")));
}

async function fetchGeminiOfficialModels() {
  const apiKey = String(config.gemini.apiKey || "").trim();
  if (!apiKey) return [];

  const url = new URL(`${config.gemini.baseUrl.replace(/\/+$/, "")}/models`);
  url.searchParams.set("key", apiKey);
  const resp = await withTimeout(fetch(url.toString(), { method: "GET" }), 5000, "Gemini model catalog request timed out.");
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => null);
  const models = Array.isArray(json?.models) ? json.models : [];
  return uniqueNonEmptyModelIds(
    models.map((m) => {
      const raw = typeof m?.name === "string" ? m.name : "";
      return raw.startsWith("models/") ? raw.slice(7) : raw;
    })
  );
}

async function fetchAnthropicOfficialModels() {
  const apiKey = String(config.anthropic.apiKey || "").trim();
  if (!apiKey) return [];

  const url = `${config.anthropic.baseUrl.replace(/\/+$/, "")}/models`;
  const resp = await withTimeout(
    fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": config.anthropic.version
      }
    }),
    5000,
    "Anthropic model catalog request timed out."
  );
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => null);
  const models = Array.isArray(json?.data) ? json.data : [];
  return uniqueNonEmptyModelIds(models.map((m) => (typeof m?.id === "string" ? m.id : "")));
}

async function getOfficialModelCandidateIds({ forceRefresh = false } = {}) {
  if (!forceRefresh && officialModelCache.expiresAt > Date.now() && officialModelCache.ids.length > 0) {
    return officialModelCache.ids;
  }

  const [codexIds, geminiIds, anthropicIds] = await Promise.all([
    fetchCodexOfficialModels().catch(() => []),
    fetchGeminiOfficialModels().catch(() => []),
    fetchAnthropicOfficialModels().catch(() => [])
  ]);

  const merged = uniqueNonEmptyModelIds([
    ...OFFICIAL_OPENAI_MODELS,
    ...OFFICIAL_GEMINI_MODELS,
    ...OFFICIAL_ANTHROPIC_MODELS,
    ...codexIds,
    ...geminiIds,
    ...anthropicIds,
    ...getModelCandidateIds()
  ]).sort();

  officialModelCache.ids = merged;
  officialModelCache.expiresAt = Date.now() + 5 * 60 * 1000;
  return merged;
}

function readHeaderValue(req, name) {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || "";
  return typeof raw === "string" ? raw : "";
}

function extractBearerToken(req) {
  const auth = readHeaderValue(req, "authorization");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "";
  return (match[1] || "").trim();
}

function sanitizeUpstreamApiKeyCandidate(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  const shared = String(config.codexOAuth.sharedApiKey || "").trim();
  if (shared && key === shared) return "";
  return key;
}

function isLikelyGeminiApiKey(value) {
  const key = String(value || "").trim();
  // Typical Google API key format.
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(key);
}

function isLikelyAnthropicApiKey(value) {
  const key = String(value || "").trim();
  // Typical Anthropic key format.
  return /^sk-ant-[0-9A-Za-z_-]{16,}$/i.test(key);
}

function extractGeminiRequestApiKeys(req) {
  if (!config.providerUpstream.allowRequestApiKeys) {
    return {
      headerKey: "",
      queryKey: ""
    };
  }
  const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
  return {
    headerKey: sanitizeUpstreamApiKeyCandidate(readHeaderValue(req, "x-goog-api-key")),
    queryKey: sanitizeUpstreamApiKeyCandidate(incoming.searchParams.get("key") || "")
  };
}

function shouldForceGeminiUpstream(req) {
  const forceHeader = String(readHeaderValue(req, "x-proxy-gemini-upstream") || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on", "force"].includes(forceHeader)) return true;
  const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
  const forceQuery = String(incoming.searchParams.get("proxy_gemini_upstream") || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "force"].includes(forceQuery);
}

function shouldPreferGeminiCompat(req) {
  // In codex-oauth mode, Gemini should default to local compatibility mode so
  // localhost/public proxy callers do not need a real Google API key.
  if (config.authMode !== "codex-oauth") return false;
  if (shouldForceGeminiUpstream(req)) return false;
  return true;
}

function shouldFallbackGeminiUpstreamToCompat(req, httpStatus) {
  return shouldPreferGeminiCompat(req) && [401, 403, 429].includes(Number(httpStatus || 0));
}

function resolveGeminiApiKey(req) {
  if (shouldPreferGeminiCompat(req)) return "";
  const configuredKey = sanitizeUpstreamApiKeyCandidate(config.gemini.apiKey || "");
  if (configuredKey && isLikelyGeminiApiKey(configuredKey)) return configuredKey;
  const { headerKey, queryKey } = extractGeminiRequestApiKeys(req);
  if (headerKey && isLikelyGeminiApiKey(headerKey)) return headerKey;
  if (queryKey && isLikelyGeminiApiKey(queryKey)) return queryKey;
  return "";
}

function resolveAnthropicApiKey(req) {
  const configuredKey = sanitizeUpstreamApiKeyCandidate(config.anthropic.apiKey || "");
  if (configuredKey && isLikelyAnthropicApiKey(configuredKey)) return configuredKey;
  if (!config.providerUpstream.allowRequestApiKeys) return "";
  const headerKey = sanitizeUpstreamApiKeyCandidate(readHeaderValue(req, "x-api-key"));
  if (headerKey && isLikelyAnthropicApiKey(headerKey)) return headerKey;
  return "";
}

function isAnthropicNativeRequest(req) {
  return (
    config.upstreamMode === "anthropic-v1" ||
    Boolean(readHeaderValue(req, "anthropic-version")) ||
    Boolean(readHeaderValue(req, "anthropic-beta")) ||
    (config.providerUpstream.allowRequestApiKeys && Boolean(readHeaderValue(req, "x-api-key")))
  );
}

async function handleAnthropicModelsList(req, res) {
  const nowIso = new Date().toISOString();
  const modelIds = getOpenAICompatibleModelIds();
  res.json({
    data: modelIds.map((id) => ({
        type: "model",
        id,
        display_name: id,
        created_at: nowIso
      })),
    first_id: modelIds[0] || config.anthropic.defaultModel,
    last_id: modelIds[modelIds.length - 1] || config.anthropic.defaultModel,
    has_more: false
  });
}

function mapHttpStatusToGeminiStatus(httpStatus) {
  const code = Number(httpStatus || 400);
  if (code === 401 || code === 403) return "UNAUTHENTICATED";
  if (code === 404) return "NOT_FOUND";
  if (code === 429) return "RESOURCE_EXHAUSTED";
  if (code >= 500) return "INTERNAL";
  return "INVALID_ARGUMENT";
}

function parseGeminiErrorMessage(rawText, fallbackMessage) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fallbackMessage;
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim().length > 0) {
      return parsed.error.message;
    }
    if (typeof parsed?.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
  } catch {
    // ignore and fallback
  }
  return fallbackMessage;
}

function mapHttpStatusToAnthropicErrorType(httpStatus) {
  const code = Number(httpStatus || 400);
  if (code === 401 || code === 403) return "authentication_error";
  if (code === 404) return "not_found_error";
  if (code === 429) return "rate_limit_error";
  if (code >= 500) return "api_error";
  return "invalid_request_error";
}

function resolveCompatErrorStatusCode(err, fallback = 502) {
  const explicit = Number(err?.statusCode);
  if (Number.isFinite(explicit) && explicit >= 100 && explicit <= 599) {
    return explicit;
  }
  const message = String(err?.message || "");
  if (/chatgpt_account_id|oauth token|access token|unauthorized|forbidden/i.test(message)) {
    return 401;
  }
  return fallback;
}

function parseAnthropicErrorMessage(rawText, fallbackMessage) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fallbackMessage;
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim().length > 0) {
      return parsed.error.message;
    }
    if (typeof parsed?.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
  } catch {
    // ignore and fallback
  }
  return fallbackMessage;
}

function sendAnthropicError(res, { httpStatus = 400, message, type }) {
  res.status(httpStatus).json({
    type: "error",
    error: {
      type: type || mapHttpStatusToAnthropicErrorType(httpStatus),
      message: String(message || "Anthropic request failed.")
    }
  });
}

function sendGeminiError(res, { httpStatus = 400, message, status }) {
  res.status(httpStatus).json({
    error: {
      code: Number(httpStatus || 400),
      message: String(message || "Gemini request failed."),
      status: status || mapHttpStatusToGeminiStatus(httpStatus)
    }
  });
}

async function handleGeminiNativeProxy(req, res) {
  res.locals.protocolType = "gemini-v1beta-native";
  const apiKey = resolveGeminiApiKey(req);
  if (!apiKey) {
    await geminiLocalCompatHelpers.handleGeminiNativeCompat(req, res);
    return;
  }

  const incoming = new URL(req.originalUrl, "http://localhost");
  const isOpenAICompatPath = incoming.pathname.startsWith("/v1beta/openai/");
  const mappedPath = mapGeminiNativePath(incoming.pathname, res);
  const target = new URL(`${mappedPath}${incoming.search}`, config.gemini.baseUrl);

  if (!isOpenAICompatPath && !target.searchParams.has("key")) {
    target.searchParams.set("key", apiKey);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (hopByHop.has(name) || name === "content-length" || name === "host") continue;
    if (typeof v === "string") headers.set(k, v);
  }

  if (isOpenAICompatPath) {
    headers.set("authorization", `Bearer ${apiKey}`);
  } else {
    headers.delete("authorization");
    headers.set("x-goog-api-key", apiKey);
  }

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.rawBody || Buffer.alloc(0);
    noteUpstreamRequestAudit(
      res,
      init.body,
      headers.get("content-type") || req.headers?.["content-type"] || ""
    );
  }

  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(target.toString(), init, res);
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendGeminiError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await geminiLocalCompatHelpers.handleGeminiNativeCompat(req, res);
      return;
    }
    sendGeminiError(res, {
      httpStatus: upstream.status,
      message: parseGeminiErrorMessage(
        raw,
        `Gemini upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeUpstreamBodyToResponse(upstream, res);
}

function mapGeminiNativePath(pathname, res) {
  const match = String(pathname || "").match(/^\/v1beta\/models\/([^/:]+)(:generateContent|:streamGenerateContent)?$/);
  if (!match) return pathname;
  const requestedModel = decodeURIComponent(match[1]);
  const route = resolveModelRoute(requestedModel, "gemini-v1beta");
  if (res && res.locals) res.locals.modelRoute = route;
  const mappedModel = encodeURIComponent(route.mappedModel);
  const suffix = match[2] || "";
  return `/v1beta/models/${mappedModel}${suffix}`;
}

async function handleAnthropicNativeProxy(req, res) {
  res.locals.protocolType = "anthropic-v1-native";
  const apiKey = resolveAnthropicApiKey(req);
  if (!apiKey) {
    await anthropicLocalCompatHelpers.handleAnthropicNativeCompat(req, res);
    return;
  }

  const target = new URL(req.originalUrl, config.anthropic.baseUrl);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (hopByHop.has(name) || name === "content-length" || name === "host") continue;
    if (typeof v === "string") headers.set(k, v);
  }

  headers.set("x-api-key", apiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", config.anthropic.version);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    let requestBody = req.rawBody || Buffer.alloc(0);
    const incoming = new URL(req.originalUrl, "http://localhost");
    if (
      anthropicLocalCompatHelpers.isAnthropicNativeMessagesPath(incoming.pathname) &&
      requestBody.length > 0 &&
      readHeaderValue(req, "content-type").toLowerCase().includes("application/json")
    ) {
      try {
        const parsed = JSON.parse(requestBody.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const route = resolveModelRoute(parsed.model || config.anthropic.defaultModel, "anthropic-v1");
          parsed.model = route.mappedModel;
          if (res && res.locals) res.locals.modelRoute = route;
          requestBody = Buffer.from(JSON.stringify(parsed), "utf8");
        }
      } catch {
        // keep original body when parse fails
      }
    }
    init.body = requestBody;
    noteUpstreamRequestAudit(
      res,
      requestBody,
      headers.get("content-type") || req.headers?.["content-type"] || ""
    );
  }

  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(target.toString(), init, res);
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendAnthropicError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      type: "api_error"
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    if (
      config.authMode === "codex-oauth" &&
      isCodexMultiAccountEnabled() &&
      (upstream.status === 401 || upstream.status === 403 || upstream.status === 429)
    ) {
      await anthropicLocalCompatHelpers.handleAnthropicNativeCompat(req, res);
      return;
    }
    sendAnthropicError(res, {
      httpStatus: upstream.status,
      message: parseAnthropicErrorMessage(
        raw,
        `Anthropic upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeUpstreamBodyToResponse(upstream, res);
}

async function handleGeminiProtocol(req, res) {
  res.locals.protocolType = "gemini-v1beta-openai-compat";
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname === "/v1/models" || incoming.pathname === "/v1/models/" || incoming.pathname.startsWith("/v1/models/")) {
    res.locals.protocolType = "gemini-v1beta-native";
    const aliasedOriginalUrl = req.originalUrl.replace(/^\/v1\/models/, "/v1beta/models");
    const previousOriginalUrl = req.originalUrl;
    req.originalUrl = aliasedOriginalUrl;
    try {
      await handleGeminiNativeProxy(req, res);
    } finally {
      req.originalUrl = previousOriginalUrl;
    }
    return;
  }

  if (incoming.pathname !== "/v1/chat/completions") {
    sendGeminiError(res, {
      httpStatus: 400,
      message:
        "In UPSTREAM_MODE=gemini-v1beta, supported endpoints are /v1/chat/completions and /v1/models/{model}:{generateContent|streamGenerateContent}.",
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  if (req.method !== "POST") {
    sendGeminiError(res, {
      httpStatus: 405,
      message: "Use POST /v1/chat/completions.",
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  const apiKey = resolveGeminiApiKey(req);
  if (!apiKey) {
    await geminiLocalCompatHelpers.handleGeminiOpenAICompatWithCodex(req, res);
    return;
  }

  let chatReq;
  try {
    chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.gemini.defaultModel);
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 400,
      message: err.message,
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const contents = conversation
    .map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.text || " " }]
    }))
    .filter((x) => x.parts[0].text.trim().length > 0);
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }

  const generationConfig = {};
  if (chatReq.temperature !== undefined) generationConfig.temperature = chatReq.temperature;
  if (chatReq.top_p !== undefined) generationConfig.topP = chatReq.top_p;
  if (chatReq.max_tokens !== undefined) generationConfig.maxOutputTokens = chatReq.max_tokens;
  if (Array.isArray(chatReq.stop) && chatReq.stop.length > 0) generationConfig.stopSequences = chatReq.stop;
  else if (typeof chatReq.stop === "string" && chatReq.stop.length > 0)
    generationConfig.stopSequences = [chatReq.stop];

  const body = { contents };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  const modelRoute = resolveModelRoute(chatReq.model || config.gemini.defaultModel, "gemini-v1beta");
  const requestedModel = modelRoute.requestedModel;
  const upstreamModel = modelRoute.mappedModel;
  res.locals.modelRoute = modelRoute;
  const url = `${config.gemini.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(upstreamModel)}:generateContent`;
  noteUpstreamRequestAudit(res, JSON.stringify(body), "application/json");
  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(
      url,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": String(apiKey)
      },
      body: JSON.stringify(body)
      },
      res
    );
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendGeminiError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  let raw;
  try {
    raw = await readUpstreamTextOrThrow(upstream);
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 502,
      message: err.message,
      status: "UNAVAILABLE"
    });
    return;
  }
  if (!upstream.ok) {
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await geminiLocalCompatHelpers.handleGeminiOpenAICompatWithCodex(req, res);
      return;
    }
    sendGeminiError(res, {
      httpStatus: upstream.status,
      message: parseGeminiErrorMessage(raw, `Gemini upstream request failed with HTTP ${upstream.status}.`)
    });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendGeminiError(res, {
      httpStatus: 502,
      message: "Gemini returned non-JSON response.",
      status: "INTERNAL"
    });
    return;
  }

  const candidate = Array.isArray(parsed.candidates) && parsed.candidates.length > 0 ? parsed.candidates[0] : null;
  const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = contentParts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("");

  const usage = {
    prompt_tokens: Number(parsed?.usageMetadata?.promptTokenCount || 0),
    completion_tokens: Number(parsed?.usageMetadata?.candidatesTokenCount || 0),
    total_tokens: Number(parsed?.usageMetadata?.totalTokenCount || 0)
  };
  const finishReason = mapGeminiFinishReasonToOpenAI(candidate?.finishReason);
  const completion = buildOpenAIChatCompletion({
    model: requestedModel,
    text,
    finishReason,
    usage
  });
  res.locals.tokenUsage = completion.usage;

  if (chatReq.stream === true) {
    sendOpenAICompletionAsSse(res, completion);
    return;
  }
  res.status(200).json(completion);
}

async function handleAnthropicProtocol(req, res) {
  res.locals.protocolType = "anthropic-v1-openai-compat";
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname !== "/v1/chat/completions") {
    sendAnthropicError(res, {
      httpStatus: 400,
      message: "In UPSTREAM_MODE=anthropic-v1, currently only /v1/chat/completions is supported.",
      type: "invalid_request_error"
    });
    return;
  }

  if (req.method !== "POST") {
    sendAnthropicError(res, {
      httpStatus: 405,
      message: "Use POST /v1/chat/completions.",
      type: "invalid_request_error"
    });
    return;
  }

  const apiKey = resolveAnthropicApiKey(req);
  if (!apiKey) {
    await anthropicOpenAICompatHelpers.handleAnthropicOpenAICompatWithCodex(req, res);
    return;
  }

  let chatReq;
  try {
    chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.anthropic.defaultModel);
  } catch (err) {
    sendAnthropicError(res, {
      httpStatus: 400,
      message: err.message,
      type: "invalid_request_error"
    });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const anthropicMessages = conversation
    .map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.text || " "
    }))
    .filter((msg) => msg.content.trim().length > 0);
  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: "user", content: " " });
  }

  const modelRoute = resolveModelRoute(chatReq.model || config.anthropic.defaultModel, "anthropic-v1");
  res.locals.modelRoute = modelRoute;
  const body = {
    model: modelRoute.mappedModel,
    max_tokens: Number(chatReq.max_tokens || 4096),
    messages: anthropicMessages,
    stream: false
  };
  if (systemText) body.system = systemText;
  if (chatReq.temperature !== undefined) body.temperature = chatReq.temperature;
  if (chatReq.top_p !== undefined) body.top_p = chatReq.top_p;
  if (Array.isArray(chatReq.stop) && chatReq.stop.length > 0) body.stop_sequences = chatReq.stop;
  else if (typeof chatReq.stop === "string" && chatReq.stop.length > 0) body.stop_sequences = [chatReq.stop];

  const url = `${config.anthropic.baseUrl.replace(/\/+$/, "")}/messages`;
  noteUpstreamRequestAudit(res, JSON.stringify(body), "application/json");
  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(
      url,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(apiKey),
        "anthropic-version": config.anthropic.version
      },
      body: JSON.stringify(body)
      },
      res
    );
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    res.status(502).json({
      error: "upstream_unreachable",
      message: details.message || err.message,
      code: details.code || details.name || null,
      detail: details.detail || null,
      retry_count: Number(res.locals?.upstreamRetryCount || 0)
    });
    return;
  }

  let raw;
  try {
    raw = await readUpstreamTextOrThrow(upstream);
  } catch (err) {
    sendAnthropicError(res, {
      httpStatus: 502,
      message: err.message,
      type: "api_error"
    });
    return;
  }
  if (!upstream.ok) {
    sendAnthropicError(res, {
      httpStatus: upstream.status,
      message: parseAnthropicErrorMessage(
        raw,
        `Anthropic upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendAnthropicError(res, {
      httpStatus: 502,
      message: "Anthropic returned non-JSON response.",
      type: "api_error"
    });
    return;
  }

  const text = Array.isArray(parsed?.content)
    ? parsed.content
        .filter((x) => x?.type === "text" && typeof x?.text === "string")
        .map((x) => x.text)
        .join("")
    : "";
  const usage = {
    prompt_tokens: Number(parsed?.usage?.input_tokens || 0),
    completion_tokens: Number(parsed?.usage?.output_tokens || 0),
    total_tokens: Number(parsed?.usage?.input_tokens || 0) + Number(parsed?.usage?.output_tokens || 0)
  };
  const finishReason = mapAnthropicStopReasonToOpenAI(parsed?.stop_reason);
  const completion = buildOpenAIChatCompletion({
    model: modelRoute.requestedModel,
    text,
    finishReason,
    usage
  });
  res.locals.tokenUsage = completion.usage;

  if (chatReq.stream === true) {
    sendOpenAICompletionAsSse(res, completion);
    return;
  }
  res.status(200).json(completion);
}

function parseOpenAIChatCompletionsLikeRequest(rawBody, defaultModel) {
  if (!rawBody || rawBody.length === 0) {
    throw new Error("/v1/chat/completions requires a JSON body.");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body for /v1/chat/completions.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON object body for /v1/chat/completions.");
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  return {
    model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : defaultModel,
    messages,
    stream: parsed.stream === true,
    max_tokens: parsed.max_tokens,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    stop: parsed.stop
  };
}

function splitSystemAndConversation(messages) {
  const systemParts = [];
  const conversation = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "user";
    const text = extractOpenAIMessageText(msg.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "assistant") {
      conversation.push({ role: "assistant", text: text || "" });
      continue;
    }

    if (role === "tool") {
      const toolLabel =
        typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 0 ? `tool:${msg.tool_call_id}` : "tool";
      conversation.push({ role: "user", text: `[${toolLabel}] ${text || ""}`.trim() });
      continue;
    }

    conversation.push({ role: "user", text: text || "" });
  }
  return {
    systemText: systemParts.join("\n\n"),
    conversation
  };
}

function extractOpenAIMessageText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const chunks = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.text === "string") {
      parts.push(chunk.text);
      continue;
    }
    if (typeof chunk.input_text === "string") {
      parts.push(chunk.input_text);
      continue;
    }
    if (typeof chunk.output_text === "string") {
      parts.push(chunk.output_text);
      continue;
    }
    if (chunk.type === "image_url" || chunk.type === "input_image") {
      parts.push("[image]");
    }
  }
  return parts.join("");
}

function buildOpenAIChatCompletion({ model, text, finishReason, usage }) {
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || ""
        },
        finish_reason: finishReason || "stop"
      }
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function sendOpenAICompletionAsSse(res, completion) {
  const model = completion.model;
  const id = completion.id;
  const created = completion.created;
  const content = completion?.choices?.[0]?.message?.content || "";
  const finishReason = completion?.choices?.[0]?.finish_reason || "stop";

  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");

  const writeChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeChunk({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null
      }
    ]
  });

  if (content) {
    writeChunk({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null
        }
      ]
    });
  }

  const finalChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason
      }
    ]
  };
  if (completion.usage) {
    finalChunk.usage = completion.usage;
  }
  writeChunk(finalChunk);
  res.write("data: [DONE]\n\n");
  res.end();
}

function mapGeminiFinishReasonToOpenAI(reason) {
  const value = String(reason || "").toUpperCase();
  if (value === "MAX_TOKENS") return "length";
  if (value === "STOP" || value === "FINISH_REASON_UNSPECIFIED") return "stop";
  if (value === "SAFETY" || value === "RECITATION" || value === "BLOCKLIST") return "content_filter";
  return "stop";
}

function mapAnthropicStopReasonToOpenAI(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "max_tokens") return "length";
  if (value === "stop_sequence" || value === "end_turn" || value === "tool_use") return "stop";
  return "stop";
}

function mapOpenAIFinishReasonToGemini(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "length") return "MAX_TOKENS";
  if (value === "content_filter") return "SAFETY";
  return "STOP";
}

function mapOpenAIFinishReasonToAnthropic(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "length") return "max_tokens";
  if (value === "tool_calls") return "tool_use";
  return "end_turn";
}

function isUnsupportedMaxOutputTokensError(statusCode, rawText) {
  if (Number(statusCode || 0) !== 400) return false;
  const text = String(rawText || "").toLowerCase();
  if (!text) return false;
  return text.includes("unsupported parameter") && text.includes("max_output_tokens");
}

function estimateOpenAIChatCompletionTokens(rawBody) {
  if (!rawBody || rawBody.length === 0) return 0;

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const { systemText, conversation } = splitSystemAndConversation(messages);
  const segments = [];
  if (systemText.trim().length > 0) segments.push(systemText);
  for (const item of conversation) {
    if (!item || typeof item !== "object") continue;
    segments.push(`${item.role || "user"}\n${String(item.text || "")}`.trim());
  }
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    segments.push(JSON.stringify(parsed.tools));
  }
  if (parsed.tool_choice !== undefined) {
    segments.push(JSON.stringify(parsed.tool_choice));
  }
  if (parsed.response_format && typeof parsed.response_format === "object") {
    segments.push(JSON.stringify(parsed.response_format));
  }
  if (parsed.metadata && typeof parsed.metadata === "object") {
    segments.push(JSON.stringify(parsed.metadata));
  }

  const fallbackSerialized = JSON.stringify(parsed);
  const combined = segments.filter((part) => typeof part === "string" && part.length > 0).join("\n\n");
  let inputTokens = estimateTokenCountFromText(combined || fallbackSerialized);

  if (messages.length > 0) inputTokens += messages.length * 6;
  if (systemText.trim().length > 0) inputTokens += 4;
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) inputTokens += parsed.tools.length * 20;

  return Math.max(1, Number(inputTokens || 0));
}

async function runDirectChatCompletionTest(prompt) {
  const modelRoute = resolveCodexCompatibleRoute(config.codex.defaultModel);
  const reasoningEffort = resolveReasoningEffort(undefined, {
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    instructions: config.codex.defaultInstructions
  }, modelRoute.mappedModel);
  if (config.upstreamMode === "codex-chatgpt") {
    return await runCodexDirectSelfTest(prompt, reasoningEffort);
  }
  if (config.upstreamMode === "gemini-v1beta") {
    return await runGeminiDirectSelfTest(prompt, reasoningEffort);
  }
  if (config.upstreamMode === "anthropic-v1") {
    return await runAnthropicDirectSelfTest(prompt, reasoningEffort);
  }
  throw new Error(`Unsupported upstream mode for self-test: ${config.upstreamMode}`);
}

async function runCodexDirectSelfTest(prompt, reasoningEffort) {
  const auth = await getValidAuthContext();
  if (!auth.accountId) {
    throw new Error("Cannot run test: missing chatgpt account id.");
  }

  const body = {
    model: config.codex.defaultModel,
    stream: true,
    store: false,
    instructions: config.codex.defaultInstructions,
    reasoning: {
      effort: reasoningEffort
    },
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }]
  };

  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "openai-beta": "responses=experimental",
      originator: getCodexOriginator(),
      accept: "text/event-stream",
      "content-type": "application/json",
      "user-agent": "codex-pro-max-admin-test"
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
  }
  const completed = extractCompletedResponseFromSse(raw);
  if (!completed) {
    throw new Error("Upstream test failed: could not parse response.completed event.");
  }
  return {
    model: completed.model || config.codex.defaultModel,
    status: completed.status || "completed",
    reasoningEffort,
    preview: truncate(extractAssistantTextFromResponse(completed), 240)
  };
}

async function runGeminiDirectSelfTest(prompt, reasoningEffort) {
  if (config.gemini.apiKey) {
    const model = config.gemini.defaultModel;
    const url = `${config.gemini.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": String(config.gemini.apiKey)
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Gemini test failed: invalid JSON response.");
    }
    const candidate = Array.isArray(parsed?.candidates) && parsed.candidates.length > 0 ? parsed.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const preview = truncate(
      parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join(""),
      240
    );
    return {
      model,
      status: "completed",
      reasoningEffort,
      preview
    };
  }

  const result = await runCodexConversationViaOAuth({
    model: config.gemini.defaultModel,
    systemText: config.codex.defaultInstructions,
    conversation: [{ role: "user", text: prompt }]
  });
  return {
    model: result.model || config.gemini.defaultModel,
    status: "completed",
    reasoningEffort,
    preview: truncate(result.text, 240)
  };
}

async function runAnthropicDirectSelfTest(prompt, reasoningEffort) {
  if (config.anthropic.apiKey) {
    const model = config.anthropic.defaultModel;
    const response = await fetch(`${config.anthropic.baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(config.anthropic.apiKey),
        "anthropic-version": config.anthropic.version
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
        stream: false
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Anthropic test failed: invalid JSON response.");
    }
    const preview = truncate(
      Array.isArray(parsed?.content)
        ? parsed.content
            .filter((x) => x?.type === "text" && typeof x?.text === "string")
            .map((x) => x.text)
            .join("")
        : "",
      240
    );
    return {
      model,
      status: "completed",
      reasoningEffort,
      preview
    };
  }

  const result = await runCodexConversationViaOAuth({
    model: config.anthropic.defaultModel,
    systemText: config.codex.defaultInstructions,
    conversation: [{ role: "user", text: prompt }]
  });
  return {
    model: result.model || config.anthropic.defaultModel,
    status: "completed",
    reasoningEffort,
    preview: truncate(result.text, 240)
  };
}

function getCodexOriginator() {
  if (config.authMode === "codex-oauth") return config.codexOAuth.originator;
  return "pi";
}

function parseReasoningEffortOrFallback(value, fallback, options = {}) {
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

function getSupportedReasoningEffortsForModel(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (!normalized) return null;

  const minor = getGpt5MinorVersionForReasoning(normalized);
  if (minor === null) return null;

  // Capability matrix based on OpenAI model docs:
  // - Base GPT-5.x (non-codex, non-pro): `none` starts from 5.1, `xhigh` starts from 5.2 (incl. 5.4).
  // - Codex family: generally low/medium/high, with xhigh available from newer codex generations.
  //   (and no `none`).
  // - Pro family: gpt-5-pro => high only; gpt-5.2+/5.4-pro => medium/high/xhigh.
  const isCodex = normalized.includes("-codex");
  const isPro = normalized.includes("-pro");
  const isGpt5Pro = normalized.startsWith("gpt-5-pro");
  const isGpt51CodexMax = normalized.startsWith("gpt-5.1-codex-max");

  if (isGpt5Pro) {
    return new Set(["high"]);
  }

  // gpt-5.2+/5.4 pro family
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

function clampReasoningEffortForModel(effort, modelId) {
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
  return "medium";
}

function resolveReasoningEffort(value, context = null, modelId = null) {
  const requested = parseReasoningEffortOrFallback(value, null, { allowAdaptive: true });
  let resolved = null;
  if (requested && requested !== "adaptive") {
    resolved = requested;
  }

  if (!resolved) {
    const configured = parseReasoningEffortOrFallback(config.codex.defaultReasoningEffort, "medium", {
      allowAdaptive: true
    });

    if (requested === "adaptive" || configured === "adaptive") {
      resolved = inferAdaptiveReasoningEffort(context);
    } else {
      resolved = configured;
    }
  }

  return clampReasoningEffortForModel(resolved, modelId);
}

function applyReasoningEffortDefaults(target, reasoningEffortFromRequest, context = null, modelId = null) {
  const hasReasoningObject = target.reasoning && typeof target.reasoning === "object" && !Array.isArray(target.reasoning);
  const existingEffort = hasReasoningObject ? target.reasoning.effort : null;
  const resolvedEffort = resolveReasoningEffort(existingEffort ?? reasoningEffortFromRequest, context, modelId);

  target.reasoning = hasReasoningObject ? { ...target.reasoning } : {};
  target.reasoning.effort = resolvedEffort;
}

function inferAdaptiveReasoningEffort(context) {
  const metrics = {
    textChars: 0,
    messageCount: 0,
    imageCount: 0,
    toolCallCount: 0,
    toolDefinitionCount: 0,
    complexityHints: 0
  };

  if (context && typeof context === "object") {
    if (typeof context.instructions === "string") {
      metrics.textChars += context.instructions.length;
    }
    if (Array.isArray(context.tools)) {
      metrics.toolDefinitionCount += context.tools.length;
    }
    if (Array.isArray(context.messages)) {
      analyzeChatMessagesForEffort(context.messages, metrics);
    }
    if (Array.isArray(context.input)) {
      analyzeResponsesInputForEffort(context.input, metrics);
    }
  }

  let score = 0;
  if (metrics.textChars > 900) score += 4;
  else if (metrics.textChars > 450) score += 3;
  else if (metrics.textChars > 180) score += 2;
  else if (metrics.textChars > 80) score += 1;

  if (metrics.messageCount >= 12) score += 2;
  else if (metrics.messageCount >= 5) score += 1;

  if (metrics.toolCallCount > 0) score += 2;
  if (metrics.toolDefinitionCount > 0) score += 1;
  if (metrics.imageCount > 0) score += 1;
  score += Math.min(metrics.complexityHints, 3);

  if (
    score === 0 &&
    metrics.textChars < 80 &&
    metrics.messageCount <= 2 &&
    metrics.toolCallCount === 0 &&
    metrics.toolDefinitionCount === 0 &&
    metrics.imageCount === 0
  ) {
    return "none";
  }
  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  if (score <= 7) return "high";
  return "xhigh";
}

function analyzeChatMessagesForEffort(messages, metrics) {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    metrics.messageCount += 1;
    if (Array.isArray(msg.tool_calls)) {
      metrics.toolCallCount += msg.tool_calls.length;
    }
    analyzeContentValueForEffort(msg.content, metrics);
  }
}

function analyzeResponsesInputForEffort(input, metrics) {
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.role) metrics.messageCount += 1;
    if (item.type === "function_call" || item.type === "function_call_output") {
      metrics.toolCallCount += 1;
      if (typeof item.arguments === "string") metrics.textChars += item.arguments.length;
      if (typeof item.output === "string") metrics.textChars += item.output.length;
    }
    analyzeContentValueForEffort(item.content, metrics);
  }
}

function analyzeContentValueForEffort(content, metrics) {
  if (typeof content === "string") {
    metrics.textChars += content.length;
    metrics.complexityHints += scoreTextComplexityHints(content);
    return;
  }
  if (!content || typeof content !== "object") return;

  const chunks = Array.isArray(content) ? content : [content];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const type = typeof chunk.type === "string" ? chunk.type : "";
    if (type === "image_url" || type === "input_image") {
      metrics.imageCount += 1;
    }
    if (typeof chunk.text === "string") {
      metrics.textChars += chunk.text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.text);
    }
    if (typeof chunk.input_text === "string") {
      metrics.textChars += chunk.input_text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.input_text);
    }
    if (typeof chunk.output_text === "string") {
      metrics.textChars += chunk.output_text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.output_text);
    }
    if (typeof chunk.refusal === "string") {
      metrics.textChars += chunk.refusal.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.refusal);
    }
  }
}

function scoreTextComplexityHints(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const punctuationCount =
    (text.match(/[,:;，、；：\n]/g)?.length || 0) + (text.includes("。") ? 1 : 0);
  const lowered = text.toLowerCase();
  const keywords = [
    "analysis",
    "analyze",
    "architecture",
    "design",
    "plan",
    "strategy",
    "risk",
    "deploy",
    "monitor",
    "security",
    "拆解",
    "分析",
    "架構",
    "計畫",
    "风險",
    "風險",
    "部署",
    "監控",
    "資安",
    "流程",
    "步驟"
  ];
  let keywordHits = 0;
  for (const kw of keywords) {
    if (lowered.includes(kw.toLowerCase())) keywordHits += 1;
  }

  let hint = 0;
  if (punctuationCount >= 6) hint += 1;
  if (keywordHits >= 2) hint += 1;
  if (keywordHits >= 5) hint += 1;
  return hint;
}

async function completeOAuthCallback({ code, state }) {
  const pending = pendingAuth.get(state);
  if (!pending) {
    throw new Error("Invalid OAuth callback: missing/expired state.");
  }
  pendingAuth.delete(state);

  const oauthRuntime = getActiveOAuthRuntime();
  if (!oauthRuntime) {
    throw new Error("OAuth runtime is unavailable in current auth mode.");
  }
  if (pending.mode !== config.authMode) {
    throw new Error(`OAuth state mode mismatch: expected ${pending.mode}, got ${config.authMode}.`);
  }

  const token = await exchangeCodeForToken(code, pending.verifier, oauthRuntime.oauth);
  const normalizedToken = normalizeToken(token, oauthRuntime.store.token);
  oauthRuntime.store.token = normalizedToken;

  let callbackSummary = {
    accountId: extractOpenAICodexAccountId(normalizedToken.access_token || "") || null,
    entryId: extractOpenAICodexPrincipalId(normalizedToken.access_token || "") || null,
    email: extractOpenAICodexEmail(normalizedToken.access_token || "") || null,
    slot: parseSlotValue(pending.slot),
    action: "updated"
  };

  if (config.authMode === "codex-oauth") {
    const shaped = ensureCodexOAuthStoreShape(oauthRuntime.store);
    Object.keys(oauthRuntime.store).forEach((key) => delete oauthRuntime.store[key]);
    Object.assign(oauthRuntime.store, shaped.store);
    let probe = null;
    let probedSnapshot = null;
    let detectedPlanType =
      normalizeOpenAICodexPlanType(callbackSummary?.planType) ||
      extractOpenAICodexPlanType(normalizedToken.access_token || "");

    try {
      probedSnapshot = await withTimeout(
        fetchCodexUsageSnapshotForAccount(
          {
            token: normalizeToken(normalizedToken, normalizedToken),
            account_id: callbackSummary.accountId || null,
            identity_id: callbackSummary.entryId || null,
            usage_snapshot: null
          },
          oauthRuntime.oauth
        ),
        12000,
        "Usage probe timed out."
      );
      detectedPlanType =
        normalizeOpenAICodexPlanType(probedSnapshot?.plan_type) || detectedPlanType;
      probe = {
        ok: true,
        planType: detectedPlanType,
        snapshot: probedSnapshot
      };
    } catch (err) {
      probe = {
        ok: false,
        error: String(err?.message || err || "usage_probe_failed")
      };
    }

    const upsert = upsertCodexOAuthAccount(oauthRuntime.store, normalizedToken, {
      label: pending.label || "",
      slot: pending.slot,
      force: pending.force,
      planType: detectedPlanType,
      usageSnapshot: probedSnapshot
    });
    callbackSummary = {
      accountId: upsert.accountId,
      entryId: upsert.entryId || callbackSummary.entryId,
      email: upsert.email || callbackSummary.email,
      slot: upsert.slot,
      action: upsert.action,
      planType: upsert.planType || detectedPlanType || null
    };

    if (probe?.ok) {
      callbackSummary.planType = probe.planType || callbackSummary.planType || null;
      callbackSummary.usageFetched = true;
    } else if (probe) {
      callbackSummary.usageFetched = false;
      callbackSummary.usageFetchError = probe.error || probe.skipped || "usage_probe_failed";
    }
  }

  await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
  clearAuthContextCache();
  return callbackSummary;
}

async function ensureCodexOAuthCallbackServer() {
  if (config.authMode !== "codex-oauth") return;
  if (codexCallbackServer && codexCallbackServer.listening) return;
  if (codexCallbackServerStartPromise) {
    await codexCallbackServerStartPromise;
    return;
  }

  codexCallbackServerStartPromise = new Promise((resolve, reject) => {
    const host = config.codexOAuth.callbackBindHost;
    const port = config.codexOAuth.callbackPort;
    const callbackPath = config.codexOAuth.callbackPath;
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== callbackPath) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const state = String(url.searchParams.get("state") || "");
        const code = String(url.searchParams.get("code") || "");
        const error = String(url.searchParams.get("error") || "");

        if (error) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            `<h1>OAuth failed</h1><p>${escapeHtml(error)}</p><p>Return to dashboard and try login again.</p>`
          );
          return;
        }
        if (!state || !code) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end("<h1>OAuth failed</h1><p>Missing code/state in callback.</p>");
          return;
        }

        try {
          const summary = await completeOAuthCallback({ code, state });
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          const msg = buildOAuthCallbackMessage(summary);
          res.end(OAUTH_CALLBACK_SUCCESS_HTML.replace("</body>", `${msg}</body>`));
        } catch (err) {
          console.error("Codex OAuth callback handling failed:", err);
          res.statusCode = 500;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            `<h1>Token exchange failed</h1><p>${escapeHtml(err.message)}</p><p>Return to dashboard and retry.</p>`
          );
        }
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`Internal callback error: ${err.message}`);
      }
    });

    server.once("error", (err) => {
      if (codexCallbackServer === server) codexCallbackServer = null;
      reject(
        new Error(
          `Failed to bind codex callback server at http://${host}:${port}${callbackPath}: ${err.message}`
        )
      );
    });

    server.listen(port, host, () => {
      codexCallbackServer = server;
      resolve();
    });
  });

  try {
    await codexCallbackServerStartPromise;
  } finally {
    codexCallbackServerStartPromise = null;
  }
}

function cleanupPendingStates() {
  const now = Date.now();
  for (const [state, value] of pendingAuth.entries()) {
    if (now - value.createdAt > 10 * 60 * 1000) pendingAuth.delete(state);
  }
}

function randomBase64Url(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256base64url(text) {
  return crypto.createHash("sha256").update(text).digest("base64url");
}

function truncate(text, maxLen) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function describeOAuthUpsertAction(action) {
  switch (String(action || "")) {
    case "created":
      return "new account added";
    case "created_reassigned_slot":
      return "new account added (requested slot occupied, reassigned)";
    case "updated_existing_account":
      return "existing account token refreshed";
    case "already_exists_same_account":
      return "same account detected (not added again)";
    case "replaced_slot":
      return "slot owner replaced";
    default:
      return "updated";
  }
}

function buildOAuthCallbackMessage(summary) {
  const accountId = summary?.accountId || "unknown";
  const entryId = summary?.entryId || "";
  const email = summary?.email || "";
  const action = summary?.action || "updated";
  const slot = summary?.slot || "-";
  const planType = String(summary?.planType || "").trim();
  const usageFetched = summary?.usageFetched === true;
  const usageFetchError = String(summary?.usageFetchError || "").trim();
  const actionLabel = describeOAuthUpsertAction(action);
  const emailLine = email ? `<p>Email: ${escapeHtml(email)}</p>` : "";
  const entryLine = entryId ? `<p>Entry: ${escapeHtml(truncate(String(entryId), 80))}</p>` : "";
  const planLine = planType ? `<p>Detected Plan: ${escapeHtml(planType)}</p>` : "";
  const usageLine = usageFetched
    ? `<p>Usage Snapshot: refreshed</p>`
    : usageFetchError
      ? `<p style="color:#b45309"><strong>Usage probe:</strong> ${escapeHtml(usageFetchError)}</p>`
      : "";
  const warning =
    action === "already_exists_same_account"
      ? `<p style="color:#b45309"><strong>Notice:</strong> This login returned the same ChatGPT account ID, so no new account was added.</p><p style="color:#b45309">Use another browser profile/incognito and login with a different account.</p>`
      : "";
  return `<p>Account: ${escapeHtml(accountId)}</p>${entryLine}${emailLine}<p>Action: ${escapeHtml(actionLabel)}</p><p>Slot: ${escapeHtml(String(slot))}</p>${planLine}${usageLine}${warning}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export { app, mainServer };

export const __testing = {
  config,
  normalizeCodexServiceTier,
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  parseResponsesResultFromSse,
  normalizeCherryAnthropicAgentOriginalUrl: anthropicLocalCompatHelpers.normalizeCherryAnthropicAgentOriginalUrl,
  parseAnthropicNativeBody: anthropicLocalCompatHelpers.parseAnthropicNativeBody,
  normalizeAnthropicNativeTools: anthropicLocalCompatHelpers.normalizeAnthropicNativeTools,
  normalizeAnthropicNativeToolChoice: anthropicLocalCompatHelpers.normalizeAnthropicNativeToolChoice,
  normalizeAnthropicNativeExecutionConfig: anthropicLocalCompatHelpers.normalizeAnthropicNativeExecutionConfig,
  resolveAnthropicNativeReasoningSummary: anthropicLocalCompatHelpers.resolveAnthropicNativeReasoningSummary,
  normalizeAnthropicToolUseInput: anthropicLocalCompatHelpers.normalizeAnthropicToolUseInput,
  toResponsesInputFromAnthropicMessages: anthropicLocalCompatHelpers.toResponsesInputFromAnthropicMessages,
  planAnthropicFunctionCallEmission: anthropicLocalCompatHelpers.planAnthropicFunctionCallEmission,
  rememberAnthropicPendingToolBatch: anthropicLocalCompatHelpers.rememberAnthropicPendingToolBatch,
  maybeBuildQueuedAnthropicToolMessage: anthropicLocalCompatHelpers.maybeBuildQueuedAnthropicToolMessage,
  clearAnthropicPendingToolBatches: anthropicLocalCompatHelpers.clearAnthropicPendingToolBatches,
  buildAnthropicMessageFromResponsesResponse: anthropicLocalCompatHelpers.buildAnthropicMessageFromResponsesResponse,
  renderAnthropicMessageSseEvents: anthropicLocalCompatHelpers.renderAnthropicMessageSseEvents,
  estimateAnthropicCountTokens: anthropicLocalCompatHelpers.estimateAnthropicCountTokens,
  buildCodexResponsesRequestBody,
  handleAnthropicNativeProxy
};

