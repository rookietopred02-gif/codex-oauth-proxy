import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DASHBOARD_AUTH_STORE_VERSION = 1;
const DASHBOARD_SESSION_COOKIE = "codex_pm_dashboard_session";
const DEFAULT_SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64
});

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function randomBase64Url(bytes = 32) {
  return toBase64Url(crypto.randomBytes(Math.max(16, Number(bytes || 32) || 32)));
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStore(raw, { defaultEnabled = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const passwordSalt = typeof source.passwordSalt === "string" ? source.passwordSalt.trim() : "";
  const passwordHash = typeof source.passwordHash === "string" ? source.passwordHash.trim() : "";
  const sessionSecret = typeof source.sessionSecret === "string" ? source.sessionSecret.trim() : "";
  const nextStore = {
    version: DASHBOARD_AUTH_STORE_VERSION,
    enabled: normalizeBoolean(source.enabled, defaultEnabled),
    passwordSalt,
    passwordHash,
    sessionSecret: sessionSecret || randomBase64Url(32)
  };
  if (nextStore.enabled && !hasConfiguredPassword(nextStore)) {
    nextStore.enabled = false;
  }

  const changed =
    !source ||
    source.version !== nextStore.version ||
    source.enabled !== nextStore.enabled ||
    source.passwordSalt !== nextStore.passwordSalt ||
    source.passwordHash !== nextStore.passwordHash ||
    source.sessionSecret !== nextStore.sessionSecret;

  return {
    store: nextStore,
    changed
  };
}

function hasConfiguredPassword(store) {
  return Boolean(store?.passwordSalt) && Boolean(store?.passwordHash);
}

function hashDashboardPassword(password, salt = randomBase64Url(16)) {
  const secret = String(password ?? "");
  const saltText = String(salt || "").trim();
  if (!saltText) {
    throw new Error("dashboard_password_salt_missing");
  }
  const derived = crypto.scryptSync(secret, saltText, DEFAULT_SCRYPT_OPTIONS.keylen, {
    N: DEFAULT_SCRYPT_OPTIONS.N,
    r: DEFAULT_SCRYPT_OPTIONS.r,
    p: DEFAULT_SCRYPT_OPTIONS.p,
    maxmem: 32 * 1024 * 1024
  });
  return {
    salt: saltText,
    hash: derived.toString("hex")
  };
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(headerValue) {
  const out = {};
  const raw = String(headerValue || "");
  if (!raw) return out;
  for (const segment of raw.split(";")) {
    const idx = segment.indexOf("=");
    if (idx <= 0) continue;
    const key = segment.slice(0, idx).trim();
    if (!key) continue;
    const value = segment.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  const pathValue = String(options.path || "/").trim() || "/";
  parts.push(`Path=${pathValue}`);
  if (Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure === true) parts.push("Secure");
  return parts.join("; ");
}

function requestIsSecure(req) {
  if (req?.secure === true) return true;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").trim().toLowerCase();
  if (!forwardedProto) return false;
  return forwardedProto.split(",").some((value) => value.trim() === "https");
}

function appendSetCookie(res, cookieValue) {
  if (typeof res.append === "function") {
    res.append("Set-Cookie", cookieValue);
    return;
  }
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookieValue]);
    return;
  }
  res.setHeader("Set-Cookie", [existing, cookieValue]);
}

function extractClientAddress(req) {
  const cfIp = String(req?.headers?.["cf-connecting-ip"] || "").trim();
  if (cfIp) return cfIp;
  const forwardedFor = String(req?.headers?.["x-forwarded-for"] || "").trim();
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return (
    String(req?.socket?.remoteAddress || "").trim() ||
    String(req?.connection?.remoteAddress || "").trim() ||
    "unknown"
  );
}

function signSessionPayload(payloadText, sessionSecret) {
  return toBase64Url(crypto.createHmac("sha256", String(sessionSecret || "")).update(payloadText, "utf8").digest());
}

function buildSessionCookieValue(store, sessionTtlSeconds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payloadText = JSON.stringify({
    v: 1,
    iat: nowSec,
    exp: nowSec + Math.max(300, Number(sessionTtlSeconds || 0) || 0),
    nonce: randomBase64Url(12)
  });
  const encodedPayload = toBase64Url(Buffer.from(payloadText, "utf8"));
  const signature = signSessionPayload(encodedPayload, store.sessionSecret);
  return `${encodedPayload}.${signature}`;
}

function verifySessionCookieValue(rawValue, store) {
  const cookieValue = String(rawValue || "").trim();
  if (!cookieValue) {
    return {
      authenticated: false,
      error: "dashboard_auth_required",
      message: "Dashboard authentication required."
    };
  }

  const [encodedPayload, encodedSignature] = cookieValue.split(".");
  if (!encodedPayload || !encodedSignature) {
    return {
      authenticated: false,
      error: "dashboard_auth_invalid_session",
      message: "Dashboard session is invalid. Please sign in again."
    };
  }

  const expectedSignature = signSessionPayload(encodedPayload, store.sessionSecret);
  if (!constantTimeEqual(encodedSignature, expectedSignature)) {
    return {
      authenticated: false,
      error: "dashboard_auth_invalid_session",
      message: "Dashboard session is invalid. Please sign in again."
    };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload).toString("utf8"));
  } catch {
    return {
      authenticated: false,
      error: "dashboard_auth_invalid_session",
      message: "Dashboard session is invalid. Please sign in again."
    };
  }

  const expiresAt = Number(payload?.exp || 0);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSec) {
    return {
      authenticated: false,
      error: "dashboard_auth_session_expired",
      message: "Dashboard session expired. Please sign in again."
    };
  }

  return {
    authenticated: true,
    expiresAt
  };
}

