function toStatusCode(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[1-5]\d{2}$/.test(text)) return 0;
    return Number(text);
  }
  try {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function isCodexTokenInvalidatedError(statusCode, reason) {
  if (toStatusCode(statusCode || 0) !== 401) return false;
  const text = String(reason || "").toLowerCase();
  return (
    text.includes("token_invalidated") ||
    text.includes("token_revoked") ||
    text.includes("account_deactivated") ||
    text.includes("account has been deactivated") ||
    text.includes("your openai account has been deactivated") ||
    text.includes("authentication token has been invalidated") ||
    text.includes("encountered invalidated oauth token") ||
    text.includes("invalidated oauth token") ||
    text.includes("please try signing in again")
  );
}
