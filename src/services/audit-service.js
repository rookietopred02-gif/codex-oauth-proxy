import { createRecentRequestsStore } from "../recent-requests-store.js";

export async function createAuditService({
  historyPath,
  maxEntries,
  getCodexOAuthStore,
  ensureCodexOAuthStoreShape,
  findCodexPoolAccountByRef
}) {
  const runtimeStats = {
    startedAt: Date.now(),
    totalRequests: 0,
    okRequests: 0,
    errorRequests: 0,
    recentRequests: []
  };

  let runtimeRequestSeq = 0;
  const recentRequestsStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries
  });
  runtimeStats.recentRequests = (await recentRequestsStore.load()).recentRequests;

  function nextRuntimeRequestSeq() {
    runtimeRequestSeq += 1;
    return runtimeRequestSeq;
  }

  function resolveAuditAccountLabel(accountRef = "") {
    const needle = String(accountRef || "").trim();
    if (!needle) return "";
    const store = ensureCodexOAuthStoreShape(getCodexOAuthStore()).store;
    const target = findCodexPoolAccountByRef(store.accounts || [], needle);
    if (!target) return needle;
    const label = String(target.label || "").trim();
    return label || target.account_id || needle;
  }

  return {
    recentRequestsStore,
    resolveAuditAccountLabel,
    runtimeStats,
    nextRuntimeRequestSeq
  };
}
