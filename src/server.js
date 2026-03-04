import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
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
const DEFAULT_CODEX_CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || "2026.2.26";
const VALID_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);
const VALID_REASONING_EFFORT_MODES = new Set(["none", "low", "medium", "high", "xhigh", "adaptive"]);
const VALID_MULTI_ACCOUNT_STRATEGIES = new Set(["round-robin", "random", "sticky"]);
const OFFICIAL_OPENAI_MODELS = [
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

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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
  authMode, // openclaw | codex-oauth | custom-oauth
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
  openclaw: {
    authStorePath: path.resolve(
      process.env.OPENCLAW_AUTH_STORE_PATH ||
        path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json")
    ),
    profileId: process.env.OPENCLAW_PROFILE_ID || "openai-codex:default"
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
    multiAccountStrategy: String(process.env.CODEX_MULTI_ACCOUNT_STRATEGY || "round-robin").trim().toLowerCase(),
    sharedApiKey: String(process.env.LOCAL_API_KEY || process.env.PROXY_API_KEY || "").trim(),
    tokenStorePath: path.resolve(
      process.env.CODEX_TOKEN_STORE_PATH || path.join(rootDir, "data", "codex-oauth-store.json")
    )
  },
  codex: {
    defaultModel: process.env.CODEX_DEFAULT_MODEL || "gpt-5.3-codex",
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
  }
};

if (config.authMode !== "openclaw" && config.authMode !== "codex-oauth" && config.authMode !== "custom-oauth") {
  console.error("AUTH_MODE must be one of: openclaw, codex-oauth, custom-oauth");
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
    `Invalid CODEX_MULTI_ACCOUNT_STRATEGY="${config.codexOAuth.multiAccountStrategy}", fallback to round-robin.`
  );
  config.codexOAuth.multiAccountStrategy = "round-robin";
}

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

