import fs from "node:fs/promises";
import path from "node:path";

export async function loadTokenStore(tokenStorePath) {
  try {
    const raw = await fs.readFile(tokenStorePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { token: null };
  }
}

export async function saveTokenStore(tokenStorePath, nextStore) {
  await fs.mkdir(path.dirname(tokenStorePath), { recursive: true });
  await fs.writeFile(tokenStorePath, JSON.stringify(nextStore, null, 2), "utf8");
}

export async function loadJsonStore(filePath, fallbackValue = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export async function saveJsonStore(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function normalizeToken(tokenResponse, currentToken = null) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresIn = Number(tokenResponse.expires_in || 3600);
  const expiresAt = Number(tokenResponse.expires_at || nowSec + expiresIn);
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || currentToken?.refresh_token || null,
    token_type: tokenResponse.token_type || "Bearer",
    scope: tokenResponse.scope || null,
    expires_at: expiresAt
  };
}
