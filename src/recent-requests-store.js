import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_PERSIST_DEBOUNCE_MS = 50;
const RECENT_REQUESTS_STORAGE_VERSION = 2;

function clampMaxEntries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.floor(parsed));
}

function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return { ...row };
}

function sanitizeRowFileSegment(value, fallback = "request") {
  const text = String(value || "").trim();
  const normalized = text.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function getRowsDirectory(filePath) {
  return `${filePath}.rows`;
}

function buildRowFileName(index, row) {
  const idSegment = sanitizeRowFileSegment(row?.id, `row_${index + 1}`);
  return `${String(index + 1).padStart(4, "0")}_${idSegment}.json`;
}

async function removeStaleRowFiles(rowsDirectory, keepFileNames) {
  let existingFiles = [];
  try {
    existingFiles = await fs.readdir(rowsDirectory);
  } catch {
    return;
  }
  await Promise.all(
    existingFiles
      .filter((fileName) => !keepFileNames.has(fileName))
      .map((fileName) => fs.rm(path.join(rowsDirectory, fileName), { force: true }).catch(() => {}))
  );
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
  const rowsDirectory = getRowsDirectory(filePath);
  let state = normalizeRecentRequestsStore([], limit);
  let persistChain = Promise.resolve();
  let persistTimer = null;
  let pendingFlushPromise = null;
  let resolvePendingFlush = null;
  let rejectPendingFlush = null;

  async function writeState() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.mkdir(rowsDirectory, { recursive: true });

    const keepFileNames = new Set();
    const persistedRows = [];

    for (const [index, row] of state.recentRequests.entries()) {
      const rowFile = buildRowFileName(index, row);
      keepFileNames.add(rowFile);
      await fs.writeFile(path.join(rowsDirectory, rowFile), JSON.stringify(row, null, 2), "utf8");
      persistedRows.push({
        file: rowFile
      });
    }

    await removeStaleRowFiles(rowsDirectory, keepFileNames);

    const persistedState = {
      storageVersion: RECENT_REQUESTS_STORAGE_VERSION,
      updatedAt: state.updatedAt,
      count: state.count,
      recentRequests: persistedRows
    };
    await fs.writeFile(filePath, JSON.stringify(persistedState, null, 2), "utf8");
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
      const parsed = JSON.parse(raw);
      if (
        Number(parsed?.storageVersion || 0) === RECENT_REQUESTS_STORAGE_VERSION &&
        Array.isArray(parsed?.recentRequests)
      ) {
        const loadedRows = [];
        for (const entry of parsed.recentRequests) {
          const rowFile = typeof entry?.file === "string" ? entry.file.trim() : "";
          if (!rowFile) continue;
          try {
            const rowRaw = await fs.readFile(path.join(rowsDirectory, rowFile), "utf8");
            loadedRows.push(JSON.parse(rowRaw));
          } catch {
            continue;
          }
        }
        state = normalizeRecentRequestsStore(
          {
            updatedAt: parsed?.updatedAt,
            recentRequests: loadedRows
          },
          limit
        );
      } else {
        state = normalizeRecentRequestsStore(parsed, limit);
      }
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
