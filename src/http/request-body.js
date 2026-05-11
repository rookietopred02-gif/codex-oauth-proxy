const RAW_BODY_CACHE = Symbol("codexProMax.rawBody");
const RAW_BODY_PROMISE = Symbol("codexProMax.rawBodyPromise");
const JSON_BODY_CACHE = Symbol("codexProMax.jsonBody");
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

function parseIntegerValue(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function toHttpStatusCode(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
  }
  if (typeof value === "string" && /^[1-5]\d{2}$/.test(value)) {
    return Number(value);
  }
  return fallback;
}

function resolveMaxBodyBytes(options = {}) {
  const configured = parseIntegerValue(options.maxBytes ?? options.maxBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES);
  if (configured === null || configured <= 0) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  return configured;
}

function createBodyTooLargeError(maxBytes) {
  const error = new Error(`Request body exceeds the ${maxBytes} byte limit.`);
  error.code = "request_body_too_large";
  error.statusCode = 413;
  return error;
}

export function isRequestBodyError(err) {
  return err?.code === "invalid_json" || err?.code === "request_body_too_large";
}

export function isRequestBodyTooLargeError(err) {
  return err?.code === "request_body_too_large";
}

export function getRequestBodyErrorStatus(err, fallbackStatus = 400) {
  const statusCode = toHttpStatusCode(err?.statusCode ?? fallbackStatus, fallbackStatus);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : fallbackStatus;
}

function setRawBodyCache(req, rawBody) {
  const normalized = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  req[RAW_BODY_CACHE] = normalized;
  req.rawBody = normalized;
  return normalized;
}

export function getCachedRawBody(req) {
  if (!req || typeof req !== "object") return null;
  if (Buffer.isBuffer(req[RAW_BODY_CACHE])) return req[RAW_BODY_CACHE];
  if (Buffer.isBuffer(req.rawBody)) return setRawBodyCache(req, req.rawBody);
  return null;
}

export function getCachedJsonBody(req) {
  if (!req || typeof req !== "object") return undefined;
  const cached = req[JSON_BODY_CACHE];
  if (!cached || cached.ok !== true) return undefined;
  return cached.value;
}

export async function readRawBody(req, options = {}) {
  const cached = getCachedRawBody(req);
  if (cached) return cached;

  if (!req || typeof req !== "object") {
    return Buffer.alloc(0);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return setRawBodyCache(req, Buffer.alloc(0));
  }

  if (req[RAW_BODY_PROMISE]) {
    return req[RAW_BODY_PROMISE];
  }

  req[RAW_BODY_PROMISE] = (async () => {
    const maxBytes = resolveMaxBodyBytes(options);
    const contentLength = parseIntegerValue(req.headers?.["content-length"] || 0);
    if (contentLength !== null && contentLength > maxBytes) {
      throw createBodyTooLargeError(maxBytes);
    }
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        throw createBodyTooLargeError(maxBytes);
      }
      chunks.push(buffer);
    }
    return setRawBodyCache(req, chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
  })();

  try {
    return await req[RAW_BODY_PROMISE];
  } finally {
    req[RAW_BODY_PROMISE] = null;
  }
}

export async function readJsonBody(req, options = {}) {
  const allowEmpty = options.allowEmpty !== false;
  const cached = req?.[JSON_BODY_CACHE];
  if (cached) {
    if (cached.ok) return cached.value;
    throw cached.error;
  }

  const rawBody = await readRawBody(req, options);
  if (!rawBody || rawBody.length === 0) {
    const emptyValue = allowEmpty ? {} : null;
    if (req && typeof req === "object") {
      req[JSON_BODY_CACHE] = { ok: true, value: emptyValue };
    }
    return emptyValue;
  }

  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    if (req && typeof req === "object") {
      req[JSON_BODY_CACHE] = { ok: true, value: parsed };
    }
    return parsed;
  } catch {
    const error = new Error("Body must be valid JSON.");
    error.code = "invalid_json";
    error.statusCode = 400;
    if (req && typeof req === "object") {
      req[JSON_BODY_CACHE] = { ok: false, error };
    }
    throw error;
  }
}
