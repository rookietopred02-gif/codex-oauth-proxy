import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runnerDir = path.join(rootDir, "tools", "temp-mail-runner");
const outputRoot = path.join(rootDir, "build-resources", "temp-mail-runner");

const TARGETS = [
  { id: "win32-x64", goos: "windows", goarch: "amd64", binaryName: "temp-mail-runner.exe" },
  { id: "linux-x64", goos: "linux", goarch: "amd64", binaryName: "temp-mail-runner" },
  { id: "darwin-x64", goos: "darwin", goarch: "amd64", binaryName: "temp-mail-runner" },
  { id: "darwin-arm64", goos: "darwin", goarch: "arm64", binaryName: "temp-mail-runner" }
];

function runCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited ${code}`).trim()));
    });
  });
}

async function buildGoBinary(target) {
  const outputPath = path.join(outputRoot, target.id, target.binaryName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand("go", ["build", "-o", outputPath, "."], {
    cwd: runnerDir,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: target.goos,
      GOARCH: target.goarch
    }
  });
  if (target.goos !== "windows") {
    await fs.chmod(outputPath, 0o755);
  }
  return outputPath;
}

const outputs = [];
for (const target of TARGETS) {
  outputs.push(await buildGoBinary(target));
}

for (const output of outputs) {
  console.log(`[build:runner] wrote ${output}`);
}
