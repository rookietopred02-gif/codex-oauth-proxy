import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testing as appServerTesting, startAppServer, stopAppServer } from "../src/app-server.js";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

function isFetchAllowedPort(port) {
  return Number.isInteger(port) && port > 0 && !FETCH_FORBIDDEN_PORTS.has(port);
}

async function reserveFreePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const reservedPort = typeof address === "object" && address ? Number(address.port || 0) : 0;
        server.close((err) => {
          if (err) reject(err);
          else resolve(reservedPort);
        });
      });
    });
    if (isFetchAllowedPort(port)) return port;
  }
  throw new Error("Could not reserve a fetch-compatible test port.");
}

async function createTempAppDataDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-app-server-"));
}

async function writeDesktopEnv(appDataDir, lines) {
  await fs.mkdir(appDataDir, { recursive: true });
  await fs.writeFile(path.join(appDataDir, ".env"), `${lines.join("\n")}\n`, "utf8");
}

async function assertHealth(url) {
  const response = await fetch(`${url}/health`);
  assert.equal(response.ok, true);
  const body = await response.json();
  assert.equal(body.ok, true);
}

test("startAppServer uses the desktop env PORT when no explicit port is provided", async () => {
  const appDataDir = await createTempAppDataDir();
  const envPort = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${envPort}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1"
    });

    assert.equal(backend.port, envPort);
    assert.equal(backend.url, `http://127.0.0.1:${envPort}`);
    await assertHealth(backend.url);
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("startAppServer explicit port overrides the desktop env PORT", async () => {
  const appDataDir = await createTempAppDataDir();
  const envPort = await reserveFreePort();
  const explicitPort = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${envPort}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1",
      port: explicitPort
    });

    assert.equal(backend.port, explicitPort);
    assert.equal(backend.url, `http://127.0.0.1:${explicitPort}`);
    await assertHealth(backend.url);
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("desktop embedded server port parser rejects decimal-form values", async () => {
  const appDataDir = await createTempAppDataDir();
  await writeDesktopEnv(appDataDir, ["PORT=8788.9", "AUTH_MODE=codex-oauth"]);

  try {
    assert.equal(appServerTesting.normalizeEmbeddedServerPort("8787"), 8787);
    assert.equal(appServerTesting.normalizeEmbeddedServerPort("8787.0"), null);
    assert.equal(appServerTesting.normalizeEmbeddedServerPort(8787.5), null);
    assert.equal(
      appServerTesting.resolveEmbeddedServerPort(path.join(appDataDir, ".env"), "9898.1"),
      8787
    );
    assert.equal(appServerTesting.resolveEmbeddedServerPort(path.join(appDataDir, ".env")), 8787);
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("proxy API auth failures are not cacheable", async () => {
  const appDataDir = await createTempAppDataDir();
  const port = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${port}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1"
    });

    const response = await fetch(`${backend.url}/v1/models`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("expires"), "0");
    assert.equal(body.error, "proxy_api_key_not_configured");
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("startAppServer can restart repeatedly on the same desktop-configured port", async () => {
  const appDataDir = await createTempAppDataDir();
  const stablePort = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${stablePort}`, "AUTH_MODE=codex-oauth"]);

  try {
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const backend = await startAppServer({
        appDataDir,
        host: "127.0.0.1"
      });

      assert.equal(backend.port, stablePort);
      await assertHealth(backend.url);
      await stopAppServer(`SOAK_${iteration}`);
    }
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("configureEmbeddedServerEnv resolves packaged cloudflared resources", async () => {
  const appDataDir = await createTempAppDataDir();
  const resourcesDir = path.join(appDataDir, "resources");
  const snapshot = {
    CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR: process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR
  };

  try {
    const runtime = appServerTesting.configureEmbeddedServerEnv({
      rootDir: path.resolve("C:/Users/fi/source/codex-pro-max"),
      appDataDir,
      resourcesDir,
      host: "127.0.0.1",
      port: 4242,
      packaged: true
    });

    assert.equal(runtime.port, 4242);
    assert.equal(process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR, path.join(resourcesDir, "cloudflared"));
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});
