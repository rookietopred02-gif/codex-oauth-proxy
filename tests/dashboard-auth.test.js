import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startAppServer, stopAppServer } from "../src/app-server.js";

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
  return await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-dashboard-auth-"));
}

async function writeDesktopEnv(appDataDir, lines) {
  await fs.mkdir(appDataDir, { recursive: true });
  await fs.writeFile(path.join(appDataDir, ".env"), `${lines.join("\n")}\n`, "utf8");
}

function getCookieHeader(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return setCookies
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

test("dashboard password protection locks admin routes and stores only a local hash", async () => {
  const appDataDir = await createTempAppDataDir();
  const port = await reserveFreePort();
  const password = "supersecret123";

  await writeDesktopEnv(appDataDir, [`PORT=${port}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1"
    });

    let response = await fetch(`${backend.url}/dashboard-auth/status`);
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.configured, false);
    assert.equal(body.authenticated, false);

    response = await fetch(`${backend.url}/admin/state`);
    assert.equal(response.status, 200);

    response = await fetch(`${backend.url}/dashboard/`);
    assert.equal(response.status, 200);
    const dashboardHtml = await response.text();
    assert.match(dashboardHtml, /dashboardAuthGate/);

    response = await fetch(`${backend.url}/dashboard-auth/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        enabled: true,
        password
      })
    });
    assert.equal(response.status, 200);
    const configCookie = getCookieHeader(response);
    body = await response.json();
    assert.equal(body.enabled, true);
    assert.equal(body.configured, true);
    assert.equal(body.authenticated, true);
    assert.ok(configCookie.includes("codex_pm_dashboard_session="));

    response = await fetch(`${backend.url}/admin/state`);
    assert.equal(response.status, 401);
    body = await response.json();
    assert.equal(body.error, "dashboard_auth_required");

    response = await fetch(`${backend.url}/auth/status`);
    assert.equal(response.status, 401);

    response = await fetch(`${backend.url}/admin/state`, {
      headers: {
        cookie: configCookie
      }
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.ok, true);

    response = await fetch(`${backend.url}/dashboard-auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password: "wrong-password"
      })
    });
    assert.equal(response.status, 401);
    body = await response.json();
    assert.equal(body.error, "dashboard_auth_invalid_password");

    response = await fetch(`${backend.url}/dashboard-auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password
      })
    });
    assert.equal(response.status, 200);
    const loginCookie = getCookieHeader(response);
    assert.ok(loginCookie.includes("codex_pm_dashboard_session="));

    const authStorePath = path.join(appDataDir, "data", "dashboard-auth.json");
    const authStoreText = await fs.readFile(authStorePath, "utf8");
    const authStore = JSON.parse(authStoreText);
    assert.equal(authStore.enabled, true);
    assert.equal(typeof authStore.passwordHash, "string");
    assert.equal(typeof authStore.passwordSalt, "string");
    assert.match(authStore.passwordHash, /^[a-f0-9]{32,}$/);
    assert.ok(authStore.passwordSalt.length > 0);
    assert.equal(authStoreText.includes(password), false);

    response = await fetch(`${backend.url}/dashboard-auth/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: loginCookie
      },
      body: JSON.stringify({
        enabled: false
      })
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.enabled, false);

    response = await fetch(`${backend.url}/admin/state`);
    assert.equal(response.status, 200);
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});
