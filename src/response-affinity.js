const DEFAULT_AFFINITY_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AFFINITY_MAX_ENTRIES = 2048;

function toFiniteNumber(value, fallback = 0) {
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toIntegerNumber(value, fallback) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : fallback;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toPositiveInteger(value, fallback) {
  const parsed = toIntegerNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function toTimestamp(value, fallback = Date.now()) {
  const parsed = toIntegerNumber(value, null);
  if (parsed !== null && parsed >= 0) return parsed;
  const fallbackParsed = toIntegerNumber(fallback, 0);
  return fallbackParsed !== null && fallbackParsed >= 0 ? fallbackParsed : 0;
}

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function extractPreviousResponseId(rawBody) {
  if (!rawBody || rawBody.length === 0) return "";

  let parsed;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
    parsed = JSON.parse(text);
  } catch {
    return "";
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  return normalizeId(parsed.previous_response_id);
}

export function createResponseAffinityStore(options = {}) {
  const ttlMs = toPositiveInteger(options.ttlMs, DEFAULT_AFFINITY_TTL_MS);
  const maxEntries = toPositiveInteger(options.maxEntries, DEFAULT_AFFINITY_MAX_ENTRIES);
  const entries = new Map();

  function prune(now = Date.now()) {
    const currentTime = toTimestamp(now);
    for (const [key, value] of entries) {
      const updatedAt = toTimestamp(value?.updatedAt, 0);
      if (!value || currentTime - updatedAt > ttlMs) {
        entries.delete(key);
      }
    }

    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  function remember(responseId, affinity, now = Date.now()) {
    const normalizedResponseId = normalizeId(responseId);
    const poolEntryId = normalizeId(affinity?.poolEntryId);
    if (!normalizedResponseId || !poolEntryId) return null;
    const currentTime = toTimestamp(now);

    prune(currentTime);
    entries.delete(normalizedResponseId);
    const entry = {
      responseId: normalizedResponseId,
      poolEntryId,
      accountId: normalizeId(affinity?.accountId),
      updatedAt: currentTime
    };
    entries.set(normalizedResponseId, entry);
    prune(currentTime);
    return { ...entry };
  }

  function lookup(responseId, now = Date.now()) {
    const normalizedResponseId = normalizeId(responseId);
    if (!normalizedResponseId) return null;
    const currentTime = toTimestamp(now);

    prune(currentTime);
    const entry = entries.get(normalizedResponseId);
    if (!entry) return null;

    entries.delete(normalizedResponseId);
    const refreshed = { ...entry, updatedAt: currentTime };
    entries.set(normalizedResponseId, refreshed);
    return { ...refreshed };
  }

  function forget(responseId) {
    const normalizedResponseId = normalizeId(responseId);
    if (!normalizedResponseId) return false;
    return entries.delete(normalizedResponseId);
  }

  function clear() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return {
    clear,
    forget,
    lookup,
    prune,
    remember,
    size
  };
}
