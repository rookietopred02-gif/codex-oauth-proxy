import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { DESKTOP_APP_NAME, resolveDesktopUserDataDir } from "./runtime-paths.mjs";
import { startAppServer, stopAppServer } from "../src/app-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const electron = require("electron");

if (!electron || typeof electron !== "object") {
  throw new Error("Electron main-process APIs are unavailable in this runtime.");
}

const { app, BrowserWindow, dialog, ipcMain, shell } = electron;

app.setName(DESKTOP_APP_NAME);
app.setPath(
  "userData",
  resolveDesktopUserDataDir({
    appDataRoot: app.getPath("appData"),
    appName: DESKTOP_APP_NAME,
    env: process.env
  })
);

let mainWindow = null;
let backend = null;
let quitting = false;
let backendRestartPromise = null;
const TOKEN_IMPORT_EXTENSION_PATTERN = /\.(json|csv|txt|cpa|sub2api)$/i;

const startupLogPath = process.env.CODEX_PRO_MAX_ELECTRON_STARTUP_LOG
  ? path.resolve(process.env.CODEX_PRO_MAX_ELECTRON_STARTUP_LOG)
  : path.join(os.tmpdir(), "codex-pro-max-electron-startup.log");

function logDesktopLifecycle(message, error = null) {
  try {
    const lines = [`[${new Date().toISOString()}] ${message}`];
    if (error) {
      lines.push(String(error?.stack || error?.message || error));
    }
    fs.appendFileSync(startupLogPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Ignore diagnostic logging failures.
  }
}

function normalizeRuntimePort(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const port = Math.floor(parsed);
  if (port < 1 || port > 65535) return null;
  return port;
}

function isSupportedTokenImportFilePath(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return false;
  const baseName = path.basename(normalized);
  if (!/\.[a-z0-9]+$/i.test(baseName)) return true;
  return TOKEN_IMPORT_EXTENSION_PATTERN.test(baseName);
}

async function collectTokenImportPayloadsFromPath(targetPath, outputFiles, rootPath = targetPath) {
  let stats = null;
  try {
    stats = await fsPromises.stat(targetPath);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    let entries = [];
    try {
      entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(targetPath, entry.name);
      await collectTokenImportPayloadsFromPath(childPath, outputFiles, rootPath);
    }
    return;
  }

  if (!stats.isFile() || !isSupportedTokenImportFilePath(targetPath)) {
    return;
  }

  let content = "";
  try {
    content = await fsPromises.readFile(targetPath, "utf8");
  } catch {
    return;
  }
  if (!content.trim()) {
    return;
  }

  const relativeName = path.relative(rootPath, targetPath);
  outputFiles.push({
    name: relativeName && relativeName !== "" ? relativeName : path.basename(targetPath),
    content
  });
}

async function pickTokenImportFiles() {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: "Import Tokens",
    buttonLabel: "Import",
    properties: ["openFile", "openDirectory", "multiSelections", "dontAddToRecent"],
    filters: [
      {
        name: "Token import files",
        extensions: ["json", "csv", "txt", "cpa", "sub2api"]
      }
    ]
  });
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return [];
  }

  const payloadFiles = [];
  for (const filePath of result.filePaths) {
    await collectTokenImportPayloadsFromPath(filePath, payloadFiles, filePath);
  }
  return payloadFiles;
}

function buildBackendStartOptions(port = undefined) {
  return {
    appDataDir: app.getPath("userData"),
    resourcesDir: process.resourcesPath,
    packaged: app.isPackaged,
    host: "127.0.0.1",
    ...(port !== undefined ? { port } : {})
  };
}

async function loadDashboardWindow() {
  if (!backend) {
    throw new Error("Backend is not running.");
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`${backend.url}/dashboard/`);
}

function showStartupError(err) {
  const detail = String(err?.stack || err?.message || err || "Unknown startup failure.");
  dialog.showErrorBox(
    "codex-pro-max failed to start",
    `The embedded backend could not be started.\n\n${detail}`
  );
}

