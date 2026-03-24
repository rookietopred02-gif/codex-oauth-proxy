export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = Number(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens
  );
  const outputTokens = Number(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens
  );
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);

  const hasInput = Number.isFinite(inputTokens);
  const hasOutput = Number.isFinite(outputTokens);
  const hasTotal = Number.isFinite(totalTokens);

  if (!hasInput && !hasOutput && !hasTotal) return null;

  const resolvedTotalTokens =
    hasTotal ? totalTokens : (hasInput ? inputTokens : 0) + (hasOutput ? outputTokens : 0);

  return {
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput ? outputTokens : null,
    totalTokens: Number.isFinite(resolvedTotalTokens) ? resolvedTotalTokens : null
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
    totalTokens: nextUsage.totalTokens ?? currentUsage.totalTokens
  });
}

export function toChatUsageFromNormalizedTokenUsage(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) return null;
  return {
    prompt_tokens: Number(normalized.inputTokens || 0),
    completion_tokens: Number(normalized.outputTokens || 0),
    total_tokens: Number(normalized.totalTokens || 0)
  };
}

export function mapResponsesUsageToChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  };
}
