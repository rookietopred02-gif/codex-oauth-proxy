export const DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 900_000;
export const MAX_UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 3_600_000;

export function readNonNegativeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

export function normalizeNonNegativeInteger(value, fallback = 0) {
  return readNonNegativeInteger(value) ?? readNonNegativeInteger(fallback) ?? 0;
}

export function normalizeUpstreamStreamIdleTimeoutMs(
  value,
  fallback = DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
) {
  return normalizeNonNegativeInteger(value, fallback);
}