async function waitForHealth(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return true;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error("Timed out waiting for backend health.");
}

async function createMainWindow() {
  logDesktopLifecycle("createMainWindow: starting.");
  if (!backend) {
    logDesktopLifecycle("createMainWindow: starting embedded backend.");
    backend = await startAppServer(buildBackendStartOptions());
    logDesktopLifecycle(`createMainWindow: embedded backend started at ${backend.url}.`);
  }

  await waitForHealth(`${backend.url}/health`);
  logDesktopLifecycle("createMainWindow: embedded backend reported healthy.");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    title: "codex-pro-max",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    logDesktopLifecycle(`mainWindow: did-fail-load code=${code} url=${validatedUrl || "-"} description=${description || "-"}.`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logDesktopLifecycle(
      `mainWindow: render-process-gone reason=${details?.reason || "unknown"} exitCode=${details?.exitCode ?? "null"}.`
    );
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(backend.url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.once("ready-to-show", () => {
    logDesktopLifecycle("mainWindow: ready-to-show.");
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    logDesktopLifecycle("mainWindow: closed.");
    mainWindow = null;
  });

  await loadDashboardWindow();
  logDesktopLifecycle("createMainWindow: dashboard loaded.");
}

async function restartEmbeddedBackend(port) {
  const nextPort = normalizeRuntimePort(port);
  if (nextPort === null) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  if (backendRestartPromise) {
    return await backendRestartPromise;
  }

  backendRestartPromise = (async () => {
    const previousPort = normalizeRuntimePort(backend?.port);

    await stopAppServer("PORT_CHANGE");
    backend = null;

    try {
      backend = await startAppServer(buildBackendStartOptions(nextPort));
      await waitForHealth(`${backend.url}/health`);
      await loadDashboardWindow();
      return {
        ok: true,
        port: backend.port,
        url: backend.url
      };
    } catch (err) {
      console.error(`[electron] failed to restart backend on port ${nextPort}: ${err?.message || err}`);

      if (previousPort !== null && previousPort !== nextPort) {
        try {
          backend = await startAppServer(buildBackendStartOptions(previousPort));
          await waitForHealth(`${backend.url}/health`);
          await loadDashboardWindow();
        } catch (recoverErr) {
          console.error(
            `[electron] failed to restore backend on port ${previousPort}: ${recoverErr?.message || recoverErr}`
          );
          backend = null;
        }
      }

      throw err;
    } finally {
      backendRestartPromise = null;
    }
  })();

  return await backendRestartPromise;
}

async function shutdownBackend() {
  if (!backend || quitting) return;
  quitting = true;
  try {
    await stopAppServer("APP_QUIT");
  } finally {
    backend = null;
    quitting = false;
  }
}

app.on("window-all-closed", () => {
  logDesktopLifecycle("app: window-all-closed.");
  app.quit();
});

app.on("before-quit", async (event) => {
  logDesktopLifecycle("app: before-quit.");
  if (!backend || quitting) return;
  event.preventDefault();
  quitting = true;
  try {
    await stopAppServer("APP_QUIT");
  } finally {
    backend = null;
    app.quit();
  }
});

app.whenReady()
  .then(() => {
    logDesktopLifecycle("app: ready.");
    return createMainWindow();
  })
  .catch(async (err) => {
    console.error(`[electron] startup failed: ${err?.message || err}`);
    logDesktopLifecycle("app: startup failed.", err);
    showStartupError(err);
    await shutdownBackend().catch(() => {});
    app.exit(1);
  });

app.on("activate", () => {
  logDesktopLifecycle("app: activate.");
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((err) => {
      console.error(`[electron] failed to recreate window: ${err?.message || err}`);
      logDesktopLifecycle("app: recreate window failed.", err);
      showStartupError(err);
    });
  }
});

ipcMain.handle("desktop:restart-backend", async (_event, payload = {}) => {
  return await restartEmbeddedBackend(payload?.port);
});

ipcMain.handle("desktop:pick-token-import-files", async () => {
  return await pickTokenImportFiles();
});
