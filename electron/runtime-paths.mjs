// @ts-check

import path from "node:path";

export const DESKTOP_APP_NAME = "codex-pro-max";

function resolveExplicitDesktopDataDir(env = process.env) {
  const rawValue = String(
    env?.CODEX_PRO_MAX_APP_DATA_DIR || env?.CODEX_PRO_MAX_DESKTOP_USER_DATA_DIR || ""
  ).trim();
  if (!rawValue) return null;
  return path.resolve(rawValue);
}

export function resolveDesktopUserDataDir({
  appDataRoot,
  appName = DESKTOP_APP_NAME,
  env = process.env
} = {}) {
  const explicitDir = resolveExplicitDesktopDataDir(env);
  if (explicitDir) {
    return explicitDir;
  }
  if (!appDataRoot) {
    throw new Error("appDataRoot is required when no desktop app data override is set.");
  }
  return path.join(path.resolve(appDataRoot), appName);
}
