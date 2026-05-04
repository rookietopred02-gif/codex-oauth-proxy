function defaultGetAccountEntryId(account) {
  return String(account?.identity_id || account?.entry_id || account?.entryId || account?.account_id || "").trim();
}

function defaultFindAccountByRef(accounts, ref) {
  const needle = String(ref || "").trim();
  if (!needle) return null;
  const pool = Array.isArray(accounts) ? accounts : [];
  const byEntryId = pool.find((account) => defaultGetAccountEntryId(account) === needle);
  if (byEntryId) return byEntryId;
  const byAccountId = pool.filter((account) => String(account?.account_id || account?.accountId || "").trim() === needle);
  return byAccountId.length === 1 ? byAccountId[0] : null;
}

export function resetCodexAccountHealth(account, options = {}) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return false;
  if (options.enable !== false) {
    account.enabled = true;
  }
  account.failure_count = 0;
  account.cooldown_until = 0;
  account.last_error = "";
  account.last_status_code = 0;
  account.token_invalidated_at = 0;
  return true;
}

export function captureActiveCodexAccountPointer(store, options = {}) {
  const activeRef = String(store?.active_account_id || "").trim();
  const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
  const findAccountByRef =
    typeof options.findAccountByRef === "function" ? options.findAccountByRef : defaultFindAccountByRef;
  return {
    activeRef,
    account: activeRef ? findAccountByRef(accounts, activeRef) : null,
    accessToken: String(store?.token?.access_token || "")
  };
}

export function restoreActiveCodexAccountPointer(store, snapshot, options = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return false;
  const activeRef = String(snapshot?.activeRef || "").trim();
  if (!activeRef) return false;

  const accounts = Array.isArray(store.accounts) ? store.accounts : [];
  const getEntryId = typeof options.getEntryId === "function" ? options.getEntryId : defaultGetAccountEntryId;
  const findAccountByRef =
    typeof options.findAccountByRef === "function" ? options.findAccountByRef : defaultFindAccountByRef;
  const capturedAccount = snapshot?.account && accounts.includes(snapshot.account) ? snapshot.account : null;
  const activeAccount = capturedAccount || findAccountByRef(accounts, activeRef);
  if (!activeAccount?.token?.access_token) return false;

  const nextActiveRef = String(getEntryId(activeAccount) || activeRef).trim();
  if (!nextActiveRef) return false;
  store.active_account_id = nextActiveRef;
  store.token = activeAccount.token;
  return true;
}
