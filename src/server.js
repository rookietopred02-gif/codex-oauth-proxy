import "dotenv/config";

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import express from "express";

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
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
const VALID_REASONING_EFFORT_MODES = new Set(["none", "low", "medium", "high", "xhigh", "adaptive"]);
const VALID_MULTI_ACCOUNT_STRATEGIES = new Set(["smart", "manual", "round-robin", "random", "sticky"]);
const MULTI_ACCOUNT_STRATEGY_LIST = [...VALID_MULTI_ACCOUNT_STRATEGIES].join(", ");
const VALID_CLOUDFLARED_MODES = new Set(["quick", "auth"]);
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
const DEFAULT_COMPACT_MODEL_CONTEXT_LIMIT = 128000;
const MODEL_CONTEXT_LIMITS = {
  "gpt-5.4": 400000,
  "gpt-5.4-pro": 400000,
  "gpt-5.3-codex": 400000,
  "gpt-5.2-codex": 400000,
  "gpt-5.1-codex-max": 400000,
  "gpt-5.1-codex": 400000,
  "gpt-5.1-codex-mini": 400000,
  "gpt-5-codex": 400000,
  "gpt-5": 400000,
  "gpt-5-mini": 200000,
  "gpt-4.1": 128000,
  "gpt-4.1-mini": 128000,
  "gpt-4o": 128000,
  o3: 200000,
  "o4-mini": 200000
};
const CONTEXT_OVERFLOW_ERROR_PATTERNS = [
  "context_length_exceeded",
  "context length exceeded",
  "context window",
  "maximum context length",
  "too many tokens",
  "prompt is too long",
  "input is too large",
  "input exceeds the context window",
  "request too large"
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
    authStorePath: path.resolve(
      process.env.PROFILE_AUTH_STORE_PATH ||
        path.join(os.homedir(), ".codex-oauth-proxy", "auth-profiles.json")
    ),
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
  codex: {
    defaultModel: process.env.CODEX_DEFAULT_MODEL || "gpt-5.4",
    defaultInstructions: process.env.CODEX_DEFAULT_INSTRUCTIONS || "You are a helpful assistant.",
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
  },
  autoCompact: {
    enabled: parseBooleanEnv(process.env.AUTO_COMPACT_ENABLED, true),
    mode: String(process.env.AUTO_COMPACT_MODE || "deterministic").trim().toLowerCase(),
    triggerRatio: parseNumberEnv(process.env.AUTO_COMPACT_TRIGGER_RATIO, 0.72, {
      min: 0.1,
      max: 1.5
    }),
    l1Ratio: parseNumberEnv(process.env.AUTO_COMPACT_L1_RATIO, 0.72, {
      min: 0.1,
      max: 1.5
    }),
    l2Ratio: parseNumberEnv(process.env.AUTO_COMPACT_L2_RATIO, 0.82, {
      min: 0.1,
      max: 1.5
    }),
    l3Ratio: parseNumberEnv(process.env.AUTO_COMPACT_L3_RATIO, 0.9, {
      min: 0.1,
      max: 1.5
    }),
    keepLastTurns: parseNumberEnv(process.env.AUTO_COMPACT_KEEP_LAST_TURNS, 6, {
      min: 1,
      max: 20,
      integer: true
    }),
    keepLastToolRounds: parseNumberEnv(process.env.AUTO_COMPACT_KEEP_LAST_TOOL_ROUNDS, 4, {
      min: 0,
      max: 20,
      integer: true
    }),
    toolOutputMaxChars: parseNumberEnv(process.env.AUTO_COMPACT_TOOL_OUTPUT_MAX_CHARS, 12000, {
      min: 1000,
      max: 100000,
      integer: true
    }),
    summaryMaxChars: parseNumberEnv(process.env.AUTO_COMPACT_SUMMARY_MAX_CHARS, 6000, {
      min: 500,
      max: 20000,
      integer: true
    }),
    retryOnContextError: parseBooleanEnv(process.env.AUTO_COMPACT_RETRY_ON_CONTEXT_ERROR, true),
    maxRetries: parseNumberEnv(process.env.AUTO_COMPACT_MAX_RETRIES, 1, {
      min: 0,
      max: 2,
      integer: true
    }),
    summarizerEnabled: parseBooleanEnv(process.env.AUTO_COMPACT_SUMMARIZER_ENABLED, false),
    summarizerModel: String(process.env.AUTO_COMPACT_SUMMARIZER_MODEL || "gpt-5-mini").trim() || "gpt-5-mini",
    summarizerTimeoutMs: parseNumberEnv(process.env.AUTO_COMPACT_SUMMARIZER_TIMEOUT_MS, 12000, {
      min: 1000,
      max: 60000,
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

if (!["deterministic", "hybrid"].includes(config.autoCompact.mode)) {
  config.autoCompact.mode = "deterministic";
}
if (!(config.autoCompact.l1Ratio <= config.autoCompact.l2Ratio && config.autoCompact.l2Ratio <= config.autoCompact.l3Ratio)) {
  const ratios = [config.autoCompact.l1Ratio, config.autoCompact.l2Ratio, config.autoCompact.l3Ratio].sort(
    (a, b) => a - b
  );
  [config.autoCompact.l1Ratio, config.autoCompact.l2Ratio, config.autoCompact.l3Ratio] = ratios;
}
config.autoCompact.triggerRatio = Math.max(
  0.1,
  Math.min(1.5, Number.isFinite(config.autoCompact.triggerRatio) ? config.autoCompact.triggerRatio : config.autoCompact.l1Ratio)
);

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
          headers: { "user-agent": "codex-oauth-proxy/0.1.0", accept: "application/octet-stream" },
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

function isProxyApiPath(pathName) {
  const path = String(pathName || "");
  return path.startsWith("/v1") || path.startsWith("/v1beta");
}

function toChunkBuffer(chunk, encoding = "utf8") {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding || "utf8");
  return Buffer.from(String(chunk), encoding || "utf8");
}

function parseContentType(value) {
  if (Array.isArray(value)) return parseContentType(value[0] || "");
  if (typeof value !== "string") return "";
  return value.split(";")[0].trim().toLowerCase();
}

function sanitizeAuditPayload(text) {
  let out = String(text || "");
  out = out.replace(
    /(authorization"\s*:\s*"Bearer\s+)([^"]+)(")/gi,
    (_m, p1, _token, p3) => `${p1}[REDACTED]${p3}`
  );
  out = out.replace(
    /("?(?:access_token|refresh_token|id_token|api_key|x-api-key|x-goog-api-key)"?\s*:\s*")([^"]+)(")/gi,
    (_m, p1, _token, p3) => `${p1}[REDACTED]${p3}`
  );
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, "$1[REDACTED]");
  return out;
}

function formatPayloadForAudit(raw, contentType) {
  let text = "";
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) return "";
    text = raw.toString("utf8");
  } else {
    text = String(raw || "");
  }
  if (!text) return "";

  const ct = parseContentType(contentType);
  const looksJson = ct.includes("json") || /^[\s]*[\[{]/.test(text);
  if (looksJson) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // keep original when non-standard JSON
    }
  }

  text = sanitizeAuditPayload(text);
  if (text.length > RUNTIME_AUDIT_MAX_TEXT_CHARS) {
    const hidden = text.length - RUNTIME_AUDIT_MAX_TEXT_CHARS;
    text = `${text.slice(0, RUNTIME_AUDIT_MAX_TEXT_CHARS)}\n\n... [truncated ${hidden} chars]`;
  }
  return text;
}

function inferProtocolType(pathName, localProtocolType = "") {
  const hinted = String(localProtocolType || "").trim();
  if (hinted) return hinted;
  const path = String(pathName || "");
  if (path.startsWith("/v1beta/")) return "gemini-v1beta";
  if (path.startsWith("/v1/messages")) return "anthropic-v1";
  if (/^\/v1\/models\/.+:(generateContent|streamGenerateContent)/.test(path)) return "gemini-v1beta";
  if (path.startsWith("/v1/")) return "openai-v1";
  return config.upstreamMode;
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

function sanitizeAuditPath(urlLike) {
  const raw = String(urlLike || "");
  if (!raw) return raw;
  try {
    const parsed = new URL(raw, "http://localhost");
    parsed.searchParams.delete("key");
    parsed.searchParams.delete("api_key");
    parsed.searchParams.delete("x-api-key");
    const search = parsed.search || "";
    return `${parsed.pathname}${search}`;
  } catch {
    return raw;
  }
}

app.use((req, _res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    next();
  });
  req.on("error", next);
});

app.use((req, res, next) => {
  const pathName = String(req.path || req.url || "");
  const isProxyRequest =
    pathName.startsWith("/v1") || pathName.startsWith("/v1beta") || pathName.startsWith("/v1/messages");
  if (!isProxyRequest) {
    next();
    return;
  }

  const managedEnabled = hasActiveManagedProxyApiKeys();
  const legacyKey = String(config.codexOAuth.sharedApiKey || "").trim();
  if (!managedEnabled && !legacyKey) {
    next();
    return;
  }

  const provided = extractProxyApiKeyFromRequest(req);
  const managedMatch = findManagedProxyApiKeyByValue(provided);
  if (managedMatch) {
    recordManagedProxyApiKeyUsage(managedMatch);
    res.locals.proxyApiKeyId = managedMatch.id;
    next();
    return;
  }
  if (!managedEnabled && legacyKey && provided === legacyKey) {
    next();
    return;
  }
  if (managedEnabled && legacyKey && provided === legacyKey) {
    next();
    return;
  }

  res.status(401).json({
    error: "invalid_api_key",
    message:
      "Invalid API key. Use one of: Authorization: Bearer <your_proxy_api_key>, x-api-key, x-goog-api-key, or ?key=<your_proxy_api_key>."
  });
});

app.use("/dashboard", express.static(publicDir));
app.get("/dashboard", (_req, res) => {
  res.redirect("/dashboard/");
});

app.get("/", async (_req, res) => {
  const status = await getAuthStatus();
  res.json({
    name: "codex-oauth-proxy",
    mode: config.authMode,
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl(),
    sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
    multiAccountEnabled: isCodexMultiAccountEnabled(),
    multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
    authenticated: status.authenticated,
    status: "/auth/status",
    login:
      config.authMode === "profile-store"
        ? "login via profile store"
        : `http://${config.host}:${config.port}/auth/login`,
    proxyBase: "/v1/*",
    dashboard: `http://${config.host}:${config.port}/dashboard/`
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    mode: config.authMode,
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl()
  });
});

app.get("/auth/status", async (_req, res) => {
  try {
    res.json(await getAuthStatus());
  } catch (err) {
    res.status(500).json({ error: "status_failed", message: err.message });
  }
});

