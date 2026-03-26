// @ts-check

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourceRoots = ["src", "electron", "scripts", "tests", "public/dashboard"];
const syntaxExtensions = new Set([".js", ".mjs"]);

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

async function extractInlineModuleFiles(htmlPath) {
  const html = await fs.readFile(htmlPath, "utf8");
  const matches = [...html.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/gi)];
  if (matches.length === 0) return [];

  const tempDir = await fs.mkdtemp(path.join(path.dirname(htmlPath), ".inline-module-check-"));
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

await main();
