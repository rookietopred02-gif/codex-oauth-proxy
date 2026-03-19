import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_PERSIST_DEBOUNCE_MS = 50;

function clampMaxEntries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.floor(parsed));
}

function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return { ...row };
}

export function normalizeRecentRequestsStore(payload, maxEntries = DEFAULT_MAX_ENTRIES) {
  const limit = clampMaxEntries(maxEntries);
  const sourceRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.recentRequests)
      ? payload.recentRequests
      : [];
  const rows = sourceRows.map(normalizeRow).filter(Boolean).slice(0, limit);
  return {
    updatedAt: Number(payload?.updatedAt || Date.now()),
    count: rows.length,
    recentRequests: rows
  };
}

export function createRecentRequestsStore({ filePath, maxEntries = DEFAULT_MAX_ENTRIES }) {
  const limit = clampMaxEntries(maxEntries);
  let state = normalizeRecentRequestsStore([], limit);
  let persistChain = Promise.resolve();
  let persistTimer = null;
  let pendingFlushPromise = null;
  let resolvePendingFlush = null;
  let rejectPendingFlush = null;

  async function writeState() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  function ensurePendingFlush() {
    if (!pendingFlushPromise) {
      pendingFlushPromise = new Promise((resolve, reject) => {
        resolvePendingFlush = resolve;
        rejectPendingFlush = reject;
      });
    }
    return pendingFlushPromise;
  }

  function settlePendingFlush(err = null) {
    const resolve = resolvePendingFlush;
    const reject = rejectPendingFlush;
    pendingFlushPromise = null;
    resolvePendingFlush = null;
    rejectPendingFlush = null;
    if (err) {
      reject?.(err);
      return;
    }
    resolve?.();
  }

  function persistNow() {
    const pending = ensurePendingFlush();
    persistChain = persistChain.catch(() => {}).then(writeState);
    persistChain.then(() => settlePendingFlush()).catch((err) => settlePendingFlush(err));
    return pending;
  }

  function queuePersist(delayMs = DEFAULT_PERSIST_DEBOUNCE_MS) {
    const pending = ensurePendingFlush();
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, delayMs);
    return pending;
  }

  async function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      await persistNow();
      return;
    }
    if (pendingFlushPromise) {
      await pendingFlushPromise;
      return;
    }
    await persistChain;
  }

  async function load() {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      state = normalizeRecentRequestsStore(JSON.parse(raw), limit);
    } catch {
      state = normalizeRecentRequestsStore([], limit);
    }
    await persistNow();
    return snapshot();
  }

  function snapshot() {
    return {
      updatedAt: state.updatedAt,
      count: state.count,
      recentRequests: state.recentRequests.map((row) => ({ ...row }))
    };
  }

  function replace(rows) {
    state = normalizeRecentRequestsStore({ updatedAt: Date.now(), recentRequests: rows }, limit);
    void queuePersist();
    return snapshot();
  }

  function append(row) {
    const nextRows = [row, ...state.recentRequests].slice(0, limit);
    state = normalizeRecentRequestsStore({ updatedAt: Date.now(), recentRequests: nextRows }, limit);
    void queuePersist();
    return snapshot();
  }

  function clear() {
    state = normalizeRecentRequestsStore([], limit);
    void persistNow();
    return snapshot();
  }

  return {
    append,
    clear,
    filePath,
    flush,
    load,
    replace,
    snapshot
  };
}
