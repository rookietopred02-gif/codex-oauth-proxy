function toFiniteTokenNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readNestedTokenValue(object, keys) {
  if (!object || typeof object !== "object") return null;
  for (const key of keys) {
    const value = object[key];
    const parsed = toFiniteTokenNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readCachedInputTokens(usage) {
  const direct = readNestedTokenValue(usage, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cachedPromptTokens",
    "cached_prompt_tokens"
  ]);
  if (direct !== null) return direct;

  for (const detailsKey of [
    "input_tokens_details",
    "prompt_tokens_details",
    "inputTokensDetails",
    "promptTokensDetails"
  ]) {
    const nested = readNestedTokenValue(usage?.[detailsKey], ["cached_tokens", "cachedTokens"]);
    if (nested !== null) return nested;
  }
  return null;
}

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = toFiniteTokenNumber(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens
  );
  const outputTokens = toFiniteTokenNumber(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens
  );
  const totalTokens = toFiniteTokenNumber(usage.total_tokens ?? usage.totalTokens);
  const cachedInputTokens = readCachedInputTokens(usage);

  const hasInput = inputTokens !== null;
  const hasOutput = outputTokens !== null;
  const hasTotal = totalTokens !== null;
  const hasCachedInput = cachedInputTokens !== null;

  if (!hasInput && !hasOutput && !hasTotal && !hasCachedInput) return null;

  const resolvedTotalTokens = hasTotal
    ? totalTokens
    : hasInput || hasOutput
      ? (hasInput ? inputTokens : 0) + (hasOutput ? outputTokens : 0)
      : null;

  return {
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput ? outputTokens : null,
    totalTokens: Number.isFinite(resolvedTotalTokens) ? resolvedTotalTokens : null,
    cachedInputTokens: hasCachedInput ? cachedInputTokens : null
  };
}

export function mergeNormalizedTokenUsage(current, next) {
  const currentUsage = normalizeTokenUsage(current);
  const nextUsage = normalizeTokenUsage(next);
  if (!currentUsage) return nextUsage;
  if (!nextUsage) return currentUsage;

  return normalizeTokenUsage({
    inputTokens: nextUsage.inputTokens ?? currentUsage.inputTokens,
    outputTokens: nextUsage.outputTokens ?? currentUsage.outputTokens,
    totalTokens: nextUsage.totalTokens ?? currentUsage.totalTokens,
    cachedInputTokens: nextUsage.cachedInputTokens ?? currentUsage.cachedInputTokens
  });
}

export function toChatUsageFromNormalizedTokenUsage(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return null;
  const chatUsage = {
    prompt_tokens: normalized.inputTokens ?? 0,
    completion_tokens: normalized.outputTokens ?? 0,
    total_tokens: normalized.totalTokens ?? 0
  };
  if (normalized.cachedInputTokens !== null) {
    chatUsage.prompt_tokens_details = {
      cached_tokens: normalized.cachedInputTokens ?? 0
    };
  }
  return chatUsage;
}

export function mapResponsesUsageToChatUsage(usage) {
  return toChatUsageFromNormalizedTokenUsage(usage);
}