app.get("/auth/login", async (req, res) => {
  if (config.authMode === "profile-store") {
    res.status(400).json({
      mode: "profile-store",
      message: "This mode uses Profile Store's existing OAuth session.",
      action: "Run: your external auth tool login flow",
      authStorePath: config.profileStore.authStorePath
    });
    return;
  }

  const oauthRuntime = getActiveOAuthRuntime();
  if (!oauthRuntime) {
    res.status(400).json({
      error: "oauth_unavailable",
      message: "AUTH_MODE is profile-store; use Profile Store login flow."
    });
    return;
  }

  if (config.authMode === "codex-oauth") {
    try {
      await ensureCodexOAuthCallbackServer();
    } catch (err) {
      res.status(500).json({
        error: "callback_server_failed",
        message: err.message
      });
      return;
    }
  }

  const state = randomBase64Url(24);
  const verifier = randomBase64Url(64);
  const challenge = sha256base64url(verifier);

  pendingAuth.set(state, {
    verifier,
    createdAt: Date.now(),
    mode: config.authMode,
    label: typeof req.query.label === "string" ? req.query.label.trim() : "",
    slot: parseSlotValue(req.query.slot),
    force: String(req.query.force || "").trim() === "1"
  });
  cleanupPendingStates();

  const authUrl = new URL(oauthRuntime.oauth.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", oauthRuntime.oauth.clientId);
  authUrl.searchParams.set("redirect_uri", oauthRuntime.oauth.redirectUri);
  authUrl.searchParams.set("scope", oauthRuntime.oauth.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (config.authMode === "codex-oauth") {
    authUrl.searchParams.set("id_token_add_organizations", "true");
    authUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authUrl.searchParams.set("originator", config.codexOAuth.originator);
    authUrl.searchParams.set("max_age", "0");
  }

  if (req.query.prompt) {
    authUrl.searchParams.set("prompt", String(req.query.prompt));
  } else if (config.authMode === "codex-oauth" && isCodexMultiAccountEnabled()) {
    // OpenAI OAuth does not support select_account; use login to re-prompt account auth.
    authUrl.searchParams.set("prompt", "login");
  }

  res.redirect(authUrl.toString());
});

app.get("/auth/callback", async (req, res) => {
  if (config.authMode === "profile-store") {
    res.status(400).send("Callback is not used in AUTH_MODE=profile-store.");
    return;
  }
  if (config.authMode === "codex-oauth") {
    res
      .status(400)
      .send(
        `Callback in AUTH_MODE=codex-oauth is handled at ${config.codexOAuth.redirectUri}. Start login from /auth/login.`
      );
    return;
  }

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const error = String(req.query.error || "");

  if (error) {
    res.status(400).send(`OAuth failed: ${error}`);
    return;
  }

  if (!code || !state || !pendingAuth.has(state)) {
    res.status(400).send("Invalid OAuth callback: missing code/state or expired state.");
    return;
  }

  try {
    const summary = await completeOAuthCallback({ code, state });

    const msg = buildOAuthCallbackMessage(summary);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(OAUTH_CALLBACK_SUCCESS_HTML.replace("</body>", `${msg}</body>`));
  } catch (err) {
    console.error("OAuth callback exchange failed:", err);
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

app.post("/auth/logout", async (req, res) => {
  if (config.authMode === "profile-store") {
    res.status(400).json({
      mode: "profile-store",
      message: "Managed by Profile Store. Run `your external auth tool login flow` to change account."
    });
    return;
  }

  const oauthRuntime = getActiveOAuthRuntime();
  if (!oauthRuntime) {
    res.status(400).json({
      error: "oauth_unavailable",
      message: "No active OAuth runtime."
    });
    return;
  }

  if (config.authMode === "codex-oauth") {
    const body = parseJsonBody(req);
    const accountRef = String(body.entryId || body.accountId || "").trim();
    const removed = removeCodexPoolAccountFromStore(oauthRuntime.store, accountRef);
    if (!removed.removed) {
      res.status(404).json({
        error: "not_found",
        message: "No removable OAuth account was found."
      });
      return;
    }

    oauthRuntime.store = removed.store;
    await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
    clearAuthContextCache();
    res.json({
      ok: true,
      mode: "codex-oauth",
      removedEntryId: removed.removedEntryId,
      removedAccountId: removed.removedAccountId,
      remainingAccounts: removed.remainingAccounts,
      activeEntryId: removed.activeEntryId
    });
    return;
  }

  oauthRuntime.store.token = null;
  await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
  clearAuthContextCache();
  res.json({ ok: true, mode: config.authMode });
});

app.get("/admin/state", async (_req, res) => {
  try {
    const authStatus = await getAuthStatus();
    await checkCloudflaredInstalled(false).catch(() => {});
    const apiKeySummary = buildApiKeySummary();
    res.json({
      ok: true,
      startedAt: runtimeStats.startedAt,
      uptimeMs: Date.now() - runtimeStats.startedAt,
      config: {
        authMode: config.authMode,
        upstreamMode: config.upstreamMode,
        upstreamBaseUrl: getActiveUpstreamBaseUrl(),
        defaultModel: config.codex.defaultModel,
        defaultInstructions: config.codex.defaultInstructions,
        defaultReasoningEffort: config.codex.defaultReasoningEffort,
        sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
        apiKeyEnforced: apiKeySummary.enforced,
        multiAccountEnabled: isCodexMultiAccountEnabled(),
        multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
        preheatCooldownSeconds: config.codexPreheat.cooldownSeconds,
        preheatBatchSize: config.codexPreheat.batchSize,
        preheatMinPrimaryRemaining: config.codexPreheat.minPrimaryRemaining,
        preheatMinSecondaryRemaining: config.codexPreheat.minSecondaryRemaining,
        modelRouterEnabled: config.modelRouter.enabled,
        modelMappings: config.modelRouter.customMappings,
        publicAccess: {
          mode: cloudflaredRuntime.mode || config.publicAccess.defaultMode,
          useHttp2: cloudflaredRuntime.useHttp2 !== false,
          autoInstall: config.publicAccess.autoInstall !== false,
          localPort: Number(cloudflaredRuntime.localPort || config.port)
        },
        autoCompact: {
          enabled: config.autoCompact.enabled !== false,
          mode: config.autoCompact.mode,
          triggerRatio: config.autoCompact.triggerRatio,
          l1Ratio: config.autoCompact.l1Ratio,
          l2Ratio: config.autoCompact.l2Ratio,
          l3Ratio: config.autoCompact.l3Ratio,
          keepLastTurns: config.autoCompact.keepLastTurns,
          keepLastToolRounds: config.autoCompact.keepLastToolRounds,
          toolOutputMaxChars: config.autoCompact.toolOutputMaxChars,
          summaryMaxChars: config.autoCompact.summaryMaxChars,
          retryOnContextError: config.autoCompact.retryOnContextError !== false,
          maxRetries: config.autoCompact.maxRetries,
          summarizerEnabled: config.autoCompact.summarizerEnabled === true,
          summarizerModel: config.autoCompact.summarizerModel,
          summarizerTimeoutMs: config.autoCompact.summarizerTimeoutMs
        }
      },
      auth: authStatus,
      apiKeys: apiKeySummary,
      publicAccess: getCloudflaredStatus(),
      preheat: getCodexPreheatState(),
      stats: {
        totalRequests: runtimeStats.totalRequests,
        okRequests: runtimeStats.okRequests,
        errorRequests: runtimeStats.errorRequests,
        recentRequests: runtimeStats.recentRequests
      }
    });
  } catch (err) {
    res.status(500).json({ error: "state_failed", message: err.message });
  }
});

app.get("/admin/api-keys", async (_req, res) => {
  const summary = buildApiKeySummary();
  res.json({
    ok: true,
    ...summary
  });
});

app.post("/admin/api-keys/generate", async (req, res) => {
  try {
    const body = parseJsonBody(req);
    const nowSec = Math.floor(Date.now() / 1000);
    const label = sanitizeProxyApiKeyLabel(body?.label);
    const expiresInDaysRaw = Number(body?.expiresInDays);
    const expiresInDays = Number.isFinite(expiresInDaysRaw)
      ? Math.max(0, Math.min(3650, Math.floor(expiresInDaysRaw)))
      : 0;
    const expiresAt = expiresInDays > 0 ? nowSec + expiresInDays * 86400 : 0;
    const apiKey = createProxyApiKey();
    const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const entry = {
      id,
      label,
      prefix: apiKey.slice(0, 10),
      value: apiKey,
      hash: hashProxyApiKey(apiKey),
      created_at: nowSec,
      last_used_at: 0,
      use_count: 0,
      revoked_at: 0,
      expires_at: expiresAt
    };

    if (!Array.isArray(proxyApiKeyStore.keys)) proxyApiKeyStore.keys = [];
    proxyApiKeyStore.keys.unshift(entry);
    await saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore);

    res.json({
      ok: true,
      apiKey,
      key: {
        id: entry.id,
        label: entry.label,
        prefix: entry.prefix,
        value: entry.value,
        createdAt: entry.created_at,
        expiresAt: entry.expires_at > 0 ? entry.expires_at : null,
        active: true
      },
      summary: buildApiKeySummary()
    });
  } catch (err) {
    res.status(400).json({
      error: "api_key_generate_failed",
      message: err.message
    });
  }
});

app.post("/admin/api-keys/revoke", async (req, res) => {
  try {
    const body = parseJsonBody(req);
    const id = String(body?.id || "").trim();
    if (!id) {
      throw new Error("id is required.");
    }
    const keys = Array.isArray(proxyApiKeyStore.keys) ? proxyApiKeyStore.keys : [];
    const targetIdx = keys.findIndex((x) => String(x?.id || "") === id);
    if (targetIdx < 0) {
      res.status(404).json({
        error: "api_key_not_found",
        message: "API key not found."
      });
      return;
    }
    keys.splice(targetIdx, 1);
    await saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore);
    res.json({
      ok: true,
      id,
      summary: buildApiKeySummary()
    });
  } catch (err) {
    res.status(400).json({
      error: "api_key_revoke_failed",
      message: err.message
    });
  }
});

app.get("/admin/public-access/status", async (_req, res) => {
  await checkCloudflaredInstalled(false).catch(() => {});
  res.json({
    ok: true,
    status: getCloudflaredStatus()
  });
});

app.post("/admin/public-access/install", async (_req, res) => {
  try {
    const result = await installCloudflaredBinary();
    res.json({
      ok: true,
      result,
      status: getCloudflaredStatus()
    });
  } catch (err) {
    res.status(400).json({
      error: "public_access_install_failed",
      message: err.message,
      status: getCloudflaredStatus()
    });
  }
});

app.post("/admin/public-access/start", async (req, res) => {
  try {
    const body = parseJsonBody(req);
    const modeRaw = String(body?.mode || "").trim().toLowerCase();
    const mode = VALID_CLOUDFLARED_MODES.has(modeRaw) ? modeRaw : cloudflaredRuntime.mode || config.publicAccess.defaultMode;
    const token = body?.token === undefined ? undefined : String(body.token || "").trim();
    const useHttp2 = body?.useHttp2 === undefined ? undefined : Boolean(body.useHttp2);
    const autoInstall = body?.autoInstall === undefined ? undefined : Boolean(body.autoInstall);
    const localPort = body?.localPort === undefined ? undefined : parseNumberEnv(body.localPort, Number(config.port), {
      min: 1,
      max: 65535,
      integer: true
    });

    const status = await startCloudflaredTunnel({
      mode,
      token,
      useHttp2,
      localPort,
      autoInstall
    });

    config.publicAccess.defaultMode = status.mode;
    config.publicAccess.defaultUseHttp2 = status.useHttp2 !== false;
    config.publicAccess.defaultTunnelToken = cloudflaredRuntime.tunnelToken || "";
    config.publicAccess.localPort = Number(status.localPort || config.port);

    res.json({
      ok: true,
      status
    });
  } catch (err) {
    res.status(400).json({
      error: "public_access_start_failed",
      message: err.message
    });
  }
});

app.post("/admin/public-access/stop", async (_req, res) => {
  try {
    const status = await stopCloudflaredTunnel();
    res.json({
      ok: true,
      status
    });
  } catch (err) {
    res.status(400).json({
      error: "public_access_stop_failed",
      message: err.message
    });
  }
});

app.get("/admin/model-candidates", async (req, res) => {
  const forceRefresh = String(req.query.refresh || "").trim() === "1";
  const models = await getOfficialModelCandidateIds({ forceRefresh });
  res.json({
    ok: true,
    models,
    wildcardPresets: ["gpt-*", "gpt-4*", "gpt-5*", "claude-*", "gemini-*"]
  });
});

app.get("/admin/auth-pool", async (_req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  if (normalized.changed) {
    await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  }

  const activeEntryId = codexOAuthStore.active_account_id || null;
  const metrics = buildCodexPoolMetrics(codexOAuthStore.accounts || [], activeEntryId || "");
  res.json({
    ok: true,
    multiAccountEnabled: isCodexMultiAccountEnabled(),
    strategy: config.codexOAuth.multiAccountStrategy,
    sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
    activeEntryId,
    activeAccountId:
      (codexOAuthStore.accounts || []).find((x) => getCodexPoolEntryId(x) === String(activeEntryId || ""))
        ?.account_id || null,
    rotation: codexOAuthStore.rotation || { next_index: 0 },
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
        lastError: x.last_error || "",
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
  });
});

app.post("/admin/auth-pool/toggle", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const body = parseJsonBody(req);
  const accountRef = String(body.entryId || body.accountId || "").trim();
  const enabled = body.enabled !== false;
  if (!accountRef) {
    res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
    return;
  }
  target.enabled = enabled;
  const targetEntryId = getCodexPoolEntryId(target);
  if (!enabled && codexOAuthStore.active_account_id === targetEntryId) {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({ ok: true, entryId: targetEntryId, accountId: target.account_id, enabled });
});

app.post("/admin/auth-pool/activate", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const body = parseJsonBody(req);
  const accountRef = String(body.entryId || body.accountId || "").trim();
  if (!accountRef) {
    res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
    return;
  }
  target.enabled = true;
  target.cooldown_until = 0;
  target.last_error = "";
  const targetEntryId = getCodexPoolEntryId(target);
  codexOAuthStore.active_account_id = targetEntryId;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({ ok: true, entryId: targetEntryId, accountId: target.account_id });
});

app.post("/admin/auth-pool/remove", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const body = parseJsonBody(req);
  const accountRef = String(body.entryId || body.accountId || "").trim();
  if (!accountRef) {
    res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
    return;
  }

  const result = removeCodexPoolAccountFromStore(codexOAuthStore, accountRef);
  if (!result.removed) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
    return;
  }
  codexOAuthStore = result.store;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({
    ok: true,
    entryId: result.removedEntryId,
    accountId: result.removedAccountId,
    removed: true,
    remainingAccounts: result.remainingAccounts,
    activeEntryId: result.activeEntryId
  });
});

app.post("/admin/auth-pool/import", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const body = parseJsonBody(req);
  const replace = body.replace === true;
  const probeUsage = body.probeUsage !== false;
  const items = Array.isArray(body.tokens) ? body.tokens : [];
  if (items.length === 0) {
    res.status(400).json({ error: "invalid_request", message: "tokens[] is required." });
    return;
  }

  const flattenCandidates = [];
  for (const rawItem of items) {
    if (rawItem && typeof rawItem === "object" && Array.isArray(rawItem.tokens)) {
      for (const nested of rawItem.tokens) {
        flattenCandidates.push(nested);
      }
      continue;
    }
    if (rawItem && typeof rawItem === "object" && rawItem.payload && typeof rawItem.payload === "object") {
      flattenCandidates.push(rawItem.payload);
      continue;
    }
    flattenCandidates.push(rawItem);
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  if (replace) {
    codexOAuthStore.accounts = [];
    codexOAuthStore.active_account_id = null;
    codexOAuthStore.rotation = { next_index: 0 };
    codexOAuthStore.token = null;
  }

  let imported = 0;
  const importedRefs = [];
  for (const raw of flattenCandidates) {
    if (!raw || typeof raw !== "object") continue;

    const accessToken = String(raw.access_token || raw.accessToken || "").trim();
    if (!accessToken) continue;

    const rawUsageSnapshot =
      raw.usage_snapshot && typeof raw.usage_snapshot === "object"
        ? raw.usage_snapshot
        : raw.usageSnapshot && typeof raw.usageSnapshot === "object"
          ? raw.usageSnapshot
          : null;
    const upsert = upsertCodexOAuthAccount(
      codexOAuthStore,
      normalizeToken(
        {
          access_token: accessToken,
          refresh_token: raw.refresh_token || raw.refreshToken || null,
          token_type: raw.token_type || raw.tokenType || "Bearer",
          scope: raw.scope || null,
          expires_at: raw.expires_at || raw.expiresAt || null,
          expires_in: raw.expires_in || raw.expiresIn || null
        },
        raw
      ),
      {
        label:
          (typeof raw.label === "string" && raw.label.trim()) ||
          (typeof raw.email === "string" && raw.email.trim()) ||
          (typeof raw.name === "string" && raw.name.trim()) ||
          "",
        slot: parseSlotValue(raw.slot),
        force: raw.force === true,
        planType:
          normalizeOpenAICodexPlanType(raw.plan_type) ||
          normalizeOpenAICodexPlanType(raw.planType) ||
          normalizeOpenAICodexPlanType(rawUsageSnapshot?.plan_type),
        usageSnapshot: rawUsageSnapshot
      }
    );

    if (raw.enabled === false) {
      const importedAccount = findCodexPoolAccountByRef(codexOAuthStore.accounts, upsert.entryId);
      if (importedAccount) importedAccount.enabled = false;
    }

    if (upsert.entryId) importedRefs.push(String(upsert.entryId));
    imported += 1;
  }
  if (imported === 0) {
    res.status(400).json({ error: "invalid_request", message: "No valid token entries in tokens[]." });
    return;
  }

  let usageProbed = 0;
  let usageProbeFailed = 0;
  const usageProbeErrors = [];
  if (probeUsage) {
    const uniqueRefs = [...new Set(importedRefs.filter(Boolean))];
    for (const ref of uniqueRefs) {
      const target = findCodexPoolAccountByRef(codexOAuthStore.accounts, ref);
      if (!target || target.enabled === false) continue;
      try {
        const probe = await withTimeout(
          refreshCodexUsageSnapshotInStore(codexOAuthStore, ref, config.codexOAuth, {
            includeDisabled: false
          }),
          12000,
          "Usage probe timed out."
        );
        if (probe?.ok) {
          usageProbed += 1;
        } else {
          usageProbeFailed += 1;
          usageProbeErrors.push({
            entryId: probe?.entryId || ref,
            error: String(probe?.error || probe?.skipped || "usage_probe_failed")
          });
        }
      } catch (err) {
        usageProbeFailed += 1;
        usageProbeErrors.push({
          entryId: ref,
          error: String(err?.message || err || "usage_probe_failed")
        });
      }
    }
  }

  const renormalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = renormalized.store;

  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({
    ok: true,
    imported,
    accountPoolSize: (codexOAuthStore.accounts || []).length,
    usageProbe: {
      enabled: probeUsage,
      probed: usageProbed,
      failed: usageProbeFailed,
      errors: usageProbeErrors
    }
  });
});

app.get("/admin/auth-pool/export", async (_req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const accounts = Array.isArray(codexOAuthStore.accounts) ? codexOAuthStore.accounts : [];

  const sanitizeSegment = (value, fallback) => {
    const cleaned = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned || fallback;
  };

  const files = accounts.map((account, index) => {
    const entryId = getCodexPoolEntryId(account) || `entry_${index + 1}`;
    const slot = Number(account?.slot || 0) || index + 1;
    const labelPart = sanitizeSegment(account?.label || "", "account");
    const accountPart = sanitizeSegment(account?.account_id || "", `slot-${slot}`);
    const fileName = `slot-${slot}-${labelPart}-${accountPart}`.slice(0, 96) + ".json";

    const token = account?.token || {};
    const usageSnapshot =
      account?.usage_snapshot && typeof account.usage_snapshot === "object" ? account.usage_snapshot : null;
    const planType = normalizeOpenAICodexPlanType(usageSnapshot?.plan_type || account?.plan_type);

    return {
      fileName,
      payload: {
        label: typeof account?.label === "string" ? account.label : "",
        slot,
        enabled: account?.enabled !== false,
        entry_id: entryId,
        account_id: account?.account_id || null,
        plan_type: planType || null,
        usage_snapshot: usageSnapshot,
        usage_updated_at: Number(account?.usage_updated_at || 0) || 0,
        access_token: token?.access_token || "",
        refresh_token: token?.refresh_token || null,
        token_type: token?.token_type || "Bearer",
        scope: token?.scope || null,
        expires_at: Number(token?.expires_at || 0) || 0
      }
    };
  });

  res.json({
    ok: true,
    exported: files.length,
    generatedAt: new Date().toISOString(),
    files
  });
});

