import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCloudflaredService } from "../src/services/cloudflared-service.js";

async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-cloudflared-"));
}

function createConfig(overrides = {}) {
  return {
    port: 8787,
    publicAccess: {
      defaultMode: "quick",
      defaultUseHttp2: true,
      defaultTunnelToken: "",
      localPort: 8787,
      autoInstall: true,
      cloudflaredBinPath: "",
      ...overrides.publicAccess
    },
    ...overrides
  };
}

test("cloudflared service resolves bundled resources before falling back to PATH", async () => {
  const rootDir = await createTempDir();
  const resourcesDir = path.join(rootDir, "resources");
  const bundledPath = path.join(resourcesDir, "win32-x64", "cloudflared.exe");
  await fs.mkdir(path.dirname(bundledPath), { recursive: true });
  await fs.writeFile(bundledPath, "MZ-test-binary");

  const service = createCloudflaredService({
    config: createConfig(),
    rootDir,
    runtimeBinDir: path.join(rootDir, "bin"),
    bundledCloudflaredResourcesDir: resourcesDir,
    defaultCloudflaredBin: "cloudflared.exe",
    resolveBundledCloudflaredBinaryName: () => "cloudflared.exe",
    resolveBundledCloudflaredTargetNames: () => ["win32-x64"],
    validCloudflaredModes: new Set(["quick", "auth"]),
    parseNumberEnv: (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  });

  try {
    assert.equal(service.resolveBin(), bundledPath);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("cloudflared service extracts quick and hostname-based URLs from log lines", () => {
  const service = createCloudflaredService({
    config: createConfig(),
    rootDir: "C:/tmp/codex-pro-max-cloudflared",
    runtimeBinDir: "C:/tmp/codex-pro-max-cloudflared/bin",
    bundledCloudflaredResourcesDir: "",
    defaultCloudflaredBin: "cloudflared",
    resolveBundledCloudflaredBinaryName: () => "cloudflared",
    resolveBundledCloudflaredTargetNames: () => [],
    validCloudflaredModes: new Set(["quick", "auth"]),
    parseNumberEnv: (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  });

  assert.equal(
    service.extractUrlFromLine("INF +------------------------------------------------------------+ https://demo.trycloudflare.com"),
    "https://demo.trycloudflare.com"
  );
  assert.equal(
    service.extractUrlFromLine('INF Updated to new configuration {\\"hostname\\":\\"proxy.example.com\\"}'),
    "https://proxy.example.com"
  );
});
