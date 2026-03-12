const DEFAULT_CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHAIN_MAX_ENTRIES = 1024;

function normalizeId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function clipText(value, maxLen = 220) {
  const normalized = String(value || "")
    .split(/\s+/)
    .join(" ")
    .trim();
  if (!normalized) return "";
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen - 3)}...`;
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

function summarizeToolArguments(rawArguments) {
  let parsed = rawArguments;
  if (typeof rawArguments === "string") {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return clipText(rawArguments, 160);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return clipText(parsed, 160);
  }

  const importantKeys = ["command", "description", "path", "pattern", "query", "url"];
  const parts = [];
  for (const key of importantKeys) {
    const value = parsed[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    parts.push(`${key}=${clipText(value, 120)}`);
  }
  if (parts.length > 0) return parts.join(", ");
  return clipText(JSON.stringify(parsed), 160);
}

function summarizeStructuredToolOutput(toolName, parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";

  if (toolName === "read_file") {
    if (parsed.content !== undefined && parsed.content !== null && parsed.content !== "") {
      return clipText(parsed.content, 220);
    }
    if (Array.isArray(parsed.artifact_paths) && parsed.artifact_paths.length > 0) {
      const details = parsed.artifact_paths.slice(0, 3).map((path) => String(path || "?")).join(", ");
      return clipText(`${parsed.summary || "Read file"} | artifacts=${details}`, 220);
    }
    return "";
  }

  if (toolName === "grep_text") {
    if (Array.isArray(parsed.matches) && parsed.matches.length > 0) {
      const rendered = [];
      for (const match of parsed.matches.slice(0, 3)) {
        if (!match || typeof match !== "object") continue;
        rendered.push(`${match.path || "?"}:${match.line}: ${match.text || ""}`);
      }
      if (rendered.length > 0) return clipText(rendered.join("; "), 220);
    }
    return "";
  }

  if (toolName === "list_dir") {
    if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      const rendered = parsed.entries
        .slice(0, 5)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => String(entry.path || "?"));
      if (rendered.length > 0) {
        const totalEntries = Number(parsed.total_entries || rendered.length);
        const suffix = totalEntries > rendered.length ? ` (+${totalEntries - rendered.length} more)` : "";
        return clipText(rendered.join(", ") + suffix, 220);
      }
    }
    return "";
  }

  return "";
}

function summarizeToolOutput(toolName, rawOutput) {
  if (rawOutput === undefined || rawOutput === null || rawOutput === "") {
    return "no recorded output";
  }

  let parsed = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      return clipText(rawOutput, 220);
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const structuredSummary = summarizeStructuredToolOutput(toolName, parsed);
    if (structuredSummary) return structuredSummary;
    for (const key of ["summary", "stdout", "stderr", "content"]) {
      const value = parsed[key];
      if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
        return clipText(value, 220);
      }
    }
    return clipText(JSON.stringify(parsed), 220);
  }

  return clipText(parsed, 220);
}

function summarizeReplayedToolExchange(functionCall, functionOutput) {
  const toolName = normalizeId(functionCall?.name) || "tool";
  const argumentsSummary = summarizeToolArguments(functionCall?.arguments || "{}");
  const outputSummary = summarizeToolOutput(toolName, functionOutput?.output);
  return argumentsSummary ? `${toolName}(${argumentsSummary}) -> ${outputSummary}` : `${toolName} -> ${outputSummary}`;
}

function compactHistoryForReplay(history, currentInput) {
  const currentCallIds = new Set(
    (Array.isArray(currentInput) ? currentInput : [])
      .filter((item) => item && typeof item === "object" && normalizeId(item.type) === "function_call_output")
      .map((item) => normalizeId(item.call_id))
      .filter(Boolean)
  );

  const replayItems = [];
  const pendingHistoricalCalls = new Map();
  const bufferedSummaries = [];

  function flushBuffer() {
    if (bufferedSummaries.length === 0) return;
    replayItems.push({
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `Previous tool results:\n${bufferedSummaries.join("\n")}`
        }
      ]
    });
    bufferedSummaries.length = 0;
  }

  for (const item of Array.isArray(history) ? history : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const itemType = normalizeId(item.type);

    if (itemType === "function_call") {
      const callId = normalizeId(item.call_id);
      if (currentCallIds.size > 0 && callId && currentCallIds.has(callId)) {
        flushBuffer();
        replayItems.push(cloneJson(item));
      } else if (callId) {
        pendingHistoricalCalls.set(callId, item);
      } else {
        flushBuffer();
        replayItems.push(cloneJson(item));
      }
      continue;
    }

    if (itemType === "function_call_output") {
      const callId = normalizeId(item.call_id);
      if (currentCallIds.size > 0 && callId && currentCallIds.has(callId)) {
        flushBuffer();
        replayItems.push(cloneJson(item));
      } else {
        const summary = summarizeReplayedToolExchange(pendingHistoricalCalls.get(callId), item);
        pendingHistoricalCalls.delete(callId);
        if (summary) bufferedSummaries.push(`- ${summary}`);
      }
      continue;
    }

    flushBuffer();
    replayItems.push(cloneJson(item));
  }

  for (const orphanCall of pendingHistoricalCalls.values()) {
    const summary = summarizeReplayedToolExchange(orphanCall, null);
    if (summary) bufferedSummaries.push(`- ${summary}`);
  }
  flushBuffer();
  return replayItems;
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
  expanded.input = compactHistoryForReplay([...priorHistory, ...currentInput], currentInput);
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