app.post("/admin/auth-pool/refresh-usage", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Account pool management is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }

  const body = parseJsonBody(req);
  const accountRef = String(body.entryId || body.accountId || "").trim();
  const includeDisabled = body.includeDisabled === true;

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;

  let targets = Array.isArray(codexOAuthStore.accounts) ? [...codexOAuthStore.accounts] : [];
  if (!includeDisabled) {
    targets = targets.filter((x) => x.enabled !== false);
  }
  if (accountRef) {
    targets = targets.filter(
      (x) => getCodexPoolEntryId(x) === accountRef || String(x.account_id || "") === accountRef
    );
  }
  if (targets.length === 0) {
    res.status(404).json({
      error: "not_found",
      message: accountRef
        ? `No matching account to refresh: ${accountRef}`
        : "No eligible accounts to refresh usage."
    });
    return;
  }

  const results = [];
  let refreshed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const probe = await refreshCodexUsageSnapshotInStore(
      codexOAuthStore,
      getCodexPoolEntryId(target),
      config.codexOAuth,
      { includeDisabled }
    );
    if (probe.ok) {
      refreshed += 1;
      results.push({
        entryId: probe.entryId,
        accountId: probe.accountId,
        ok: true,
        usage: probe.snapshot
      });
    } else {
      results.push({
        entryId: probe.entryId || getCodexPoolEntryId(target),
        accountId: probe.accountId || target.account_id || null,
        ok: false,
        error: String(probe.error || probe.skipped || "usage_probe_failed")
      });
    }
    if (i < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  if (targets[0]?.token?.access_token) {
    codexOAuthStore.token = targets[0].token;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({
    ok: true,
    refreshed,
    total: targets.length,
    results
  });
});

app.get("/admin/preheat/state", (_req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Preheat is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }
  res.json({
    ok: true,
    preheat: getCodexPreheatState()
  });
});

app.post("/admin/preheat/run", async (req, res) => {
  if (config.authMode !== "codex-oauth") {
    res.status(400).json({
      error: "unsupported_mode",
      message: "Preheat is only available in AUTH_MODE=codex-oauth."
    });
    return;
  }
  try {
    const body = parseJsonBody(req);
    const force = body.force === true;
    const summary = await runCodexPreheat("manual", { force });
    res.json({
      ok: true,
      summary,
      preheat: getCodexPreheatState()
    });
  } catch (err) {
    res.status(400).json({
      error: "preheat_failed",
      message: err.message,
      preheat: getCodexPreheatState()
    });
  }
});

app.post("/admin/requests/clear", (_req, res) => {
  runtimeStats.recentRequests = [];
  res.json({ ok: true, cleared: true });
});

app.post("/admin/config", async (req, res) => {
  try {
    const body = parseJsonBody(req);
    if (typeof body.upstreamMode === "string") {
      const value = normalizeUpstreamMode(body.upstreamMode);
      if (value !== "codex-chatgpt" && value !== "gemini-v1beta" && value !== "anthropic-v1") {
        throw new Error("upstreamMode must be codex-chatgpt, gemini-v1beta, or anthropic-v1");
      }
      config.upstreamMode = value;
    }
    if (typeof body.upstreamBaseUrl === "string" && body.upstreamBaseUrl.trim().length > 0) {
      setActiveUpstreamBaseUrl(body.upstreamBaseUrl.trim());
    }
    if (typeof body.defaultModel === "string" && body.defaultModel.trim().length > 0) {
      config.codex.defaultModel = body.defaultModel.trim();
    }
    // Allow empty string (or null) so UI can intentionally clear default instructions.
    if (body.defaultInstructions === null) {
      config.codex.defaultInstructions = "";
    } else if (typeof body.defaultInstructions === "string") {
      config.codex.defaultInstructions = body.defaultInstructions.trim();
    }
    if (typeof body.defaultReasoningEffort === "string") {
      const normalized = parseReasoningEffortOrFallback(body.defaultReasoningEffort, null, {
        allowAdaptive: true
      });
      if (!normalized) {
        throw new Error("defaultReasoningEffort must be one of: none, low, medium, high, xhigh, adaptive");
      }
      config.codex.defaultReasoningEffort = normalized;
    }
    if (typeof body.multiAccountEnabled === "boolean") {
      config.codexOAuth.multiAccountEnabled = body.multiAccountEnabled;
    }
    if (typeof body.multiAccountStrategy === "string") {
      const strategy = body.multiAccountStrategy.trim().toLowerCase();
      if (!VALID_MULTI_ACCOUNT_STRATEGIES.has(strategy)) {
        throw new Error(`multiAccountStrategy must be one of: ${MULTI_ACCOUNT_STRATEGY_LIST}`);
      }
      config.codexOAuth.multiAccountStrategy = strategy;
    }
    if (typeof body.publicAccessMode === "string") {
      const mode = String(body.publicAccessMode || "").trim().toLowerCase();
      if (!VALID_CLOUDFLARED_MODES.has(mode)) {
        throw new Error("publicAccessMode must be one of: quick, auth.");
      }
      config.publicAccess.defaultMode = mode;
      cloudflaredRuntime.mode = mode;
    }
    if (body.publicAccessUseHttp2 !== undefined) {
      const useHttp2 = Boolean(body.publicAccessUseHttp2);
      config.publicAccess.defaultUseHttp2 = useHttp2;
      cloudflaredRuntime.useHttp2 = useHttp2;
    }
    if (body.publicAccessAutoInstall !== undefined) {
      config.publicAccess.autoInstall = true;
    }
    if (body.publicAccessLocalPort !== undefined) {
      const parsed = parseNumberEnv(body.publicAccessLocalPort, NaN, {
        min: 1,
        max: 65535,
        integer: true
      });
      if (!Number.isFinite(parsed)) {
        throw new Error("publicAccessLocalPort must be a number between 1 and 65535.");
      }
      config.publicAccess.localPort = parsed;
      cloudflaredRuntime.localPort = parsed;
    }
    if (body.publicAccessToken !== undefined) {
      config.publicAccess.defaultTunnelToken = String(body.publicAccessToken || "").trim();
      cloudflaredRuntime.tunnelToken = config.publicAccess.defaultTunnelToken;
    }
    if (body.preheatCooldownSeconds !== undefined) {
      const parsed = parseNumberEnv(body.preheatCooldownSeconds, NaN, {
        min: 30,
        max: 86400,
        integer: true
      });
      if (!Number.isFinite(parsed)) {
        throw new Error("preheatCooldownSeconds must be a number between 30 and 86400.");
      }
      config.codexPreheat.cooldownSeconds = parsed;
    }
    if (body.preheatBatchSize !== undefined) {
      const parsed = parseNumberEnv(body.preheatBatchSize, NaN, {
        min: 1,
        max: 32,
        integer: true
      });
      if (!Number.isFinite(parsed)) {
        throw new Error("preheatBatchSize must be a number between 1 and 32.");
      }
      config.codexPreheat.batchSize = parsed;
    }
    if (body.preheatMinPrimaryRemaining !== undefined) {
      const parsed = parseNumberEnv(body.preheatMinPrimaryRemaining, NaN, {
        min: 0,
        max: 100,
        integer: true
      });
      if (!Number.isFinite(parsed)) {
        throw new Error("preheatMinPrimaryRemaining must be a number between 0 and 100.");
      }
      config.codexPreheat.minPrimaryRemaining = parsed;
    }
    if (body.preheatMinSecondaryRemaining !== undefined) {
      const parsed = parseNumberEnv(body.preheatMinSecondaryRemaining, NaN, {
        min: 0,
        max: 100,
        integer: true
      });
      if (!Number.isFinite(parsed)) {
        throw new Error("preheatMinSecondaryRemaining must be a number between 0 and 100.");
      }
      config.codexPreheat.minSecondaryRemaining = parsed;
    }
    if (typeof body.modelRouterEnabled === "boolean") {
      config.modelRouter.enabled = body.modelRouterEnabled;
    }
    if (body.modelMappings !== undefined) {
      config.modelRouter.customMappings = sanitizeModelMappings(body.modelMappings);
    }

    const autoCompactBody =
      body.autoCompact && typeof body.autoCompact === "object" && !Array.isArray(body.autoCompact)
        ? body.autoCompact
        : body;
    const autoCompactModeValue =
      typeof autoCompactBody.mode === "string"
        ? autoCompactBody.mode
        : typeof autoCompactBody.autoCompactMode === "string"
          ? autoCompactBody.autoCompactMode
          : undefined;
    if (autoCompactModeValue !== undefined) {
      const mode = String(autoCompactModeValue || "").trim().toLowerCase();
      if (!["deterministic", "hybrid"].includes(mode)) {
        throw new Error("autoCompact.mode must be one of: deterministic, hybrid.");
      }
      config.autoCompact.mode = mode;
    }
    const parseRatioSetting = (rawValue, fieldName, fallback) => {
      if (rawValue === undefined) return fallback;
      const parsed = parseNumberEnv(rawValue, NaN, { min: 0.1, max: 1.5 });
      if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be between 0.1 and 1.5.`);
      return parsed;
    };
    const parseIntSetting = (rawValue, fieldName, min, max, fallback) => {
      if (rawValue === undefined) return fallback;
      const parsed = parseNumberEnv(rawValue, NaN, { min, max, integer: true });
      if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be between ${min} and ${max}.`);
      return parsed;
    };

    if (autoCompactBody.enabled !== undefined || autoCompactBody.autoCompactEnabled !== undefined) {
      const value =
        autoCompactBody.enabled !== undefined ? autoCompactBody.enabled : autoCompactBody.autoCompactEnabled;
      config.autoCompact.enabled = Boolean(value);
    }
    config.autoCompact.triggerRatio = parseRatioSetting(
      autoCompactBody.triggerRatio ?? autoCompactBody.autoCompactTriggerRatio,
      "autoCompact.triggerRatio",
      config.autoCompact.triggerRatio
    );
    config.autoCompact.l1Ratio = parseRatioSetting(
      autoCompactBody.l1Ratio ?? autoCompactBody.autoCompactL1Ratio,
      "autoCompact.l1Ratio",
      config.autoCompact.l1Ratio
    );
    config.autoCompact.l2Ratio = parseRatioSetting(
      autoCompactBody.l2Ratio ?? autoCompactBody.autoCompactL2Ratio,
      "autoCompact.l2Ratio",
      config.autoCompact.l2Ratio
    );
    config.autoCompact.l3Ratio = parseRatioSetting(
      autoCompactBody.l3Ratio ?? autoCompactBody.autoCompactL3Ratio,
      "autoCompact.l3Ratio",
      config.autoCompact.l3Ratio
    );
    config.autoCompact.keepLastTurns = parseIntSetting(
      autoCompactBody.keepLastTurns ?? autoCompactBody.autoCompactKeepLastTurns,
      "autoCompact.keepLastTurns",
      1,
      20,
      config.autoCompact.keepLastTurns
    );
    config.autoCompact.keepLastToolRounds = parseIntSetting(
      autoCompactBody.keepLastToolRounds ?? autoCompactBody.autoCompactKeepLastToolRounds,
      "autoCompact.keepLastToolRounds",
      0,
      20,
      config.autoCompact.keepLastToolRounds
    );
    config.autoCompact.toolOutputMaxChars = parseIntSetting(
      autoCompactBody.toolOutputMaxChars ?? autoCompactBody.autoCompactToolOutputMaxChars,
      "autoCompact.toolOutputMaxChars",
      1000,
      100000,
      config.autoCompact.toolOutputMaxChars
    );
    config.autoCompact.summaryMaxChars = parseIntSetting(
      autoCompactBody.summaryMaxChars ?? autoCompactBody.autoCompactSummaryMaxChars,
      "autoCompact.summaryMaxChars",
      500,
      20000,
      config.autoCompact.summaryMaxChars
    );
    if (
      autoCompactBody.retryOnContextError !== undefined ||
      autoCompactBody.autoCompactRetryOnContextError !== undefined
    ) {
      const value =
        autoCompactBody.retryOnContextError !== undefined
          ? autoCompactBody.retryOnContextError
          : autoCompactBody.autoCompactRetryOnContextError;
      config.autoCompact.retryOnContextError = Boolean(value);
    }
    config.autoCompact.maxRetries = parseIntSetting(
      autoCompactBody.maxRetries ?? autoCompactBody.autoCompactMaxRetries,
      "autoCompact.maxRetries",
      0,
      2,
      config.autoCompact.maxRetries
    );
    if (
      autoCompactBody.summarizerEnabled !== undefined ||
      autoCompactBody.autoCompactSummarizerEnabled !== undefined
    ) {
      const value =
        autoCompactBody.summarizerEnabled !== undefined
          ? autoCompactBody.summarizerEnabled
          : autoCompactBody.autoCompactSummarizerEnabled;
      config.autoCompact.summarizerEnabled = Boolean(value);
    }
    if (
      typeof autoCompactBody.summarizerModel === "string" ||
      typeof autoCompactBody.autoCompactSummarizerModel === "string"
    ) {
      const value = String(
        autoCompactBody.summarizerModel ?? autoCompactBody.autoCompactSummarizerModel ?? ""
      ).trim();
      if (!value) {
        throw new Error("autoCompact.summarizerModel must not be empty.");
      }
      config.autoCompact.summarizerModel = value;
    }
    config.autoCompact.summarizerTimeoutMs = parseIntSetting(
      autoCompactBody.summarizerTimeoutMs ?? autoCompactBody.autoCompactSummarizerTimeoutMs,
      "autoCompact.summarizerTimeoutMs",
      1000,
      60000,
      config.autoCompact.summarizerTimeoutMs
    );
    if (!(config.autoCompact.l1Ratio <= config.autoCompact.l2Ratio && config.autoCompact.l2Ratio <= config.autoCompact.l3Ratio)) {
      throw new Error("autoCompact ratios must satisfy: l1Ratio <= l2Ratio <= l3Ratio.");
    }

    res.json({
      ok: true,
      config: {
        authMode: config.authMode,
        upstreamMode: config.upstreamMode,
        upstreamBaseUrl: getActiveUpstreamBaseUrl(),
        defaultModel: config.codex.defaultModel,
        defaultInstructions: config.codex.defaultInstructions,
        defaultReasoningEffort: config.codex.defaultReasoningEffort,
        sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
        multiAccountEnabled: isCodexMultiAccountEnabled(),
        multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
        preheatCooldownSeconds: config.codexPreheat.cooldownSeconds,
        preheatBatchSize: config.codexPreheat.batchSize,
        preheatMinPrimaryRemaining: config.codexPreheat.minPrimaryRemaining,
        preheatMinSecondaryRemaining: config.codexPreheat.minSecondaryRemaining,
        modelRouterEnabled: config.modelRouter.enabled,
        modelMappings: config.modelRouter.customMappings,
        publicAccess: {
          mode: cloudflaredRuntime.mode || config.publicAccess.defaultMode,
          useHttp2: cloudflaredRuntime.useHttp2 !== false,
          autoInstall: config.publicAccess.autoInstall !== false,
          localPort: Number(cloudflaredRuntime.localPort || config.port)
        },
        autoCompact: {
          enabled: config.autoCompact.enabled !== false,
          mode: config.autoCompact.mode,
          triggerRatio: config.autoCompact.triggerRatio,
          l1Ratio: config.autoCompact.l1Ratio,
          l2Ratio: config.autoCompact.l2Ratio,
          l3Ratio: config.autoCompact.l3Ratio,
          keepLastTurns: config.autoCompact.keepLastTurns,
          keepLastToolRounds: config.autoCompact.keepLastToolRounds,
          toolOutputMaxChars: config.autoCompact.toolOutputMaxChars,
          summaryMaxChars: config.autoCompact.summaryMaxChars,
          retryOnContextError: config.autoCompact.retryOnContextError !== false,
          maxRetries: config.autoCompact.maxRetries,
          summarizerEnabled: config.autoCompact.summarizerEnabled === true,
          summarizerModel: config.autoCompact.summarizerModel,
          summarizerTimeoutMs: config.autoCompact.summarizerTimeoutMs
        }
      }
    });
  } catch (err) {
    res.status(400).json({ error: "invalid_config", message: err.message });
  }
});

app.post("/admin/test", async (req, res) => {
  try {
    const body = parseJsonBody(req);
    const prompt =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : "Reply with one short sentence: proxy test passed.";
    const result = await runDirectChatCompletionTest(prompt);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: "test_failed", message: err.message });
  }
});


app.get("/v1/models", async (req, res) => {
  if (isAnthropicNativeRequest(req)) {
    await handleAnthropicModelsList(req, res);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const models = getOpenAICompatibleModelIds().map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "codex-oauth-proxy"
  }));
  res.json({
    object: "list",
    data: models
  });
});

