import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  assert.equal(predicate(), true);
}

function createFakeChild({ killEmitsExit = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    if (killEmitsExit) {
      queueMicrotask(() => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.emit("exit", 0, signal);
      });
    }
    return true;
  };
  child.emitExit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return child;
}

function createSpawnHarness({ emitTunnelUrl = true, autoExitTunnel = false, tunnelExitCode = 1, killEmitsExit = true } = {}) {
  const tunnelChildren = [];
  const versionChildren = [];
  const spawnImpl = (_bin, args = []) => {
    const child = createFakeChild({ killEmitsExit });
    child.args = [...args];
    if (args.includes("--version")) {
      versionChildren.push(child);
      queueMicrotask(() => {
        child.stdout.emit("data", "cloudflared version test\n");
        child.emitExit(0, null);
      });
      return child;
    }

    tunnelChildren.push(child);
    queueMicrotask(() => {
      if (emitTunnelUrl) {
        child.stderr.emit("data", "INF +------------------------------------------------------------+ https://demo.trycloudflare.com\n");
      }
      if (autoExitTunnel) {
        child.emitExit(tunnelExitCode, null);
      }
    });
    return child;
  };
  return { spawnImpl, tunnelChildren, versionChildren };
}

function createHarnessedService(harness, overrides = {}) {
  return createCloudflaredService({
    config: createConfig(overrides.config || {}),
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
    },
    spawnImpl: harness.spawnImpl,
    restartBaseDelayMs: 5,
    restartMaxDelayMs: 20,
    startupStableMs: 5,
    startupTimeoutMs: 80,
    stopTimeoutMs: 20,
    ...overrides.service
  });
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

test("cloudflared service serializes concurrent tunnel starts", async () => {
  const harness = createSpawnHarness();
  const service = createHarnessedService(harness);

  const [first, second] = await Promise.all([service.startTunnel(), service.startTunnel()]);

  assert.equal(harness.tunnelChildren.length, 1);
  assert.equal(first.running, true);
  assert.equal(second.running, true);
});

test("cloudflared service keeps stream errors from crashing the process", async () => {
  const harness = createSpawnHarness();
  const service = createHarnessedService(harness);

  await service.startTunnel();

  assert.doesNotThrow(() => {
    harness.tunnelChildren[0].stderr.emit("error", new Error("stderr boom"));
  });
  assert.match(service.getStatus().outputTail.join("\n"), /stderr boom/);
});

test("cloudflared service supervises unexpected tunnel exits with backoff restart", async () => {
  const harness = createSpawnHarness();
  const service = createHarnessedService(harness);

  await service.startTunnel();
  const firstChild = harness.tunnelChildren[0];
  firstChild.emitExit(1, null);

  await waitFor(() => harness.tunnelChildren.length >= 2 && service.getStatus().running === true);
  const secondChild = harness.tunnelChildren[1];

  assert.equal(service.getStatus().restartCount, 1);
  assert.equal(service.runtime.process, secondChild);

  firstChild.emitExit(1, null);
  assert.equal(service.runtime.process, secondChild);
  assert.equal(service.getStatus().running, true);
});

test("cloudflared service rejects initial starts that exit before becoming stable", async () => {
  const harness = createSpawnHarness({ emitTunnelUrl: false, autoExitTunnel: true, tunnelExitCode: 1 });
  const service = createHarnessedService(harness);

  await assert.rejects(service.startTunnel(), /cloudflared exited/i);
  await delay(40);

  assert.equal(harness.tunnelChildren.length, 1);
  assert.equal(service.getStatus().running, false);
  assert.equal(service.getStatus().restartScheduledAt, null);
});

test("cloudflared service bounds stopTunnel when the child never exits", async () => {
  const harness = createSpawnHarness({ killEmitsExit: false });
  const service = createHarnessedService(harness);

  await service.startTunnel();
  const startedAt = Date.now();
  const status = await service.stopTunnel();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(status.running, false);
  assert.ok(elapsedMs < 1000, `stopTunnel should remain bounded, got ${elapsedMs}ms`);
});
