import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startAppServer, stopAppServer } from "../src/app-server.js";
import { createDashboardAuthController } from "../src/dashboard-auth.js";

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

function createHeaderCaptureResponse() {
  const headers = new Map();
  return {
    getHeader(name) {
      return headers.get(String(name || "").toLowerCase());
    },
    setHeader(name, value) {
      headers.set(String(name || "").toLowerCase(), value);
    },
    headers
  };
}

test("dashboard auth bounds malformed session ttl values", async () => {
  const appDataDir = await createTempAppDataDir();
  try {
    const controller = await createDashboardAuthController({
      storePath: path.join(appDataDir, "data", "dashboard-auth.json"),
      sessionTtlSeconds: Symbol("ttl")
    });
    await controller.configure({
      enabled: true,
      password: "supersecret123"
    });

    const res = createHeaderCaptureResponse();
    controller.appendSessionCookie(res, { headers: {} });

    const cookie = String(res.headers.get("set-cookie") || "");
    assert.match(cookie, /Max-Age=300/);
    assert.equal(
      controller.authenticateRequest({
        headers: {
          cookie: cookie.split(";")[0]
        }
      }).ok,
      true
    );
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("dashboard auth rejects decimal-form session ttl values", async () => {
  const appDataDir = await createTempAppDataDir();
  try {
    const controller = await createDashboardAuthController({
      storePath: path.join(appDataDir, "data", "dashboard-auth.json"),
      sessionTtlSeconds: "999.9"
    });
    await controller.configure({
      enabled: true,
      password: "supersecret123"
    });

    const res = createHeaderCaptureResponse();
    controller.appendSessionCookie(res, { headers: {} });

    const cookie = String(res.headers.get("set-cookie") || "");
    assert.match(cookie, /Max-Age=300/);
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("dashboard auth bounds malformed throttle and password policy options", async () => {
  const appDataDir = await createTempAppDataDir();
  try {
    const controller = await createDashboardAuthController({
      storePath: path.join(appDataDir, "data", "dashboard-auth.json"),
      loginWindowMs: Symbol("window"),
      loginMaxAttempts: Symbol("attempts"),
      minimumPasswordLength: Symbol("minimum")
    });

    await assert.rejects(
      () => controller.configure({ enabled: true, password: "1234567" }),
      /Dashboard password must be at least 8 characters/
    );
    await controller.configure({ enabled: true, password: "12345678" });
    await assert.rejects(
      () => controller.attemptLogin({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, "not-right"),
      /Incorrect dashboard password/
    );
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("dashboard auth enforces minimum throttle and password policy bounds", async () => {
  const appDataDir = await createTempAppDataDir();
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.2" } };
  try {
    const controller = await createDashboardAuthController({
      storePath: path.join(appDataDir, "data", "dashboard-auth.json"),
      loginWindowMs: 0,
      loginMaxAttempts: 0,
      minimumPasswordLength: 0
    });

    await assert.rejects(
      () => controller.configure({ enabled: true, password: "12345" }),
      /Dashboard password must be at least 6 characters/
    );
    await controller.configure({ enabled: true, password: "123456" });
    await assert.rejects(() => controller.attemptLogin(req, "not-right"), /Incorrect dashboard password/);
    await assert.rejects(() => controller.attemptLogin(req, "not-right"), /Too many dashboard login attempts/);
  } finally {
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

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

    response = await fetch(`${backend.url}/dashboard-auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{\"password\":"
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    body = await response.json();
    assert.equal(body.error, "invalid_json");

    response = await fetch(`${backend.url}/dashboard-auth/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{\"enabled\":"
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    body = await response.json();
    assert.equal(body.error, "invalid_json");

    response = await fetch(`${backend.url}/admin/state`);
    assert.equal(response.status, 200);

    response = await fetch(`${backend.url}/admin/state`, {
      headers: {
        "cf-visitor": "{\"scheme\":\"https\"}",
        "x-forwarded-for": "203.0.113.10"
      }
    });
    assert.equal(response.status, 401);
    body = await response.json();
    assert.equal(body.error, "dashboard_auth_required");

    response = await fetch(`${backend.url}/admin/auth-pool/export`, {
      headers: {
        "cf-visitor": "{\"scheme\":\"https\"}",
        "x-forwarded-for": "203.0.113.10"
      }
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("expires"), "0");
    body = await response.json();
    assert.equal(body.error, "dashboard_auth_required");

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

test("dashboard auth sets a secure session cookie when proxied through Cloudflare HTTPS", async () => {
  const appDataDir = await createTempAppDataDir();
  const port = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${port}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1"
    });

    let response = await fetch(`${backend.url}/dashboard-auth/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        enabled: true,
        password: "supersecret123"
      })
    });
    assert.equal(response.status, 200);

    response = await fetch(`${backend.url}/dashboard-auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-visitor": "{\"scheme\":\"https\"}"
      },
      body: JSON.stringify({
        password: "supersecret123"
      })
    });

    assert.equal(response.status, 200);
    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie().join("; ")
        : String(response.headers.get("set-cookie") || "");
    assert.match(setCookie, /Secure/i);
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});

test("dashboard auth rejects proxied initial password configuration even over a local tunnel socket", async () => {
  const appDataDir = await createTempAppDataDir();
  const port = await reserveFreePort();

  await writeDesktopEnv(appDataDir, [`PORT=${port}`, "AUTH_MODE=codex-oauth"]);

  try {
    const backend = await startAppServer({
      appDataDir,
      host: "127.0.0.1"
    });

    const response = await fetch(`${backend.url}/dashboard-auth/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "198.51.100.44"
      },
      body: JSON.stringify({
        enabled: true,
        password: "supersecret123"
      })
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, "dashboard_auth_local_only");
  } finally {
    await stopAppServer("TEST");
    await fs.rm(appDataDir, { recursive: true, force: true });
  }
});
