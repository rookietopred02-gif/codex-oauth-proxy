const AUDIT_TOKEN_KEYS_PATTERN =
  /("?(?:access_token|refresh_token|id_token|token|api_key|apikey|x-api-key|x-goog-api-key|authorization|cookie|set-cookie|password|passwd|pwd|secret|client_secret|private_key|session_secret)"?\s*:\s*")([^"]+)(")/gi;
const AUDIT_TOKEN_ASSIGNMENT_PATTERN =
  /\b(access_token|refresh_token|id_token|token|api_key|apikey|x-api-key|x-goog-api-key|authorization|cookie|set-cookie|password|passwd|pwd|secret|client_secret|private_key|session_secret)=([^&\s]+)/gi;
const AUDIT_SECRET_HEADER_PATTERN =
  /\b(authorization|cookie|set-cookie|x-api-key|x-goog-api-key)\s*:\s*([^\r\n]+)/gi;
const REDACTED = "[REDACTED]";

function normalizeAuditKeyName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isSecretAuditKey(key) {
  const normalized = normalizeAuditKeyName(key);
  if (!normalized) return false;
  if (
    [
      "authorization",
      "cookie",
      "setcookie",
      "password",
      "passwd",
      "pwd",
      "secret",
      "clientsecret",
      "apikey",
      "xapikey",
      "xgoogapikey",
      "privatekey",
      "accesstoken",
      "refreshtoken",
      "idtoken",
      "token",
      "sessionsecret",
      "sessiontoken"
    ].includes(normalized)
  ) {
    return true;
  }
  if (normalized.endsWith("secret")) return true;
  if (normalized.endsWith("password")) return true;
  if (normalized.endsWith("apikey")) return true;
  if (normalized.endsWith("privatekey")) return true;
  return normalized.endsWith("token") && !normalized.endsWith("tokens");
}

function redactAuditValue(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditValue(item, seen));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? sanitizeAuditPayload(value) : value;
  }
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    out[key] = isSecretAuditKey(key) ? REDACTED : redactAuditValue(entryValue, seen);
  }
  return out;
}

export function isProxyApiPath(pathName) {
  const path = String(pathName || "");
  return path.startsWith("/v1") || path.startsWith("/v1beta");
}

export function toChunkBuffer(chunk, encoding = "utf8") {
  if (chunk === undefined || chunk === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, encoding || "utf8");
  return Buffer.from(String(chunk), encoding || "utf8");
}

export function parseContentType(value) {
  if (Array.isArray(value)) return parseContentType(value[0] || "");
  if (typeof value !== "string") return "";
  return value.split(";")[0].trim().toLowerCase();
}

export function sanitizeAuditPayload(text) {
  let out = String(text || "");
  out = out.replace(
    /(authorization"\s*:\s*"Bearer\s+)([^"]+)(")/gi,
    (_m, p1, _token, p3) => `${p1}${REDACTED}${p3}`
  );
  out = out.replace(AUDIT_TOKEN_KEYS_PATTERN, (_m, p1, _token, p3) => `${p1}${REDACTED}${p3}`);
  out = out.replace(AUDIT_TOKEN_ASSIGNMENT_PATTERN, (_m, key) => `${key}=${REDACTED}`);
  out = out.replace(AUDIT_SECRET_HEADER_PATTERN, (_m, key) => `${key}: ${REDACTED}`);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, `$1${REDACTED}`);
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, REDACTED);
  return out;
}

export function formatPayloadForAudit(raw, contentType, maxChars = 0) {
  let text = "";
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) return "";
    text = raw.toString("utf8");
  } else if (raw && typeof raw === "object") {
    try {
      text = JSON.stringify(raw, null, 2);
    } catch {
      text = String(raw);
    }
  } else {
    text = String(raw || "");
  }
  if (!text) return "";

  const ct = parseContentType(contentType);
  const looksJson = ct.includes("json") || /^[\s]*[\[{]/.test(text);
  if (looksJson) {
    try {
      text = JSON.stringify(redactAuditValue(JSON.parse(text)), null, 2);
    } catch {
      // keep original when non-standard JSON
    }
  } else if (raw && typeof raw === "object") {
    try {
      text = JSON.stringify(redactAuditValue(raw), null, 2);
    } catch {
      // keep original when non-standard objects
    }
  }

  text = sanitizeAuditPayload(text);
  const limit = Number(maxChars || 0);
  if (limit > 0 && text.length > limit) {
    const hidden = text.length - limit;
    text = `${text.slice(0, limit)}\n\n... [truncated ${hidden} chars]`;
  }
  return text;
}

export function inferProtocolType(pathName, localProtocolType = "", fallbackProtocolType = "") {
  const hinted = String(localProtocolType || "").trim();
  if (hinted) return hinted;
  const path = String(pathName || "");
  if (path.startsWith("/v1beta/")) return "gemini-v1beta";
  if (path.startsWith("/v1/messages")) return "anthropic-v1";
  if (/^\/v1\/models\/.+:(generateContent|streamGenerateContent|countTokens)$/.test(path)) {
    return "gemini-v1beta";
  }
  if (path.startsWith("/v1/")) return "openai-v1";
  return fallbackProtocolType;
}

export function sanitizeAuditPath(urlLike) {
  const raw = String(urlLike || "");
  if (!raw) return raw;
  try {
    const parsed = new URL(raw, "http://localhost");
    for (const key of [...parsed.searchParams.keys()]) {
      const normalized = normalizeAuditKeyName(key);
      if (normalized === "key" || isSecretAuditKey(key)) {
        parsed.searchParams.delete(key);
      }
    }
    const search = parsed.search || "";
    return `${parsed.pathname}${search}`;
  } catch {
    return raw;
  }
}
