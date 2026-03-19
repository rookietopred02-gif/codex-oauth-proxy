import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const outputRoot = path.join(rootDir, "build-resources", "cloudflared");

const TARGETS = [
  {
    id: "win32-x64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    archive: false,
    archiveFileName: "cloudflared.exe",
    outputBinaryName: "cloudflared.exe"
  },
  {
    id: "linux-x64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    archive: false,
    archiveFileName: "cloudflared",
    outputBinaryName: "cloudflared"
  },
  {
    id: "darwin-x64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
    archive: true,
    archiveFileName: "cloudflared-darwin-amd64.tgz",
    outputBinaryName: "cloudflared"
  },
  {
    id: "darwin-arm64",
    url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
    archive: true,
    archiveFileName: "cloudflared-darwin-arm64.tgz",
    outputBinaryName: "cloudflared"
  }
];

function runCommand(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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

async function downloadToFile(url, filePath) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "codex-pro-max-cloudflared-bundle"
    }
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

async function extractArchive(archivePath, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await runCommand("tar", ["-xzf", archivePath, "-C", outputDir]);
}

async function prepareTarget(target) {
  const targetDir = path.join(outputRoot, target.id);
  const finalBinaryPath = path.join(targetDir, target.outputBinaryName);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `cloudflared-${target.id}-`));

  try {
    if (!target.archive) {
      await downloadToFile(target.url, finalBinaryPath);
    } else {
      const archivePath = path.join(tempDir, target.archiveFileName);
      await downloadToFile(target.url, archivePath);
      await extractArchive(archivePath, tempDir);
      const extractedBinaryPath = path.join(tempDir, "cloudflared");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(extractedBinaryPath, finalBinaryPath);
    }

    if (!finalBinaryPath.endsWith(".exe")) {
      await fs.chmod(finalBinaryPath, 0o755);
    }
    return finalBinaryPath;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const outputs = [];
for (const target of TARGETS) {
  outputs.push(await prepareTarget(target));
}

for (const output of outputs) {
  console.log(`[build:cloudflared] wrote ${output}`);
}
