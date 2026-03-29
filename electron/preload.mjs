import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");

if (!electron || typeof electron !== "object" || !electron.contextBridge) {
  throw new Error("Electron renderer APIs are unavailable in this runtime.");
}

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("codexProMaxDesktop", {
  platform: process.platform,
  async pickTokenImportFiles() {
    return await ipcRenderer.invoke("desktop:pick-token-import-files");
  },
  async restartBackend(port) {
    return await ipcRenderer.invoke("desktop:restart-backend", { port });
  }
});
