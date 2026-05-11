// @ts-check

export function parseTokenMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toFiniteNumber(value) {
  try {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function parseRequestTimestamp(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function formatRecentRequestRate(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return "0";
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1).replace(/\.0$/, "");
}

export function formatTokenMetric(value) {
  const n = parseTokenMetric(value);
  if (n === null) return "-";
  if (Math.abs(n) < 1000) return String(n);
  const v = n / 1000;
  if (Math.abs(v) >= 100) return `${Math.round(v)}k`;
  return `${v.toFixed(1).replace(/\.0$/, "")}k`;
}

export function sumRecentRequestTotals(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const totals = sourceRows.reduce(
    (acc, row) => {
      const input = parseTokenMetric(row?.inputTokens);
      const cachedInput = parseTokenMetric(row?.cachedInputTokens);
      const output = parseTokenMetric(row?.outputTokens);
      const total = parseTokenMetric(row?.totalTokens);
      const hasInput = input !== null;
      const hasCachedInput = cachedInput !== null;
      const hasOutput = output !== null;
      const hasTotal = total !== null;
      acc.count += 1;
      if (hasInput) {
        acc.input += input;
        acc.knownInput += 1;
      }
      if (hasCachedInput) {
        acc.cachedInput += cachedInput;
        acc.knownCachedInput += 1;
      }
      if (hasOutput) {
        acc.output += output;
        acc.knownOutput += 1;
      }
      if (hasTotal) {
        acc.total += total;
        acc.knownTotal += 1;
      } else if (hasInput || hasOutput) {
        acc.total += (hasInput ? input : 0) + (hasOutput ? output : 0);
        acc.knownTotal += 1;
      }
      return acc;
    },
    {
      count: 0,
      input: 0,
      cachedInput: 0,
      output: 0,
      total: 0,
      rpm: 0,
      knownInput: 0,
      knownCachedInput: 0,
      knownOutput: 0,
      knownTotal: 0
    }
  );
  const timestamps = sourceRows
    .map((row) => parseRequestTimestamp(row?.ts))
    .filter((ts) => ts !== null);
  if (timestamps.length > 0) {
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    const windowMinutes = Math.max(1, (maxTs - minTs) / 60000);
    totals.rpm = timestamps.length / windowMinutes;
  }
  return totals;
}
