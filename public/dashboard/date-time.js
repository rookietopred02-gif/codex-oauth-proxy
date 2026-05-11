// @ts-check

export function getDashboardDateLocale(uiLang) {
  const normalized = String(uiLang || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (normalized === "zh-hans" || normalized === "zh-cn" || normalized.startsWith("zh-hans-")) return "zh-CN";
  if (
    normalized === "zh-hant" ||
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh" ||
    normalized.startsWith("zh-hant-")
  ) {
    return "zh-TW";
  }
  return "en-US";
}

function parseDashboardDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? new Date(value) : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? new Date(parsed) : null;
}

export function formatDashboardDateTime(value, uiLang, options = {}, DateTimeFormat = Intl.DateTimeFormat) {
  const date = parseDashboardDate(value);
  if (!date) return "-";
  if (!Number.isFinite(date.getTime())) return "-";
  const locale = getDashboardDateLocale(uiLang);
  try {
    return new DateTimeFormat(locale, {
      hour12: locale === "en-US",
      ...options
    }).format(date);
  } catch {
    return "-";
  }
}
