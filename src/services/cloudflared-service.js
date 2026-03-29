// @ts-check

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

/**
 * @param {{
 *   config: any;
 *   rootDir: string;
 *   runtimeBinDir: string;
 *   bundledCloudflaredResourcesDir: string;
 *   defaultCloudflaredBin: string;
 *   resolveBundledCloudflaredBinaryName: (platform?: string) => string;
 *   resolveBundledCloudflaredTargetNames: (platform?: string, arch?: string) => string[];
 *   validCloudflaredModes: Set<string>;
 *   parseNumberEnv: (value: unknown, fallback: number, options?: object) => number;
 * }} options
 */
export function createCloudflaredService({
  config,
  rootDir,
  runtimeBinDir,
  bundledCloudflaredResourcesDir,
  defaultCloudflaredBin,
  resolveBundledCloudflaredBinaryName,
  resolveBundledCloudflaredTargetNames,
  validCloudflaredModes,
  parseNumberEnv
}) {
  let installPromise = null;

  const runtime = {
    process: null,
    mode: config.publicAccess.defaultMode,
    useHttp2: config.publicAccess.defaultUseHttp2,
    tunnelToken: config.publicAccess.defaultTunnelToken,
    localPort: config.publicAccess.localPort,
    url: "",
    error: "",
    running: false,
    installed: false,
    version: "",
    lastCheckedAt: 0,
    installInProgress: false,
    installMessage: "",
    installUpdatedAt: 0,
    pid: null,
    startedAt: 0,
    outputTail: []
  };

  function resolveBin() {
    const configured = String(config.publicAccess.cloudflaredBinPath || "").trim();
    if (configured && fsSync.existsSync(configured)) return configured;

    if (bundledCloudflaredResourcesDir) {
      const binaryName = resolveBundledCloudflaredBinaryName();
      const candidates = resolveBundledCloudflaredTargetNames().map((targetName) =>
        path.join(path.resolve(bundledCloudflaredResourcesDir), targetName, binaryName)
      );
      for (const candidate of candidates) {
        if (fsSync.existsSync(candidate)) return candidate;
      }
    }

    const bundledBinDir = path.join(rootDir, "bin");
    const binDirs = runtimeBinDir === bundledBinDir ? [runtimeBinDir] : [runtimeBinDir, bundledBinDir];
    for (const binDir of binDirs) {
      const bundledDefault = path.join(binDir, defaultCloudflaredBin);
      if (fsSync.existsSync(bundledDefault)) return bundledDefault;

      try {
        const entries = fsSync
          .readdirSync(binDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .filter((name) => {
            const lower = name.toLowerCase();
            if (process.platform === "win32") {
              return /^cloudflared(?:-\d+)?\.exe$/.test(lower);
            }
            return /^cloudflared(?:-\d+)?$/.test(lower);
          })
          .map((name) => {
            const fullPath = path.join(binDir, name);
            const stat = fsSync.statSync(fullPath);
            return { fullPath, mtimeMs: Number(stat.mtimeMs || 0) };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (entries[0]?.fullPath) return entries[0].fullPath;
      } catch {
        // Ignore local bin discovery failures and fall back to PATH resolution.
      }
    }

    return defaultCloudflaredBin;
  }

  function resolveAssetMeta() {
    const archMap = {
      x64: "amd64",
      ia32: "386",
      arm64: "arm64",
      arm: "arm"
    };
    const arch = archMap[String(process.arch || "").toLowerCase()];
    if (!arch) {
      throw new Error(`Unsupported CPU architecture for cloudflared install: ${process.arch}`);
    }

    let platform = "";
    let ext = "";
    if (process.platform === "win32") {
      platform = "windows";
      ext = ".exe";
    } else if (process.platform === "linux") {
      platform = "linux";
    } else if (process.platform === "darwin") {
      platform = "darwin";
    } else {
      throw new Error(`Unsupported OS for cloudflared install: ${process.platform}`);
    }

    const assetName = `cloudflared-${platform}-${arch}${ext}`;
    const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
    const binaryName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    return {
      assetName,
      downloadUrl,
      binaryName
    };
  }

  /**
   * @param {Buffer} bytes
   */
  function isLikelyBinaryPayload(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1024) return false;
    if (process.platform === "win32") {
      return bytes[0] === 0x4d && bytes[1] === 0x5a;
    }
    if (process.platform === "linux") {
      return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    }
    if (process.platform === "darwin") {
      const magicBE = bytes.readUInt32BE(0);
      const magicLE = bytes.readUInt32LE(0);
      return (
        magicBE === 0xfeedface ||
        magicBE === 0xfeedfacf ||
        magicBE === 0xcafebabe ||
        magicLE === 0xcefaedfe ||
        magicLE === 0xcffaedfe ||
        magicLE === 0xbebafeca
      );
    }
    return true;
  }

  function resolveInstallPath(assetMeta) {
    const installDir = runtimeBinDir;
    const configuredPath = String(config.publicAccess.cloudflaredBinPath || "").trim();
    let installPath = configuredPath || path.join(installDir, assetMeta.binaryName);

    if (runtime.running) {
      const activeBin = path.resolve(resolveBin());
      const targetBin = path.resolve(installPath);
      if (activeBin === targetBin) {
        const parsed = path.parse(assetMeta.binaryName);
        installPath = path.join(installDir, `${parsed.name}-${Date.now()}${parsed.ext}`);
      }
    }

    return { installDir, installPath };
  }

  function updateOutput(line) {
    const text = String(line || "").trim();
    if (!text) return;
    runtime.outputTail.push(text);
    if (runtime.outputTail.length > 120) {
      runtime.outputTail.splice(0, runtime.outputTail.length - 120);
    }
  }

  function extractUrlFromLine(line) {
    const text = String(line || "");
    const quick = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    if (quick && quick[0]) return quick[0];
    if (text.includes("Updated to new configuration") && text.includes("hostname")) {
      const match = text.match(/\\"hostname\\":\\"([^"\\]+)\\"/);
      if (match && match[1]) {
        return `https://${match[1]}`;
      }
    }
    const hostnameField = text.match(/(?:^|[\s{,])hostname["=: ]+["']?([a-z0-9.-]+\.[a-z]{2,})["']?/i);
    if (hostnameField && hostnameField[1]) {
      return `https://${hostnameField[1]}`;
    }
    return "";
  }

  function createLineReader(stream) {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        updateOutput(line);
        const url = extractUrlFromLine(line);
        if (url) runtime.url = url;
        idx = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => {
      const tail = buffer.replace(/\r$/, "").trim();
      if (!tail) return;
      updateOutput(tail);
      const url = extractUrlFromLine(tail);
      if (url) runtime.url = url;
    });
  }

  async function checkInstalled(force = false) {
    const now = Date.now();
    if (!force && now - Number(runtime.lastCheckedAt || 0) < 30000) {
      return {
        installed: runtime.installed,
        version: runtime.version
      };
    }

    const bin = resolveBin();
    const output = await new Promise((resolve) => {
      const child = spawn(bin, ["--version"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, stdout, stderr });
      }, 8000);
      child.stdout?.on("data", (data) => {
        stdout += Buffer.from(data).toString("utf8");
      });
      child.stderr?.on("data", (data) => {
        stderr += Buffer.from(data).toString("utf8");
      });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: false, stdout, stderr });
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ ok: code === 0, stdout, stderr });
      });
    });

    runtime.lastCheckedAt = now;
    runtime.installed = output.ok === true;
    runtime.version = output.ok
      ? String(output.stdout || output.stderr || "")
          .split(/\r?\n/)[0]
          .trim()
      : "";
    return {
      installed: runtime.installed,
      version: runtime.version
    };
  }

  function getStatus() {
    return {
      installed: Boolean(runtime.installed),
      version: runtime.version || null,
      installInProgress: Boolean(runtime.installInProgress),
      installMessage: runtime.installMessage || null,
      installUpdatedAt: Number(runtime.installUpdatedAt || 0) || null,
      running: Boolean(runtime.running),
      url: runtime.url || null,
      error: runtime.error || null,
      mode: runtime.mode || "quick",
      useHttp2: runtime.useHttp2 !== false,
      autoInstall: config.publicAccess.autoInstall !== false,
      localPort: Number(runtime.localPort || config.port),
      pid: runtime.pid || null,
      startedAt: Number(runtime.startedAt || 0) || null,
      binaryPath: resolveBin(),
      outputTail: [...runtime.outputTail]
    };
  }

  async function installBinary() {
    if (installPromise) {
      return installPromise;
    }

    installPromise = (async () => {
      runtime.installInProgress = true;
      runtime.installMessage = "installing";
      runtime.installUpdatedAt = Math.floor(Date.now() / 1000);

      let tempPath = "";
      try {
        const assetMeta = resolveAssetMeta();
        const { installDir, installPath } = resolveInstallPath(assetMeta);
        await fs.mkdir(installDir, { recursive: true });

        const downloadAbort = new AbortController();
        const downloadTimeout = setTimeout(() => downloadAbort.abort(), 120000);
        let response;
        try {
          response = await fetch(assetMeta.downloadUrl, {
            method: "GET",
            redirect: "follow",
            headers: { "user-agent": "codex-pro-max/0.1.1", accept: "application/octet-stream" },
            signal: downloadAbort.signal
          });
        } catch (err) {
          if (err?.name === "AbortError") {
            throw new Error("cloudflared download timed out after 120 seconds.");
          }
          throw err;
        } finally {
          clearTimeout(downloadTimeout);
        }

        if (!response.ok) {
          throw new Error(`cloudflared download failed: HTTP ${response.status} ${response.statusText}`);
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        if (!Buffer.isBuffer(bytes) || bytes.length < 64 * 1024 || !isLikelyBinaryPayload(bytes)) {
          throw new Error("cloudflared download produced invalid payload.");
        }

        tempPath = `${installPath}.download-${Date.now()}`;
        await fs.writeFile(tempPath, bytes);
        if (process.platform !== "win32") {
          await fs.chmod(tempPath, 0o755);
        }

        if (fsSync.existsSync(installPath)) {
          await fs.unlink(installPath).catch(() => {});
        }
        await fs.rename(tempPath, installPath);
        tempPath = "";

        config.publicAccess.cloudflaredBinPath = installPath;
        runtime.lastCheckedAt = 0;
        const probe = await checkInstalled(true);
        if (!probe.installed) {
          throw new Error("cloudflared install finished but binary check still failed.");
        }

        const message = `installed (${assetMeta.assetName})`;
        runtime.installMessage = message;
        runtime.installUpdatedAt = Math.floor(Date.now() / 1000);
        runtime.error = "";
        updateOutput(`${message} -> ${installPath}`);
        return {
          installed: true,
          path: installPath,
          asset: assetMeta.assetName,
          version: probe.version || ""
        };
      } catch (err) {
        runtime.installMessage = String(err?.message || err || "install_failed");
        runtime.installUpdatedAt = Math.floor(Date.now() / 1000);
        runtime.error = runtime.installMessage;
        updateOutput(`install failed: ${runtime.installMessage}`);
        if (tempPath) {
          await fs.unlink(tempPath).catch(() => {});
        }
        throw err;
      } finally {
        runtime.installInProgress = false;
        installPromise = null;
      }
    })();

    return installPromise;
  }

  /**
   * @param {{
   *   mode?: string;
   *   token?: string;
   *   useHttp2?: boolean;
   *   localPort?: number;
   *   autoInstall?: boolean;
   * }} [options]
   */
  async function startTunnel({ mode, token, useHttp2, localPort, autoInstall } = {}) {
    if (runtime.running && runtime.process) {
      return getStatus();
    }

    const normalizedMode = validCloudflaredModes.has(String(mode || "").trim().toLowerCase())
      ? String(mode).trim().toLowerCase()
      : config.publicAccess.defaultMode;
    const normalizedAutoInstall =
      autoInstall === undefined ? config.publicAccess.autoInstall !== false : Boolean(autoInstall);
    const normalizedToken = String(token || runtime.tunnelToken || config.publicAccess.defaultTunnelToken || "").trim();
    const normalizedUseHttp2 = useHttp2 === undefined ? runtime.useHttp2 !== false : Boolean(useHttp2);
    const parsedPort = parseNumberEnv(localPort ?? runtime.localPort ?? config.port, Number(config.port), {
      min: 1,
      max: 65535,
      integer: true
    });

    if (normalizedMode === "auth" && !normalizedToken) {
      throw new Error("Cloudflared token is required when mode=auth.");
    }

    let installed = await checkInstalled(true);
    if (!installed.installed && normalizedAutoInstall) {
      await installBinary();
      installed = await checkInstalled(true);
    }
    if (!installed.installed) {
      throw new Error(
        "cloudflared binary not found. Install cloudflared and ensure it is on PATH, or set CLOUDFLARED_BIN_PATH."
      );
    }

    const bin = resolveBin();
    const args =
      normalizedMode === "auth"
        ? ["tunnel", "run", "--token", normalizedToken]
        : ["tunnel", "--url", `http://127.0.0.1:${parsedPort}`];
    if (normalizedUseHttp2) {
      args.push("--protocol", "http2");
    }

    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.once("error", (err) => {
      runtime.running = false;
      runtime.error = String(err?.message || err || "cloudflared_start_failed");
      runtime.pid = null;
      runtime.process = null;
    });
    child.once("exit", (code, signal) => {
      runtime.running = false;
      runtime.pid = null;
      runtime.process = null;
      if (!runtime.error && code !== 0) {
        runtime.error = `cloudflared exited with code=${code ?? "?"} signal=${signal ?? "-"}`;
      }
    });
    if (child.stdout) createLineReader(child.stdout);
    if (child.stderr) createLineReader(child.stderr);

    runtime.process = child;
    runtime.running = true;
    runtime.error = "";
    runtime.mode = normalizedMode;
    runtime.useHttp2 = normalizedUseHttp2;
    runtime.tunnelToken = normalizedToken;
    runtime.localPort = parsedPort;
    runtime.startedAt = Math.floor(Date.now() / 1000);
    runtime.pid = child.pid || null;
    return getStatus();
  }

  async function stopTunnel() {
    const child = runtime.process;
    if (child) {
      try {
        const exitPromise =
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => {
                child.once("exit", () => resolve());
              });
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 450));
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exitPromise;
      } catch {
        // Ignore process kill errors.
      }
    }

    runtime.process = null;
    runtime.running = false;
    runtime.pid = null;
    runtime.url = "";
    runtime.error = "";
    return getStatus();
  }

  return {
    runtime,
    checkInstalled,
    extractUrlFromLine,
    getStatus,
    installBinary,
    resolveBin,
    startTunnel,
    stopTunnel,
    updateOutput
  };
}
