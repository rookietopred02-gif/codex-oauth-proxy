function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeExpiredAccountCleanupConfig(input = {}) {
  return {
    enabled: input.enabled === true,
    intervalSeconds: clampInteger(input.intervalSeconds, 30, 10, 3600)
  };
}

function resolveAccountRef(account) {
  const entryId = String(account?.entry_id || account?.entryId || "").trim();
  if (entryId) return entryId;
  const accountId = String(account?.account_id || account?.accountId || "").trim();
  return accountId || "";
}

export function shouldAutoLogoutExpiredAccount(account, nowSec = Math.floor(Date.now() / 1000)) {
  const expiresAt = Number(account?.token?.expires_at || account?.token?.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > nowSec) return false;
  const refreshToken = String(account?.token?.refresh_token || account?.token?.refreshToken || "").trim();
  return refreshToken.length === 0;
}

export function findExpiredAccountCleanupCandidates(accounts, nowSec = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list
    .filter((account) => shouldAutoLogoutExpiredAccount(account, nowSec))
    .map((account) => ({
      ref: resolveAccountRef(account),
      entryId: String(account?.entry_id || account?.entryId || "").trim() || null,
      accountId: String(account?.account_id || account?.accountId || "").trim() || null,
      expiresAt: Number(account?.token?.expires_at || account?.token?.expiresAt || 0) || 0
    }))
    .filter((candidate) => candidate.ref);
}

export function createExpiredAccountCleanupController(options = {}) {
  const getStore = typeof options.getStore === "function" ? options.getStore : () => ({ accounts: [] });
  const getAccounts = typeof options.getAccounts === "function" ? options.getAccounts : (store) => store?.accounts || [];
  const removeAccount =
    typeof options.removeAccount === "function"
      ? options.removeAccount
      : (store) => ({ removed: false, store });
  const saveStore = typeof options.saveStore === "function" ? options.saveStore : async () => {};
  const onRemoved = typeof options.onRemoved === "function" ? options.onRemoved : async () => {};
  const isSupported = typeof options.isSupported === "function" ? options.isSupported : () => true;
  const initialConfig = normalizeExpiredAccountCleanupConfig(options.initialConfig || {});

  const state = {
    enabled: initialConfig.enabled,
    intervalSeconds: initialConfig.intervalSeconds,
    running: false,
    lastRunAt: 0,
    lastCompletedAt: 0,
    lastReason: "",
    lastStatus: initialConfig.enabled ? "idle" : "disabled",
    lastError: "",
    lastRemovedCount: 0,
    lastRemovedRefs: []
  };

  function getState() {
    return {
      enabled: state.enabled,
      intervalSeconds: state.intervalSeconds,
      running: state.running,
      lastRunAt: state.lastRunAt,
      lastCompletedAt: state.lastCompletedAt,
      lastReason: state.lastReason,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      lastRemovedCount: state.lastRemovedCount,
      lastRemovedRefs: [...state.lastRemovedRefs]
    };
  }

  function configure(input = {}) {
    const normalized = normalizeExpiredAccountCleanupConfig({
      enabled: input.enabled ?? state.enabled,
      intervalSeconds: input.intervalSeconds ?? state.intervalSeconds
    });
    state.enabled = normalized.enabled;
    state.intervalSeconds = normalized.intervalSeconds;
    if (!state.running && !state.enabled) {
      state.lastStatus = "disabled";
      state.lastError = "";
    } else if (!state.running && state.lastStatus === "disabled" && state.enabled) {
      state.lastStatus = "idle";
    }
    return getState();
  }

  async function run(reason = "manual") {
    if (state.running) {
      return {
        ok: true,
        busy: true,
        status: state.lastStatus,
        removedCount: state.lastRemovedCount,
        removedRefs: [...state.lastRemovedRefs]
      };
    }

    const startedAt = Math.floor(Date.now() / 1000);
    state.running = true;
    state.lastRunAt = startedAt;
    state.lastReason = String(reason || "manual");
    state.lastStatus = "running";
    state.lastError = "";

    try {
      if (!isSupported()) {
        state.lastStatus = "unsupported";
        state.lastRemovedCount = 0;
        state.lastRemovedRefs = [];
        return {
          ok: true,
          status: "unsupported",
          removedCount: 0,
          candidates: 0,
          removedRefs: []
        };
      }

      if (!state.enabled) {
        state.lastStatus = "disabled";
        state.lastRemovedCount = 0;
        state.lastRemovedRefs = [];
        return {
          ok: true,
          status: "disabled",
          removedCount: 0,
          candidates: 0,
          removedRefs: []
        };
      }

      const store = await getStore();
      const candidates = findExpiredAccountCleanupCandidates(getAccounts(store), startedAt);
      let nextStore = store;
      const removedRefs = [];

      for (const candidate of candidates) {
        const result = await removeAccount(nextStore, candidate.ref);
        if (!result?.removed) continue;
        nextStore = result.store ?? nextStore;
        removedRefs.push(candidate.ref);
      }

      if (removedRefs.length > 0) {
        await saveStore(nextStore, removedRefs);
        await onRemoved({
          reason: state.lastReason,
          removedRefs: [...removedRefs],
          store: nextStore
        });
      }

      state.lastStatus = removedRefs.length > 0 ? "ok" : "idle";
      state.lastRemovedCount = removedRefs.length;
      state.lastRemovedRefs = [...removedRefs];

      return {
        ok: true,
        status: state.lastStatus,
        removedCount: removedRefs.length,
        candidates: candidates.length,
        removedRefs: [...removedRefs]
      };
    } catch (err) {
      state.lastStatus = "failed";
      state.lastError = String(err?.message || err || "expired_account_cleanup_failed");
      state.lastRemovedCount = 0;
      state.lastRemovedRefs = [];
      throw err;
    } finally {
      state.running = false;
      state.lastCompletedAt = Math.floor(Date.now() / 1000);
    }
  }

  return {
    configure,
    getState,
    run
  };
}
