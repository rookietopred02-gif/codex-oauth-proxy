const DEFAULT_AFFINITY_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AFFINITY_MAX_ENTRIES = 2048;

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
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_AFFINITY_TTL_MS;
  const maxEntries =
    Number(options.maxEntries) > 0 ? Math.max(1, Math.floor(Number(options.maxEntries))) : DEFAULT_AFFINITY_MAX_ENTRIES;
  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, value] of entries) {
      if (!value || now - Number(value.updatedAt || 0) > ttlMs) {
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

    prune(now);
    entries.delete(normalizedResponseId);
    const entry = {
      responseId: normalizedResponseId,
      poolEntryId,
      accountId: normalizeId(affinity?.accountId),
      updatedAt: now
    };
    entries.set(normalizedResponseId, entry);
    prune(now);
    return { ...entry };
  }

  function lookup(responseId, now = Date.now()) {
    const normalizedResponseId = normalizeId(responseId);
    if (!normalizedResponseId) return null;

    prune(now);
    const entry = entries.get(normalizedResponseId);
    if (!entry) return null;

    entries.delete(normalizedResponseId);
    const refreshed = { ...entry, updatedAt: now };
    entries.set(normalizedResponseId, refreshed);
    return { ...refreshed };
  }

  function clear() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return {
    clear,
    lookup,
    prune,
    remember,
    size
  };
}
