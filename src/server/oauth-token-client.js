import { normalizeNonNegativeInteger } from "../upstream-timeouts.js";

const DEFAULT_TOKEN_RESPONSE_BODY_TIMEOUT_MS = 30_000;

function toStatusCode(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
  }
  if (typeof value === "string" && /^[1-5]\d{2}$/.test(value)) {
    return Number(value);
  }
  return fallback;
}

function toSafeText(value, fallback = "") {
  try {
    return value == null ? fallback : String(value);
  } catch {
    return fallback;
  }
}

function createTokenResponseBodyTimeoutError(resp, timeoutMs) {
  const statusCode = toStatusCode(resp?.status, 0);
  const err = new Error(
    `Refresh failed: token endpoint response body timed out after ${timeoutMs}ms (HTTP ${statusCode}).`
  );
  err.code = "TOKEN_RESPONSE_BODY_TIMEOUT";
  err.statusCode = statusCode;
  return err;
}

async function readReaderChunkWithTimeout(reader, resp, timeoutMs) {
  if (!(timeoutMs > 0)) {
    return await reader.read();
  }

  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutError = createTokenResponseBodyTimeoutError(resp, timeoutMs);
          reject(timeoutError);
          reader.cancel?.(timeoutError).catch(() => {});
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseTextWithTimeout(resp, timeoutMs) {
  const normalizedTimeoutMs = normalizeNonNegativeInteger(
    timeoutMs,
    DEFAULT_TOKEN_RESPONSE_BODY_TIMEOUT_MS
  );

  if (!resp?.body || typeof resp.body.getReader !== "function") {
    if (!(normalizedTimeoutMs > 0)) {
      return await resp.text();
    }
    let timer = null;
    try {
      return await Promise.race([
        resp.text(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(createTokenResponseBodyTimeoutError(resp, normalizedTimeoutMs));
          }, normalizedTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await readReaderChunkWithTimeout(reader, resp, normalizedTimeoutMs);
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

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

  const text = await readResponseTextWithTimeout(resp, options.responseBodyTimeoutMs);
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      const statusCode = toStatusCode(resp?.status, 0);
      const err = new Error(`Refresh failed: invalid JSON response from token endpoint (HTTP ${statusCode}).`);
      err.statusCode = statusCode;
      throw err;
    }
  } else {
    payload = {};
  }

  if (!resp.ok) {
    const statusCode = toStatusCode(resp?.status, 0);
    const statusText = toSafeText(resp?.statusText).trim();
    const upstreamDetail =
      typeof payload?.error_description === "string" && payload.error_description.trim()
        ? payload.error_description.trim()
        : typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "";
    const suffix = upstreamDetail ? `: ${upstreamDetail}` : "";
    const err = new Error(`Refresh failed: HTTP ${statusCode} ${statusText}${suffix}`);
    err.statusCode = statusCode;
    err.upstreamError = typeof payload?.error === "string" ? payload.error : null;
    throw err;
  }

  return payload;
}
