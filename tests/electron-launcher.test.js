import assert from "node:assert/strict";
import test from "node:test";

import { buildElectronLaunchEnv, isElectronLauncherEntrypoint } from "../scripts/run-electron.mjs";

test("buildElectronLaunchEnv strips ELECTRON_RUN_AS_NODE from inherited env", () => {
  const env = buildElectronLaunchEnv({
    ELECTRON_RUN_AS_NODE: "1",
    PATH: "C:/Windows/System32"
  });

  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
  assert.equal(env.PATH, "C:/Windows/System32");
});

test("isElectronLauncherEntrypoint resolves relative argv paths against cwd", () => {
  assert.equal(isElectronLauncherEntrypoint("scripts/run-electron.mjs"), true);
  assert.equal(isElectronLauncherEntrypoint("scripts/not-the-launcher.mjs"), false);
});
