const DEFAULT_CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHAIN_MAX_ENTRIES = 1024;

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function normalizeReplayableItem(item) {
  if (typeof item === "string") {
    return {
      role: "user",
      content: [{ type: "input_text", text: item }]
    };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;

  const itemType = normalizeId(item.type);
  if (itemType) {
    return cloneJson(item);
  }

  const role = normalizeId(item.role);
  if (role) {
    return cloneJson(item);
  }

  return null;
}

function normalizeReplayableItems(items) {
  if (typeof items === "string") {
    const normalized = normalizeReplayableItem(items);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeReplayableItem(item)).filter(Boolean);
}

function areReplayItemsEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function findReplayOverlap(priorHistory, currentInput) {
  const maxOverlap = Math.min(priorHistory.length, currentInput.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (!areReplayItemsEqual(priorHistory[priorHistory.length - overlap + index], currentInput[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

function mergeReplayHistory(priorHistory, currentInput) {
  const normalizedHistory = normalizeReplayableItems(priorHistory);
  const normalizedInput = normalizeReplayableItems(currentInput);
  if (normalizedHistory.length === 0) return normalizedInput;
  if (normalizedInput.length === 0) return normalizedHistory;

  const overlap = findReplayOverlap(normalizedHistory, normalizedInput);
  return [...normalizedHistory, ...normalizedInput.slice(overlap)];
}

function normalizeChainEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const responseId = normalizeId(entry.responseId);
  if (!responseId) return null;
  return {
    responseId,
    inputHistory: normalizeReplayableItems(entry.inputHistory),
    updatedAt: Number(entry.updatedAt || Date.now())
  };
}

export function buildResponsesChainEntry(requestBody, response, now = Date.now()) {
  const responseId = normalizeId(response?.id);
  if (!responseId) return null;

  const requestInput = normalizeReplayableItems(requestBody?.input);
  const outputItems = normalizeReplayableItems(response?.output);

  return normalizeChainEntry({
    responseId,
    inputHistory: [...requestInput, ...outputItems],
    updatedAt: now
  });
}

export function expandResponsesRequestBodyFromChain(requestBody, previousEntry) {
  const entry = normalizeChainEntry(previousEntry);
  if (!entry) return cloneJson(requestBody);

  const expanded = cloneJson(requestBody) || {};
  expanded.input = mergeReplayHistory(entry.inputHistory, expanded.input);
  delete expanded.previous_response_id;
  return expanded;
}

export function createResponsesChainStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_CHAIN_TTL_MS;
  const maxEntries =
    Number(options.maxEntries) > 0 ? Math.max(1, Math.floor(Number(options.maxEntries))) : DEFAULT_CHAIN_MAX_ENTRIES;
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

  function remember(entry, now = Date.now()) {
    const normalized = normalizeChainEntry(entry);
    if (!normalized) return null;
    prune(now);
    entries.delete(normalized.responseId);
    const stored = { ...normalized, updatedAt: now };
    entries.set(stored.responseId, stored);
    prune(now);
    return cloneJson(stored);
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
    return cloneJson(refreshed);
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
