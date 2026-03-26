// @ts-check

import fsSync from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeEmbeddedServerPort(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const port = Math.floor(parsed);
  if (port < 1 || port > 65535) return null;
  return port;
}

/**
 * @param {string} envFilePath
 * @param {unknown} [explicitPort]
 * @returns {number}
 */
export function resolveEmbeddedServerPort(envFilePath, explicitPort = undefined) {
  const explicit = normalizeEmbeddedServerPort(explicitPort);
  if (explicit !== null) return explicit;

  try {
    if (envFilePath && fsSync.existsSync(envFilePath)) {
      const parsed = dotenv.parse(fsSync.readFileSync(envFilePath, "utf8"));
      const envPort = normalizeEmbeddedServerPort(parsed?.PORT);
      if (envPort !== null) return envPort;
    }
  } catch {
    // Ignore invalid desktop env files and fall back to the default port.
  }

  return 8787;
}

/**
 * @param {{
 *   rootDir: string;
 *   appDataDir: string;
 *   resourcesDir?: string;
 *   host?: string;
 *   port?: number | undefined;
 *   packaged?: boolean;
 * }} options
 */
export function configureEmbeddedServerEnv({
  rootDir,
  appDataDir,
  resourcesDir = "",
  host = "127.0.0.1",
  port = undefined,
  packaged = false
}) {
  if (!rootDir) {
    throw new Error("rootDir is required");
  }
  if (!appDataDir) {
    throw new Error("appDataDir is required");
  }

  const resolvedRootDir = path.resolve(rootDir);
  const resolvedAppDataDir = path.resolve(appDataDir);
  const resolvedResourcesDir = String(resourcesDir || "").trim() ? path.resolve(resourcesDir) : "";
  const envFilePath = path.join(resolvedAppDataDir, ".env");
  const resolvedPort = resolveEmbeddedServerPort(envFilePath, port);

  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  process.env.HOST = String(host || "127.0.0.1");
  process.env.PORT = String(resolvedPort);
  process.env.CODEX_PRO_MAX_APP_DATA_DIR = resolvedAppDataDir;
  process.env.CODEX_PRO_MAX_RUNTIME_BIN_DIR = path.join(resolvedAppDataDir, "bin");
  process.env.DOTENV_CONFIG_PATH = envFilePath;
  process.env.CODEX_PRO_MAX_PUBLIC_DIR = path.join(resolvedRootDir, "public");

  if (packaged && resolvedResourcesDir) {
    process.env.CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR = path.join(resolvedResourcesDir, "temp-mail-runner");
    process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR = path.join(resolvedResourcesDir, "cloudflared");
    process.env.CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN = "1";
  } else {
    delete process.env.CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR;
    delete process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR;
    delete process.env.CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN;
  }

  return {
    appDataDir: resolvedAppDataDir,
    resourcesDir: resolvedResourcesDir,
    host: String(process.env.HOST || host).trim() || "127.0.0.1",
    port: resolvedPort
  };
}
