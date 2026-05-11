import crypto from "node:crypto";

import {
  cloneJson,
  isRecordObject,
  mergeResponsesWebSearchCallOutputItems
} from "./responses-output-items.js";

function toSafeTokenCount(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toStatusCode(value, fallback = 502) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
  }
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : fallback;
}

export function normalizeResponsesUsageObject(usage, normalizeTokenUsage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return undefined;
  const normalizedUsage = {
    input_tokens: toSafeTokenCount(normalized.inputTokens),
    output_tokens: toSafeTokenCount(normalized.outputTokens),
    total_tokens: toSafeTokenCount(normalized.totalTokens)
  };
  if (normalized.cachedInputTokens !== null) {
    normalizedUsage.input_tokens_details = {
      cached_tokens: toSafeTokenCount(normalized.cachedInputTokens)
    };
  }
  return normalizedUsage;
}

export function buildResponsesFailureResult(event) {
  const responseError = isRecordObject(event?.response?.error) ? event.response.error : null;
  const rootError = isRecordObject(event?.error) ? event.error : null;
  const message =
    responseError?.message ||
    rootError?.message ||
    event?.message ||
    "Upstream response failed.";
  const statusCode =
    event?.response?.status_code ||
    event?.status_code ||
    responseError?.status_code ||
    rootError?.status_code ||
    502;
  return {
    message: String(message || "Upstream response failed."),
    statusCode: toStatusCode(statusCode, 502),
    code: String(responseError?.code || rootError?.code || event?.code || "")
  };
}

export function buildSyntheticCompletedResponseFromSseState(state, options) {
  const { config, normalizeTokenUsage } = options;
  const output = Array.isArray(state.output) ? state.output.filter(Boolean) : [];
  if (output.length === 0) return null;
  return {
    id:
      typeof state.responseId === "string" && state.responseId.length > 0
        ? state.responseId
        : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    model:
      typeof state.responseModel === "string" && state.responseModel.length > 0
        ? state.responseModel
        : config.codex.defaultModel,
    status:
      typeof state.responseStatus === "string" && state.responseStatus.length > 0
        ? state.responseStatus
        : "completed",
    output,
    ...(state.usage ? { usage: normalizeResponsesUsageObject(state.usage, normalizeTokenUsage) } : {})
  };
}

function getResponsesOutputItemMergeKey(item, index = 0) {
  if (!isRecordObject(item)) return `index:${index}`;
  if (typeof item.id === "string" && item.id.length > 0) {
    return `id:${item.id}`;
  }
  if (typeof item.call_id === "string" && item.call_id.length > 0) {
    return `call:${item.type || "unknown"}:${item.call_id}`;
  }
  const type = typeof item.type === "string" ? item.type : "unknown";
  const role = typeof item.role === "string" ? item.role : "";
  return `index:${index}:${type}:${role}`;
}

function mergeIndexedResponseItemArrays(accumulatedItems, completedItems) {
  const accumulated = Array.isArray(accumulatedItems) ? accumulatedItems : [];
  const completed = Array.isArray(completedItems) ? completedItems : [];
  const maxLength = Math.max(accumulated.length, completed.length);
  const merged = [];

  for (let index = 0; index < maxLength; index += 1) {
    const accumulatedItem = accumulated[index];
    const completedItem = completed[index];

    if (accumulatedItem === undefined) {
      merged.push(cloneJson(completedItem));
      continue;
    }
    if (completedItem === undefined) {
      merged.push(cloneJson(accumulatedItem));
      continue;
    }
    if (!isRecordObject(accumulatedItem) || !isRecordObject(completedItem)) {
      merged.push(cloneJson(completedItem));
      continue;
    }

    merged.push({
      ...cloneJson(accumulatedItem),
      ...cloneJson(completedItem)
    });
  }

  return merged.filter((item) => item !== undefined);
}

function mergeResponsesOutputItems(accumulatedOutput, completedOutput) {
  const accumulated = Array.isArray(accumulatedOutput) ? accumulatedOutput.filter(Boolean) : [];
  const completed = Array.isArray(completedOutput) ? completedOutput.filter(Boolean) : [];

  if (accumulated.length === 0) return completed.map((item) => cloneJson(item));
  if (completed.length === 0) return accumulated.map((item) => cloneJson(item));

  const merged = accumulated.map((item) => cloneJson(item));
  const indexByKey = new Map();

  for (let index = 0; index < accumulated.length; index += 1) {
    indexByKey.set(getResponsesOutputItemMergeKey(accumulated[index], index), index);
  }

  for (let index = 0; index < completed.length; index += 1) {
    const completedItem = completed[index];
    const key = getResponsesOutputItemMergeKey(completedItem, index);
    const existingIndex = indexByKey.get(key);

    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(cloneJson(completedItem));
      continue;
    }

    const accumulatedItem = merged[existingIndex];
    if (!isRecordObject(accumulatedItem) || !isRecordObject(completedItem)) {
      merged[existingIndex] = cloneJson(completedItem);
      continue;
    }

    if (accumulatedItem.type === "web_search_call" && completedItem.type === "web_search_call") {
      merged[existingIndex] = mergeResponsesWebSearchCallOutputItems(accumulatedItem, completedItem);
      continue;
    }

    const mergedItem = {
      ...cloneJson(accumulatedItem),
      ...cloneJson(completedItem)
    };

    if (Array.isArray(accumulatedItem.content) || Array.isArray(completedItem.content)) {
      mergedItem.content = mergeIndexedResponseItemArrays(accumulatedItem.content, completedItem.content);
    }
    if (Array.isArray(accumulatedItem.summary) || Array.isArray(completedItem.summary)) {
      mergedItem.summary = mergeIndexedResponseItemArrays(accumulatedItem.summary, completedItem.summary);
    }
    if (
      accumulatedItem.type === "function_call" &&
      typeof accumulatedItem.arguments === "string" &&
      (!mergedItem.arguments || typeof mergedItem.arguments !== "string" || mergedItem.arguments.length === 0)
    ) {
      mergedItem.arguments = accumulatedItem.arguments;
    }

    merged[existingIndex] = mergedItem;
  }

  return merged;
}

export function mergeCompletedResponseWithSseState(completedResponse, state, options) {
  const { config, normalizeTokenUsage } = options;
  const synthetic = buildSyntheticCompletedResponseFromSseState(state, { config, normalizeTokenUsage });
  if (!completedResponse) return synthetic;

  const merged = cloneJson(completedResponse) || {};
  const mergedOutput = mergeResponsesOutputItems(state.output, completedResponse.output);

  if (mergedOutput.length > 0) {
    merged.output = mergedOutput;
  } else if (synthetic?.output) {
    merged.output = synthetic.output;
  }
  if ((typeof merged.id !== "string" || merged.id.length === 0) && synthetic?.id) {
    merged.id = synthetic.id;
  }
  if ((typeof merged.model !== "string" || merged.model.length === 0) && synthetic?.model) {
    merged.model = synthetic.model;
  }
  if ((typeof merged.status !== "string" || merged.status.length === 0) && synthetic?.status) {
    merged.status = synthetic.status;
  }
  if (!isRecordObject(merged.usage) && synthetic?.usage) {
    merged.usage = synthetic.usage;
  }

  return merged;
}
