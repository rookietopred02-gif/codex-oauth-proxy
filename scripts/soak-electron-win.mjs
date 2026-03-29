import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "ignore",
    windowsHide: true,
    ...options
  });

  let exitState = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitState = { code, signal };
      resolve(exitState);
    });
  });

  return {
    child,
    getExitState: () => exitState,
    waitForExit: () => exitPromise
  };
}

async function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore already-exited children.
  }
}

async function waitForHealthyRuntime({ port, childRef, timeoutMs = 30000 }) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    const exitState = childRef.getExitState();
    if (exitState) {
      throw new Error(`Electron exited early with code=${exitState.code ?? "null"} signal=${exitState.signal ?? "none"}`);
    }

    try {
      const [healthResponse, dashboardResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`),
        fetch(`http://127.0.0.1:${port}/dashboard/`)
      ]);

      if (healthResponse.ok && dashboardResponse.ok) {
        const health = await healthResponse.json();
        return {
          healthStatus: health?.status || "ok",
          dashboardStatus: dashboardResponse.status
        };
      }

      lastError = new Error(`health=${healthResponse.status} dashboard=${dashboardResponse.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw lastError || new Error("Timed out waiting for Electron runtime health.");
}

async function resolveLatestWindowsStageDir(projectRoot = rootDir) {
  const buildsDir = path.join(projectRoot, "dist-electron", "win-builds");
  const entries = await fs.readdir(buildsDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (directories.length === 0) {
    throw new Error(`No staged Windows Electron builds found under ${buildsDir}`);
  }
  return path.join(buildsDir, directories[0]);
}

export async function soakLatestWindowsElectronBuild({
  projectRoot = rootDir,
  cycles = 3,
  port = 18793
} = {}) {
  const stageDir = await resolveLatestWindowsStageDir(projectRoot);
  const executablePath = path.join(stageDir, "win-unpacked", "codex-pro-max.exe");
  const appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-electron-soak-"));
  const envFilePath = path.join(appDataDir, ".env");
  const results = [];

  await fs.writeFile(envFilePath, `PORT=${port}\n`, "utf8");

  try {
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const childRef = spawnProcess(executablePath, [], {
        cwd: path.dirname(executablePath),
        env: {
          ...process.env,
          CODEX_PRO_MAX_APP_DATA_DIR: appDataDir
        }
      });

      try {
        const status = await waitForHealthyRuntime({
          port,
          childRef
        });
        results.push({
          cycle,
          pid: childRef.child.pid,
          ...status
        });
      } finally {
        await killProcessTree(childRef.child.pid);
        await Promise.race([childRef.waitForExit(), delay(5000)]);
      }

      await delay(1000);
    }

    return {
      executablePath,
      appDataDir,
      port,
      cycles,
      results
    };
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const summary = await soakLatestWindowsElectronBuild();
  console.log(JSON.stringify(summary, null, 2));
}
