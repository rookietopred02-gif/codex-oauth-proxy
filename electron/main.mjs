import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, shell } from "electron";

import { startAppServer, stopAppServer } from "../src/app-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let backend = null;
let quitting = false;

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
  if (!backend) {
    backend = await startAppServer({
      appDataDir: app.getPath("userData"),
      resourcesDir: process.resourcesPath,
      packaged: app.isPackaged,
      host: "127.0.0.1",
      port: 0
    });
  }

  const dashboardUrl = `${backend.url}/dashboard/`;
  await waitForHealth(`${backend.url}/health`);

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
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(backend.url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(dashboardUrl);
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
  app.quit();
});

app.on("before-quit", async (event) => {
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
  .then(createMainWindow)
  .catch(async (err) => {
    console.error(`[electron] startup failed: ${err?.message || err}`);
    await shutdownBackend().catch(() => {});
    app.exit(1);
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((err) => {
      console.error(`[electron] failed to recreate window: ${err?.message || err}`);
    });
  }
});
