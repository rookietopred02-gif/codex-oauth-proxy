import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DESKTOP_APP_NAME, resolveDesktopUserDataDir } from "../electron/runtime-paths.mjs";

test("resolveDesktopUserDataDir prefers CODEX_PRO_MAX_APP_DATA_DIR over appDataRoot", () => {
  const resolved = resolveDesktopUserDataDir({
    appDataRoot: "C:/Users/fi/AppData/Roaming",
    env: {
      CODEX_PRO_MAX_APP_DATA_DIR: "D:/portable/codex-data"
    }
  });

  assert.equal(resolved, path.resolve("D:/portable/codex-data"));
});

test("resolveDesktopUserDataDir falls back to the Electron appData root", () => {
  const appDataRoot = "C:/Users/fi/AppData/Roaming";
  const resolved = resolveDesktopUserDataDir({
    appDataRoot,
    env: {}
  });

  assert.equal(resolved, path.join(path.resolve(appDataRoot), DESKTOP_APP_NAME));
});
