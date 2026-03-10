import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_LOG_LIMIT = 300;
const RUNNER_READY_TTL_MS = 15000;
const STOP_GRACE_MS = 5000;
const STOP_KILL_MS = 9000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function normalizeTempMailConfig(input = {}) {
  const allowParallel = input.allowParallel === true || input.allow_parallel === true;
  const requestedWorkers = clampInt(input.workers, 1, 1, 50);
  const count = clampInt(input.count, 1, 1, 100);
  const nextDelaySeconds = clampInt(input.nextDelaySeconds ?? input.next_delay_seconds, 15, 0, 300);
  const password = String(input.password || "").trim();

  return {
    count,
    password,
    allowParallel,
    workers: requestedWorkers,
    effectiveWorkers: allowParallel ? requestedWorkers : 1,
    nextDelaySeconds
  };
}

export function createTempMailLogBuffer(limit = DEFAULT_LOG_LIMIT) {
  const entries = [];
  return {
    push(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    reset() {
      entries.length = 0;
    },
    values() {
      return entries.slice();
    }
  };
}

async function probeGoToolchain() {
  return await new Promise((resolve) => {
    const child = spawn("go", ["version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({ ok: false, error: "go version probe timed out." });
    }, 5000);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(err?.message || err || "go not available") });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, version: stdout.trim() || "go" });
      } else {
        finish({ ok: false, error: (stderr || stdout || `go exited ${code}`).trim() });
      }
    });
  });
}

