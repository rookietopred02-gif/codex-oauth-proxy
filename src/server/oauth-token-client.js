export async function refreshAccessToken(refreshToken, oauthConfig, options = {}) {
  const token = String(refreshToken || "").trim();
  if (!token) {
    throw new Error("Refresh token is required.");
  }

  const tokenUrl = String(oauthConfig?.tokenUrl || "").trim();
  if (!tokenUrl) {
    throw new Error("OAuth token URL is required.");
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", token);
  form.set("client_id", oauthConfig.clientId);
  if (oauthConfig.clientSecret) {
    form.set("client_secret", oauthConfig.clientSecret);
  }

  const fetchImpl = options.fetchImpl || fetch;
  const resp = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  const text = await resp.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const err = new Error(`Refresh failed: invalid JSON response from token endpoint (HTTP ${resp.status}).`);
      err.statusCode = Number(resp.status || 0) || 0;
      throw err;
    }
  } else {
    payload = {};
  }

  if (!resp.ok) {
    const upstreamDetail =
      typeof payload?.error_description === "string" && payload.error_description.trim()
        ? payload.error_description.trim()
        : typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "";
    const suffix = upstreamDetail ? `: ${upstreamDetail}` : "";
    const err = new Error(`Refresh failed: HTTP ${resp.status} ${resp.statusText || ""}${suffix}`);
    err.statusCode = Number(resp.status || 0) || 0;
    err.upstreamError = typeof payload?.error === "string" ? payload.error : null;
    throw err;
  }

  return payload;
}
