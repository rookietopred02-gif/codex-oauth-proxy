const AUDIT_TOKEN_KEYS_PATTERN = /("?)([A-Za-z0-9_.-]+)\1\s*:\s*"([^"]+)"/gi;
const AUDIT_TOKEN_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]+)=([^&\s]+)/gi;
const AUDIT_HEADER_LINE_PATTERN = /(^|\n)([A-Za-z0-9_.-]+)\s*:\s*([^\r\n]+)/g;
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
      "sessiontoken",
      "authorizationcode",
      "authcode",
      "oauthcode"
    ].includes(normalized)
  ) {
    return true;
  }
  if (normalized.endsWith("authorizationcode")) return true;
  if (normalized.endsWith("authcode")) return true;
  if (normalized.endsWith("oauthcode")) return true;
  if (normalized.endsWith("secret")) return true;
  if (normalized.endsWith("authorization")) return true;
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
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
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
  out = out.replace(AUDIT_TOKEN_KEYS_PATTERN, (match, quote, key) =>
    isSecretAuditKey(key) ? `${quote}${key}${quote}: "${REDACTED}"` : match
  );
  out = out.replace(AUDIT_TOKEN_ASSIGNMENT_PATTERN, (match, key) =>
    isSecretAuditKey(key) ? `${key}=${REDACTED}` : match
  );
  out = out.replace(AUDIT_HEADER_LINE_PATTERN, (match, prefix, key) =>
    isSecretAuditKey(key) ? `${prefix}${key}: ${REDACTED}` : match
  );
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, `$1${REDACTED}`);
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, REDACTED);
  return out;
}

function formatDecodedAuditText(text, contentType) {
  const ct = parseContentType(contentType);
  const looksJson = ct.includes("json") || /^[\s]*[\[{]/.test(text);
  if (looksJson) {
    try {
      return JSON.stringify(redactAuditValue(JSON.parse(text)), null, 2);
    } catch {
      // keep original when non-standard JSON
    }
  }
  return sanitizeAuditPayload(text);
}

function textFromAuditBytes(raw) {
  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) return "";
    return raw.toString("utf8");
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0) return "";
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    if (raw.byteLength === 0) return "";
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    if (raw.byteLength === 0) return "";
    return Buffer.from(raw).toString("utf8");
  }
  return null;
}

function isMostlyText(value) {
  const sample = String(value || "").slice(0, 4096);
  if (!sample) return false;
  let printable = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable += 1;
    }
  }
  return printable / sample.length >= 0.9;
}

function looksLikeDecodedAuditText(value, contentType) {
  const text = String(value || "");
  if (!text) return false;
  const ct = parseContentType(contentType);
  if (ct.includes("json") || ct.includes("event-stream") || ct.startsWith("text/")) {
    return isMostlyText(text);
  }
  return /(^|\n)\s*(event:|data:)/.test(text) || /^[\s]*[\[{]/.test(text) || isMostlyText(text);
}

function toNonNegativeInteger(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function decodeIndexedByteAuditPayload(text, contentType = "") {
  const source = typeof text === "string" ? text : "";
  const trimmed = source.trimStart();
  if (!/^\{\s*"0"\s*:/.test(trimmed)) return "";

  const bytePairs = [];
  const pairPattern = /"(\d+)"\s*:\s*(\d{1,3})/g;
  let expectedIndex = 0;
  let match;
  while ((match = pairPattern.exec(trimmed))) {
    const index = Number(match[1]);
    const byte = Number(match[2]);
    if (index !== expectedIndex) break;
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return "";
    bytePairs.push(byte);
    expectedIndex += 1;
  }

  if (bytePairs.length < 8) return "";
  let decoded = Buffer.from(bytePairs).toString("utf8");
  if (!looksLikeDecodedAuditText(decoded, contentType)) return "";

  decoded = formatDecodedAuditText(decoded, contentType);
  if (/\.\.\. \[truncated \d+ chars\]/.test(source)) {
    decoded = `${decoded}\n\n... [truncated legacy byte-index packet]`;
  }
  return sanitizeAuditPayload(decoded);
}

export function normalizeAuditPacketText(text, contentType = "") {
  if (typeof text !== "string" || text.length === 0) return "";
  return decodeIndexedByteAuditPayload(text, contentType) || text;
}

export function formatPayloadForAudit(raw, contentType, maxChars = 0) {
  const byteText = textFromAuditBytes(raw);
  const decodedFromBytes = byteText !== null;
  let text = byteText;
  if (!decodedFromBytes) {
    if (raw && typeof raw === "object") {
      try {
        text = JSON.stringify(raw, null, 2);
      } catch {
        text = String(raw);
      }
    } else {
      text = String(raw || "");
    }
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
  } else if (!decodedFromBytes && raw && typeof raw === "object") {
    try {
      text = JSON.stringify(redactAuditValue(raw), null, 2);
    } catch {
      // keep original when non-standard objects
    }
  }

  text = sanitizeAuditPayload(text);
  const limit = toNonNegativeInteger(maxChars, 0);
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
      if (
        normalized === "key" ||
        normalized === "code" ||
        normalized === "authorizationcode" ||
        isSecretAuditKey(key)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    const search = parsed.search || "";
    return `${parsed.pathname}${search}`;
  } catch {
    return raw;
  }
}
