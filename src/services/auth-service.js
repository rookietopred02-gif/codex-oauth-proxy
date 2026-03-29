import crypto from "node:crypto";

export function createAuthService({
  config,
  loadJsonStore,
  saveJsonStore,
  extractBearerToken,
  readHeaderValue,
  logger = console
}) {
  const authContextCache = {
    mode: "",
    accessToken: "",
    accountId: null,
    poolEntryId: null,
    poolAccountId: null,
    expiresAt: 0
  };

  let proxyApiKeyStore = { version: 1, keys: [] };
  let proxyApiKeyStoreFlushTimer = null;
  const PROXY_API_KEY_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

  function clearAuthContextCache() {
    authContextCache.mode = "";
    authContextCache.accessToken = "";
    authContextCache.accountId = null;
    authContextCache.poolEntryId = null;
    authContextCache.poolAccountId = null;
    authContextCache.expiresAt = 0;
  }

  function getCachedAuthContext() {
    if (!authContextCache.accessToken) return null;
    if (authContextCache.mode !== config.authMode) return null;
    if (Date.now() >= authContextCache.expiresAt) return null;
    return {
      accessToken: authContextCache.accessToken,
      accountId: authContextCache.accountId || null,
      poolEntryId: authContextCache.poolEntryId || null,
      poolAccountId: authContextCache.poolAccountId || null
    };
  }

  function cacheAuthContext(context, ttlMs = 15000) {
    if (!context || typeof context.accessToken !== "string" || context.accessToken.length === 0) return;
    authContextCache.mode = config.authMode;
    authContextCache.accessToken = context.accessToken;
    authContextCache.accountId = context.accountId || null;
    authContextCache.poolEntryId = context.poolEntryId || null;
    authContextCache.poolAccountId = context.poolAccountId || null;
    authContextCache.expiresAt = Date.now() + Math.max(1000, Math.floor(ttlMs));
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

  function listActiveProxyApiKeys(store, nowSec = Math.floor(Date.now() / 1000)) {
    const keys = Array.isArray(store?.keys) ? store.keys : [];
    return keys.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (Number(entry.revoked_at || 0) > 0) return false;
      const expiresAt = Number(entry.expires_at || 0);
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
    store.keys = store.keys.filter((entry) => Number(entry?.revoked_at || 0) <= 0);
    return store.keys.length !== before;
  }

  async function persistProxyApiKeyStore(nextStore = proxyApiKeyStore) {
    const normalized = normalizeProxyApiKeyStore(nextStore);
    proxyApiKeyStore = normalized.store;
    await saveJsonStore(config.apiKeys.storePath, proxyApiKeyStore);
    return proxyApiKeyStore;
  }

  async function loadProxyApiKeyStore() {
    const raw = await loadJsonStore(config.apiKeys.storePath, { version: 1, keys: [] });
    const normalized = normalizeProxyApiKeyStore(raw);
    proxyApiKeyStore = normalized.store;
    const prunedRevoked = pruneRevokedProxyApiKeys(proxyApiKeyStore);
    if (normalized.changed || prunedRevoked) {
      await persistProxyApiKeyStore(proxyApiKeyStore);
    }
    return proxyApiKeyStore;
  }

  function scheduleProxyApiKeyStoreFlush(delayMs = 2000) {
    if (proxyApiKeyStoreFlushTimer) clearTimeout(proxyApiKeyStoreFlushTimer);
    proxyApiKeyStoreFlushTimer = setTimeout(() => {
      proxyApiKeyStoreFlushTimer = null;
      persistProxyApiKeyStore(proxyApiKeyStore).catch((err) => {
        logger.warn?.(`[api-keys] failed to persist usage: ${err.message}`);
      });
    }, Math.max(250, Number(delayMs) || 2000));
  }

  function createProxyApiKey() {
    let out = "sk-";
    const bytes = crypto.randomBytes(32);
    for (let i = 0; i < bytes.length; i += 1) {
      out += PROXY_API_KEY_ALPHABET[bytes[i] % PROXY_API_KEY_ALPHABET.length];
    }
    return out;
  }

  function sanitizeProxyApiKeyLabel(value) {
    const raw = String(value || "").trim();
    if (!raw) return "generated-key";
    return raw.slice(0, 80);
  }

  function hasActiveManagedProxyApiKeys() {
    return listActiveProxyApiKeys(proxyApiKeyStore).length > 0;
  }

  function bootstrapLegacySharedApiKey(legacyKey, enabled = true) {
    if (!enabled) return false;
    const key = String(legacyKey || "").trim();
    if (!key) return false;
    const hash = hashProxyApiKey(key);
    const exists = (Array.isArray(proxyApiKeyStore?.keys) ? proxyApiKeyStore.keys : []).some(
      (entry) => String(entry?.hash || "") === hash
    );
    if (exists) return false;
    if (!Array.isArray(proxyApiKeyStore.keys)) proxyApiKeyStore.keys = [];
    const nowSec = Math.floor(Date.now() / 1000);
    proxyApiKeyStore.keys.unshift({
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
    const activeKeys = listActiveProxyApiKeys(proxyApiKeyStore);
    const exact = activeKeys.find((entry) => String(entry.hash || "") === hash) || null;
    if (exact) return exact;

    const folded = key.toLowerCase();
    const nearMatches = activeKeys.filter((entry) => String(entry.value || "").trim().toLowerCase() === folded);
    return nearMatches.length === 1 ? nearMatches[0] : null;
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
    const activeIds = new Set(activeKeys.map((entry) => String(entry.id)));
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

  function getProxyApiKeyStore() {
    return proxyApiKeyStore;
  }

  async function flushProxyApiKeyStore() {
    if (proxyApiKeyStoreFlushTimer) {
      clearTimeout(proxyApiKeyStoreFlushTimer);
      proxyApiKeyStoreFlushTimer = null;
    }
    await persistProxyApiKeyStore(proxyApiKeyStore);
  }

  return {
    bootstrapLegacySharedApiKey,
    buildApiKeySummary,
    cacheAuthContext,
    clearAuthContextCache,
    createProxyApiKey,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    flushProxyApiKeyStore,
    getCachedAuthContext,
    getProxyApiKeyStore,
    hasActiveManagedProxyApiKeys,
    hashProxyApiKey,
    loadProxyApiKeyStore,
    persistProxyApiKeyStore,
    recordManagedProxyApiKeyUsage,
    sanitizeProxyApiKeyLabel
  };
}
