import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const buildCacheDir = path.join(rootDir, "dist-electron");

async function removeBuildCache(targetPath) {
  const normalizedPath = path.resolve(targetPath);
  if (normalizedPath !== buildCacheDir) {
    throw new Error(`Refusing to remove unexpected path: ${normalizedPath}`);
  }

  await fs.rm(normalizedPath, { recursive: true, force: true });
  console.log(`[clean:build-cache] removed ${normalizedPath}`);
}

await removeBuildCache(buildCacheDir);
