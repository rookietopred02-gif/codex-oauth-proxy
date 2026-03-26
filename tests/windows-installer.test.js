import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { DESKTOP_APP_NAME } from "../electron/runtime-paths.mjs";

const packageJsonPath = new URL("../package.json", import.meta.url);
const installerScriptPath = new URL("../build/installer.nsh", import.meta.url);

test("windows uninstaller exposes an optional app-data cleanup section", async () => {
  const [pkg, installerScript] = await Promise.all([
    fs.readFile(packageJsonPath, "utf8").then((text) => JSON.parse(text)),
    fs.readFile(installerScriptPath, "utf8")
  ]);

  assert.equal(pkg.build?.nsis?.deleteAppDataOnUninstall, false);
  assert.match(installerScript, /!macro customUnInstallSection/);
  assert.match(installerScript, /Section \/o "un\.Remove current user's app data/);
  assert.match(installerScript, /SetShellVarContext current/);
  assert.match(installerScript, new RegExp(`RMDir \\/r "\\$APPDATA\\\\${DESKTOP_APP_NAME}"`));
});
