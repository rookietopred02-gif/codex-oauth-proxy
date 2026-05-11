import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const buildCacheDir = resolveBuildCacheDir(rootDir);

export function resolveBuildCacheDir(projectRoot = rootDir) {
  return path.join(path.resolve(projectRoot), "dist-electron");
}

export async function removeBuildCache(targetPath, options = {}) {
  const expectedPath = path.resolve(options.expectedPath || buildCacheDir);
  const normalizedPath = path.resolve(targetPath);
  if (normalizedPath !== expectedPath) {
    throw new Error(`Refusing to remove unexpected path: ${normalizedPath}`);
  }

  const fsImpl = options.fs || fs;
  const log = typeof options.log === "function" ? options.log : console.log;
  await fsImpl.rm(normalizedPath, { recursive: true, force: true });
  log(`[clean:build-cache] removed ${normalizedPath}`);
}

if (path.resolve(process.argv[1] || "") === __filename) {
  await removeBuildCache(buildCacheDir);
}
