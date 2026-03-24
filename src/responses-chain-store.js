const DEFAULT_CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHAIN_MAX_ENTRIES = 1024;

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function pruneContentBlocks(content, allowedTypes) {
  if (!Array.isArray(content)) return [];
  const normalized = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const blockType = normalizeId(block.type);
    if (!allowedTypes.has(blockType)) continue;
    if (blockType === "output_text" || blockType === "input_text") {
      normalized.push({
        type: blockType,
        text: typeof block.text === "string" ? block.text : ""
      });
    }
  }
  return normalized;
}

function normalizeReplayableOutputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const itemType = normalizeId(item.type);

  if (itemType === "message") {
    const content = pruneContentBlocks(item.content, new Set(["output_text"]));
    if (content.length === 0) return null;
    return {
      role: "assistant",
      content
    };
  }

  if (itemType === "function_call") {
    const callId = normalizeId(item.call_id);
    const name = normalizeId(item.name);
    if (!callId || !name) return null;
    return {
      type: "function_call",
      call_id: callId,
      name,
      arguments: typeof item.arguments === "string" ? item.arguments : "{}"
    };
  }

  return null;
}

function normalizeReplayableInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;

  const itemType = normalizeId(item.type);
  if (itemType === "function_call" || itemType === "function_call_output") {
    return cloneJson(item);
  }

  const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "";
  if (!role) return null;
  const allowedTypes = new Set([role === "assistant" ? "output_text" : "input_text"]);
  const content = pruneContentBlocks(item.content, allowedTypes);
  if (content.length === 0) return null;
  return { role, content };
}

function normalizeReplayableItems(items, mapper) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => mapper(item)).filter(Boolean);
}

function buildRequestDefaults(requestBody) {
  const defaults = {};
  for (const key of [
    "model",
    "instructions",
    "tools",
    "tool_choice",
    "temperature",
    "top_p",
    "stop",
    "reasoning",
    "truncation",
    "metadata",
    "text",
    "parallel_tool_calls",
    "max_output_tokens"
  ]) {
    if (requestBody?.[key] !== undefined) {
      defaults[key] = cloneJson(requestBody[key]);
    }
  }
  return defaults;
}

function mergeExactHistoryForReplay(history, currentInput) {
  return normalizeReplayableItems([...(Array.isArray(history) ? history : []), ...(Array.isArray(currentInput) ? currentInput : [])], normalizeReplayableInputItem);
}

function normalizeChainEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const responseId = normalizeId(entry.responseId);
  if (!responseId) return null;
  return {
    responseId,
    requestDefaults: entry.requestDefaults && typeof entry.requestDefaults === "object" ? cloneJson(entry.requestDefaults) : {},
    inputHistory: normalizeReplayableItems(entry.inputHistory, normalizeReplayableInputItem),
    updatedAt: Number(entry.updatedAt || Date.now())
  };
}

export function buildResponsesChainEntry(requestBody, response, now = Date.now()) {
  const responseId = normalizeId(response?.id);
  if (!responseId) return null;
  const requestInput = normalizeReplayableItems(requestBody?.input, normalizeReplayableInputItem);
  const outputItems = normalizeReplayableItems(response?.output, normalizeReplayableOutputItem);
  return normalizeChainEntry({
    responseId,
    requestDefaults: buildRequestDefaults(requestBody),
    inputHistory: [...requestInput, ...outputItems],
    updatedAt: now
  });
}

export function expandResponsesRequestBodyFromChain(requestBody, previousEntry) {
  const entry = normalizeChainEntry(previousEntry);
  if (!entry) return cloneJson(requestBody);

  const expanded = cloneJson(requestBody) || {};
  for (const [key, value] of Object.entries(entry.requestDefaults || {})) {
    if (expanded[key] === undefined) {
      expanded[key] = cloneJson(value);
    }
  }

  const priorHistory = normalizeReplayableItems(entry.inputHistory, normalizeReplayableInputItem);
  const currentInput = normalizeReplayableItems(expanded.input, normalizeReplayableInputItem);
  expanded.input = mergeExactHistoryForReplay(priorHistory, currentInput);
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
