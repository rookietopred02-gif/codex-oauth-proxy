// @ts-check

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
export const sourceRoots = ["src", "electron", "scripts", "tests", "public/app", "public/dashboard"];
const syntaxExtensions = new Set([".js", ".mjs"]);

export function buildInlineModuleTempPrefix(tmpDir = os.tmpdir()) {
  return path.join(tmpDir, "codex-pro-max-inline-module-check-");
}

export function isLintEntrypoint(argv1 = process.argv[1]) {
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(path.resolve(argv1)).href;
}

async function collectSyntaxFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSyntaxFiles(fullPath)));
      continue;
    }
    if (syntaxExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function extractInlineModuleFiles(htmlPath) {
  const html = await fs.readFile(htmlPath, "utf8");
  const matches = [...html.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/gi)];
  if (matches.length === 0) return [];

  const tempDir = await fs.mkdtemp(buildInlineModuleTempPrefix());
  const files = [];
  let index = 0;
  for (const match of matches) {
    index += 1;
    const inlinePath = path.join(tempDir, `inline-${index}.mjs`);
    await fs.writeFile(inlinePath, String(match[1] || ""), "utf8");
    files.push(inlinePath);
  }
  return files;
}

function runNodeSyntaxCheck(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status === 0) return null;
  const stderr = String(result.stderr || result.stdout || "").trim();
  return stderr || `Syntax check failed for ${filePath}`;
}

async function main() {
  const failures = [];
  const syntaxFiles = [];

  for (const relativeRoot of sourceRoots) {
    const fullRoot = path.join(rootDir, relativeRoot);
    syntaxFiles.push(...(await collectSyntaxFiles(fullRoot)));
  }

  const inlineFiles = await extractInlineModuleFiles(path.join(rootDir, "public", "index.html"));
  syntaxFiles.push(...inlineFiles);

  try {
    for (const filePath of syntaxFiles) {
      const error = runNodeSyntaxCheck(filePath);
      if (error) {
        failures.push(`\n[syntax] ${path.relative(rootDir, filePath)}\n${error}`);
      }
    }
  } finally {
    const tempDirs = new Set(inlineFiles.map((filePath) => path.dirname(filePath)));
    await Promise.all([...tempDirs].map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`lint passed (${syntaxFiles.length} syntax checks)`);
}

if (isLintEntrypoint()) {
  await main();
}
