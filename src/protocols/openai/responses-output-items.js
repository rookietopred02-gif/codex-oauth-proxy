import crypto from "node:crypto";

export function isRecordObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

const WEB_SEARCH_CALL_STATUS_RANK = new Map([
  ["in_progress", 1],
  ["searching", 2],
  ["incomplete", 3],
  ["failed", 3],
  ["completed", 4]
]);

export function chooseResponsesWebSearchCallStatus(existingStatus, nextStatus) {
  if (!existingStatus) return nextStatus;
  if (!nextStatus) return existingStatus;
  const existingRank = WEB_SEARCH_CALL_STATUS_RANK.get(existingStatus) || 0;
  const nextRank = WEB_SEARCH_CALL_STATUS_RANK.get(nextStatus) || 0;
  if (existingRank > 0 || nextRank > 0) {
    return nextRank >= existingRank ? nextStatus : existingStatus;
  }
  return nextStatus;
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

export function mergeResponsesWebSearchCallOutputItems(existing, next) {
  if (existing?.type !== "web_search_call" || next?.type !== "web_search_call") {
    return next;
  }
  const merged = {
    ...cloneJson(existing),
    ...cloneJson(next)
  };
  const status = chooseResponsesWebSearchCallStatus(existing.status, next.status);
  if (status) merged.status = status;
  if (isRecordObject(existing.action) || isRecordObject(next.action)) {
    const existingAction = isRecordObject(existing.action) ? cloneJson(existing.action) : {};
    const nextAction = isRecordObject(next.action) ? cloneJson(next.action) : {};
    merged.action = {
      ...existingAction,
      ...nextAction
    };
    if (hasNonEmptyArray(existingAction.sources) && !hasNonEmptyArray(nextAction.sources)) {
      merged.action.sources = existingAction.sources;
    }
  }
  return merged;
}

export function normalizeResponsesReasoningItem(item) {
  if (!isRecordObject(item) || item.type !== "reasoning") return null;
  const summary = [];
  const content = [];
  for (const part of Array.isArray(item.summary) ? item.summary : []) {
    if (!isRecordObject(part) || part.type !== "summary_text") continue;
    summary.push({
      type: "summary_text",
      text: typeof part.text === "string" ? part.text : ""
    });
  }
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!isRecordObject(part) || part.type !== "reasoning_text") continue;
    content.push({
      type: "reasoning_text",
      text: typeof part.text === "string" ? part.text : ""
    });
  }
  const normalized = {
    ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
    type: "reasoning",
    summary: []
  };
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    normalized.encrypted_content = item.encrypted_content;
  }
  if (summary.length > 0) {
    normalized.summary = summary;
  }
  if (content.length > 0) {
    normalized.content = content;
  }
  return normalized;
}

export function normalizeResponsesMessageContentPart(chunk) {
  if (!isRecordObject(chunk)) return null;
  if (chunk.type === "output_text") {
    const text =
      typeof chunk.text === "string"
        ? chunk.text
        : typeof chunk.output_text === "string"
          ? chunk.output_text
          : "";
    const normalizedChunk = {
      type: "output_text",
      text
    };
    if (Array.isArray(chunk.annotations)) {
      normalizedChunk.annotations = chunk.annotations;
    }
    return normalizedChunk;
  }
  if (chunk.type === "refusal") {
    const refusalText =
      typeof chunk.refusal === "string" ? chunk.refusal : typeof chunk.text === "string" ? chunk.text : "";
    return {
      type: "output_text",
      text: refusalText,
      annotations: []
    };
  }
  return null;
}

export function normalizeResponsesOutputMessageItem(item) {
  if (!isRecordObject(item) || item.type !== "message" || item.role !== "assistant") return null;
  const content = [];
  for (const chunk of Array.isArray(item.content) ? item.content : []) {
    const normalizedChunk = normalizeResponsesMessageContentPart(chunk);
    if (!normalizedChunk) continue;
    content.push(normalizedChunk);
  }
  return {
    ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
    type: "message",
    role: "assistant",
    ...(typeof item.status === "string" && item.status.length > 0 ? { status: item.status } : {}),
    ...(typeof item.phase === "string" && item.phase.length > 0 ? { phase: item.phase } : {}),
    content
  };
}

export function normalizeResponsesFunctionCallItem(item) {
  if (!isRecordObject(item) || item.type !== "function_call") return null;
  const name = typeof item.name === "string" ? item.name : "";
  if (!name) return null;
  const rawArguments =
    typeof item.arguments === "string"
      ? item.arguments
      : isRecordObject(item.arguments) || Array.isArray(item.arguments)
        ? JSON.stringify(item.arguments)
        : "";
  return {
    ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
    ...(typeof item.call_id === "string" && item.call_id.length > 0 ? { call_id: item.call_id } : {}),
    type: "function_call",
    name,
    arguments: rawArguments
  };
}

export function normalizeResponsesWebSearchCallItem(item) {
  if (!isRecordObject(item) || item.type !== "web_search_call") return null;
  return {
    ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
    type: "web_search_call",
    ...(typeof item.status === "string" && item.status.length > 0 ? { status: item.status } : {}),
    ...(isRecordObject(item.action) ? { action: item.action } : {})
  };
}

export function normalizeResponsesOutputItem(item) {
  if (!isRecordObject(item) || typeof item.type !== "string" || item.type.length === 0) return null;
  return (
    normalizeResponsesReasoningItem(item) ||
    normalizeResponsesOutputMessageItem(item) ||
    normalizeResponsesWebSearchCallItem(item) ||
    normalizeResponsesFunctionCallItem(item) ||
    cloneJson(item)
  );
}

export function extractAssistantMessageContentParts(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    if (!item || item.type !== "message" || item.role !== "assistant") continue;
    for (const chunk of Array.isArray(item.content) ? item.content : []) {
      const normalizedChunk = normalizeResponsesMessageContentPart(chunk);
      if (normalizedChunk) parts.push(normalizedChunk);
    }
  }
  return parts;
}

export function extractAssistantTextFromResponse(response) {
  return extractAssistantMessageContentParts(response)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

export function extractAssistantAnnotationsFromResponse(response) {
  return extractAssistantMessageContentParts(response)
    .filter((part) => part.type === "output_text" && Array.isArray(part.annotations))
    .flatMap((part) => part.annotations);
}

export function extractAssistantToolCallsFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = [];
  for (const item of output) {
    if (!item || item.type !== "function_call") continue;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) continue;
    calls.push({
      id:
        typeof item.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : `call_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "function",
      function: {
        name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}"
      }
    });
  }
  return calls;
}
