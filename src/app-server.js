// @ts-check

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureEmbeddedServerEnv,
  normalizeEmbeddedServerPort,
  resolveEmbeddedServerPort
} from "./services/desktop-runtime-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

let serverModulePromise = null;
let serverModuleNonce = 0;

async function loadServerModule() {
  if (!serverModulePromise) {
    serverModuleNonce += 1;
    serverModulePromise = import(`./server.js?runtime=${serverModuleNonce}`);
  }
  return await serverModulePromise;
}

export async function startAppServer(options = {}) {
  const runtime = configureEmbeddedServerEnv({
    rootDir,
    ...options
  });
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

export const __testing = {
  configureEmbeddedServerEnv,
  normalizeEmbeddedServerPort,
  resolveEmbeddedServerPort
};
