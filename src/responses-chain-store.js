import { createResponsesInputConversionHelpers } from "./protocols/openai/responses-input-conversion.js";

const DEFAULT_CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHAIN_MAX_ENTRIES = 1024;
const { toResponsesInputFromChatMessages } = createResponsesInputConversionHelpers();

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

function shouldFilterReplayItemByStructure(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const itemType = normalizeId(item.type);
  const phase = normalizeId(item.phase);
  return itemType === "plan" || phase === "commentary";
}

function isInstructionRoleItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const role = normalizeId(item.role);
  return role === "system" || role === "developer";
}

function normalizeReplayableAssistantItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (shouldFilterReplayItemByStructure(item)) return null;
  if (!normalizeId(item.type) && normalizeId(item.role) === "assistant") {
    const converted = toResponsesInputFromChatMessages([item]);
    const assistantMessage = Array.isArray(converted)
      ? converted.find((entry) => entry && entry.role === "assistant" && !entry.type)
      : null;
    if (assistantMessage) {
      return {
        type: "message",
        role: "assistant",
        content: cloneJson(assistantMessage.content)
      };
    }
  }
  return cloneJson(item);
}

function normalizeReplayableRoleItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const role = normalizeId(item.role);
  if (!role || normalizeId(item.type)) return cloneJson(item);
  if (role === "assistant") {
    return normalizeReplayableAssistantItem(item);
  }
  const converted = toResponsesInputFromChatMessages([item]);
  const first = Array.isArray(converted) && converted.length > 0 ? converted[0] : null;
  return first ? cloneJson(first) : cloneJson(item);
}

function normalizeReplayableItem(item, options = {}) {
  const preserveInstructionRoles = options.preserveInstructionRoles === true;
  if (typeof item === "string") {
    return {
      role: "user",
      content: [{ type: "input_text", text: item }]
    };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;

  const itemType = normalizeId(item.type);
  const role = normalizeId(item.role);
  if (shouldFilterReplayItemByStructure(item)) {
    return null;
  }
  if (role === "system" || role === "developer") {
    return preserveInstructionRoles ? cloneJson(item) : null;
  }
  if (role === "assistant") {
    return normalizeReplayableAssistantItem(item);
  }
  if (itemType) {
    return cloneJson(item);
  }

  if (role) {
    return normalizeReplayableRoleItem(item);
  }

  return null;
}

function normalizeReplayableItems(items, options = {}) {
  if (typeof items === "string") {
    const normalized = normalizeReplayableItem(items, options);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      !normalizeId(item.type) &&
      (normalizeId(item.role) === "assistant" || normalizeId(item.role) === "tool" || normalizeId(item.role) === "user")
    ) {
      const converted = toResponsesInputFromChatMessages([item]);
      for (const entry of Array.isArray(converted) ? converted : []) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (entry.role === "assistant" && !entry.type) {
          const assistantMessage = normalizeReplayableAssistantItem(entry);
          if (assistantMessage) normalized.push(assistantMessage);
          continue;
        }
        const canonical =
          !normalizeId(entry.type) && normalizeId(entry.role)
            ? normalizeReplayableRoleItem(entry)
            : normalizeReplayableItem(entry, options);
        if (canonical) normalized.push(canonical);
      }
      continue;
    }

    const canonical = normalizeReplayableItem(item, options);
    if (canonical) normalized.push(canonical);
  }
  return normalized;
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

function splitLeadingInstructionItems(items) {
  const leadingInstructionItems = [];
  let index = 0;
  while (index < items.length && isInstructionRoleItem(items[index])) {
    leadingInstructionItems.push(items[index]);
    index += 1;
  }
  return {
    leadingInstructionItems,
    remainder: items.slice(index)
  };
}

function mergeReplayHistory(priorHistory, currentInput, options = {}) {
  const normalizedHistory = normalizeReplayableItems(priorHistory);
  const normalizedInput = normalizeReplayableItems(currentInput, options);
  const { leadingInstructionItems, remainder } = splitLeadingInstructionItems(normalizedInput);
  if (normalizedHistory.length === 0) return [...leadingInstructionItems, ...remainder];
  if (remainder.length === 0) return [...normalizedHistory, ...leadingInstructionItems];

  const overlap = findReplayOverlap(normalizedHistory, remainder);
  return [...normalizedHistory, ...leadingInstructionItems, ...remainder.slice(overlap)];
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
  const hasMessagesAlias = Array.isArray(expanded.messages);
  const hasExplicitInput = expanded.input !== undefined;
  const currentTurnInput = hasExplicitInput ? expanded.input : hasMessagesAlias ? expanded.messages : expanded.input;
  expanded.input = mergeReplayHistory(entry.inputHistory, currentTurnInput, {
    preserveInstructionRoles: hasExplicitInput
  });
  if (expanded.input !== undefined && Array.isArray(expanded.messages)) {
    delete expanded.messages;
  }
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
