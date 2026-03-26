// @ts-check

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

export function buildElectronLaunchEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function isElectronLauncherEntrypoint(argv1 = process.argv[1]) {
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(path.resolve(argv1)).href;
}

export async function runElectron(argv = process.argv.slice(2)) {
  const electronBinary = require("electron");
  const args = argv.length > 0 ? argv : [path.resolve(__dirname, "..")];

  await new Promise((resolve, reject) => {
    const child = spawn(electronBinary, args, {
      stdio: "inherit",
      windowsHide: false,
      env: buildElectronLaunchEnv()
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`${electronBinary} exited with signal ${signal || "unknown"}`));
        return;
      }
      process.exitCode = code;
      resolve();
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        if (!child.killed) {
          child.kill(signal);
        }
      });
    }
  });
}

const launchedAsMain = isElectronLauncherEntrypoint();

if (launchedAsMain) {
  await runElectron();
}
