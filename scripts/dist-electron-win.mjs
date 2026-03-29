import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export function formatWindowsBuildStamp(date = new Date()) {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return iso.replace(/:/g, "-");
}

export function resolveWindowsDistPaths(projectRoot = rootDir, date = new Date()) {
  const outputRoot = path.join(projectRoot, "dist-electron");
  const stageRoot = path.join(outputRoot, "win-builds", formatWindowsBuildStamp(date));
  return {
    outputRoot,
    stageRoot
  };
}

function getElectronBuilderCli(projectRoot = rootDir) {
  return path.join(projectRoot, "node_modules", "electron-builder", "cli.js");
}

function runCommand(command, args, { cwd = rootDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    });
  });
}

async function mirrorStageArtifacts(stageRoot, outputRoot) {
  const entries = await fs.readdir(stageRoot, { withFileTypes: true });
  await fs.mkdir(outputRoot, { recursive: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(stageRoot, entry.name);
    const destinationPath = path.join(outputRoot, entry.name);
    await fs.copyFile(sourcePath, destinationPath);
  }
}

export async function buildWindowsElectronDistribution({
  projectRoot = rootDir,
  date = new Date()
} = {}) {
  const { outputRoot, stageRoot } = resolveWindowsDistPaths(projectRoot, date);
  await fs.mkdir(stageRoot, { recursive: true });

  const electronBuilderCli = getElectronBuilderCli(projectRoot);
  await runCommand(
    process.execPath,
    [electronBuilderCli, "--win", "nsis", "--x64", `-c.directories.output=${stageRoot}`],
    { cwd: projectRoot }
  );

  await mirrorStageArtifacts(stageRoot, outputRoot);
  return {
    outputRoot,
    stageRoot
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { outputRoot, stageRoot } = await buildWindowsElectronDistribution();
  console.log(`[dist:win] staged unpacked build at ${stageRoot}`);
  console.log(`[dist:win] mirrored installer artifacts to ${outputRoot}`);
}
