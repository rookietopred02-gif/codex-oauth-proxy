import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("codexProMaxDesktop", {
  platform: process.platform
});