app.use((req, res, next) => {
  const pathName = String(req.path || req.originalUrl || req.url || "");
  if (!isProxyApiPath(pathName)) {
    next();
    return;
  }

  const startedAt = Date.now();
  const reqContentType = parseContentType(req.headers?.["content-type"]);
  const requestPacket = formatPayloadForAudit(req.rawBody, reqContentType);

  const responseChunks = [];
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  function captureResponseChunk(chunk, encoding) {
    if (chunk === undefined || chunk === null) return;
    if (responseBytes >= RUNTIME_AUDIT_MAX_BODY_BYTES) return;
    const buffer = toChunkBuffer(chunk, encoding);
    if (!buffer || buffer.length === 0) return;
    const remaining = RUNTIME_AUDIT_MAX_BODY_BYTES - responseBytes;
    if (remaining <= 0) return;
    const clipped = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    responseChunks.push(clipped);
    responseBytes += clipped.length;
  }

  res.write = function patchedWrite(chunk, encoding, cb) {
    captureResponseChunk(chunk, encoding);
    return originalWrite(chunk, encoding, cb);
  };
  res.end = function patchedEnd(chunk, encoding, cb) {
    captureResponseChunk(chunk, encoding);
    return originalEnd(chunk, encoding, cb);
  };

  res.on("finish", () => {
    const modelRoute = res.locals?.modelRoute || null;
    const authAccountId = res.locals?.authAccountId || null;
    const authAccountLabel = resolveAuditAccountLabel(authAccountId);
    const responseContentType = parseContentType(res.getHeader("content-type"));
    const responsePacket = formatPayloadForAudit(Buffer.concat(responseChunks), responseContentType);
    const rawPath = req.originalUrl || req.url || "";
    const safePath = sanitizeAuditPath(rawPath);
    const protocolType = inferProtocolType(safePath, res.locals?.protocolType);
    const autoCompact = res.locals?.autoCompact || null;
    const tokenUsage =
      normalizeTokenUsage(res.locals?.tokenUsage) ||
      extractTokenUsageFromAuditResponse({
        protocolType,
        responseContentType,
        responsePacket
      });

    runtimeStats.totalRequests += 1;
    if (res.statusCode >= 200 && res.statusCode < 400) runtimeStats.okRequests += 1;
    else runtimeStats.errorRequests += 1;

    runtimeStats.recentRequests.unshift({
      id: `req_${Date.now().toString(36)}_${(runtimeRequestSeq += 1).toString(36)}`,
      ts: Date.now(),
      method: req.method,
      path: safePath,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      inputTokens: tokenUsage?.inputTokens ?? null,
      outputTokens: tokenUsage?.outputTokens ?? null,
      totalTokens: tokenUsage?.totalTokens ?? null,
      requestedModel: modelRoute?.requestedModel ?? null,
      mappedModel: modelRoute?.mappedModel ?? null,
      routeType: modelRoute?.routeType ?? null,
      routeRule: modelRoute?.routeRule ?? null,
      protocolType,
      upstreamMode: config.upstreamMode,
      autoCompactApplied: autoCompact?.applied === true,
      autoCompactLevel: Number.isFinite(Number(autoCompact?.level)) ? Number(autoCompact.level) : 0,
      autoCompactRetry: autoCompact?.retryTriggered === true,
      autoCompactReason: String(autoCompact?.reason || ""),
      autoCompactMeta: autoCompact || null,
      authAccountId,
      authAccountLabel: authAccountLabel || null,
      requestContentType: reqContentType || null,
      responseContentType: responseContentType || null,
      requestPacket: requestPacket || "",
      responsePacket: responsePacket || ""
    });

    if (runtimeStats.recentRequests.length > 120) runtimeStats.recentRequests.length = 120;
  });

  next();
});

app.use("/v1beta", async (req, res) => {
  await handleGeminiNativeProxy(req, res);
});

app.use("/v1/messages", async (req, res) => {
  await handleAnthropicNativeProxy(req, res);
});

app.use("/v1", async (req, res) => {
  res.locals.protocolType = "openai-v1";
  const incoming = new URL(req.originalUrl, "http://localhost");

  if (isGeminiNativeAliasPath(incoming.pathname)) {
    res.locals.protocolType = "gemini-v1beta-native";
    const aliasedOriginalUrl = req.originalUrl.replace(/^\/v1\/models\//, "/v1beta/models/");
    const previousOriginalUrl = req.originalUrl;
    req.originalUrl = aliasedOriginalUrl;
    try {
      await handleGeminiNativeProxy(req, res);
    } finally {
      req.originalUrl = previousOriginalUrl;
    }
    return;
  }

  const selectedProtocol =
    incoming.pathname === "/v1/chat/completions" && req.method === "POST"
      ? chooseProtocolForV1ChatCompletions(req)
      : config.upstreamMode;

  if (selectedProtocol === "gemini-v1beta") {
    await handleGeminiProtocol(req, res);
    return;
  }

  if (selectedProtocol === "anthropic-v1") {
    await handleAnthropicProtocol(req, res);
    return;
  }

  let auth;
  try {
    auth = await getValidAuthContext();
    res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
  } catch (err) {
    res.status(401).json({
      error: "unauthorized",
      message: err.message,
      hint:
        config.authMode === "profile-store"
          ? "Run `your external auth tool login flow` first."
          : "Open /auth/login first."
    });
    return;
  }

  let target;
  try {
    target = buildUpstreamTarget(req.originalUrl);
  } catch (err) {
    res.status(400).json({
      error: "unsupported_endpoint",
      message: err.message
    });
    return;
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (!hopByHop.has(k.toLowerCase()) && typeof v === "string") {
      headers.set(k, v);
    }
  }
  const applyAuthHeaders = (ctx) => {
    headers.set("authorization", `Bearer ${ctx.accessToken}`);
    if (config.upstreamMode !== "codex-chatgpt") return true;
    if (!ctx.accountId) return false;
    headers.set("chatgpt-account-id", ctx.accountId);
    if (!headers.has("openai-beta")) headers.set("openai-beta", "responses=experimental");
    if (!headers.has("originator")) headers.set("originator", getCodexOriginator());
    if (!headers.has("user-agent")) headers.set("user-agent", "codex-oauth-proxy");
    if (!headers.has("accept")) headers.set("accept", "text/event-stream");
    return true;
  };
  if (!applyAuthHeaders(auth)) {
    res.status(401).json({
      error: "missing_account_id",
      message: "Could not extract chatgpt_account_id from OAuth token."
    });
    return;
  }

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };

  let collectCompletedResponseAsJson = false;
  let streamChatCompletionsAsSse = false;
  let responseShape = "responses";
  let responseModel = config.codex.defaultModel;
  let autoCompactMeta = buildAutoCompactMetaBase("not_applicable");
  let autoCompactSourceBody = null;
  let autoCompactRetryCount = 0;
  if (req.method !== "GET" && req.method !== "HEAD") {
    let body = req.rawBody || Buffer.alloc(0);

    try {
      if (config.upstreamMode === "codex-chatgpt") {
        if (target.endpointKind === "responses") {
          const normalized = normalizeCodexResponsesRequestBody(body);
          body = normalized.body;
          collectCompletedResponseAsJson = normalized.collectCompletedResponseAsJson;
          responseShape = "responses";
          responseModel = normalized.model || responseModel;
          if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
          if (normalized.autoCompactMeta) autoCompactMeta = normalized.autoCompactMeta;
          autoCompactSourceBody = normalized.autoCompactSource || normalized.parsedBody || null;
          headers.set("content-type", "application/json");
        } else if (target.endpointKind === "chat-completions") {
          const normalized = normalizeChatCompletionsRequestBody(body);
          body = normalized.body;
          streamChatCompletionsAsSse = normalized.wantsStream;
          collectCompletedResponseAsJson = !streamChatCompletionsAsSse;
          responseShape = "chat-completions";
          responseModel = normalized.model || responseModel;
          if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
          if (normalized.autoCompactMeta) autoCompactMeta = normalized.autoCompactMeta;
          autoCompactSourceBody = normalized.autoCompactSource || normalized.parsedBody || null;
          headers.set("content-type", "application/json");
        }
      }
    } catch (err) {
      res.status(400).json({
        error: "invalid_request",
        message: err.message
      });
      return;
    }

    init.body = body;
  }
  res.locals.autoCompact = autoCompactMeta;

  const canRetryWithPool = isCodexPoolRetryEnabled();
  const maxAttempts = canRetryWithPool ? 2 : 1;
  let upstream;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      upstream = await fetch(target.url, init);
    } catch (err) {
      res.status(502).json({
        error: "upstream_unreachable",
        message: err.message
      });
      return;
    }

    const shouldRetry =
      canRetryWithPool &&
      attempt < maxAttempts &&
      shouldRotateCodexAccountForStatus(upstream.status) &&
      Boolean(auth?.poolAccountId);

    if (!shouldRetry) {
      break;
    }

    await maybeMarkCodexPoolFailure(
      auth,
      `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}`,
      upstream.status
    ).catch(() => {});

    let nextAuth;
    try {
      nextAuth = await getValidAuthContext();
    } catch {
      break;
    }
    if (!applyAuthHeaders(nextAuth)) {
      break;
    }
    auth = nextAuth;
    res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
  }

  if (!upstream) {
    res.status(502).json({
      error: "upstream_unreachable",
      message: "No upstream response received."
    });
    return;
  }

  let upstreamErrorText = null;
  if (
    !upstream.ok &&
    config.upstreamMode === "codex-chatgpt" &&
    config.autoCompact.enabled !== false &&
    config.autoCompact.retryOnContextError !== false &&
    autoCompactSourceBody &&
    Number(config.autoCompact.maxRetries || 0) > 0
  ) {
    upstreamErrorText = await upstream.text();
    const maxCompactRetries = Math.max(0, Math.floor(Number(config.autoCompact.maxRetries || 0)));
    let canContinueRetry = isContextLengthExceededError(upstream.status, upstreamErrorText);

    while (canContinueRetry && autoCompactRetryCount < maxCompactRetries) {
      const currentLevel = Number(autoCompactMeta?.level || 0);
      const nextLevel = normalizeCompactLevelForRetry(currentLevel);
      if (nextLevel <= currentLevel || nextLevel > 3) break;

      autoCompactRetryCount += 1;
      const retryCompact = applyAutoCompactToResponsesPayload(autoCompactSourceBody, config.autoCompact, {
        forceLevel: nextLevel,
        reason: "context_retry",
        retryCount: autoCompactRetryCount
      });
      autoCompactMeta = retryCompact.meta;
      res.locals.autoCompact = autoCompactMeta;
      init.body = Buffer.from(JSON.stringify(retryCompact.body), "utf8");

      try {
        upstream = await fetch(target.url, init);
      } catch (err) {
        res.status(502).json({
          error: "upstream_unreachable",
          message: err.message
        });
        return;
      }

      if (upstream.ok) {
        upstreamErrorText = null;
        break;
      }

      upstreamErrorText = await upstream.text();
      canContinueRetry = isContextLengthExceededError(upstream.status, upstreamErrorText);
    }
  }

  await maybeCaptureCodexUsageFromHeaders(auth, upstream.headers, "response").catch(() => {});

  if (upstream.ok) {
    await maybeMarkCodexPoolSuccess(auth).catch(() => {});
  }

  if (collectCompletedResponseAsJson) {
    const raw = upstreamErrorText !== null ? upstreamErrorText : await upstream.text();
    if (!upstream.ok) {
      await maybeMarkCodexPoolFailure(
        auth,
        `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
        upstream.status
      ).catch(() => {});
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!hopByHop.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.send(raw);
      return;
    }

    const completed = extractCompletedResponseFromSse(raw);
    if (!completed) {
      res.status(502).json({
        error: "invalid_upstream_sse",
        message: "Could not parse completed response from codex SSE stream."
      });
      return;
    }
    if (responseShape === "chat-completions") {
      const converted = convertResponsesToChatCompletion(completed);
      converted.model = responseModel;
      res.locals.tokenUsage = converted.usage;
      res.status(200).json(converted);
    } else {
      completed.model = responseModel;
      res.locals.tokenUsage = completed.usage || null;
      res.status(200).json(completed);
    }
    return;
  }

  if (streamChatCompletionsAsSse) {
    if (!upstream.ok) {
      const raw = upstreamErrorText !== null ? upstreamErrorText : await upstream.text();
      await maybeMarkCodexPoolFailure(
        auth,
        `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
        upstream.status
      ).catch(() => {});
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!hopByHop.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.send(raw);
      return;
    }

    try {
      const streamResult = await pipeCodexSseAsChatCompletions(upstream, res, responseModel);
      if (streamResult?.usage) {
        res.locals.tokenUsage = streamResult.usage;
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({
          error: "invalid_upstream_sse",
          message: err.message
        });
      } else {
        res.end();
      }
    }
    return;
  }

  res.status(upstream.status);
  if (!upstream.ok) {
    const raw = upstreamErrorText !== null ? upstreamErrorText : await upstream.text();
    await maybeMarkCodexPoolFailure(
      auth,
      `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
      upstream.status
    ).catch(() => {});
    upstream.headers.forEach((value, key) => {
      if (!hopByHop.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.send(raw);
    return;
  }
  upstream.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
});

const mainServer = app.listen(config.port, config.host, () => {
  console.log(`codex-oauth-proxy listening on http://${config.host}:${config.port}`);
  console.log(`mode:   ${config.authMode}`);
  console.log(`upstream-mode: ${config.upstreamMode}`);
  console.log(`upstream-url:  ${getActiveUpstreamBaseUrl()}`);
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
});

mainServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[startup] Port ${config.host}:${config.port} is already in use. ` +
      `Stop the existing process or run with a different PORT.`
    );
    process.exit(1);
    return;
  }
  console.error(`[startup] Failed to start server: ${err?.message || err}`);
  process.exit(1);
});

let gracefulExitStarted = false;
async function gracefulShutdown(signal = "SIGTERM") {
  if (gracefulExitStarted) return;
  gracefulExitStarted = true;
  console.log(`[shutdown] received ${signal}, cleaning up...`);
  try {
    if (proxyApiKeyStoreFlushTimer) {
      clearTimeout(proxyApiKeyStoreFlushTimer);
      proxyApiKeyStoreFlushTimer = null;
    }
    await saveProxyApiKeyStore(config.apiKeys.storePath, proxyApiKeyStore).catch(() => {});
    await stopCloudflaredTunnel().catch(() => {});
  } finally {
    mainServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1200).unref();
  }
}
process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(() => process.exit(0));
});
process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(() => process.exit(0));
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

async function getValidAuthContext() {
  const allowCache = !(config.authMode === "codex-oauth" && isCodexMultiAccountEnabled());
  if (allowCache) {
    const cached = getCachedAuthContext();
    if (cached) return cached;
  }

  let context;
  if (config.authMode === "profile-store") {
    context = await getValidAuthContextFromProfileStore();
  } else if (config.authMode === "codex-oauth") {
    context = await getValidAuthContextFromCodexOAuthStore(codexOAuthStore, config.codexOAuth);
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

function buildUpstreamTarget(originalUrl) {
  const incoming = new URL(originalUrl, "http://localhost");
  const endpointKind = getCodexEndpointKind(incoming.pathname);
  if (!endpointKind) {
    throw new Error(
      "In UPSTREAM_MODE=codex-chatgpt, supported endpoints are /v1/responses and /v1/chat/completions."
    );
  }

  let mappedPath;
  if (endpointKind === "responses") {
    if (incoming.pathname === "/v1/codex/responses" || incoming.pathname.startsWith("/v1/codex/responses/")) {
      mappedPath = incoming.pathname.replace(/^\/v1/, "");
    } else {
      mappedPath = incoming.pathname.replace(/^\/v1\/responses/, "/codex/responses");
    }
  } else {
    mappedPath = incoming.pathname.replace(/^\/v1\/chat\/completions/, "/codex/responses");
  }

  const base = config.upstreamBaseUrl.replace(/\/+$/, "");
  return {
    url: `${base}${mappedPath}${incoming.search}`,
    endpointKind
  };
}

function getCodexEndpointKind(pathname) {
  if (
    pathname === "/v1/responses" ||
    pathname.startsWith("/v1/responses/") ||
    pathname === "/v1/codex/responses" ||
    pathname.startsWith("/v1/codex/responses/")
  ) {
    return "responses";
  }
  if (pathname === "/v1/chat/completions" || pathname.startsWith("/v1/chat/completions/")) {
    return "chat-completions";
  }
  return null;
}

function cloneJsonSafe(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function estimateTextTokensRough(text, multiplier = 1) {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (!source) return 0;
  let asciiCount = 0;
  let cjkCount = 0;
  for (const ch of source) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkCount += 1;
    } else {
      asciiCount += 1;
    }
  }
  const estimate = asciiCount / 4 + cjkCount * 0.65;
  return Math.max(0, Math.ceil(estimate * multiplier));
}

function getModelContextLimitForCompact(modelName) {
  const raw = String(modelName || "").trim().toLowerCase();
  if (!raw) return DEFAULT_COMPACT_MODEL_CONTEXT_LIMIT;
  if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, raw)) {
    return Number(MODEL_CONTEXT_LIMITS[raw]) || DEFAULT_COMPACT_MODEL_CONTEXT_LIMIT;
  }
  if (raw.startsWith("gpt-5")) return 400000;
  if (raw.startsWith("gpt-4.1")) return 128000;
  if (raw.startsWith("gpt-4o")) return 128000;
  if (raw.startsWith("o3")) return 200000;
  if (raw.startsWith("o4-mini")) return 200000;
  return DEFAULT_COMPACT_MODEL_CONTEXT_LIMIT;
}

function collectCompactTextFromItemContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.trim().length > 0) {
      parts.push(part.text);
      continue;
    }
    if (typeof part.input_text === "string" && part.input_text.trim().length > 0) {
      parts.push(part.input_text);
      continue;
    }
    if (typeof part.output_text === "string" && part.output_text.trim().length > 0) {
      parts.push(part.output_text);
      continue;
    }
  }
  return parts.join("\n");
}

function summarizeCompactItem(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "function_call") {
    const name = String(item.name || "").trim() || "unknown_tool";
    const argsText = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? "");
    return `[tool call] ${name}(${truncate(argsText, 240)})`;
  }
  if (item.type === "function_call_output") {
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return `[tool output] ${truncate(output, 240)}`;
  }
  const role = String(item.role || "user").trim().toLowerCase() || "user";
  const text = collectCompactTextFromItemContent(item.content);
  if (!text) return "";
  return `[${role}] ${truncate(text, 300)}`;
}

function buildDeterministicCompactSummary(items, maxChars = 6000) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const userIntents = [];
  const decisions = [];
  const constraints = [];
  const referenced = new Set();
  const todo = [];

  const constraintPattern = /\b(must|should|required|only|do not|don't|禁止|不要|必須|僅能|限制)\b/i;
  const decisionPattern = /\b(implemented|updated|changed|fixed|configured|set|added|removed|switched|migrated)\b/i;
  const todoPattern = /\b(todo|next step|follow up|need to|待辦|下一步|後續|需處理)\b/i;
  const refPattern = /\b[\w./-]+\.(js|ts|json|md|html|css)\b|\b[a-zA-Z_]\w*\([^)]*\)|\b(gpt-[\w.-]+|claude-[\w.-]+|gemini-[\w.-]+)\b/g;

  for (const item of items) {
    const line = summarizeCompactItem(item);
    if (!line) continue;
    const role = String(item?.role || "").toLowerCase();
    if (role === "user") {
      userIntents.push(line);
    } else if (role === "assistant") {
      if (decisionPattern.test(line)) decisions.push(line);
      if (todoPattern.test(line)) todo.push(line);
      if (constraintPattern.test(line)) constraints.push(line);
    } else if (item?.type === "function_call_output") {
      decisions.push(line);
    }
    for (const match of line.matchAll(refPattern)) {
      const token = String(match[0] || "").trim();
      if (!token) continue;
      referenced.add(token);
      if (referenced.size >= 40) break;
    }
  }

  const sections = [];
  if (userIntents.length > 0) sections.push(`User intents:\n- ${userIntents.slice(0, 8).join("\n- ")}`);
  if (decisions.length > 0) sections.push(`Decisions made:\n- ${decisions.slice(0, 8).join("\n- ")}`);
  if (constraints.length > 0) sections.push(`Constraints:\n- ${constraints.slice(0, 8).join("\n- ")}`);
  if (referenced.size > 0) sections.push(`Referenced files/functions/models:\n- ${[...referenced].slice(0, 20).join("\n- ")}`);
  if (todo.length > 0) sections.push(`Outstanding tasks:\n- ${todo.slice(0, 8).join("\n- ")}`);
  if (sections.length === 0) {
    sections.push(`History notes:\n- ${items.map((item) => summarizeCompactItem(item)).filter(Boolean).slice(0, 12).join("\n- ")}`);
  }

  const summary = `[auto compact summary]\n${sections.join("\n\n")}`.trim();
  return truncate(summary, Math.max(500, Number(maxChars) || 6000));
}

function appendCompactSummaryToInstructions(instructions, summaryText, levelLabel) {
  const summary = String(summaryText || "").trim();
  if (!summary) return String(instructions || "");
  const base = String(instructions || "").trim();
  const marker = levelLabel ? `\n\n[auto compact ${levelLabel}]\n` : "\n\n";
  return `${base}${marker}${summary}`.trim();
}

function getLastNToolCallIds(items, keepCount) {
  if (!Array.isArray(items) || !Number.isFinite(keepCount) || keepCount <= 0) return new Set();
  const callIds = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call") continue;
    const callId = String(item.call_id || "").trim();
    if (!callId) continue;
    callIds.push(callId);
  }
  const kept = callIds.slice(-Math.max(0, Math.floor(keepCount)));
  return new Set(kept);
}

function truncateToolOutputText(text, maxChars) {
  const source = typeof text === "string" ? text : JSON.stringify(text ?? "");
  const limit = Math.max(1000, Number(maxChars) || 12000);
  if (source.length <= limit) return { text: source, trimmed: false, removedChars: 0 };
  const head = Math.max(500, Math.floor(limit * 0.66));
  const tail = Math.max(320, limit - head);
  const omitted = Math.max(0, source.length - head - tail);
  return {
    text: `${source.slice(0, head)}\n...[auto compact omitted ${omitted} chars]...\n${source.slice(-tail)}`,
    trimmed: true,
    removedChars: omitted
  };
}

function estimateConversationPressure(payload, options = config.autoCompact) {
  const body = payload && typeof payload === "object" ? payload : {};
  const inputItems = Array.isArray(body.input) ? body.input : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = String(body.model || config.codex.defaultModel || "").trim();
  const modelContextLimit = getModelContextLimitForCompact(model);

  let estimatedTokens = 0;
  let estimatedChars = 0;
  let toolCallCount = 0;
  let toolOutputChars = 0;
  let imageCount = 0;

  const instructions = String(body.instructions || "").trim();
  if (instructions) {
    estimatedChars += instructions.length;
    estimatedTokens += estimateTextTokensRough(instructions, 1.05);
  }

  if (tools.length > 0) {
    const toolsJson = JSON.stringify(tools);
    estimatedChars += toolsJson.length;
    estimatedTokens += estimateTextTokensRough(toolsJson, 1.15);
  }

  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    const jsonText = JSON.stringify(item);
    estimatedChars += jsonText.length;
    let multiplier = 1.0;
    if (item.type === "function_call") {
      toolCallCount += 1;
      multiplier = 1.1;
    } else if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      toolOutputChars += output.length;
      multiplier = 1.15;
    }
    estimatedTokens += estimateTextTokensRough(jsonText, multiplier);

    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const partType = String(part.type || "").toLowerCase();
        const hasImage =
          partType.includes("image") ||
          typeof part.image_url === "string" ||
          typeof part.image_url?.url === "string";
        if (hasImage) {
          imageCount += 1;
          estimatedTokens += 900;
        }
      }
    }
  }

  estimatedTokens += Math.ceil(inputItems.length * 6);
  estimatedTokens += Math.ceil(tools.length * 12);

  const ratio = modelContextLimit > 0 ? estimatedTokens / modelContextLimit : 0;
  return {
    estimatedTokens,
    estimatedChars,
    messageCount: inputItems.length,
    toolCallCount,
    toolOutputChars,
    imageCount,
    ratio,
    modelContextLimit
  };
}

function applyCompactLevel1(body, options, meta) {
  if (!Array.isArray(body.input)) return body;
  const keepRounds = Math.max(0, Number(options.keepLastToolRounds) || 0);
  if (keepRounds <= 0) return body;
  const keepIds = getLastNToolCallIds(body.input, keepRounds);
  if (keepIds.size === 0) return body;
  const allCallIds = new Set();
  for (const item of body.input) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "function_call") continue;
    const callId = String(item.call_id || "").trim();
    if (callId) allCallIds.add(callId);
  }
  const removedIds = new Set([...allCallIds].filter((id) => !keepIds.has(id)));
  if (removedIds.size === 0) return body;

  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object") return true;
    if (item.type !== "function_call" && item.type !== "function_call_output") return true;
    const callId = String(item.call_id || "").trim();
    if (!callId) return true;
    return keepIds.has(callId);
  });
  meta.removedToolRounds += removedIds.size;
  meta.keptToolRounds = keepIds.size;
  return body;
}

function applyCompactLevel2(body, options, meta) {
  if (!Array.isArray(body.input)) return body;
  const input = body.input;
  const messageIndexes = [];
  const oldItemsForSummary = [];

  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      const truncated = truncateToolOutputText(output, options.toolOutputMaxChars);
      if (truncated.trimmed) {
        meta.trimmedToolOutputs += 1;
        item.output = truncated.text;
      }
      continue;
    }
    if (item.role === "user" || item.role === "assistant") {
      messageIndexes.push(i);
    }
  }

  const keepTurns = Math.max(1, Number(options.keepLastTurns) || 6);
  const keepMessageIndexes = new Set(messageIndexes.slice(-keepTurns));
  const compactedInput = [];
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") {
      compactedInput.push(item);
      continue;
    }
    const isMessage = item.role === "user" || item.role === "assistant";
    if (isMessage && !keepMessageIndexes.has(i)) {
      oldItemsForSummary.push(item);
      continue;
    }
    compactedInput.push(item);
  }
  body.input = compactedInput;
  if (oldItemsForSummary.length > 0) {
    meta.summarizedTurns += oldItemsForSummary.length;
    const summary = buildDeterministicCompactSummary(oldItemsForSummary, options.summaryMaxChars);
    if (summary) {
      body.instructions = appendCompactSummaryToInstructions(body.instructions, summary, "level-2");
    }
  }
  return body;
}

function applyCompactLevel3(body, options, meta) {
  if (!Array.isArray(body.input)) return body;
  const input = body.input;
  const keepTurns = Math.max(1, Number(options.keepLastTurns) || 6);
  const keepToolRounds = Math.max(0, Number(options.keepLastToolRounds) || 0);
  const keepToolIds = getLastNToolCallIds(input, keepToolRounds);
  const messageIndexes = [];
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (item && typeof item === "object" && (item.role === "user" || item.role === "assistant")) {
      messageIndexes.push(i);
    }
  }
  const keepMessageIndexes = new Set(messageIndexes.slice(-keepTurns));
  const kept = [];
  const removed = [];
  let lastUserItem = null;

  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") {
      kept.push(item);
      continue;
    }
    if (item.role === "user") lastUserItem = item;

    const isTool = item.type === "function_call" || item.type === "function_call_output";
    if (isTool) {
      const callId = String(item.call_id || "").trim();
      if (!callId || keepToolIds.has(callId)) {
        kept.push(item);
      } else {
        removed.push(item);
      }
      continue;
    }

    const isMessage = item.role === "user" || item.role === "assistant";
    if (isMessage && !keepMessageIndexes.has(i)) {
      removed.push(item);
      continue;
    }
    kept.push(item);
  }

  if (lastUserItem) {
    const hasUser = kept.some((item) => item && typeof item === "object" && item.role === "user");
    if (!hasUser) kept.push(lastUserItem);
  }

  body.input = kept;
  if (removed.length > 0) {
    meta.summarizedTurns += removed.length;
    const summary = buildDeterministicCompactSummary(removed, options.summaryMaxChars);
    if (summary) {
      body.instructions = appendCompactSummaryToInstructions(body.instructions, summary, "level-3");
    }
  }
  return body;
}

function buildAutoCompactMetaBase(reason = "disabled") {
  return {
    enabled: false,
    applied: false,
    level: 0,
    mode: String(config.autoCompact.mode || "deterministic"),
    reason,
    estimatedBefore: null,
    estimatedAfter: null,
    ratioBefore: null,
    ratioAfter: null,
    modelContextLimit: null,
    removedToolRounds: 0,
    keptToolRounds: 0,
    trimmedToolOutputs: 0,
    summarizedTurns: 0,
    retryTriggered: false,
    retryCount: 0
  };
}

function normalizeCompactLevelForRetry(level) {
  const current = Math.max(0, Math.min(3, Math.floor(Number(level) || 0)));
  if (current <= 1) return 2;
  if (current === 2) return 3;
  return 3;
}

function applyAutoCompactToResponsesPayload(body, options = config.autoCompact, extra = {}) {
  const sourceBody = body && typeof body === "object" ? cloneJsonSafe(body) : {};
  const meta = buildAutoCompactMetaBase(extra.reason || "disabled");
  meta.enabled = options.enabled !== false;
  meta.mode = String(options.mode || "deterministic");

  if (options.enabled === false) {
    return { body: sourceBody, meta };
  }
  if (!sourceBody || typeof sourceBody !== "object") {
    meta.reason = "invalid_payload";
    return { body: body, meta };
  }
  if (!Array.isArray(sourceBody.input)) {
    meta.reason = "no_input_array";
    return { body: sourceBody, meta };
  }

  const before = estimateConversationPressure(sourceBody, options);
  meta.estimatedBefore = before.estimatedTokens;
  meta.ratioBefore = Number(before.ratio.toFixed(4));
  meta.modelContextLimit = before.modelContextLimit;

  let targetLevel = 0;
  if (Number.isFinite(Number(extra.forceLevel))) {
    targetLevel = Math.max(0, Math.min(3, Math.floor(Number(extra.forceLevel))));
    meta.reason = extra.reason || "context_retry";
  } else if (before.ratio >= options.l3Ratio) {
    targetLevel = 3;
    meta.reason = "ratio_exceeded_l3";
  } else if (before.ratio >= options.l2Ratio) {
    targetLevel = 2;
    meta.reason = "ratio_exceeded_l2";
  } else if (before.ratio >= options.l1Ratio || before.ratio >= options.triggerRatio) {
    targetLevel = 1;
    meta.reason = "ratio_exceeded_l1";
  }

  if (targetLevel <= 0) {
    const afterNoop = estimateConversationPressure(sourceBody, options);
    meta.estimatedAfter = afterNoop.estimatedTokens;
    meta.ratioAfter = Number(afterNoop.ratio.toFixed(4));
    return { body: sourceBody, meta };
  }

  let working = cloneJsonSafe(sourceBody);
  if (targetLevel >= 1) {
    working = applyCompactLevel1(working, options, meta);
    meta.level = 1;
  }
  if (targetLevel >= 2) {
    working = applyCompactLevel2(working, options, meta);
    meta.level = 2;
  }
  if (targetLevel >= 3) {
    working = applyCompactLevel3(working, options, meta);
    meta.level = 3;
  }

  const after = estimateConversationPressure(working, options);
  meta.estimatedAfter = after.estimatedTokens;
  meta.ratioAfter = Number(after.ratio.toFixed(4));
  meta.applied = meta.level > 0;
  if (extra.retryCount && Number(extra.retryCount) > 0) {
    meta.retryTriggered = true;
    meta.retryCount = Math.max(1, Math.floor(Number(extra.retryCount)));
  }

  return { body: working, meta };
}

function normalizeCodexResponsesRequestBody(rawBody) {
  if (!rawBody || rawBody.length === 0) {
    const modelRoute = resolveCodexCompatibleRoute(config.codex.defaultModel);
    const fallbackInstructions = config.codex.defaultInstructions;
    const fallbackRaw = {
      model: modelRoute.mappedModel,
      stream: true,
      store: false,
      instructions: fallbackInstructions,
      reasoning: {
        effort: resolveReasoningEffort(undefined, {
          input: [{ role: "user", content: [{ type: "input_text", text: "" }] }],
          instructions: fallbackInstructions
        }, modelRoute.mappedModel)
      },
      input: [{ role: "user", content: [{ type: "input_text", text: "" }] }]
    };
    const compactResult = applyAutoCompactToResponsesPayload(fallbackRaw, config.autoCompact, {
      reason: "empty_body_default"
    });
    const fallback = compactResult.body;
    return {
      body: Buffer.from(JSON.stringify(fallback), "utf8"),
      collectCompletedResponseAsJson: true,
      model: modelRoute.requestedModel,
      modelRoute,
      parsedBody: fallback,
      autoCompactSource: fallbackRaw,
      autoCompactMeta: compactResult.meta
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return {
      body: rawBody,
      collectCompletedResponseAsJson: false,
      autoCompactMeta: buildAutoCompactMetaBase("invalid_json")
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      body: rawBody,
      collectCompletedResponseAsJson: false,
      model: config.codex.defaultModel,
      modelRoute: null,
      autoCompactMeta: buildAutoCompactMetaBase("invalid_json_object")
    };
  }

  const wantsStream = parsed.stream === true;
  const normalized = { ...parsed };
  const modelRoute = resolveCodexCompatibleRoute(normalized.model || config.codex.defaultModel);
  normalized.model = modelRoute.mappedModel;
  normalized.stream = true;
  if (normalized.store === undefined) normalized.store = false;
  if (!normalized.instructions || String(normalized.instructions).trim() === "") {
    normalized.instructions = config.codex.defaultInstructions;
  }
  if (normalized.input === undefined && Array.isArray(normalized.messages)) {
    normalized.input = toResponsesInputFromChatMessages(normalized.messages);
  }
  if (Array.isArray(normalized.input)) {
    normalized.input = toResponsesInputFromChatMessages(normalized.input);
  }
  applyReasoningEffortDefaults(normalized, normalized.reasoning_effort, {
    input: normalized.input,
    tools: normalized.tools,
    instructions: normalized.instructions
  }, modelRoute.mappedModel);
  delete normalized.messages;
  delete normalized.reasoning_effort;

  const compactSource = cloneJsonSafe(normalized);
  const compactResult = applyAutoCompactToResponsesPayload(normalized, config.autoCompact, {
    reason: "ratio_check"
  });
  const compacted = compactResult.body;

  return {
    body: Buffer.from(JSON.stringify(compacted), "utf8"),
    collectCompletedResponseAsJson: !wantsStream,
    model: modelRoute.requestedModel,
    modelRoute,
    parsedBody: compacted,
    autoCompactSource: compactSource,
    autoCompactMeta: compactResult.meta
  };
}

function normalizeChatCompletionsRequestBody(rawBody) {
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
  const wantsStream = parsed.stream === true;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const systemMessages = messages
    .filter((msg) => msg && (msg.role === "system" || msg.role === "developer"))
    .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
    .filter((text) => text.length > 0);

  const modelRoute = resolveCodexCompatibleRoute(parsed.model || config.codex.defaultModel);
  const upstreamBodyRaw = {
    model: modelRoute.mappedModel,
    stream: true,
    store: false,
    instructions: systemMessages.join("\n\n") || config.codex.defaultInstructions,
    reasoning: {
      effort: resolveReasoningEffort(parsed.reasoning_effort, {
        messages,
        tools: parsed.tools,
        tool_choice: parsed.tool_choice,
        instructions: systemMessages.join("\n\n") || config.codex.defaultInstructions
      }, modelRoute.mappedModel)
    },
    input: toResponsesInputFromChatMessages(messages)
  };

  if (parsed.temperature !== undefined) upstreamBodyRaw.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) upstreamBodyRaw.top_p = parsed.top_p;
  // Some upstream Codex deployments reject max_output_tokens; keep compatibility by omitting it.
  if (parsed.tool_choice !== undefined) upstreamBodyRaw.tool_choice = normalizeChatToolChoice(parsed.tool_choice);
  if (parsed.tools !== undefined) upstreamBodyRaw.tools = normalizeChatTools(parsed.tools);

  const compactResult = applyAutoCompactToResponsesPayload(upstreamBodyRaw, config.autoCompact, {
    reason: "ratio_check"
  });
  const upstreamBody = compactResult.body;

  return {
    body: Buffer.from(JSON.stringify(upstreamBody), "utf8"),
    wantsStream,
    model: modelRoute.requestedModel,
    modelRoute,
    parsedBody: upstreamBody,
    autoCompactSource: upstreamBodyRaw,
    autoCompactMeta: compactResult.meta
  };
}

function toResponsesInputFromChatMessages(messages) {
  const converted = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;

    if (raw.type === "function_call" || raw.type === "function_call_output") {
      converted.push(raw);
      continue;
    }

    if (raw.role === "system" || raw.role === "developer") continue;

    if (raw.role === "assistant" && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      const assistantText = normalizeChatMessageContent(raw.content, "assistant");
      if (assistantText.length > 0) {
        converted.push({
          role: "assistant",
          content: assistantText
        });
      }

      for (const toolCall of raw.tool_calls) {
        if (!toolCall || toolCall.type !== "function") continue;
        const callId =
          typeof toolCall.id === "string" && toolCall.id.length > 0
            ? toolCall.id
            : `call_${crypto.randomUUID().replace(/-/g, "")}`;
        const name = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
        const argumentsText =
          typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "{}";
        if (!name) continue;

        converted.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: argumentsText
        });
      }
      continue;
    }

    if (raw.role === "tool") {
      const callId = typeof raw.tool_call_id === "string" ? raw.tool_call_id : "";
      if (!callId) continue;
      const output = extractToolOutputText(raw.content);
      converted.push({
        type: "function_call_output",
        call_id: callId,
        output
      });
      continue;
    }

    const role = normalizeChatRole(raw.role);
    const normalizedContent = normalizeChatMessageContent(raw.content, role);
    if (normalizedContent.length === 0) continue;
    converted.push({
      role,
      content: normalizedContent
    });
  }

  if (converted.length > 0) return converted;
  return [{ role: "user", content: [{ type: "input_text", text: "" }] }];
}

function normalizeChatRole(role) {
  if (role === "assistant") return "assistant";
  return "user";
}

function normalizeChatMessageContent(content, role) {
  const targetType = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    return [{ type: targetType, text: content }];
  }

  if (content && typeof content === "object" && !Array.isArray(content)) {
    content = [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const converted = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "refusal" && role === "assistant") {
      const refusalText =
        typeof item.refusal === "string" ? item.refusal : typeof item.text === "string" ? item.text : "";
      if (refusalText) converted.push({ type: "refusal", refusal: refusalText });
      continue;
    }

    if (role !== "assistant" && (item.type === "image_url" || item.type === "input_image")) {
      const imageUrl =
        typeof item.image_url === "string"
          ? item.image_url
          : typeof item.image_url?.url === "string"
            ? item.image_url.url
            : "";
      if (imageUrl) converted.push({ type: "input_image", image_url: imageUrl });
      continue;
    }

    const text =
      typeof item.text === "string" ? item.text : typeof item.output_text === "string" ? item.output_text : "";
    if (!text) continue;

    if (item.type === "text" || item.type === "input_text" || item.type === "output_text") {
      converted.push({ type: targetType, text });
      continue;
    }
  }
  return converted;
}

function extractToolOutputText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (typeof item.output_text === "string") {
      parts.push(item.output_text);
      continue;
    }
  }
  if (parts.length > 0) return parts.join("");
  return JSON.stringify(content);
}

function normalizeChatTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const name = typeof tool.function.name === "string" ? tool.function.name : "";
      if (!name) continue;
      converted.push({
        type: "function",
        name,
        ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
        ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
      });
      continue;
    }
    converted.push(tool);
  }
  return converted;
}

function normalizeChatToolChoice(toolChoice) {
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.type === "function" &&
    toolChoice.function &&
    typeof toolChoice.function === "object"
  ) {
    const name = typeof toolChoice.function.name === "string" ? toolChoice.function.name : "";
    if (!name) return "auto";
    return { type: "function", name };
  }
  return toolChoice;
}

function extractCompletedResponseFromSse(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) return null;

  let completed = null;
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }

    if (
      (parsed.type === "response.completed" || parsed.type === "response.done") &&
      parsed.response &&
      typeof parsed.response === "object"
    ) {
      completed = parsed.response;
    }
  }

  return completed;
}

function extractCompletedResponseFromJson(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.response && typeof parsed.response === "object") return parsed.response;
  return parsed;
}

async function pipeCodexSseAsChatCompletions(upstream, res, model) {
  if (!upstream.body) {
    throw new Error("No upstream SSE body.");
  }

  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");

  const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  let emittedAssistantRole = false;
  let emittedDone = false;
  let emittedText = false;
  let emittedToolCalls = false;
  let toolCallCounter = 0;
  let finalUsage = null;
  const functionCallsByItemId = new Map();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";

  const emit = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitAssistantRole = () => {
    if (emittedAssistantRole) return;
    emittedAssistantRole = true;
    emit({
      id: completionId,
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
  };

  const emitToolCallChunk = (toolCallIndex, callId, name, argumentsDelta) => {
    emitAssistantRole();
    emittedToolCalls = true;
    const functionPayload = {};
    if (typeof name === "string" && name.length > 0) functionPayload.name = name;
    if (typeof argumentsDelta === "string") functionPayload.arguments = argumentsDelta;

    emit({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolCallIndex,
                ...(callId ? { id: callId } : {}),
                type: "function",
                function: functionPayload
              }
            ]
          },
          finish_reason: null
        }
      ]
    });
  };

  const handleSseBlock = (block) => {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) return;

    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") return;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (event.type === "response.output_text.delta") {
      const deltaText = typeof event.delta === "string" ? event.delta : "";
      if (!deltaText) return;
      emitAssistantRole();
      emittedText = true;
      emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: deltaText },
            finish_reason: null
          }
        ]
      });
      return;
    }

    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      const itemId = event.item.id;
      const callId = typeof event.item.call_id === "string" ? event.item.call_id : "";
      const name = typeof event.item.name === "string" ? event.item.name : "";
      const toolCallIndex = toolCallCounter++;
      if (itemId) {
        functionCallsByItemId.set(itemId, {
          toolCallIndex,
          callId,
          name,
          arguments: ""
        });
      }
      emitToolCallChunk(toolCallIndex, callId, name, "");
      return;
    }

    if (event.type === "response.function_call_arguments.delta") {
      const itemId = event.item_id;
      const tracked = itemId ? functionCallsByItemId.get(itemId) : null;
      if (!tracked) return;
      const deltaText = typeof event.delta === "string" ? event.delta : "";
      if (!deltaText) return;
      tracked.arguments += deltaText;
      emitToolCallChunk(tracked.toolCallIndex, tracked.callId, undefined, deltaText);
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      const itemId = event.item_id;
      const tracked = itemId ? functionCallsByItemId.get(itemId) : null;
      if (!tracked) return;
      if (!tracked.arguments && typeof event.arguments === "string") {
        tracked.arguments = event.arguments;
        emitToolCallChunk(tracked.toolCallIndex, tracked.callId, tracked.name, tracked.arguments);
      }
      return;
    }

    if (event.type === "response.failed") {
      const message = event.response?.error?.message || "Codex response failed.";
      throw new Error(message);
    }

    if (event.type === "response.completed" || event.type === "response.done") {
      if (!emittedToolCalls) {
        emitAssistantRole();
      }
      const finishReason = emittedToolCalls ? "tool_calls" : "stop";
      const chunk = {
        id: completionId,
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
      const usage = mapCodexUsageToChatUsage(event.response?.usage);
      if (usage) {
        finalUsage = usage;
        chunk.usage = usage;
      }
      emit(chunk);
      res.write("data: [DONE]\n\n");
      emittedDone = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      handleSseBlock(block);
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim().length > 0) {
    handleSseBlock(buffer);
  }

  if (!emittedDone) {
    if (!emittedToolCalls) {
      emitAssistantRole();
    }
    const finishReason = emittedToolCalls ? "tool_calls" : "stop";
    emit({
      id: completionId,
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
    });
    res.write("data: [DONE]\n\n");
  }

  res.end();
  return { usage: finalUsage };
}

function mapCodexUsageToChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  };
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = Number(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens
  );
  const outputTokens = Number(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens
  );
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);

  const hasInput = Number.isFinite(inputTokens);
  const hasOutput = Number.isFinite(outputTokens);
  const hasTotal = Number.isFinite(totalTokens);

  if (!hasInput && !hasOutput && !hasTotal) return null;

  return {
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput ? outputTokens : null,
    totalTokens:
      hasTotal
        ? totalTokens
        : (hasInput ? inputTokens : 0) + (hasOutput ? outputTokens : 0)
  };
}

function parseSseUsageFromAuditPayload(packetText, options = {}) {
  if (typeof packetText !== "string" || !packetText.includes("data:")) return null;
  const usageRootPath = String(options.usageRootPath || "").trim();
  let inputTokens = null;
  let outputTokens = null;
  let totalTokens = null;

  const readUsageObject = (event) => {
    if (!event || typeof event !== "object") return null;
    if (!usageRootPath) {
      return (
        event?.usage ||
        event?.usageMetadata ||
        event?.message?.usage ||
        event?.response?.usage ||
        null
      );
    }
    const paths = usageRootPath.split(".").filter(Boolean);
    let cursor = event;
    for (const key of paths) {
      if (!cursor || typeof cursor !== "object") return null;
      cursor = cursor[key];
    }
    return cursor || null;
  };

  for (const line of packetText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = readUsageObject(parsed);
    if (!usage || typeof usage !== "object") continue;

    const nextInput = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount);
    const nextOutput = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount);
    const nextTotal = Number(usage.total_tokens ?? usage.totalTokenCount);

    if (Number.isFinite(nextInput)) inputTokens = nextInput;
    if (Number.isFinite(nextOutput)) outputTokens = nextOutput;
    if (Number.isFinite(nextTotal)) totalTokens = nextTotal;
  }

  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens) && !Number.isFinite(totalTokens)) {
    return null;
  }

  const normalized = normalizeTokenUsage({
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : undefined,
    total_tokens:
      Number.isFinite(totalTokens)
        ? totalTokens
        : (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)
  });
  return normalized;
}

function extractTokenUsageFromAuditResponse({ protocolType, responseContentType, responsePacket }) {
  if (!responsePacket || typeof responsePacket !== "string") return null;
  const contentType = String(responseContentType || "").toLowerCase();
  const protocol = String(protocolType || "").toLowerCase();

  if (contentType.includes("json") || responsePacket.trim().startsWith("{") || responsePacket.trim().startsWith("[")) {
    const parsed = parseJsonLoose(responsePacket);
    if (!parsed || typeof parsed !== "object") return null;

    const jsonUsage =
      parsed?.usage ||
      parsed?.response?.usage ||
      parsed?.usageMetadata ||
      parsed?.message?.usage ||
      parsed?.error?.usage ||
      null;
    const normalizedJsonUsage = normalizeTokenUsage(jsonUsage);
    if (normalizedJsonUsage) return normalizedJsonUsage;
  }

  if (!contentType.includes("event-stream")) return null;

  // OpenAI/Codex responses SSE (`response.completed` / `response.done`)
  const completed = extractCompletedResponseFromSse(responsePacket);
  const completedUsage = normalizeTokenUsage(completed?.usage);
  if (completedUsage) return completedUsage;

  // Anthropic native SSE embeds usage under `message.usage` (message_start) and `usage` (message_delta).
  if (protocol.includes("anthropic")) {
    const anthropicUsage =
      parseSseUsageFromAuditPayload(responsePacket) ||
      parseSseUsageFromAuditPayload(responsePacket, { usageRootPath: "message.usage" });
    if (anthropicUsage) return anthropicUsage;
  }

  // Gemini-style streamed payloads may emit `usageMetadata`.
  if (protocol.includes("gemini")) {
    const geminiUsage = parseSseUsageFromAuditPayload(responsePacket);
    if (geminiUsage) return geminiUsage;
  }

  return null;
}

function convertResponsesToChatCompletion(response) {
  const content = extractAssistantTextFromResponse(response);
  const toolCalls = extractAssistantToolCallsFromResponse(response);
  const nowSec = Math.floor(Date.now() / 1000);
  const usage = response?.usage || {};

  const message = {
    role: "assistant",
    content: content.length > 0 ? content : null
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: response?.id || `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Number.isFinite(response?.created_at) ? response.created_at : nowSec,
    model: response?.model || config.codex.defaultModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          toolCalls.length > 0 ? "tool_calls" : mapResponsesStatusToChatFinishReason(response?.status)
      }
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    }
  };
}

function extractAssistantTextFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== "message" || item.role !== "assistant") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const chunk of content) {
      if (!chunk || chunk.type !== "output_text" || typeof chunk.text !== "string") continue;
      parts.push(chunk.text);
    }
  }
  return parts.join("");
}

function extractAssistantToolCallsFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = [];
  for (const item of output) {
    if (!item || item.type !== "function_call") continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    calls.push({
      id:
        typeof item.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : `call_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "function",
      function: {
        name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}"
      }
    });
  }
  return calls;
}

function mapResponsesStatusToChatFinishReason(status) {
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "stop";
  return "stop";
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
    try {
      const rawBak = await fs.readFile(`${tokenStorePath}.bak`, "utf8");
      return JSON.parse(rawBak);
    } catch {
      return { token: null };
    }
  }
}

async function saveTokenStore(tokenStorePath, nextStore) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  const backupPath = `${tokenStorePath}.bak`;
  try {
    const previous = await fs.readFile(tokenStorePath, "utf8");
    if (typeof previous === "string" && previous.trim().length > 0) {
      await fs.writeFile(backupPath, previous, "utf8");
    }
  } catch {
    // ignore when no existing file
  }

  const tmpPath = `${tokenStorePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(nextStore, null, 2), "utf8");
  await fs.rename(tmpPath, tokenStorePath);
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
  const expiresInRaw = Number(tokenResponse.expires_in || tokenResponse.expiresIn || 0);
  const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
  const expiresAt = parseTokenExpirySec(
    tokenResponse.expires_at ?? tokenResponse.expiresAt,
    nowSec + expiresIn
  );
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || currentToken?.refresh_token || null,
    token_type: tokenResponse.token_type || "Bearer",
    scope: tokenResponse.scope || null,
    expires_at: expiresAt
  };
}

function parseTokenExpirySec(value, fallbackSec = 0) {
  const fallback = Number.isFinite(Number(fallbackSec)) ? Math.max(0, Math.floor(Number(fallbackSec))) : 0;
  if (value === null || value === undefined) return fallback;

  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.max(0, Math.floor(direct));
  }

  const text = String(value).trim();
  if (!text) return fallback;

  const parsedMs = Date.parse(text);
  if (Number.isFinite(parsedMs) && parsedMs > 0) {
    return Math.max(0, Math.floor(parsedMs / 1000));
  }

  return fallback;
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

  if (src.token?.access_token) {
    const tokenNormalized = normalizeToken(src.token, src.token);
    const accountId = deriveCodexAccountIdFromToken(tokenNormalized);
    const activePlanType = normalizeOpenAICodexPlanType(src?.usage_snapshot?.plan_type);
    const entryId = deriveCodexPoolEntryIdFromToken(tokenNormalized, { planType: activePlanType });
    const idx = out.accounts.findIndex((x) => getCodexPoolEntryId(x) === entryId);
    if (idx >= 0) {
      out.accounts[idx].identity_id = entryId;
      out.accounts[idx].account_id = accountId;
      out.accounts[idx].token = tokenNormalized;
      out.accounts[idx].enabled = out.accounts[idx].enabled !== false;
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
    }
    if (out.active_account_id !== entryId) out.active_account_id = entryId;
    changed = true;
  }

  if (out.accounts.length > 0 && !out.active_account_id) {
    out.active_account_id = getCodexPoolEntryId(out.accounts[0]);
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

  if (out.token !== src.token) changed = true;
  if (!out.token && out.accounts.length > 0) {
    out.token = out.accounts[0].token;
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

function pickCodexAccountCandidates(store) {
  const enabled = getCodexEnabledAccounts(store);
  if (enabled.length === 0) return [];

  const strategy = config.codexOAuth.multiAccountStrategy;
  if (strategy === "smart") {
    const decorated = enabled.map((x) => decorateCodexPoolAccount(x, store.active_account_id || ""));
    const preferred = decorated.filter((x) => x.healthStatus !== "limited" && !x.hardLimited);
    const ranked = (preferred.length > 0 ? preferred : decorated).sort(compareCodexSmartDecorated);
    return ranked.map((x) => x.account);
  }
  if (strategy === "manual") {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeRef = String(store.active_account_id || "").trim();
    const pool = Array.isArray(store.accounts) ? store.accounts : [];
    const activeReady = pool.find(
      (x) => x && x.enabled !== false && Number(x.cooldown_until || 0) <= nowSec && getCodexPoolEntryId(x) === activeRef
    );
    if (activeReady) return [activeReady];
    const activeEnabled = pool.find((x) => x && x.enabled !== false && getCodexPoolEntryId(x) === activeRef);
    if (activeEnabled) return [activeEnabled];
    const fallbackReady = pool.find((x) => x && x.enabled !== false && Number(x.cooldown_until || 0) <= nowSec);
    if (fallbackReady) return [fallbackReady];
    const fallbackEnabled = pool.find((x) => x && x.enabled !== false);
    return fallbackEnabled ? [fallbackEnabled] : [];
  }
  if (strategy === "sticky" && store.active_account_id) {
    const primary = enabled.find((x) => getCodexPoolEntryId(x) === String(store.active_account_id));
    if (primary) {
      const primaryId = getCodexPoolEntryId(primary);
      return [primary, ...enabled.filter((x) => getCodexPoolEntryId(x) !== primaryId)];
    }
  }
  if (strategy === "random") {
    const shuffled = [...enabled];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  const start = Number(store?.rotation?.next_index || 0) % enabled.length;
  return rotateListFromIndex(enabled, start);
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
  const targetEntryId = getCodexPoolEntryId(target);
  if (
    codexOAuthStore.active_account_id === targetEntryId &&
    (tokenInvalidated ||
      (config.codexOAuth.multiAccountStrategy !== "sticky" &&
        config.codexOAuth.multiAccountStrategy !== "manual"))
  ) {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
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
      effort: "none"
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
      "user-agent": "codex-oauth-proxy-usage-probe"
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
      codexOAuthStore.token = codexOAuthStore.accounts?.[0]?.token || codexOAuthStore.token || null;
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

async function getValidAuthContextFromCodexOAuthStore(store, oauthConfig) {
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

  const candidates = pickCodexAccountCandidates(store);
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
        "user-agent": "codex-oauth-proxy-model-catalog"
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
    await handleGeminiNativeCompat(req, res);
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
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 502,
      message: err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await handleGeminiNativeCompat(req, res);
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
  Readable.fromWeb(upstream.body).pipe(res);
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
    await handleAnthropicNativeCompat(req, res);
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
      incoming.pathname === "/v1/messages" &&
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
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    sendAnthropicError(res, {
      httpStatus: 502,
      message: err.message,
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
      await handleAnthropicNativeCompat(req, res);
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
  Readable.fromWeb(upstream.body).pipe(res);
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
    await handleGeminiOpenAICompatWithCodex(req, res);
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
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": String(apiKey)
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 502,
      message: err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await handleGeminiOpenAICompatWithCodex(req, res);
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
    await handleAnthropicOpenAICompatWithCodex(req, res);
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
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(apiKey),
        "anthropic-version": config.anthropic.version
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    res.status(502).json({ error: "upstream_unreachable", message: err.message });
    return;
  }

  const raw = await upstream.text();
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
    stop: parsed.stop,
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
    reasoning_effort: parsed.reasoning_effort
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
  if (value === "tool_calls") return "tool_use";
  if (value === "length") return "max_tokens";
  return "end_turn";
}

function isUnsupportedMaxOutputTokensError(statusCode, rawText) {
  if (Number(statusCode || 0) !== 400) return false;
  const text = String(rawText || "").toLowerCase();
  if (!text) return false;
  return text.includes("unsupported parameter") && text.includes("max_output_tokens");
}

function isContextLengthExceededError(statusCode, rawText) {
  const status = Number(statusCode || 0);
  if (![400, 413].includes(status)) return false;
  const text = String(rawText || "").toLowerCase();
  if (!text) return false;
  return CONTEXT_OVERFLOW_ERROR_PATTERNS.some((pattern) => text.includes(pattern));
}

function compactResponsesInputForRetry(inputItems) {
  if (!Array.isArray(inputItems) || inputItems.length === 0) return [];
  const maxItems = 18;
  const maxChars = 120_000;
  const kept = [];
  let chars = 0;

  for (let i = inputItems.length - 1; i >= 0; i -= 1) {
    const item = inputItems[i];
    const itemLen = JSON.stringify(item ?? "").length;
    const wouldExceedItems = kept.length >= maxItems;
    const wouldExceedChars = chars + itemLen > maxChars;
    if (wouldExceedItems || wouldExceedChars) continue;
    kept.unshift(item);
    chars += itemLen;
  }

  if (kept.length === 0) {
    kept.push(inputItems[inputItems.length - 1]);
  }
  return kept;
}

function collectGeminiTextParts(parts) {
  if (!Array.isArray(parts)) return "";
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string" && part.text.length > 0) {
      texts.push(part.text);
      continue;
    }
    if (part.inlineData || part.inline_data || part.fileData || part.file_data || part.image_url) {
      texts.push("[image]");
    }
  }
  return texts.join("\n");
}

function parseGeminiNativeBody(rawBody, fallbackModel) {
  if (!rawBody || rawBody.length === 0) {
    throw new Error("Gemini request body is required.");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body for Gemini endpoint.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini request body must be a JSON object.");
  }

  const systemText = collectGeminiTextParts(parsed?.systemInstruction?.parts || parsed?.system_instruction?.parts);
  const contents = Array.isArray(parsed.contents) ? parsed.contents : [];
  const conversation = [];
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "").toLowerCase() === "model" ? "assistant" : "user";
    const text = collectGeminiTextParts(item.parts);
    if (text.trim().length === 0) continue;
    conversation.push({ role, text });
  }
  if (conversation.length === 0) {
    conversation.push({ role: "user", text: " " });
  }

  const generationConfig =
    parsed.generationConfig && typeof parsed.generationConfig === "object" ? parsed.generationConfig : {};

  return {
    model: typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model : fallbackModel,
    systemText,
    conversation,
    stream: false,
    max_tokens: generationConfig.maxOutputTokens,
    temperature: generationConfig.temperature,
    top_p: generationConfig.topP,
    stop: Array.isArray(generationConfig.stopSequences)
      ? generationConfig.stopSequences
      : typeof generationConfig.stopSequences === "string"
        ? [generationConfig.stopSequences]
        : undefined
  };
}

function buildGeminiModelDescriptor(model) {
  return {
    name: `models/${model}`,
    version: "proxy-local",
    displayName: model,
    description: "Local Gemini-compatible facade powered by Codex OAuth.",
    inputTokenLimit: 1048576,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    temperature: 1,
    maxTemperature: 2,
    topP: 0.95,
    topK: 40
  };
}

function buildGeminiGenerateContentResponse({ model, text, finishReason, usage }) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: text || "" }]
        },
        finishReason: mapOpenAIFinishReasonToGemini(finishReason),
        index: 0
      }
    ],
    usageMetadata: {
      promptTokenCount: Number(usage?.prompt_tokens || 0),
      candidatesTokenCount: Number(usage?.completion_tokens || 0),
      totalTokenCount: Number(usage?.total_tokens || 0)
    },
    modelVersion: model
  };
}