const runtimeStats = {
  startedAt: Date.now(),
  totalRequests: 0,
  okRequests: 0,
  errorRequests: 0,
  recentRequests: []
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

  const expectedApiKey = config.codexOAuth.sharedApiKey;
  if (!expectedApiKey) {
    next();
    return;
  }

  const bearer = extractBearerToken(req);
  const xApiKey = readHeaderValue(req, "x-api-key");
  if (bearer === expectedApiKey || xApiKey === expectedApiKey) {
    next();
    return;
  }

  res.status(401).json({
    error: "invalid_api_key",
    message: "Invalid local API key. Set Authorization: Bearer <LOCAL_API_KEY>."
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
      config.authMode === "openclaw"
        ? "login via OpenClaw"
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
  if (config.authMode === "openclaw") {
    res.status(400).json({
      mode: "openclaw",
      message: "This mode uses OpenClaw's existing OAuth session.",
      action: "Run: openclaw models auth login --provider openai-codex",
      authStorePath: config.openclaw.authStorePath
    });
    return;
  }

  const oauthRuntime = getActiveOAuthRuntime();
  if (!oauthRuntime) {
    res.status(400).json({
      error: "oauth_unavailable",
      message: "AUTH_MODE is openclaw; use OpenClaw login flow."
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
    label: typeof req.query.label === "string" ? req.query.label.trim() : ""
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
  }

  if (req.query.prompt) {
    authUrl.searchParams.set("prompt", String(req.query.prompt));
  }

  res.redirect(authUrl.toString());
});

app.get("/auth/callback", async (req, res) => {
  if (config.authMode === "openclaw") {
    res.status(400).send("Callback is not used in AUTH_MODE=openclaw.");
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
    await completeOAuthCallback({ code, state });

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(OAUTH_CALLBACK_SUCCESS_HTML);
  } catch (err) {
    console.error("OAuth callback exchange failed:", err);
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

app.post("/auth/logout", async (_req, res) => {
  if (config.authMode === "openclaw") {
    res.status(400).json({
      mode: "openclaw",
      message: "Managed by OpenClaw. Run `openclaw models auth login --provider openai-codex` to change account."
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

  oauthRuntime.store.token = null;
  if (config.authMode === "codex-oauth") {
    oauthRuntime.store.accounts = [];
    oauthRuntime.store.active_account_id = null;
    oauthRuntime.store.rotation = { next_index: 0 };
  }
  await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
  clearAuthContextCache();
  res.json({ ok: true });
});

app.get("/admin/state", async (_req, res) => {
  try {
    const authStatus = await getAuthStatus();
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
        multiAccountEnabled: isCodexMultiAccountEnabled(),
        multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
        modelRouterEnabled: config.modelRouter.enabled,
        modelMappings: config.modelRouter.customMappings
      },
      auth: authStatus,
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

  res.json({
    ok: true,
    multiAccountEnabled: isCodexMultiAccountEnabled(),
    strategy: config.codexOAuth.multiAccountStrategy,
    sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
    activeAccountId: codexOAuthStore.active_account_id || null,
    rotation: codexOAuthStore.rotation || { next_index: 0 },
    accounts: (codexOAuthStore.accounts || []).map((x) => ({
      accountId: x.account_id,
      label: x.label || "",
      enabled: x.enabled !== false,
      expiresAt: x.token?.expires_at || null,
      lastUsedAt: x.last_used_at || 0,
      failureCount: x.failure_count || 0,
      cooldownUntil: x.cooldown_until || 0,
      lastError: x.last_error || "",
      usageSnapshot: x.usage_snapshot || null,
      usageUpdatedAt: x.usage_updated_at || 0
    }))
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
  const accountId = String(body.accountId || "").trim();
  const enabled = body.enabled !== false;
  if (!accountId) {
    res.status(400).json({ error: "invalid_request", message: "accountId is required." });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = (codexOAuthStore.accounts || []).find((x) => x.account_id === accountId);
  if (!target) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountId}` });
    return;
  }
  target.enabled = enabled;
  if (!enabled && codexOAuthStore.active_account_id === accountId) {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({ ok: true, accountId, enabled });
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
  const accountId = String(body.accountId || "").trim();
  if (!accountId) {
    res.status(400).json({ error: "invalid_request", message: "accountId is required." });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = (codexOAuthStore.accounts || []).find((x) => x.account_id === accountId);
  if (!target) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountId}` });
    return;
  }
  target.enabled = true;
  target.cooldown_until = 0;
  target.last_error = "";
  codexOAuthStore.active_account_id = accountId;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({ ok: true, accountId });
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
  const accountId = String(body.accountId || "").trim();
  if (!accountId) {
    res.status(400).json({ error: "invalid_request", message: "accountId is required." });
    return;
  }

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const before = (codexOAuthStore.accounts || []).length;
  codexOAuthStore.accounts = (codexOAuthStore.accounts || []).filter((x) => x.account_id !== accountId);
  const removed = before !== codexOAuthStore.accounts.length;
  if (!removed) {
    res.status(404).json({ error: "not_found", message: `Account not found: ${accountId}` });
    return;
  }
  if (codexOAuthStore.active_account_id === accountId) {
    codexOAuthStore.active_account_id = codexOAuthStore.accounts[0]?.account_id || null;
  }
  codexOAuthStore.token = codexOAuthStore.accounts[0]?.token || null;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({ ok: true, accountId, removed: true });
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
  const items = Array.isArray(body.tokens) ? body.tokens : [];
  if (items.length === 0) {
    res.status(400).json({ error: "invalid_request", message: "tokens[] is required." });
    return;
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
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    if (!raw.access_token) continue;
    const token = normalizeToken(raw, raw);
    upsertCodexOAuthAccount(codexOAuthStore, token, {
      label: typeof raw.label === "string" ? raw.label : ""
    });
    imported += 1;
  }
  if (imported === 0) {
    res.status(400).json({ error: "invalid_request", message: "No valid token entries in tokens[]." });
    return;
  }

  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  res.json({
    ok: true,
    imported,
    accountPoolSize: (codexOAuthStore.accounts || []).length
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
  const accountId = String(body.accountId || "").trim();
  const includeDisabled = body.includeDisabled === true;

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;

  let targets = Array.isArray(codexOAuthStore.accounts) ? [...codexOAuthStore.accounts] : [];
  if (!includeDisabled) {
    targets = targets.filter((x) => x.enabled !== false);
  }
  if (accountId) {
    targets = targets.filter((x) => x.account_id === accountId);
  }
  if (targets.length === 0) {
    res.status(404).json({
      error: "not_found",
      message: accountId
        ? `No matching account to refresh: ${accountId}`
        : "No eligible accounts to refresh usage."
    });
    return;
  }

  const results = [];
  let refreshed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    try {
      const snapshot = await fetchCodexUsageSnapshotForAccount(target, config.codexOAuth);
      applyCodexUsageSnapshotToStore(codexOAuthStore, target.account_id, snapshot);
      target.last_error = "";
      refreshed += 1;
      results.push({
        accountId: target.account_id,
        ok: true,
        usage: snapshot
      });
    } catch (err) {
      target.last_error = String(err.message || err);
      results.push({
        accountId: target.account_id,
        ok: false,
        error: String(err.message || err)
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
    if (typeof body.defaultInstructions === "string" && body.defaultInstructions.trim().length > 0) {
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
        throw new Error("multiAccountStrategy must be one of: round-robin, random, sticky");
      }
      config.codexOAuth.multiAccountStrategy = strategy;
    }
    if (typeof body.modelRouterEnabled === "boolean") {
      config.modelRouter.enabled = body.modelRouterEnabled;
    }
    if (body.modelMappings !== undefined) {
      config.modelRouter.customMappings = sanitizeModelMappings(body.modelMappings);
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
        modelRouterEnabled: config.modelRouter.enabled,
        modelMappings: config.modelRouter.customMappings
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

app.use("/v1beta", async (req, res) => {
  await handleGeminiNativeProxy(req, res);
});

app.use("/v1/messages", async (req, res) => {
  await handleAnthropicNativeProxy(req, res);
});

app.use("/v1", (req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const tokenUsage = normalizeTokenUsage(res.locals?.tokenUsage);
    const modelRoute = res.locals?.modelRoute || null;
    const authAccountId = res.locals?.authAccountId || null;
    runtimeStats.totalRequests += 1;
    if (res.statusCode >= 200 && res.statusCode < 400) runtimeStats.okRequests += 1;
    else runtimeStats.errorRequests += 1;
    runtimeStats.recentRequests.unshift({
      ts: Date.now(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      inputTokens: tokenUsage?.inputTokens ?? null,
      outputTokens: tokenUsage?.outputTokens ?? null,
      totalTokens: tokenUsage?.totalTokens ?? null,
      requestedModel: modelRoute?.requestedModel ?? null,
      mappedModel: modelRoute?.mappedModel ?? null,
      routeType: modelRoute?.routeType ?? null,
      routeRule: modelRoute?.routeRule ?? null,
      authAccountId
    });
    if (runtimeStats.recentRequests.length > 120) runtimeStats.recentRequests.length = 120;
  });
  next();
});

app.use("/v1", async (req, res) => {
  if (config.upstreamMode === "gemini-v1beta") {
    await handleGeminiProtocol(req, res);
    return;
  }

  if (config.upstreamMode === "anthropic-v1") {
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
        config.authMode === "openclaw"
          ? "Run `openclaw models auth login --provider openai-codex` first."
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
          headers.set("content-type", "application/json");
        } else if (target.endpointKind === "chat-completions") {
          const normalized = normalizeChatCompletionsRequestBody(body);
          body = normalized.body;
          streamChatCompletionsAsSse = normalized.wantsStream;
          collectCompletedResponseAsJson = !streamChatCompletionsAsSse;
          responseShape = "chat-completions";
          responseModel = normalized.model || responseModel;
          if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
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

  await maybeCaptureCodexUsageFromHeaders(auth, upstream.headers, "response").catch(() => {});

  if (upstream.ok) {
    await maybeMarkCodexPoolSuccess(auth).catch(() => {});
  }

  if (collectCompletedResponseAsJson) {
    const raw = await upstream.text();
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
      const raw = await upstream.text();
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
    await maybeMarkCodexPoolFailure(
      auth,
      `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}`,
      upstream.status
    ).catch(() => {});
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

app.listen(config.port, config.host, () => {
  console.log(`codex-oauth-proxy listening on http://${config.host}:${config.port}`);
  console.log(`mode:   ${config.authMode}`);
  console.log(`upstream-mode: ${config.upstreamMode}`);
  console.log(`upstream-url:  ${getActiveUpstreamBaseUrl()}`);
  if (config.authMode === "openclaw") {
    console.log(`source: ${config.openclaw.authStorePath}`);
    console.log(`profile:${config.openclaw.profileId}`);
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
});

async function getAuthStatus() {
  if (config.authMode === "openclaw") {
    const { store, profileId, profile } = await loadOpenClawProfile();
    return {
      mode: "openclaw",
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      authenticated: Boolean(profile?.access),
      profileId,
      provider: profile?.provider ?? null,
      expiresAt: profile?.expires ?? null,
      hasRefreshToken: Boolean(profile?.refresh),
      accountId: profile?.accountId || extractOpenAICodexAccountId(profile?.access || "") || null,
      authStorePath: config.openclaw.authStorePath,
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
      activeAccountId: codexOAuthStore.active_account_id || null,
      accounts: accounts.map((x) => ({
        accountId: x.account_id,
        label: x.label || "",
        enabled: x.enabled !== false,
        expiresAt: x.token?.expires_at || null,
        lastUsedAt: x.last_used_at || 0,
        failureCount: x.failure_count || 0,
        cooldownUntil: x.cooldown_until || 0,
        usageSnapshot: x.usage_snapshot || null,
        usageUpdatedAt: x.usage_updated_at || 0
      }))
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
  if (config.authMode === "openclaw") {
    context = await getValidAuthContextFromOpenClawStore();
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

async function loadOpenClawProfile() {
  let raw;
  try {
    raw = await fs.readFile(config.openclaw.authStorePath, "utf8");
  } catch {
    throw new Error(`OpenClaw auth store not found: ${config.openclaw.authStorePath}`);
  }

  const store = JSON.parse(raw);
  const resolved = resolveOpenClawProfile(store, config.openclaw.profileId);
  if (!resolved.profile) {
    throw new Error(
      `No usable oauth profile found. Run: openclaw models auth login --provider openai-codex`
    );
  }
  return { store, profileId: resolved.profileId, profile: resolved.profile };
}

function resolveOpenClawProfile(store, preferredProfileId) {
  const profiles = store?.profiles ?? {};
  let profileId = preferredProfileId;
  let profile = profiles[profileId];

  if (!isOpenClawCodexOauthProfile(profile)) {
    const fallbackEntry = Object.entries(profiles).find(([, value]) => isOpenClawCodexOauthProfile(value));
    if (fallbackEntry) {
      profileId = fallbackEntry[0];
      profile = fallbackEntry[1];
    }
  }

  return { profileId, profile };
}

function isOpenClawCodexOauthProfile(profile) {
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

async function getValidAuthContextFromOpenClawStore() {
  const { store, profileId, profile } = await loadOpenClawProfile();
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

  await fs.writeFile(config.openclaw.authStorePath, JSON.stringify(store, null, 2), "utf8");
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
  const payload = decodeJwtPayload(accessToken);
  const authClaim = payload?.[OPENAI_CODEX_JWT_CLAIM_PATH];
  const accountId = authClaim?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
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

function normalizeCodexResponsesRequestBody(rawBody) {
  if (!rawBody || rawBody.length === 0) {
    const modelRoute = resolveModelRoute(config.codex.defaultModel, "codex-chatgpt");
    const fallback = {
      model: modelRoute.mappedModel,
      stream: true,
      store: false,
      instructions: config.codex.defaultInstructions,
      reasoning: {
        effort: config.codex.defaultReasoningEffort
      },
      input: [{ role: "user", content: [{ type: "input_text", text: "" }] }]
    };
    return {
      body: Buffer.from(JSON.stringify(fallback), "utf8"),
      collectCompletedResponseAsJson: true,
      model: modelRoute.requestedModel,
      modelRoute
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return {
      body: rawBody,
      collectCompletedResponseAsJson: false
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      body: rawBody,
      collectCompletedResponseAsJson: false,
      model: config.codex.defaultModel,
      modelRoute: null
    };
  }

  const wantsStream = parsed.stream === true;
  const normalized = { ...parsed };
  const modelRoute = resolveModelRoute(normalized.model || config.codex.defaultModel, "codex-chatgpt");
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
  });
  delete normalized.messages;
  delete normalized.reasoning_effort;

  return {
    body: Buffer.from(JSON.stringify(normalized), "utf8"),
    collectCompletedResponseAsJson: !wantsStream,
    model: modelRoute.requestedModel,
    modelRoute
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

  const modelRoute = resolveModelRoute(parsed.model || config.codex.defaultModel, "codex-chatgpt");
  const upstreamBody = {
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
      })
    },
    input: toResponsesInputFromChatMessages(messages)
  };

  if (parsed.temperature !== undefined) upstreamBody.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) upstreamBody.top_p = parsed.top_p;
  if (parsed.max_tokens !== undefined) upstreamBody.max_output_tokens = parsed.max_tokens;
  if (parsed.tool_choice !== undefined) upstreamBody.tool_choice = normalizeChatToolChoice(parsed.tool_choice);
  if (parsed.tools !== undefined) upstreamBody.tools = normalizeChatTools(parsed.tools);

  return {
    body: Buffer.from(JSON.stringify(upstreamBody), "utf8"),
    wantsStream,
    model: modelRoute.requestedModel,
    modelRoute
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
    totalTokens: hasTotal ? totalTokens : null
  };
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
    return { token: null };
  }
}

async function saveTokenStore(tokenStorePath, nextStore) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  await fs.writeFile(tokenStorePath, JSON.stringify(nextStore, null, 2), "utf8");
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
  const accountId = String(raw.account_id || raw.accountId || "").trim();
  const token = raw.token && typeof raw.token === "object" ? raw.token : null;
  if (!accountId || !token?.access_token) return null;
  return {
    account_id: accountId,
    label: typeof raw.label === "string" ? raw.label : "",
    enabled: raw.enabled !== false,
    token: normalizeToken(token, token),
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
    const idx = out.accounts.findIndex((x) => x.account_id === accountId);
    if (idx >= 0) {
      out.accounts[idx].token = tokenNormalized;
      out.accounts[idx].enabled = out.accounts[idx].enabled !== false;
    } else {
      out.accounts.push({
        account_id: accountId,
        label: "",
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
    if (!out.active_account_id) out.active_account_id = accountId;
    changed = true;
  }

  if (out.accounts.length > 0 && !out.active_account_id) {
    out.active_account_id = out.accounts[0].account_id;
    changed = true;
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

  return { store: out, changed };
}

function getCodexEnabledAccounts(store) {
  if (!Array.isArray(store?.accounts)) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  return store.accounts.filter((x) => x && x.enabled !== false && Number(x.cooldown_until || 0) <= nowSec);
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
  if (strategy === "sticky" && store.active_account_id) {
    const primary = enabled.find((x) => x.account_id === store.active_account_id);
    if (primary) {
      return [primary, ...enabled.filter((x) => x.account_id !== primary.account_id)];
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
  const label = typeof options.label === "string" ? options.label.trim() : "";
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Array.isArray(store.accounts)) store.accounts = [];

  const idx = store.accounts.findIndex((x) => x.account_id === accountId);
  if (idx >= 0) {
    store.accounts[idx] = {
      ...store.accounts[idx],
      token: normalizeToken(normalizedToken, store.accounts[idx].token),
      enabled: true,
      label: label || store.accounts[idx].label || "",
      last_error: ""
    };
  } else {
    store.accounts.push({
      account_id: accountId,
      label,
      enabled: true,
      token: normalizeToken(normalizedToken, normalizedToken),
      created_at: nowSec,
      last_used_at: 0,
      failure_count: 0,
      cooldown_until: 0,
      last_error: "",
      usage_snapshot: null,
      usage_updated_at: 0
    });
  }

  store.active_account_id = accountId;
  store.token = normalizedToken;
  store.rotation = store.rotation || { next_index: 0 };
  if (!Number.isFinite(store.rotation.next_index)) store.rotation.next_index = 0;

  return accountId;
}

function shouldRotateCodexAccountForStatus(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function getCodexPoolCooldownSeconds(statusCode, failureCount) {
  if (statusCode === 401 || statusCode === 403) return Math.min(1800, 120 * Math.max(1, failureCount));
  if (statusCode === 429) return Math.min(600, 30 * Math.max(1, failureCount));
  return Math.min(180, 15 * Math.max(1, failureCount));
}

async function markCodexPoolAccountFailure(accountId, reason, statusCode = 0) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = (codexOAuthStore.accounts || []).find((x) => x.account_id === accountId);
  if (!target) return;
  target.failure_count = Number(target.failure_count || 0) + 1;
  target.last_error = String(reason || "request_failed");
  const cooldownSeconds = getCodexPoolCooldownSeconds(statusCode, target.failure_count);
  const nowSec = Math.floor(Date.now() / 1000);
  target.cooldown_until = nowSec + cooldownSeconds;
  if (codexOAuthStore.active_account_id === accountId && config.codexOAuth.multiAccountStrategy !== "sticky") {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

async function markCodexPoolAccountSuccess(accountId) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = (codexOAuthStore.accounts || []).find((x) => x.account_id === accountId);
  if (!target) return;
  target.last_used_at = Math.floor(Date.now() / 1000);
  target.failure_count = 0;
  target.cooldown_until = 0;
  target.last_error = "";
  if (config.codexOAuth.multiAccountStrategy === "sticky") {
    codexOAuthStore.active_account_id = accountId;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

function isCodexPoolRetryEnabled() {
  return config.authMode === "codex-oauth" && isCodexMultiAccountEnabled();
}

async function maybeMarkCodexPoolFailure(authContext, reason, statusCode = 0) {
  if (!isCodexPoolRetryEnabled()) return false;
  if (!authContext?.poolAccountId) return false;
  const code = Number(statusCode || 0);
  if (!shouldRotateCodexAccountForStatus(code)) return false;
  await markCodexPoolAccountFailure(authContext.poolAccountId, reason, code);
  return true;
}

async function maybeMarkCodexPoolSuccess(authContext) {
  if (!isCodexPoolRetryEnabled()) return;
  if (!authContext?.poolAccountId) return;
  await markCodexPoolAccountSuccess(authContext.poolAccountId);
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

function applyCodexUsageSnapshotToStore(store, accountId, snapshot) {
  if (!store || !Array.isArray(store.accounts) || !accountId || !snapshot) return false;
  const target = store.accounts.find((x) => x.account_id === accountId);
  if (!target) return false;
  target.usage_snapshot = snapshot;
  target.usage_updated_at = Number(snapshot.fetched_at || Math.floor(Date.now() / 1000));
  return true;
}

async function maybeCaptureCodexUsageFromHeaders(authContext, headers, source = "response") {
  if (config.authMode !== "codex-oauth") return;
  const accountId = authContext?.poolAccountId || authContext?.accountId;
  if (!accountId) return;
  const snapshot = extractCodexUsageSnapshotFromHeaders(headers, source);
  if (!snapshot) return;

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const changed = applyCodexUsageSnapshotToStore(codexOAuthStore, accountId, snapshot);
  if (!changed) return;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

async function fetchCodexUsageSnapshotForAccount(account, oauthConfig) {
  if (!account || !account.token?.access_token) {
    throw new Error("Missing access token.");
  }

  if (isExpiredOrNearExpirySec(account.token.expires_at)) {
    if (!account.token.refresh_token) {
      throw new Error("Access token expired and no refresh token available.");
    }
    const refreshed = await refreshAccessToken(account.token.refresh_token, oauthConfig);
    account.token = normalizeToken(refreshed, account.token);
  }

  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;
  const body = {
    model: config.codex.defaultModel,
    stream: true,
    store: false,
    instructions: config.codex.defaultInstructions || "You are Codex.",
    reasoning: {
      effort: "low"
    },
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "usage_probe" }]
      }
    ]
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token.access_token}`,
      "chatgpt-account-id": account.account_id,
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
    const accountId = context.accountId || deriveCodexAccountIdFromToken(store.token || {});
    upsertCodexOAuthAccount(store, store.token, { label: accountId });
    await saveTokenStore(oauthConfig.tokenStorePath, store);
    return {
      ...context,
      poolAccountId: accountId
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
      account.account_id = accountIdFromToken;
      account.enabled = true;
      account.last_used_at = nowSec;
      account.failure_count = 0;
      account.cooldown_until = 0;
      account.last_error = "";
      store.token = account.token;
      store.active_account_id = account.account_id;
      store.rotation = store.rotation || { next_index: 0 };
      if (candidates.length > 1 && config.codexOAuth.multiAccountStrategy === "round-robin") {
        const enabled = getCodexEnabledAccounts(store);
        const idx = enabled.findIndex((x) => x.account_id === account.account_id);
        store.rotation.next_index = idx >= 0 ? (idx + 1) % enabled.length : 0;
      }
      await saveTokenStore(oauthConfig.tokenStorePath, store);
      return {
        accessToken: account.token.access_token,
        accountId: accountIdFromToken,
        poolAccountId: account.account_id
      };
    } catch (err) {
      account.failure_count = Number(account.failure_count || 0) + 1;
      account.last_error = String(err.message || err);
      const cooldownSeconds = Math.min(120, 10 * account.failure_count);
      account.cooldown_until = nowSec + cooldownSeconds;
      errors.push(`${account.account_id}: ${account.last_error}`);
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
      accountId: extractOpenAICodexAccountId(store.token.access_token) || null
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
    accountId: extractOpenAICodexAccountId(store.token.access_token) || null
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

function resolveGeminiApiKey(req) {
  const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
  const queryKey = incoming.searchParams.get("key") || "";
  const headerKey = readHeaderValue(req, "x-goog-api-key");
  const bearerKey = extractBearerToken(req);
  return headerKey || queryKey || config.gemini.apiKey || bearerKey;
}

function resolveAnthropicApiKey(req) {
  const headerKey = readHeaderValue(req, "x-api-key");
  const bearerKey = extractBearerToken(req);
  return headerKey || config.anthropic.apiKey || bearerKey;
}

function isAnthropicNativeRequest(req) {
  return (
    config.upstreamMode === "anthropic-v1" ||
    Boolean(readHeaderValue(req, "x-api-key")) ||
    Boolean(readHeaderValue(req, "anthropic-version")) ||
    Boolean(readHeaderValue(req, "anthropic-beta"))
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
    res.status(502).json({
      type: "error",
      error: {
        type: "api_error",
        message: err.message
      }
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
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname === "/v1/models" || incoming.pathname === "/v1/models/" || incoming.pathname.startsWith("/v1/models/")) {
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
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname !== "/v1/chat/completions") {
    res.status(400).json({
      error: "unsupported_endpoint",
      message: "In UPSTREAM_MODE=anthropic-v1, currently only /v1/chat/completions is supported."
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed", message: "Use POST /v1/chat/completions." });
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
    res.status(400).json({ error: "invalid_request", message: err.message });
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
    res.status(upstream.status).send(raw);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.status(502).json({ error: "invalid_upstream_json", message: "Anthropic returned non-JSON response." });
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
  return "end_turn";
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
    stop: Array.isArray(parsed.stop_sequences)
      ? parsed.stop_sequences
      : typeof parsed.stop_sequence === "string"
        ? [parsed.stop_sequence]
        : undefined
  };
}

function buildAnthropicMessageResponse({ model, text, finishReason, usage }) {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: text || "" }],
    stop_reason: mapOpenAIFinishReasonToAnthropic(finishReason),
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
  writeEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });
  if (typeof message?.content?.[0]?.text === "string" && message.content[0].text.length > 0) {
    writeEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: message.content[0].text
      }
    });
  }
  writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });
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
  max_tokens,
  temperature,
  top_p,
  stop
}) {
  let auth = await getValidAuthContext();
  if (!auth.accountId) {
    throw new Error("Could not extract chatgpt_account_id from OAuth token.");
  }

  const messages = [];
  if (typeof systemText === "string" && systemText.trim().length > 0) {
    messages.push({ role: "system", content: systemText });
  }
  for (const msg of Array.isArray(conversation) ? conversation : []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const text = typeof msg.text === "string" && msg.text.length > 0 ? msg.text : " ";
    messages.push({ role, content: text });
  }
  if (messages.length === 0) {
    messages.push({ role: "user", content: " " });
  }

  const route =
    typeof upstreamModel === "string" && upstreamModel.trim().length > 0
      ? {
          requestedModel:
            typeof requestedModel === "string" && requestedModel.trim().length > 0
              ? requestedModel.trim()
              : model || config.codex.defaultModel,
          mappedModel: upstreamModel.trim()
        }
      : resolveModelRoute(model || config.codex.defaultModel, "codex-chatgpt");
  const resolvedRequestedModel = route.requestedModel;
  const resolvedUpstreamModel = route.mappedModel;
  const instructions = typeof systemText === "string" && systemText.trim().length > 0 ? systemText : config.codex.defaultInstructions;
  const baseBody = {
    model: resolvedUpstreamModel,
    stream: false,
    store: false,
    instructions,
    reasoning: {
      effort: resolveReasoningEffort(undefined, { messages, instructions })
    },
    input: toResponsesInputFromChatMessages(messages)
  };

  if (typeof max_tokens === "number" && Number.isFinite(max_tokens) && max_tokens > 0) {
    baseBody.max_output_tokens = Math.floor(max_tokens);
  }
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
      const maybeStreamOnly =
        requestResult.response.status === 400 &&
        /(stream|event-stream|sse)/i.test(requestResult.raw || "");
      if (maybeStreamOnly) {
        activeBody = { ...baseBody, stream: true };
        requestResult = await sendCodexRequest(activeBody, "text/event-stream");
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
    finishReason: mapResponsesStatusToChatFinishReason(completed.status),
    usage,
    authAccountId: auth.poolAccountId || auth.accountId || null
  };
}

async function handleGeminiNativeCompat(req, res) {
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
  const codexRoute = resolveModelRoute(parsedReq.model, "codex-chatgpt");
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

  const codexRoute = resolveModelRoute(parsedReq.model || config.anthropic.defaultModel, "codex-chatgpt");
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
      type: "error",
      error: {
        type: "authentication_error",
        message: err.message
      }
    });
    return;
  }

  const message = buildAnthropicMessageResponse({
    model: result.model,
    text: result.text,
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
  const modelRoute = resolveModelRoute(chatReq.model || config.gemini.defaultModel, "codex-chatgpt");
  res.locals.modelRoute = modelRoute;
  let result;
  try {
    result = await runCodexConversationViaOAuth({
      requestedModel: modelRoute.requestedModel,
      upstreamModel: modelRoute.mappedModel,
      systemText,
      conversation,
      max_tokens: chatReq.max_tokens,
      temperature: chatReq.temperature,
      top_p: chatReq.top_p,
      stop: chatReq.stop
    });
  } catch (err) {
    res.status(401).json({
      error: "unauthorized",
      message: err.message,
      hint: config.authMode === "openclaw" ? "Run OpenClaw login first." : "Open /auth/login first."
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
  const modelRoute = resolveModelRoute(chatReq.model || config.anthropic.defaultModel, "codex-chatgpt");
  res.locals.modelRoute = modelRoute;
  let result;
  try {
    result = await runCodexConversationViaOAuth({
      requestedModel: modelRoute.requestedModel,
      upstreamModel: modelRoute.mappedModel,
      systemText,
      conversation,
      max_tokens: chatReq.max_tokens,
      temperature: chatReq.temperature,
      top_p: chatReq.top_p,
      stop: chatReq.stop
    });
  } catch (err) {
    res.status(401).json({
      error: "unauthorized",
      message: err.message,
      hint: config.authMode === "openclaw" ? "Run OpenClaw login first." : "Open /auth/login first."
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
  const reasoningEffort = resolveReasoningEffort(undefined, {
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    instructions: config.codex.defaultInstructions
  });
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

function resolveReasoningEffort(value, context = null) {
  const requested = parseReasoningEffortOrFallback(value, null, { allowAdaptive: true });
  if (requested && requested !== "adaptive") {
    return requested;
  }

  const configured = parseReasoningEffortOrFallback(config.codex.defaultReasoningEffort, "medium", {
    allowAdaptive: true
  });

  if (requested === "adaptive" || configured === "adaptive") {
    return inferAdaptiveReasoningEffort(context);
  }

  return configured;
}

function applyReasoningEffortDefaults(target, reasoningEffortFromRequest, context = null) {
  const hasReasoningObject = target.reasoning && typeof target.reasoning === "object" && !Array.isArray(target.reasoning);
  const existingEffort = hasReasoningObject ? target.reasoning.effort : null;
  const resolvedEffort = resolveReasoningEffort(existingEffort ?? reasoningEffortFromRequest, context);

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
  if (config.authMode === "codex-oauth") {
    const shaped = ensureCodexOAuthStoreShape(oauthRuntime.store);
    Object.keys(oauthRuntime.store).forEach((key) => delete oauthRuntime.store[key]);
    Object.assign(oauthRuntime.store, shaped.store);
    upsertCodexOAuthAccount(oauthRuntime.store, normalizedToken, {
      label: pending.label || ""
    });
  }
  await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
  clearAuthContextCache();
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
          await completeOAuthCallback({ code, state });
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(OAUTH_CALLBACK_SUCCESS_HTML);
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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
