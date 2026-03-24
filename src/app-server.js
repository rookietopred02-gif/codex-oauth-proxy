import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

let serverModulePromise = null;
let serverModuleNonce = 0;

function configureEmbeddedServerEnv({
  appDataDir,
  resourcesDir = "",
  host = "127.0.0.1",
  port = 0,
  packaged = false
} = {}) {
  if (!appDataDir) {
    throw new Error("appDataDir is required");
  }

  const resolvedAppDataDir = path.resolve(appDataDir);
  const resolvedResourcesDir = String(resourcesDir || "").trim() ? path.resolve(resourcesDir) : "";

  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  process.env.HOST = String(host || "127.0.0.1");
  process.env.PORT = String(port ?? 0);
  process.env.CODEX_PRO_MAX_APP_DATA_DIR = resolvedAppDataDir;
  process.env.CODEX_PRO_MAX_RUNTIME_BIN_DIR = path.join(resolvedAppDataDir, "bin");
  process.env.DOTENV_CONFIG_PATH = path.join(resolvedAppDataDir, ".env");
  process.env.CODEX_PRO_MAX_PUBLIC_DIR = path.join(rootDir, "public");

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
    port: Number(process.env.PORT || port || 0) || 0
  };
}

async function loadServerModule() {
  if (!serverModulePromise) {
    serverModuleNonce += 1;
    serverModulePromise = import(`./server.js?runtime=${serverModuleNonce}`);
  }
  return await serverModulePromise;
}

export async function startAppServer(options = {}) {
  const runtime = configureEmbeddedServerEnv(options);
  await fs.mkdir(runtime.appDataDir, { recursive: true });

  const serverModule = await loadServerModule();
  return await serverModule.startServer({
    host: runtime.host,
    port: runtime.port
  });
}

export async function stopAppServer(signal = "SIGTERM") {
  if (!serverModulePromise) {
    return {
      app: null,
      mainServer: null,
      stopped: true
    };
  }
  const serverModule = await loadServerModule();
  try {
    return await serverModule.stopServer(signal);
  } finally {
    serverModulePromise = null;
  }
}
