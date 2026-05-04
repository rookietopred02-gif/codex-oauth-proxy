export function createCodexAccountIdentityHelpers(options = {}) {
  const jwtClaimPath = String(options.jwtClaimPath || "").trim();

  function decodeJwtPayload(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
  }

  function extractOpenAICodexAuthClaim(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    return jwtClaimPath ? payload?.[jwtClaimPath] || null : null;
  }

  function extractOpenAICodexAccountId(accessToken) {
    const authClaim = extractOpenAICodexAuthClaim(accessToken);
    const accountId = authClaim?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
  }

  function extractOpenAICodexEmail(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    const profileClaim = payload?.["https://api.openai.com/profile"];
    const email = profileClaim?.email || payload?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  }

  function extractOpenAICodexPrincipalId(accessToken) {
    const authClaim = extractOpenAICodexAuthClaim(accessToken);
    const payload = decodeJwtPayload(accessToken);
    const direct =
      authClaim?.chatgpt_account_user_id ||
      authClaim?.chatgpt_user_id ||
      payload?.sub ||
      null;
    if (typeof direct === "string" && direct.length > 0) return direct;
    const email = extractOpenAICodexEmail(accessToken);
    if (typeof email === "string" && email.length > 0) return `email:${email.toLowerCase()}`;
    return null;
  }

  function normalizeOpenAICodexPlanType(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    return raw.replace(/[^a-z0-9_-]+/g, "-");
  }

  function extractOpenAICodexPlanType(accessToken) {
    const authClaim = extractOpenAICodexAuthClaim(accessToken);
    return normalizeOpenAICodexPlanType(authClaim?.chatgpt_plan_type || authClaim?.plan_type || "");
  }

  function extractOpenAICodexOrganizationIds(token) {
    const payload = decodeJwtPayload(token);
    const authClaim = extractOpenAICodexAuthClaim(token);
    const collections = [
      payload?.organizations,
      authClaim?.organizations,
      payload?.orgs,
      authClaim?.orgs,
      payload?.organization_ids,
      authClaim?.organization_ids
    ];
    const ids = [];
    for (const collection of collections) {
      if (!Array.isArray(collection)) continue;
      for (const entry of collection) {
        const candidate =
          typeof entry === "string"
            ? entry
            : typeof entry?.id === "string"
              ? entry.id
              : typeof entry?.account_id === "string"
                ? entry.account_id
                : typeof entry?.chatgpt_account_id === "string"
                  ? entry.chatgpt_account_id
                  : typeof entry?.organization_id === "string"
                    ? entry.organization_id
                    : "";
        const normalized = String(candidate || "").trim();
        if (!normalized || ids.includes(normalized)) continue;
        ids.push(normalized);
      }
    }
    return ids;
  }

  return {
    decodeJwtPayload,
    extractOpenAICodexAuthClaim,
    extractOpenAICodexAccountId,
    extractOpenAICodexPrincipalId,
    normalizeOpenAICodexPlanType,
    extractOpenAICodexPlanType,
    extractOpenAICodexEmail,
    extractOpenAICodexOrganizationIds
  };
}