function buildPublicStatus(store, sessionResult) {
  const enabled = store?.enabled === true;
  return {
    ok: true,
    enabled,
    configured: hasConfiguredPassword(store),
    authenticated: enabled ? sessionResult?.authenticated === true : false
  };
}

export async function createDashboardAuthController(options = {}) {
  const {
    storePath,
    defaultEnabled = false,
    sessionTtlSeconds = 12 * 60 * 60,
    loginWindowMs = 15 * 60 * 1000,
    loginMaxAttempts = 10,
    minimumPasswordLength = 8
  } = options;

  if (!storePath) {
    throw new Error("dashboard_auth_store_path_required");
  }

  let state = normalizeStore(null, { defaultEnabled }).store;
  const loginAttempts = new Map();

  async function persistState() {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(state, null, 2), "utf8");
  }

  async function load() {
    let raw = null;
    try {
      raw = JSON.parse(await fs.readFile(storePath, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    const normalized = normalizeStore(raw, { defaultEnabled });
    state = normalized.store;
    if (normalized.changed && raw) {
      await persistState();
    }
    return state;
  }

  function pruneLoginAttempts(address, now = Date.now()) {
    const key = String(address || "unknown");
    const existing = Array.isArray(loginAttempts.get(key)) ? loginAttempts.get(key) : [];
    const next = existing.filter((ts) => now - ts < loginWindowMs);
    if (next.length === 0) {
      loginAttempts.delete(key);
      return [];
    }
    loginAttempts.set(key, next);
    return next;
  }

  function recordFailedLogin(req) {
    const address = extractClientAddress(req);
    const next = pruneLoginAttempts(address);
    next.push(Date.now());
    loginAttempts.set(address, next);
  }

  function clearFailedLogin(req) {
    loginAttempts.delete(extractClientAddress(req));
  }

  function getLoginThrottle(req) {
    const address = extractClientAddress(req);
    const attempts = pruneLoginAttempts(address);
    if (attempts.length < loginMaxAttempts) {
      return {
        blocked: false,
        retryAfterSeconds: 0
      };
    }
    const oldest = attempts[0];
    const retryAfterMs = Math.max(0, loginWindowMs - (Date.now() - oldest));
    return {
      blocked: true,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
    };
  }

  function buildSessionCookie(req) {
    return serializeCookie(DASHBOARD_SESSION_COOKIE, buildSessionCookieValue(state, sessionTtlSeconds), {
      path: "/",
      maxAge: sessionTtlSeconds,
      httpOnly: true,
      sameSite: "Strict",
      secure: requestIsSecure(req)
    });
  }

  function buildClearedSessionCookie(req) {
    return serializeCookie(DASHBOARD_SESSION_COOKIE, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "Strict",
      secure: requestIsSecure(req)
    });
  }

  function appendSessionCookie(res, req) {
    appendSetCookie(res, buildSessionCookie(req));
  }

  function clearSessionCookie(res, req) {
    appendSetCookie(res, buildClearedSessionCookie(req));
  }

  function getSessionResult(req) {
    if (!state.enabled) {
      return { authenticated: false };
    }
    const cookies = parseCookieHeader(req?.headers?.cookie);
    return verifySessionCookieValue(cookies[DASHBOARD_SESSION_COOKIE], state);
  }

  function authenticateRequest(req) {
    if (!state.enabled) {
      return {
        ok: true,
        authenticated: false
      };
    }
    const session = getSessionResult(req);
    if (!session.authenticated) {
      return {
        ok: false,
        ...session
      };
    }
    return {
      ok: true,
      authenticated: true,
      expiresAt: session.expiresAt || 0
    };
  }

  function getPublicStatus(req) {
    return buildPublicStatus(state, getSessionResult(req));
  }

  async function configure({ enabled, password } = {}) {
    const nextState = { ...state };
    const hasPasswordInput = typeof password === "string" && password.length > 0;
    if (hasPasswordInput) {
      if (password.length < minimumPasswordLength) {
        throw new Error(`Dashboard password must be at least ${minimumPasswordLength} characters.`);
      }
      const passwordRecord = hashDashboardPassword(password);
      nextState.passwordSalt = passwordRecord.salt;
      nextState.passwordHash = passwordRecord.hash;
      nextState.sessionSecret = randomBase64Url(32);
    }
    if (typeof enabled === "boolean") {
      nextState.enabled = enabled;
    }
    if (nextState.enabled && !hasConfiguredPassword(nextState)) {
      throw new Error("Set a dashboard password before enabling public dashboard protection.");
    }
    state = nextState;
    await persistState();
    return {
      enabled: state.enabled,
      configured: hasConfiguredPassword(state)
    };
  }

  async function attemptLogin(req, password) {
    if (!state.enabled) {
      throw new Error("Dashboard protection is disabled.");
    }
    if (!hasConfiguredPassword(state)) {
      throw new Error("Dashboard password is not configured.");
    }
    const throttle = getLoginThrottle(req);
    if (throttle.blocked) {
      const error = new Error("Too many dashboard login attempts. Try again later.");
      error.code = "dashboard_auth_rate_limited";
      error.retryAfterSeconds = throttle.retryAfterSeconds;
      throw error;
    }

    const attempted = String(password ?? "");
    const expected = hashDashboardPassword(attempted, state.passwordSalt).hash;
    if (!constantTimeEqual(expected, state.passwordHash)) {
      recordFailedLogin(req);
      const error = new Error("Incorrect dashboard password.");
      error.code = "dashboard_auth_invalid_password";
      throw error;
    }

    clearFailedLogin(req);
    return getPublicStatus(req);
  }

  await load();

  return {
    cookieName: DASHBOARD_SESSION_COOKIE,
    storePath: path.resolve(storePath),
    isEnabled: () => state.enabled === true,
    isConfigured: () => hasConfiguredPassword(state),
    getPublicStatus,
    authenticateRequest,
    appendSessionCookie,
    clearSessionCookie,
    configure,
    attemptLogin,
    load
  };
}
