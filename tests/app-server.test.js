import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __testing as appServerTesting, startAppServer, stopAppServer } from "../src/app-server.js";

async function reserveFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? Number(address.port || 0) : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
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

test("configureEmbeddedServerEnv resolves packaged temp-mail and cloudflared resources", async () => {
  const appDataDir = await createTempAppDataDir();
  const resourcesDir = path.join(appDataDir, "resources");
  const snapshot = {
    CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR: process.env.CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR,
    CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR: process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR,
    CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN: process.env.CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN
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
    assert.equal(process.env.CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR, path.join(resourcesDir, "temp-mail-runner"));
    assert.equal(process.env.CODEX_PRO_MAX_CLOUDFLARED_RESOURCES_DIR, path.join(resourcesDir, "cloudflared"));
    assert.equal(process.env.CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN, "1");
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
