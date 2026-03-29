const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const electron = require("electron");
const { app, dialog } = electron;

const startupLogPath = process.env.CODEX_PRO_MAX_ELECTRON_STARTUP_LOG
  ? path.resolve(process.env.CODEX_PRO_MAX_ELECTRON_STARTUP_LOG)
  : path.join(os.tmpdir(), "codex-pro-max-electron-startup.log");

function appendStartupLog(message, error = null) {
  try {
    const lines = [`[${new Date().toISOString()}] ${message}`];
    if (error) {
      lines.push(String(error?.stack || error?.message || error));
    }
    fs.appendFileSync(startupLogPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Ignore diagnostic logging failures during startup.
  }
}

function showStartupError(error) {
  const detail = String(error?.stack || error?.message || error || "Unknown Electron startup failure.");
  try {
    dialog.showErrorBox("codex-pro-max failed to start", detail);
  } catch {
    // Ignore dialog failures in non-interactive sessions.
  }
}

process.on("uncaughtException", (error) => {
  appendStartupLog("Uncaught exception during Electron bootstrap.", error);
  showStartupError(error);
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  appendStartupLog("Unhandled rejection during Electron bootstrap.", reason);
});

(async () => {
  try {
    appendStartupLog("Bootstrapping Electron main process.");
    await import(pathToFileURL(path.join(__dirname, "main.mjs")).href);
    appendStartupLog("Electron main process module loaded.");
  } catch (error) {
    appendStartupLog("Electron main process module failed to load.", error);
    showStartupError(error);
    app.exit(1);
  }
})();