function sendGeminiSseResponse(res, payload) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function parseAnthropicMessageText(content) {
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
    if (chunk.type === "tool_result") {
      parts.push(parseAnthropicMessageText(chunk.content));
      continue;
    }
    if (chunk.type === "image" || chunk.type === "tool_use") {
      parts.push(`[${chunk.type}]`);
    }
  }
  return parts.join("\n");
}

function parseAnthropicNativeBody(rawBody) {
  if (!rawBody || rawBody.length === 0) {
    throw new Error("Anthropic request body is required.");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Invalid JSON body for Anthropic endpoint.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Anthropic request body must be a JSON object.");
  }

  const conversation = [];
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const text = parseAnthropicMessageText(item.content);
    if (text.trim().length === 0) continue;
    conversation.push({ role, text });
  }
  if (conversation.length === 0) {
    conversation.push({ role: "user", text: " " });
  }

  const systemText = parseAnthropicMessageText(parsed.system);
  const normalizedTools = normalizeAnthropicToolsForCodex(parsed.tools);
  const normalizedToolChoice = normalizeAnthropicToolChoiceForCodex(parsed.tool_choice);
  return {
    model:
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model
        : config.anthropic.defaultModel,
    systemText,
    conversation,
    stream: parsed.stream === true,
    max_tokens: parsed.max_tokens,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    tools: normalizedTools,
    tool_choice: normalizedToolChoice,
    stop: Array.isArray(parsed.stop_sequences)
      ? parsed.stop_sequences
      : typeof parsed.stop_sequence === "string"
        ? [parsed.stop_sequence]
        : undefined
  };
}

function normalizeAnthropicToolsForCodex(tools) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const rawType = typeof tool.type === "string" ? tool.type.trim().toLowerCase() : "";
    if (rawType.startsWith("web_search")) {
      normalized.push({
        type: "web_search",
        search_context_size:
          typeof tool.search_context_size === "string" && tool.search_context_size.trim().length > 0
            ? tool.search_context_size.trim()
            : "medium"
      });
      continue;
    }
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) continue;
    const parameters =
      tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema)
        ? tool.input_schema
        : { type: "object", properties: {} };
    normalized.push({
      type: "function",
      function: {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters
      }
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAnthropicToolChoiceForCodex(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  const choiceType = typeof toolChoice.type === "string" ? toolChoice.type.trim().toLowerCase() : "";
  if (choiceType === "auto") return "auto";
  if (choiceType === "none") return "none";
  if (choiceType === "any") return "required";
  if (choiceType === "tool") {
    const name = typeof toolChoice.name === "string" ? toolChoice.name.trim() : "";
    if (!name) return "auto";
    return {
      type: "function",
      function: {
        name
      }
    };
  }
  return undefined;
}

function buildAnthropicMessageResponse({ model, text, finishReason, usage, toolCalls }) {
  const content = [];
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "text", text });
  }
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue;
      const callId = typeof call.id === "string" && call.id.length > 0
        ? call.id
        : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      if (!name) continue;
      let input = {};
      const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : "";
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
          else input = { value: parsed };
        } catch {
          input = { raw: rawArgs };
        }
      }
      content.push({
        type: "tool_use",
        id: callId,
        name,
        input
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const hasToolUse = content.some((block) => block && block.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : mapOpenAIFinishReasonToAnthropic(finishReason);

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage?.prompt_tokens || 0),
      output_tokens: Number(usage?.completion_tokens || 0)
    }
  };
}

function sendAnthropicMessageAsSse(res, message) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");

  const writeEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent("message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: Number(message?.usage?.input_tokens || 0),
        output_tokens: 0
      }
    }
  });
  const contentBlocks = Array.isArray(message?.content) && message.content.length > 0
    ? message.content
    : [{ type: "text", text: "" }];

  for (let index = 0; index < contentBlocks.length; index += 1) {
    const block = contentBlocks[index] || { type: "text", text: "" };
    if (block.type === "tool_use") {
      writeEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input && typeof block.input === "object" ? block.input : {}
        }
      });
      writeEvent("content_block_stop", { type: "content_block_stop", index });
      continue;
    }

    writeEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" }
    });
    if (typeof block.text === "string" && block.text.length > 0) {
      writeEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: block.text
        }
      });
    }
    writeEvent("content_block_stop", { type: "content_block_stop", index });
  }
  writeEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence
    },
    usage: {
      output_tokens: Number(message?.usage?.output_tokens || 0)
    }
  });
  writeEvent("message_stop", { type: "message_stop" });
  res.end();
}

