import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 120;
const DEFAULT_PERSIST_DEBOUNCE_MS = 50;
const RECENT_REQUESTS_STORAGE_VERSION = 3;
const REQUEST_PACKET_FIELDS = ["requestPacket", "upstreamRequestPacket", "responsePacket"];

function clampMaxEntries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.floor(parsed));
}

function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return { ...row };
}

function summarizeRow(row) {
  const normalized = normalizeRow(row);
  if (!normalized) return null;
  for (const field of REQUEST_PACKET_FIELDS) {
    delete normalized[field];
  }
  return normalized;
}

function normalizeSummary(summary) {
  const normalized = summarizeRow(summary);
  if (!normalized) return null;
  normalized.id = typeof normalized.id === "string" ? normalized.id.trim() : "";
  return normalized.id ? normalized : null;
}

function sanitizeRowFileSegment(value, fallback = "request") {
  const text = String(value || "").trim();
  const normalized = text.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function getRowsDirectory(filePath) {
  return `${filePath}.rows`;
}

function buildRowFileName(rowOrId) {
  const rowId =
    typeof rowOrId === "string"
      ? rowOrId
      : typeof rowOrId?.id === "string"
        ? rowOrId.id
        : "";
  const idSegment = sanitizeRowFileSegment(rowId, "request");
  return `${idSegment}.json`;
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

function buildEntriesFromRows(rows, limit) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const normalizedRow = normalizeRow(row);
      if (!normalizedRow) return null;
      if (typeof normalizedRow.id !== "string" || normalizedRow.id.trim().length === 0) {
        normalizedRow.id = `legacy_req_${index + 1}`;
      }
      const summary = summarizeRow(normalizedRow);
      if (!summary?.id) return null;
      return {
        id: summary.id,
        file: buildRowFileName(summary.id),
        summary,
        row: normalizedRow
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

export function normalizeRecentRequestsStore(payload, maxEntries = DEFAULT_MAX_ENTRIES) {
  const limit = clampMaxEntries(maxEntries);
  const sourceRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.recentRequests)
      ? payload.recentRequests
      : [];
  const entries = buildEntriesFromRows(sourceRows, limit);
  return {
    updatedAt: Number(payload?.updatedAt || Date.now()),
    count: entries.length,
    recentRequests: entries.map((entry) => ({ ...entry.summary }))
  };
}

export function createRecentRequestsStore({ filePath, maxEntries = DEFAULT_MAX_ENTRIES }) {
  const limit = clampMaxEntries(maxEntries);
  const rowsDirectory = getRowsDirectory(filePath);
  let entries = [];
  let updatedAt = Date.now();
  let persistChain = Promise.resolve();
  let persistTimer = null;
  let pendingFlushPromise = null;
  let resolvePendingFlush = null;
  let rejectPendingFlush = null;

  function snapshot() {
    return {
      updatedAt,
      count: entries.length,
      recentRequests: entries.map((entry) => ({ ...entry.summary }))
    };
  }

  async function writeState() {
    const persistedEntries = entries.slice(0, limit).filter(Boolean);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.mkdir(rowsDirectory, { recursive: true });

    const keepFileNames = new Set();
    for (const entry of persistedEntries) {
      keepFileNames.add(entry.file);
      if (!entry.row) continue;
      await fs.writeFile(path.join(rowsDirectory, entry.file), JSON.stringify(entry.row, null, 2), "utf8");
    }

    await removeStaleRowFiles(rowsDirectory, keepFileNames);

    const persistedState = {
      storageVersion: RECENT_REQUESTS_STORAGE_VERSION,
      updatedAt,
      count: persistedEntries.length,
      recentRequests: persistedEntries.map((entry) => ({
        id: entry.id,
        file: entry.file,
        summary: { ...entry.summary }
      }))
    };
    await fs.writeFile(filePath, JSON.stringify(persistedState, null, 2), "utf8");

    for (const entry of persistedEntries) {
      if (!entry.row) continue;
      entry.row = null;
    }
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
    let shouldRewrite = false;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);

      if (
        Number(parsed?.storageVersion || 0) === RECENT_REQUESTS_STORAGE_VERSION &&
        Array.isArray(parsed?.recentRequests)
      ) {
        entries = parsed.recentRequests
          .map((entry) => {
            const file = typeof entry?.file === "string" ? entry.file.trim() : "";
            const summary = normalizeSummary(entry?.summary);
            if (!file || !summary?.id) return null;
            return {
              id: summary.id,
              file,
              summary,
              row: null
            };
          })
          .filter(Boolean)
          .slice(0, limit);
        updatedAt = Number(parsed?.updatedAt || Date.now());
      } else if (
        Array.isArray(parsed?.recentRequests) &&
        parsed.recentRequests.every((entry) => typeof entry?.file === "string" && entry.file.trim().length > 0)
      ) {
        const loaded = [];
        for (const entry of parsed.recentRequests) {
          const rowFile = typeof entry?.file === "string" ? entry.file.trim() : "";
          if (!rowFile) continue;
          try {
            const rowRaw = await fs.readFile(path.join(rowsDirectory, rowFile), "utf8");
            const row = JSON.parse(rowRaw);
            const summary = summarizeRow(row);
            if (!summary?.id) continue;
            loaded.push({
              id: summary.id,
              file: rowFile,
              summary,
              row
            });
          } catch {
            continue;
          }
        }
        entries = loaded.slice(0, limit);
        updatedAt = Number(parsed?.updatedAt || Date.now());
        shouldRewrite = true;
      } else {
        entries = buildEntriesFromRows(parsed?.recentRequests || parsed, limit);
        updatedAt = Number(parsed?.updatedAt || Date.now());
        shouldRewrite = entries.length > 0;
      }
    } catch {
      entries = [];
      updatedAt = Date.now();
    }

    if (shouldRewrite) {
      await persistNow();
    }
    return snapshot();
  }

  async function getById(requestId) {
    const targetId = String(requestId || "").trim();
    if (!targetId) return null;
    const entry = entries.find((item) => item.id === targetId);
    if (!entry) return null;
    if (entry.row) return { ...entry.row };
    try {
      const raw = await fs.readFile(path.join(rowsDirectory, entry.file), "utf8");
      const row = normalizeRow(JSON.parse(raw));
      return row ? { ...row } : null;
    } catch {
      return null;
    }
  }

  function replace(rows) {
    entries = buildEntriesFromRows(rows, limit);
    updatedAt = Date.now();
    void queuePersist();
    return snapshot();
  }

  function append(row) {
    const normalizedRow = normalizeRow(row);
    const summary = summarizeRow(normalizedRow);
    if (!normalizedRow || !summary?.id) return snapshot();
    const entry = {
      id: summary.id,
      file: buildRowFileName(summary.id),
      summary,
      row: normalizedRow
    };
    entries = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, limit);
    updatedAt = Date.now();
    void queuePersist();
    return snapshot();
  }

  function clear() {
    entries = [];
    updatedAt = Date.now();
    void persistNow();
    return snapshot();
  }

  return {
    append,
    clear,
    filePath,
    flush,
    getById,
    load,
    replace,
    snapshot
  };
}