export function createTempMailController({
  rootDir,
  importTokens,
  isSupported = () => true,
  spawnImpl = spawn,
  probeRunnerImpl = probeGoToolchain,
  logLimit = DEFAULT_LOG_LIMIT
}) {
  if (typeof importTokens !== "function") throw new Error("importTokens is required");
  if (!rootDir) throw new Error("rootDir is required");

  const logBuffer = createTempMailLogBuffer(logLimit);
  const state = {
    supported: true,
    runnerReady: false,
    runnerError: "",
    runnerVersion: "",
    running: false,
    stopping: false,
    config: null,
    progress: {
      total: 0,
      started: 0,
      completed: 0,
      success: 0,
      fail: 0
    },
    lastResult: null,
    lastError: "",
    logs: []
  };

  let child = null;
  let lineChain = Promise.resolve();
  let runnerCheckedAt = 0;
  let stopTimer = null;
  let killTimer = null;

  function snapshot() {
    return {
      supported: state.supported,
      runnerReady: state.runnerReady,
      runnerError: state.runnerError,
      runnerVersion: state.runnerVersion,
      running: state.running,
      stopping: state.stopping,
      config: state.config
        ? {
            count: state.config.count,
            allowParallel: state.config.allowParallel,
            workers: state.config.workers,
            effectiveWorkers: state.config.effectiveWorkers,
            nextDelaySeconds: state.config.nextDelaySeconds
          }
        : null,
      progress: { ...state.progress },
      lastResult: state.lastResult,
      lastError: state.lastError,
      logs: logBuffer.values()
    };
  }

  function pushLog(text, level = "info", source = "controller") {
    const entry = {
      ts: new Date().toISOString(),
      level: String(level || "info"),
      source: String(source || "controller"),
      text: String(text || "")
    };
    logBuffer.push(entry);
    state.logs = logBuffer.values();
    return entry;
  }

  async function refreshRunner(force = false) {
    state.supported = isSupported() === true;
    if (!state.supported) {
      state.runnerReady = false;
      state.runnerError = "Temp Mail requires AUTH_MODE=codex-oauth.";
      state.runnerVersion = "";
      return snapshot();
    }

    const now = Date.now();
    if (!force && now - runnerCheckedAt < RUNNER_READY_TTL_MS) {
      return snapshot();
    }

    runnerCheckedAt = now;
    const runnerDir = path.join(rootDir, "tools", "temp-mail-runner");
    const result = await probeRunnerImpl({ runnerDir, rootDir });
    state.runnerReady = result?.ok === true;
    state.runnerVersion = result?.version || "";
    state.runnerError = result?.ok === true ? "" : String(result?.error || "Temp Mail runner is unavailable.");
    return snapshot();
  }

  function clearStopTimers() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  }

  async function handleRunnerEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "log") {
      pushLog(event.text || "", event.level || "info", "runner");
      return;
    }
    if (event.type === "progress") {
      const total = clampInt(event.total, state.progress.total || 0, 0, 1000);
      const started = clampInt(event.started, state.progress.started, 0, 1000);
      const completed = clampInt(event.completed, state.progress.completed, 0, 1000);
      const success = clampInt(event.success, state.progress.success, 0, 1000);
      const fail = clampInt(event.fail, state.progress.fail, 0, 1000);
      state.progress = { total, started, completed, success, fail };
      return;
    }
    if (event.type === "token" && event.payload && typeof event.payload === "object") {
      const payload = event.payload;
      pushLog(`Importing token for ${payload.email || payload.label || "new account"}...`, "info", "controller");
      const imported = await importTokens([payload], { replace: false, probeUsage: true });
      state.lastResult = {
        ...(state.lastResult || {}),
        lastImportedEmail: payload.email || "",
        imported,
        importedAt: new Date().toISOString()
      };
      pushLog(
        `Imported ${imported.imported} token(s); pool=${imported.accountPoolSize}; usage probes=${imported.usageProbe?.probed || 0}.`,
        "success",
        "controller"
      );
      return;
    }
    if (event.type === "error") {
      state.lastError = String(event.message || "Temp Mail runner failed.");
      pushLog(state.lastError, "error", "runner");
      return;
    }
    if (event.type === "done") {
      state.lastResult = {
        ...(state.lastResult || {}),
        summary: {
          success: clampInt(event.success, state.progress.success, 0, 1000),
          fail: clampInt(event.fail, state.progress.fail, 0, 1000),
          total: clampInt(event.total, state.progress.total, 0, 1000),
          stopped: event.stopped === true,
          elapsed: event.elapsed || ""
        },
        finishedAt: new Date().toISOString()
      };
      if (event.message) pushLog(String(event.message), event.stopped === true ? "warning" : "success", "runner");
    }
  }

  function queueRunnerLine(line, source = "runner") {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    lineChain = lineChain
      .then(async () => {
        const parsed = safeJsonParse(trimmed);
        if (parsed && typeof parsed === "object" && parsed.type) {
          await handleRunnerEvent(parsed);
          return;
        }
        pushLog(trimmed, source === "stderr" ? "error" : "info", source);
      })
      .catch((err) => {
        state.lastError = String(err?.message || err || "Temp Mail event processing failed.");
        pushLog(state.lastError, "error", "controller");
      });
  }

  function attachReadline(stream, source) {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => queueRunnerLine(line, source));
    return rl;
  }

  async function start(input) {
    if (state.running || state.stopping) {
      throw new Error("Temp Mail is already running.");
    }
    const config = normalizeTempMailConfig(input);
    if (!config.password) {
      throw new Error("Temp Mail password is required.");
    }

    await refreshRunner(false);
    if (!state.runnerReady) {
      throw new Error(state.runnerError || "Temp Mail runner is unavailable.");
    }

    logBuffer.reset();
    state.logs = [];
    state.lastError = "";
    state.lastResult = null;
    state.progress = {
      total: config.count,
      started: 0,
      completed: 0,
      success: 0,
      fail: 0
    };
    state.config = config;
    state.running = true;
    state.stopping = false;
    pushLog(
      `Starting Temp Mail run: count=${config.count}, delay=${config.nextDelaySeconds}s, effectiveThreads=${config.effectiveWorkers}.`,
      "info",
      "controller"
    );

    const runnerDir = path.join(rootDir, "tools", "temp-mail-runner");
    const runnerArgs = ["run", "."];
    child = spawnImpl("go", runnerArgs, {
      cwd: runnerDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutRl = attachReadline(child.stdout, "runner");
    const stderrRl = attachReadline(child.stderr, "stderr");

    child.on("error", (err) => {
      state.lastError = String(err?.message || err || "Failed to launch Temp Mail runner.");
      pushLog(state.lastError, "error", "controller");
    });

    child.on("exit", (code, signal) => {
      Promise.resolve(lineChain)
        .catch(() => {})
        .finally(() => {
          clearStopTimers();
          stdoutRl.close();
          stderrRl.close();
          const wasStopping = state.stopping;
          state.running = false;
          state.stopping = false;
          if (code !== 0 && !wasStopping) {
            state.lastError = `Temp Mail runner exited with code ${code ?? "?"}${signal ? ` (${signal})` : ""}.`;
            pushLog(state.lastError, "error", "controller");
          } else if (signal && !wasStopping) {
            pushLog(`Temp Mail runner exited via signal ${signal}.`, "warning", "controller");
          }
          child = null;
        });
    });

    child.stdin.write(
      JSON.stringify({
        type: "start",
        config: {
          count: config.count,
          password: config.password,
          allow_parallel: config.allowParallel,
          workers: config.effectiveWorkers,
          next_delay_seconds: config.nextDelaySeconds
        }
      }) + "\n"
    );

    return snapshot();
  }

  async function stop() {
    if (!state.running && !state.stopping) {
      return snapshot();
    }
    if (!child) {
      state.running = false;
      state.stopping = false;
      return snapshot();
    }
    if (state.stopping) return snapshot();

    state.stopping = true;
    pushLog("Stopping Temp Mail runner...", "warning", "controller");
    try {
      child.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
    } catch {
      // ignore broken pipe
    }

    stopTimer = setTimeout(() => {
      if (!child) return;
      pushLog("Temp Mail runner did not stop in time; terminating process...", "warning", "controller");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, STOP_GRACE_MS);
    stopTimer.unref?.();

    killTimer = setTimeout(() => {
      if (!child) return;
      pushLog("Temp Mail runner still alive; forcing kill.", "error", "controller");
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, STOP_KILL_MS);
    killTimer.unref?.();

    return snapshot();
  }

  async function shutdown() {
    await stop();
  }

  return {
    refreshRunner,
    getState: snapshot,
    pushLog,
    start,
    stop,
    shutdown
  };
}
