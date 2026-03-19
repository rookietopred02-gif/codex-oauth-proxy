const RAW_BODY_CACHE = Symbol("codexProMax.rawBody");
const RAW_BODY_PROMISE = Symbol("codexProMax.rawBodyPromise");
const JSON_BODY_CACHE = Symbol("codexProMax.jsonBody");

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

export async function readRawBody(req) {
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
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

  const rawBody = await readRawBody(req);
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
    if (req && typeof req === "object") {
      req[JSON_BODY_CACHE] = { ok: false, error };
    }
    throw error;
  }
}
