export function isCodexTokenInvalidatedError(statusCode, reason) {
  if (Number(statusCode || 0) !== 401) return false;
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