async function runCodexConversationViaOAuth({
  model,
  requestedModel,
  upstreamModel,
  systemText,
  conversation,
  messages,
  tools,
  tool_choice,
  reasoning_effort,
  max_tokens,
  temperature,
  top_p,
  stop
}) {
  let auth = await getValidAuthContext();
  if (!auth.accountId) {
    throw new Error("Could not extract chatgpt_account_id from OAuth token.");
  }

  const contextMessages = Array.isArray(messages) ? messages : [];
  const fallbackMessages = [];
  if (typeof systemText === "string" && systemText.trim().length > 0) {
    fallbackMessages.push({ role: "system", content: systemText });
  }
  for (const msg of Array.isArray(conversation) ? conversation : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const text = typeof msg.text === "string" && msg.text.length > 0 ? msg.text : " ";
    fallbackMessages.push({ role, content: text });
  }
  if (fallbackMessages.length === 0) {
    fallbackMessages.push({ role: "user", content: " " });
  }
  const sourceMessages = contextMessages.length > 0 ? contextMessages : fallbackMessages;
  const systemMessages = sourceMessages
    .filter((msg) => msg && (msg.role === "system" || msg.role === "developer"))
    .map((msg) => (typeof msg.content === "string" ? msg.content : extractOpenAIMessageText(msg.content)))
    .filter((text) => typeof text === "string" && text.trim().length > 0);
  const instructions =
    systemMessages.join("\n\n") ||
    (typeof systemText === "string" && systemText.trim().length > 0 ? systemText : config.codex.defaultInstructions);
  const inputMessages = sourceMessages.filter(
    (msg) => msg && msg.role !== "system" && msg.role !== "developer"
  );
  if (inputMessages.length === 0) {
    inputMessages.push({ role: "user", content: " " });
  }
  const normalizedInput = toResponsesInputFromChatMessages(inputMessages);

  const route =
    typeof upstreamModel === "string" && upstreamModel.trim().length > 0
      ? {
          requestedModel:
            typeof requestedModel === "string" && requestedModel.trim().length > 0
              ? requestedModel.trim()
              : model || config.codex.defaultModel,
          mappedModel: upstreamModel.trim()
        }
      : resolveCodexCompatibleRoute(model || config.codex.defaultModel);
  const resolvedRequestedModel = route.requestedModel;
  const resolvedUpstreamModel = route.mappedModel;
  const baseBody = {
    model: resolvedUpstreamModel,
    stream: false,
    store: false,
    instructions,
    reasoning: {
      effort: resolveReasoningEffort(reasoning_effort, {
        messages: sourceMessages,
        tools,
        tool_choice,
        instructions
      }, resolvedUpstreamModel)
    },
    input: normalizedInput
  };
  if (tools !== undefined) baseBody.tools = normalizeChatTools(tools);
  if (tool_choice !== undefined) baseBody.tool_choice = normalizeChatToolChoice(tool_choice);

  // Intentionally omit max_output_tokens for broad upstream compatibility.
  if (typeof temperature === "number" && Number.isFinite(temperature)) baseBody.temperature = temperature;
  if (typeof top_p === "number" && Number.isFinite(top_p)) baseBody.top_p = top_p;
  if (Array.isArray(stop) && stop.length > 0) baseBody.stop = stop;
  else if (typeof stop === "string" && stop.length > 0) baseBody.stop = [stop];

  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;
  const executeOnce = async (currentAuth) => {
    if (!currentAuth.accountId) {
      const accountErr = new Error("Could not extract chatgpt_account_id from OAuth token.");
      accountErr.statusCode = 401;
      throw accountErr;
    }

    const sendCodexRequest = async (body, acceptHeader) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${currentAuth.accessToken}`,
          "chatgpt-account-id": currentAuth.accountId,
          "openai-beta": "responses=experimental",
          originator: getCodexOriginator(),
          accept: acceptHeader,
          "content-type": "application/json",
          "user-agent": "codex-oauth-proxy-local-compat"
        },
        body: JSON.stringify(body)
      });
      const raw = await response.text();
      return { response, raw };
    };

    let activeBody = { ...baseBody };
    let requestResult = await sendCodexRequest(activeBody, "application/json");
    if (!requestResult.response.ok) {
      if (isUnsupportedMaxOutputTokensError(requestResult.response.status, requestResult.raw)) {
        const fallbackBody = { ...baseBody };
        delete fallbackBody.max_output_tokens;
        activeBody = fallbackBody;
        requestResult = await sendCodexRequest(activeBody, "application/json");
      }
    }
    if (!requestResult.response.ok) {
      const maybeStreamOnly =
        requestResult.response.status === 400 &&
        /(stream|event-stream|sse)/i.test(requestResult.raw || "");
      if (maybeStreamOnly) {
        activeBody = { ...baseBody, stream: true };
        requestResult = await sendCodexRequest(activeBody, "text/event-stream");
      }
    }
    if (!requestResult.response.ok) {
      const contextExceeded = isContextLengthExceededError(
        requestResult.response.status,
        requestResult.raw
      );
      if (contextExceeded && Array.isArray(activeBody.input) && activeBody.input.length > 1) {
        const compactedInput = compactResponsesInputForRetry(activeBody.input);
        if (compactedInput.length > 0 && compactedInput.length < activeBody.input.length) {
          activeBody = { ...baseBody, input: compactedInput };
          requestResult = await sendCodexRequest(activeBody, "application/json");
          if (!requestResult.response.ok) {
            const maybeStreamOnlyCompacted =
              requestResult.response.status === 400 &&
              /(stream|event-stream|sse)/i.test(requestResult.raw || "");
            if (maybeStreamOnlyCompacted) {
              activeBody = { ...activeBody, stream: true };
              requestResult = await sendCodexRequest(activeBody, "text/event-stream");
            }
          }
        }
      }
    }
    if (!requestResult.response.ok) {
      const requestErr = new Error(
        `Upstream request failed: HTTP ${requestResult.response.status}: ${truncate(requestResult.raw, 400)}`
      );
      requestErr.statusCode = requestResult.response.status;
      throw requestErr;
    }

    await maybeCaptureCodexUsageFromHeaders(currentAuth, requestResult.response.headers, "response").catch(
      () => {}
    );

    const contentType = requestResult.response.headers.get("content-type") || "";
    let completed =
      activeBody.stream === true || contentType.includes("text/event-stream")
        ? extractCompletedResponseFromSse(requestResult.raw)
        : extractCompletedResponseFromJson(requestResult.raw);

    if (!completed && activeBody.stream !== true) {
      activeBody = { ...baseBody, stream: true };
      requestResult = await sendCodexRequest(activeBody, "text/event-stream");
      if (!requestResult.response.ok) {
        const streamErr = new Error(
          `Upstream request failed: HTTP ${requestResult.response.status}: ${truncate(requestResult.raw, 400)}`
        );
        streamErr.statusCode = requestResult.response.status;
        throw streamErr;
      }
      completed = extractCompletedResponseFromSse(requestResult.raw);
    }

    if (!completed) {
      throw new Error("Could not parse completed response from upstream.");
    }

    return completed;
  };

  const canRetryWithPool = isCodexPoolRetryEnabled();
  const maxAttempts = canRetryWithPool ? 2 : 1;
  let completed = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      completed = await executeOnce(auth);
      await maybeMarkCodexPoolSuccess(auth).catch(() => {});
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const statusCode = Number(err?.statusCode || 0);
      const canRotateNow =
        canRetryWithPool &&
        attempt < maxAttempts &&
        Boolean(auth?.poolAccountId) &&
        shouldRotateCodexAccountForStatus(statusCode);

      if (!canRotateNow) {
        if (canRetryWithPool && shouldRotateCodexAccountForStatus(statusCode)) {
          await maybeMarkCodexPoolFailure(auth, err.message, statusCode).catch(() => {});
        }
        break;
      }

      await maybeMarkCodexPoolFailure(auth, err.message, statusCode).catch(() => {});
      auth = await getValidAuthContext();
      if (!auth.accountId) {
        const accountErr = new Error("Could not extract chatgpt_account_id from OAuth token.");
        accountErr.statusCode = 401;
        lastError = accountErr;
        break;
      }
    }
  }

  if (!completed) {
    throw lastError || new Error("Upstream request failed.");
  }

  const usageNormalized = normalizeTokenUsage(completed.usage);
  const usage = {
    prompt_tokens: Number(usageNormalized?.inputTokens || completed?.usage?.input_tokens || 0),
    completion_tokens: Number(usageNormalized?.outputTokens || completed?.usage?.output_tokens || 0),
    total_tokens: Number(
      usageNormalized?.totalTokens ||
        completed?.usage?.total_tokens ||
        Number(usageNormalized?.inputTokens || 0) + Number(usageNormalized?.outputTokens || 0)
    )
  };
  return {
    model: resolvedRequestedModel,
    text: extractAssistantTextFromResponse(completed),
    toolCalls: extractAssistantToolCallsFromResponse(completed),
    finishReason: mapResponsesStatusToChatFinishReason(completed.status),
    usage,
    authAccountId: auth.poolAccountId || auth.accountId || null
  };
}

async function handleGeminiNativeCompat(req, res) {
  res.locals.protocolType = "gemini-v1beta-native";
  const incoming = new URL(req.originalUrl, "http://localhost");
  const pathname = incoming.pathname;

  if (req.method === "GET" && (pathname === "/v1beta/models" || pathname === "/v1beta/models/")) {
    const modelIds = getOpenAICompatibleModelIds();
    res.status(200).json({
      models: modelIds.map((id) => buildGeminiModelDescriptor(id))
    });
    return;
  }

  const modelDetailMatch = pathname.match(/^\/v1beta\/models\/([^/:]+)$/);
  if (req.method === "GET" && modelDetailMatch) {
    const modelId = decodeURIComponent(modelDetailMatch[1]);
    res.status(200).json(buildGeminiModelDescriptor(modelId));
    return;
  }

  const generateMatch = pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
  if (!generateMatch || req.method !== "POST") {
    res.status(400).json({
      error: {
        code: 400,
        message:
          "In local Gemini compatibility mode, supported endpoints are GET /v1beta/models, GET /v1beta/models/{model}, POST /v1beta/models/{model}:generateContent, POST /v1beta/models/{model}:streamGenerateContent.",
        status: "INVALID_ARGUMENT"
      }
    });
    return;
  }

  const modelFromPath = decodeURIComponent(generateMatch[1]);
  const action = generateMatch[2];
  let parsedReq;
  try {
    parsedReq = parseGeminiNativeBody(req.rawBody, modelFromPath || config.gemini.defaultModel);
  } catch (err) {
    res.status(400).json({
      error: {
        code: 400,
        message: err.message,
        status: "INVALID_ARGUMENT"
      }
    });
    return;
  }
  parsedReq.model = modelFromPath || parsedReq.model;
  const codexRoute = resolveCodexCompatibleRoute(parsedReq.model);
  res.locals.modelRoute = codexRoute;

  let result;
  try {
    result = await runCodexConversationViaOAuth({
      ...parsedReq,
      requestedModel: codexRoute.requestedModel,
      upstreamModel: codexRoute.mappedModel
    });
  } catch (err) {
    res.status(401).json({
      error: {
        code: 401,
        message: err.message,
        status: "UNAUTHENTICATED"
      }
    });
    return;
  }

  const payload = buildGeminiGenerateContentResponse({
    model: result.model,
    text: result.text,
    finishReason: result.finishReason,
    usage: result.usage
  });
  res.locals.authAccountId = result.authAccountId || null;

  if (action === "streamGenerateContent") {
    const wantsSse = String(incoming.searchParams.get("alt") || "").toLowerCase() === "sse";
    if (wantsSse) {
      sendGeminiSseResponse(res, payload);
      return;
    }
    res.status(200).json([payload]);
    return;
  }

  res.status(200).json(payload);
}

async function handleAnthropicNativeCompat(req, res) {
  res.locals.protocolType = "anthropic-v1-native";
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname !== "/v1/messages") {
    res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "In local Anthropic compatibility mode, only POST /v1/messages is supported."
      }
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Use POST /v1/messages."
      }
    });
    return;
  }

  let parsedReq;
  try {
    parsedReq = parseAnthropicNativeBody(req.rawBody);
  } catch (err) {
    res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: err.message
      }
    });
    return;
  }

  const codexRoute = resolveCodexCompatibleRoute(parsedReq.model || config.anthropic.defaultModel);
  res.locals.modelRoute = codexRoute;

  let result;
  try {
    result = await runCodexConversationViaOAuth({
      ...parsedReq,
      requestedModel: codexRoute.requestedModel,
      upstreamModel: codexRoute.mappedModel
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 401);
    res.status(statusCode).json({
      type: "error",
      error: {
        type: mapHttpStatusToAnthropicErrorType(statusCode),
        message: err.message
      }
    });
    return;
  }

  const message = buildAnthropicMessageResponse({
    model: result.model,
    text: result.text,
    toolCalls: result.toolCalls,
    finishReason: result.finishReason,
    usage: result.usage
  });
  res.locals.authAccountId = result.authAccountId || null;

  if (parsedReq.stream === true) {
    sendAnthropicMessageAsSse(res, message);
    return;
  }
  res.status(200).json(message);
}

async function handleGeminiOpenAICompatWithCodex(req, res) {
  let chatReq;
  try {
    chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.gemini.defaultModel);
  } catch (err) {
    res.status(400).json({ error: "invalid_request", message: err.message });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const modelRoute = resolveCodexCompatibleRoute(chatReq.model || config.gemini.defaultModel);
  res.locals.modelRoute = modelRoute;
  let result;
  try {
    result = await runCodexConversationViaOAuth({
      requestedModel: modelRoute.requestedModel,
      upstreamModel: modelRoute.mappedModel,
      systemText,
      conversation,
      messages: chatReq.messages,
      tools: chatReq.tools,
      tool_choice: chatReq.tool_choice,
      reasoning_effort: chatReq.reasoning_effort,
      max_tokens: chatReq.max_tokens,
      temperature: chatReq.temperature,
      top_p: chatReq.top_p,
      stop: chatReq.stop
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 401);
    res.status(statusCode).json({
      error: statusCode === 429 ? "usage_limit_reached" : "unauthorized",
      message: err.message,
      hint:
        statusCode === 401
          ? config.authMode === "profile-store"
            ? "Run profile store login first."
            : "Open /auth/login first."
          : null
    });
    return;
  }

  const completion = buildOpenAIChatCompletion({
    model: modelRoute.requestedModel,
    text: result.text,
    finishReason: result.finishReason,
    usage: result.usage
  });
  res.locals.authAccountId = result.authAccountId || null;
  res.locals.tokenUsage = completion.usage;
  if (chatReq.stream === true) {
    sendOpenAICompletionAsSse(res, completion);
    return;
  }
  res.status(200).json(completion);
}

async function handleAnthropicOpenAICompatWithCodex(req, res) {
  let chatReq;
  try {
    chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.anthropic.defaultModel);
  } catch (err) {
    res.status(400).json({ error: "invalid_request", message: err.message });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const modelRoute = resolveCodexCompatibleRoute(chatReq.model || config.anthropic.defaultModel);
  res.locals.modelRoute = modelRoute;
  let result;
  try {
    result = await runCodexConversationViaOAuth({
      requestedModel: modelRoute.requestedModel,
      upstreamModel: modelRoute.mappedModel,
      systemText,
      conversation,
      messages: chatReq.messages,
      tools: chatReq.tools,
      tool_choice: chatReq.tool_choice,
      reasoning_effort: chatReq.reasoning_effort,
      max_tokens: chatReq.max_tokens,
      temperature: chatReq.temperature,
      top_p: chatReq.top_p,
      stop: chatReq.stop
    });
  } catch (err) {
    const statusCode = Number(err?.statusCode || 401);
    res.status(statusCode).json({
      error: statusCode === 429 ? "usage_limit_reached" : "unauthorized",
      message: err.message,
      hint:
        statusCode === 401
          ? config.authMode === "profile-store"
            ? "Run profile store login first."
            : "Open /auth/login first."
          : null
    });
    return;
  }

  const completion = buildOpenAIChatCompletion({
    model: modelRoute.requestedModel,
    text: result.text,
    finishReason: result.finishReason,
    usage: result.usage
  });
  res.locals.authAccountId = result.authAccountId || null;
  res.locals.tokenUsage = completion.usage;
  if (chatReq.stream === true) {
    sendOpenAICompletionAsSse(res, completion);
    return;
  }
  res.status(200).json(completion);
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
      "user-agent": "codex-oauth-proxy-admin-test"
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

