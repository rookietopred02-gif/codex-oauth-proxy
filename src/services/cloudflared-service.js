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
 *   spawnImpl?: typeof spawn;
 *   restartBaseDelayMs?: number;
 *   restartMaxDelayMs?: number;
 *   startupStableMs?: number;
 *   startupTimeoutMs?: number;
 *   stopTimeoutMs?: number;
 *   downloadTimeoutMs?: number;
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
  parseNumberEnv,
  spawnImpl = spawn,
  restartBaseDelayMs = 1000,
  restartMaxDelayMs = 30000,
  startupStableMs = 1200,
  startupTimeoutMs = 8000,
  stopTimeoutMs = 2500,
  downloadTimeoutMs = 120000
}) {
  let installPromise = null;
  let startPromise = null;
  let stopPromise = null;
  let restartTimer = null;
  let restartAttempt = 0;
  let supervisorVersion = 0;
  let childGeneration = 0;
  let stopInProgress = false;
  let desiredTunnelOptions = null;

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
    supervised: false,
    restartCount: 0,
    restartAttempt: 0,
    restartScheduledAt: 0,
    lastExitAt: 0,
    lastExitCode: null,
    lastExitSignal: null,
    outputTail: []
  };

  function readFiniteNumber(value) {
    try {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function readIntegerNumber(value) {
    if (typeof value === "number") {
      return Number.isInteger(value) && Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
    return null;
  }

  function clampInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = readFiniteNumber(value);
    const fallbackParsed = readFiniteNumber(fallback);
    const source = parsed ?? fallbackParsed ?? min;
    return Math.max(min, Math.min(max, Math.floor(source)));
  }

  function clampDurationMs(value, fallback, min = 0, max = 120000) {
    return clampInteger(value, fallback, min, max);
  }

  function readNullableTimestampSec(value) {
    const parsed = clampInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
    return parsed || null;
  }

  function readStatusPort(value, fallback) {
    const parsed = readIntegerNumber(value);
    const fallbackParsed = readIntegerNumber(fallback) ?? 8787;
    const source = parsed ?? fallbackParsed;
    return Math.max(1, Math.min(65535, source));
  }

  const resolvedRestartBaseDelayMs = clampDurationMs(restartBaseDelayMs, 1000, 0, 120000);
  const resolvedRestartMaxDelayMs = clampDurationMs(restartMaxDelayMs, 30000, resolvedRestartBaseDelayMs, 300000);
  const resolvedStartupStableMs = clampDurationMs(startupStableMs, 1200, 0, 60000);
  const resolvedStartupTimeoutMs = clampDurationMs(startupTimeoutMs, 8000, resolvedStartupStableMs, 120000);
  const resolvedStopTimeoutMs = clampDurationMs(stopTimeoutMs, 2500, 100, 60000);
  const resolvedDownloadTimeoutMs = clampDurationMs(downloadTimeoutMs, 120000, 1, 300000);

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, clampInteger(ms, 0, 0, 300000)));
  }

  function formatDurationForMessage(ms) {
    const durationMs = clampDurationMs(ms, 120000, 1, 300000);
    return durationMs % 1000 === 0 ? `${durationMs / 1000} seconds` : `${durationMs}ms`;
  }

  async function readDownloadArrayBuffer(response, timeoutMessage) {
    let timer = null;
    try {
      return await Promise.race([
        response.arrayBuffer(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(timeoutMessage);
            err.name = "AbortError";
            response?.body?.cancel?.(err).catch(() => {});
            reject(err);
          }, resolvedDownloadTimeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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

  function createLineReader(stream, label = "stream") {
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
    stream.on("error", (err) => {
      updateOutput(`${label} error: ${err?.message || err || "stream_error"}`);
    });
  }

  async function checkInstalled(force = false) {
    const now = Date.now();
    const lastCheckedAt = readFiniteNumber(runtime.lastCheckedAt) ?? 0;
    if (!force && now - lastCheckedAt < 30000) {
      return {
        installed: runtime.installed,
        version: runtime.version
      };
    }

    const bin = resolveBin();
    const output = await new Promise((resolve) => {
      const child = spawnImpl(bin, ["--version"], {
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
      installUpdatedAt: readNullableTimestampSec(runtime.installUpdatedAt),
      running: Boolean(runtime.running),
      url: runtime.url || null,
      error: runtime.error || null,
      mode: runtime.mode || "quick",
      useHttp2: runtime.useHttp2 !== false,
      autoInstall: config.publicAccess.autoInstall !== false,
      localPort: readStatusPort(runtime.localPort, config.port),
      pid: runtime.pid || null,
      startedAt: readNullableTimestampSec(runtime.startedAt),
      supervised: Boolean(runtime.supervised),
      restartCount: clampInteger(runtime.restartCount, 0),
      restartAttempt: clampInteger(runtime.restartAttempt, 0),
      restartScheduledAt: readNullableTimestampSec(runtime.restartScheduledAt),
      lastExitAt: readNullableTimestampSec(runtime.lastExitAt),
      lastExitCode: runtime.lastExitCode,
      lastExitSignal: runtime.lastExitSignal,
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
        const downloadTimeoutMessage = `cloudflared download timed out after ${formatDurationForMessage(
          resolvedDownloadTimeoutMs
        )}.`;
        const downloadTimeout = setTimeout(() => downloadAbort.abort(), resolvedDownloadTimeoutMs);
        downloadTimeout.unref?.();
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
            throw new Error(downloadTimeoutMessage);
          }
          throw err;
        } finally {
          clearTimeout(downloadTimeout);
        }

        if (!response.ok) {
          throw new Error(`cloudflared download failed: HTTP ${response.status} ${response.statusText}`);
        }

        const bytes = Buffer.from(await readDownloadArrayBuffer(response, downloadTimeoutMessage));
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
   * @param {{ mode?: string; token?: string; useHttp2?: boolean; localPort?: number; autoInstall?: boolean }} [options]
   */
  function normalizeTunnelOptions(options = {}) {
    const { mode, token, useHttp2, localPort, autoInstall } = options;
    const normalizedMode = validCloudflaredModes.has(String(mode || "").trim().toLowerCase())
      ? String(mode).trim().toLowerCase()
      : config.publicAccess.defaultMode;
    const normalizedAutoInstall =
      autoInstall === undefined ? config.publicAccess.autoInstall !== false : Boolean(autoInstall);
    const requestedToken = String(token || "").trim();
    const fallbackToken = String(runtime.tunnelToken || config.publicAccess.defaultTunnelToken || "").trim();
    const normalizedToken = normalizedMode === "auth" ? requestedToken || fallbackToken : "";
    const normalizedUseHttp2 = useHttp2 === undefined ? runtime.useHttp2 !== false : Boolean(useHttp2);
    const fallbackPort = readStatusPort(config.port, 8787);
    const parsedPort = readStatusPort(localPort ?? runtime.localPort ?? config.port, fallbackPort);

    if (normalizedMode === "auth" && !normalizedToken) {
      throw new Error("Cloudflared token is required when mode=auth.");
    }

    return {
      mode: normalizedMode,
      token: normalizedToken,
      useHttp2: normalizedUseHttp2,
      localPort: parsedPort,
      autoInstall: normalizedAutoInstall
    };
  }

  function clearRestartTimer() {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = null;
    runtime.restartScheduledAt = 0;
  }

  function isCurrentChild(child, generation) {
    return Boolean(child) && runtime.process === child && childGeneration === generation;
  }

  function markChildStopped(child, generation, { code = null, signal = null, error = "" } = {}) {
    if (!isCurrentChild(child, generation)) return false;
    runtime.running = false;
    runtime.pid = null;
    runtime.process = null;
    runtime.lastExitAt = Math.floor(Date.now() / 1000);
    runtime.lastExitCode = code;
    runtime.lastExitSignal = signal || null;
    if (error) runtime.error = String(error);
    return true;
  }

  function waitForChildExit(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (typeof child.off === "function") child.off("exit", onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      child.once("exit", onExit);
      timer = setTimeout(() => finish(false), clampDurationMs(timeoutMs, resolvedStopTimeoutMs, 100, 60000));
      timer.unref?.();
    });
  }

  async function waitForTunnelStartup(child, generation) {
    const startedAt = Date.now();
    const stableAt = startedAt + resolvedStartupStableMs;
    const deadline = startedAt + resolvedStartupTimeoutMs;

    while (Date.now() <= deadline) {
      if (!isCurrentChild(child, generation)) {
        if (!runtime.running && runtime.error) {
          throw new Error(runtime.error);
        }
        throw new Error("cloudflared start was superseded before it became ready.");
      }
      if (!runtime.running) {
        throw new Error(runtime.error || "cloudflared exited before the tunnel became ready.");
      }
      if (runtime.url || Date.now() >= stableAt) return;
      await delay(Math.min(100, Math.max(10, stableAt - Date.now())));
    }
  }

  function scheduleRestart(reason, version = supervisorVersion) {
    if (!desiredTunnelOptions || version !== supervisorVersion) return;
    if (restartTimer) return;

    restartAttempt += 1;
    const delayMs = Math.min(
      resolvedRestartMaxDelayMs,
      resolvedRestartBaseDelayMs * Math.max(1, 2 ** Math.max(0, restartAttempt - 1))
    );
    runtime.supervised = true;
    runtime.restartAttempt = restartAttempt;
    runtime.restartScheduledAt = Date.now() + delayMs;
    updateOutput(`cloudflared restart scheduled in ${delayMs}ms: ${reason?.message || reason || "unexpected exit"}`);

    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!desiredTunnelOptions || version !== supervisorVersion) {
        runtime.restartScheduledAt = 0;
        return;
      }
      launchTunnel(desiredTunnelOptions, { supervisorRestart: true, version }).catch((err) => {
        runtime.error = String(err?.message || err || "cloudflared_restart_failed");
        updateOutput(`cloudflared restart failed: ${runtime.error}`);
        scheduleRestart(err, version);
      });
    }, delayMs);
    restartTimer.unref?.();
  }

  async function launchTunnel(resolvedOptions, { supervisorRestart = false, version = supervisorVersion } = {}) {
    if (runtime.running && runtime.process) {
      return getStatus();
    }
    if (!desiredTunnelOptions || version !== supervisorVersion) {
      return getStatus();
    }

    let installed = await checkInstalled(true);
    if (!installed.installed && resolvedOptions.autoInstall) {
      await installBinary();
      installed = await checkInstalled(true);
    }
    if (!installed.installed) {
      throw new Error(
        "cloudflared binary not found. Install cloudflared and ensure it is on PATH, or set CLOUDFLARED_BIN_PATH."
      );
    }

    if (!desiredTunnelOptions || version !== supervisorVersion) {
      return getStatus();
    }

    const bin = resolveBin();
    const args =
      resolvedOptions.mode === "auth"
        ? ["tunnel", "run", "--token", resolvedOptions.token]
        : ["tunnel", "--url", `http://127.0.0.1:${resolvedOptions.localPort}`];
    if (resolvedOptions.useHttp2) {
      args.push("--protocol", "http2");
    }

    const child = spawnImpl(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const generation = childGeneration + 1;
    let restartOnUnexpectedExit = false;

    child.once("error", (err) => {
      const expectedStop = stopInProgress || !desiredTunnelOptions || version !== supervisorVersion;
      const message = String(err?.message || err || "cloudflared_start_failed");
      if (!markChildStopped(child, generation, { error: message })) return;
      if (!expectedStop && restartOnUnexpectedExit) scheduleRestart(message, version);
    });
    child.once("exit", (code, signal) => {
      const expectedStop = stopInProgress || !desiredTunnelOptions || version !== supervisorVersion;
      const message = `cloudflared exited with code=${code ?? "?"} signal=${signal ?? "-"}`;
      if (!markChildStopped(child, generation, { code, signal, error: expectedStop ? "" : message })) return;
      if (!expectedStop && restartOnUnexpectedExit) {
        scheduleRestart(message, version);
      }
    });
    if (child.stdout) createLineReader(child.stdout, "stdout");
    if (child.stderr) createLineReader(child.stderr, "stderr");

    childGeneration = generation;
    runtime.process = child;
    runtime.running = true;
    runtime.error = "";
    runtime.url = "";
    runtime.mode = resolvedOptions.mode;
    runtime.useHttp2 = resolvedOptions.useHttp2;
    runtime.tunnelToken = resolvedOptions.token;
    runtime.localPort = resolvedOptions.localPort;
    runtime.startedAt = Math.floor(Date.now() / 1000);
    runtime.pid = child.pid || null;
    runtime.supervised = true;
    if (supervisorRestart) {
      runtime.restartCount += 1;
    }

    await waitForTunnelStartup(child, generation);
    restartOnUnexpectedExit = true;
    restartAttempt = 0;
    runtime.restartAttempt = 0;
    runtime.restartScheduledAt = 0;
    return getStatus();
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
  async function startTunnel(options = {}) {
    if (startPromise) return await startPromise;
    if (stopPromise) await stopPromise.catch(() => {});
    if (runtime.running && runtime.process) {
      return getStatus();
    }

    startPromise = (async () => {
      const resolvedOptions = normalizeTunnelOptions(options);
      supervisorVersion += 1;
      desiredTunnelOptions = resolvedOptions;
      restartAttempt = 0;
      runtime.restartAttempt = 0;
      clearRestartTimer();

      try {
        return await launchTunnel(resolvedOptions, { supervisorRestart: false, version: supervisorVersion });
      } catch (err) {
        desiredTunnelOptions = null;
        clearRestartTimer();
        runtime.supervised = false;
        throw err;
      }
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stopTunnel() {
    if (stopPromise) return await stopPromise;

    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      supervisorVersion += 1;
      desiredTunnelOptions = null;
      restartAttempt = 0;
      runtime.restartAttempt = 0;
      runtime.restartScheduledAt = 0;
      runtime.supervised = false;
      clearRestartTimer();
      stopInProgress = true;

      try {
        await terminateActiveTunnelProcess();
      } finally {
        stopInProgress = false;
        runtime.process = null;
        runtime.running = false;
        runtime.pid = null;
        runtime.url = "";
        runtime.error = "";
      }

      return getStatus();
    })();

    try {
      return await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  async function terminateActiveTunnelProcess() {
    const child = runtime.process;
    if (child) {
      try {
        child.kill("SIGTERM");
        await waitForChildExit(child, Math.min(450, resolvedStopTimeoutMs));
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        const exited = await waitForChildExit(child, Math.max(100, resolvedStopTimeoutMs));
        if (!exited) {
          updateOutput("cloudflared stop timed out while waiting for process exit.");
        }
      } catch {
        // Ignore process kill errors.
      }
    }
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
