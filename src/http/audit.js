const AUDIT_TOKEN_KEYS_PATTERN =
  /("?(?:access_token|refresh_token|id_token|api_key|x-api-key|x-goog-api-key)"?\s*:\s*")([^"]+)(")/gi;

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
    (_m, p1, _token, p3) => `${p1}[REDACTED]${p3}`
  );
  out = out.replace(AUDIT_TOKEN_KEYS_PATTERN, (_m, p1, _token, p3) => `${p1}[REDACTED]${p3}`);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, "$1[REDACTED]");
  return out;
}

export function formatPayloadForAudit(raw, contentType, maxChars = 0) {
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
  if (/^\/v1\/models\/.+:(generateContent|streamGenerateContent)/.test(path)) return "gemini-v1beta";
  if (path.startsWith("/v1/")) return "openai-v1";
  return fallbackProtocolType;
}

export function sanitizeAuditPath(urlLike) {
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
