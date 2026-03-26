// @ts-check

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const textRoots = ["src", "public", "electron", "scripts", "tests"];
const textExtensions = new Set([".js", ".mjs", ".html", ".json", ".md", ".css", ".nsh"]);

async function collectTextFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...(await collectTextFiles(fullPath)));
      continue;
    }
    if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const files = [];
  for (const relativeRoot of textRoots) {
    files.push(...(await collectTextFiles(path.join(rootDir, relativeRoot))));
  }
  files.push(path.join(rootDir, "package.json"));
  files.push(path.join(rootDir, "README.md"));

  const failures = [];
  for (const filePath of files) {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split(/\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/[ \t]+$/.test(line)) {
        failures.push(`${path.relative(rootDir, filePath)}:${index + 1} has trailing whitespace`);
      }
    }
    if (text.length > 0 && !text.endsWith("\n")) {
      failures.push(`${path.relative(rootDir, filePath)} is missing a trailing newline`);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`format check passed (${files.length} files)`);
}

await main();
