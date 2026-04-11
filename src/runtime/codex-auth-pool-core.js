import crypto from "node:crypto";

export function createCodexAuthPoolCoreHelpers(options = {}) {
  const normalizeToken = options.normalizeToken;
  const extractAccountId =
    options.extractAccountId || options.extractOpenAICodexAccountId || (() => "");
  const extractPrincipalId =
    options.extractPrincipalId || options.extractOpenAICodexPrincipalId || (() => "");
  const extractPlanType =
    options.extractPlanType || options.extractOpenAICodexPlanType || (() => "");
  const extractEmail = options.extractEmail || options.extractOpenAICodexEmail || (() => "");
  const normalizePlanType =
    options.normalizePlanType || options.normalizeOpenAICodexPlanType || ((value) => value);
  const parseSlotValue = options.parseSlotValue || (() => null);
  const getStrategy = options.getStrategy || (() => "");
  const isAccountLeased = options.isAccountLeased || (() => false);

  function deriveCodexAccountIdFromToken(tokenLike) {
    const accessToken = tokenLike?.access_token || tokenLike?.access || "";
    const accountId = extractAccountId(accessToken);
    if (accountId) return accountId;
    const fingerprintSource = `${accessToken.slice(0, 48)}|${tokenLike?.refresh_token || tokenLike?.refresh || ""}`;
    return `acct_${crypto.createHash("sha1").update(fingerprintSource).digest("hex").slice(0, 12)}`;
  }

  function buildCodexPoolEntryId(principalId, accountId, planType = null) {
    const normalizedPlanType = normalizePlanType(planType);
    if (principalId) {
      return normalizedPlanType ? `${principalId}::plan:${normalizedPlanType}` : principalId;
    }
    if (accountId) {
      return normalizedPlanType ? `acct:${accountId}::plan:${normalizedPlanType}` : `acct:${accountId}`;
    }
    return "";
  }

  function deriveCodexPoolEntryIdFromToken(tokenLike, extra = {}) {
    const accessToken = tokenLike?.access_token || tokenLike?.access || "";
    const principalId = extractPrincipalId(accessToken);
    const accountId = extractAccountId(accessToken);
    const planType =
      normalizePlanType(extra.planType) ||
      extractPlanType(accessToken) ||
      normalizePlanType(tokenLike?.usage_snapshot?.plan_type) ||
      normalizePlanType(tokenLike?.plan_type);
    const structuredId = buildCodexPoolEntryId(principalId, accountId, planType);
    if (structuredId) return structuredId;
    const fingerprintSource = `${accessToken.slice(0, 48)}|${tokenLike?.refresh_token || tokenLike?.refresh || ""}`;
    const fallbackId = `entry_${crypto.createHash("sha1").update(fingerprintSource).digest("hex").slice(0, 16)}`;
    return planType ? `${fallbackId}::plan:${planType}` : fallbackId;
  }

  function getCodexPoolEntryId(accountEntry) {
    if (!accountEntry || typeof accountEntry !== "object") return "";
    const raw = accountEntry.identity_id || accountEntry.entry_id || accountEntry.account_id || "";
    return String(raw).trim();
  }

  function createDefaultCodexAccountPoolStore() {
    return {
      token: null,
      accounts: [],
      rotation: {
        next_index: 0
      },
      active_account_id: null
    };
  }

  function sanitizeCodexAccountEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const token = raw.token && typeof raw.token === "object" ? raw.token : null;
    if (!token?.access_token) return null;

    const normalizedToken = normalizeToken(token, token);
    const tokenAccountId = extractAccountId(normalizedToken.access_token || "");
    const persistedPlanType =
      normalizePlanType(raw?.usage_snapshot?.plan_type) ||
      normalizePlanType(raw?.plan_type);
    const tokenEntryId = deriveCodexPoolEntryIdFromToken(normalizedToken, { planType: persistedPlanType });
    const fallbackAccountId = String(raw.account_id || raw.accountId || "").trim();
    const fallbackEntryId = String(raw.identity_id || raw.entry_id || raw.account_id || "").trim();
    const accountId = tokenAccountId || fallbackAccountId;
    const entryId = tokenEntryId || fallbackEntryId;
    if (!accountId || !entryId) return null;
    return {
      identity_id: entryId,
      account_id: accountId,
      label: typeof raw.label === "string" ? raw.label : "",
      slot: parseSlotValue(raw.slot),
      enabled: raw.enabled !== false,
      token: normalizedToken,
      created_at: Number(raw.created_at || raw.createdAt || Math.floor(Date.now() / 1000)),
      last_used_at: Number(raw.last_used_at || raw.lastUsedAt || 0),
      failure_count: Number(raw.failure_count || raw.failureCount || 0),
      cooldown_until: Number(raw.cooldown_until || raw.cooldownUntil || 0),
      last_error: typeof raw.last_error === "string" ? raw.last_error : "",
      last_status_code: Number(raw.last_status_code || raw.lastStatusCode || 0),
      token_invalidated_at: Number(raw.token_invalidated_at || raw.tokenInvalidatedAt || 0),
      usage_snapshot:
        raw.usage_snapshot && typeof raw.usage_snapshot === "object" ? raw.usage_snapshot : null,
      usage_updated_at: Number(raw.usage_updated_at || raw.usageUpdatedAt || 0)
    };
  }

  function normalizeCodexAccountSlots(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return false;

    let changed = false;
    const used = new Set();
    const needsAssignment = [];

    for (const account of accounts) {
      const slot = parseSlotValue(account?.slot);
      if (slot && !used.has(slot)) {
        if (Number(account.slot || 0) !== slot) {
          account.slot = slot;
          changed = true;
        }
        used.add(slot);
        continue;
      }

      if (account.slot !== null) {
        account.slot = null;
        changed = true;
      }
      needsAssignment.push(account);
    }

    let cursor = 1;
    for (const account of needsAssignment) {
      while (cursor <= 64 && used.has(cursor)) cursor += 1;
      if (cursor > 64) break;
      account.slot = cursor;
      used.add(cursor);
      changed = true;
      cursor += 1;
    }

    return changed;
  }

  function ensureCodexOAuthStoreShape(store) {
    const src = store && typeof store === "object" ? store : {};
    const strategy = String(getStrategy?.() || "").trim().toLowerCase();
    const isManualStrategy = strategy === "manual";
    const preserveManualActiveSelection =
      isManualStrategy &&
      typeof src?.active_account_id === "string" &&
      src.active_account_id.trim().length > 0;
    const out = {
      ...createDefaultCodexAccountPoolStore(),
      ...src,
      rotation: {
        next_index: Number(src?.rotation?.next_index || src?.rotation?.nextIndex || 0)
      }
    };

    const originalAccounts = Array.isArray(src.accounts) ? src.accounts : [];
    out.accounts = originalAccounts.map(sanitizeCodexAccountEntry).filter(Boolean);

    let changed = !Array.isArray(src.accounts) || out.accounts.length !== originalAccounts.length;
    let tokenBackedEntryId = "";
    let tokenBackedAccountEnabled = false;

    if (src.token?.access_token) {
      const tokenNormalized = normalizeToken(src.token, src.token);
      const accountId = deriveCodexAccountIdFromToken(tokenNormalized);
      const activePlanType = normalizePlanType(src?.usage_snapshot?.plan_type);
      const entryId = deriveCodexPoolEntryIdFromToken(tokenNormalized, { planType: activePlanType });
      tokenBackedEntryId = entryId;
      const idx = out.accounts.findIndex((account) => getCodexPoolEntryId(account) === entryId);
      if (idx >= 0) {
        out.accounts[idx].identity_id = entryId;
        out.accounts[idx].account_id = accountId;
        out.accounts[idx].token = tokenNormalized;
        tokenBackedAccountEnabled = out.accounts[idx].enabled !== false;
      } else {
        out.accounts.push({
          identity_id: entryId,
          account_id: accountId,
          label: "",
          slot: null,
          enabled: true,
          token: tokenNormalized,
          created_at: Math.floor(Date.now() / 1000),
          last_used_at: 0,
          failure_count: 0,
          cooldown_until: 0,
          last_error: "",
          last_status_code: 0,
          token_invalidated_at: 0,
          usage_snapshot: null,
          usage_updated_at: 0
        });
        tokenBackedAccountEnabled = true;
      }
      if (
        tokenBackedAccountEnabled &&
        out.active_account_id !== entryId &&
        !preserveManualActiveSelection &&
        !isManualStrategy
      ) {
        out.active_account_id = entryId;
        changed = true;
      }
    }

    const firstEnabledAccount = out.accounts.find((account) => account && account.enabled !== false) || null;

    if (out.accounts.length > 0 && !out.active_account_id && firstEnabledAccount && !isManualStrategy) {
      out.active_account_id = getCodexPoolEntryId(firstEnabledAccount);
      changed = true;
    }
    if (out.active_account_id && out.accounts.length > 0) {
      const activeRef = String(out.active_account_id);
      const hasDirect = out.accounts.some((account) => getCodexPoolEntryId(account) === activeRef);
      if (!hasDirect) {
        const byLegacyPlanless = out.accounts.find((account) =>
          getCodexPoolEntryId(account).startsWith(`${activeRef}::plan:`)
        );
        if (byLegacyPlanless) {
          out.active_account_id = getCodexPoolEntryId(byLegacyPlanless);
          changed = true;
        } else {
          const byLegacyAccountId = out.accounts.find((account) => String(account.account_id || "") === activeRef);
          if (byLegacyAccountId) {
            out.active_account_id = getCodexPoolEntryId(byLegacyAccountId);
            changed = true;
          }
        }
      }

      const activeAccount = out.accounts.find((account) => getCodexPoolEntryId(account) === String(out.active_account_id || ""));
      if ((!activeAccount || activeAccount.enabled === false) && !preserveManualActiveSelection && !isManualStrategy) {
        const fallbackActiveId = firstEnabledAccount ? getCodexPoolEntryId(firstEnabledAccount) : null;
        if (out.active_account_id !== fallbackActiveId) {
          out.active_account_id = fallbackActiveId;
          changed = true;
        }
      }
    }

    if (out.accounts.length === 0) {
      out.rotation.next_index = 0;
      out.active_account_id = null;
    } else if (!Number.isFinite(out.rotation.next_index) || out.rotation.next_index < 0) {
      out.rotation.next_index = 0;
      changed = true;
    } else {
      out.rotation.next_index = out.rotation.next_index % out.accounts.length;
    }

    const preferredTokenAccount =
      out.accounts.find((account) => getCodexPoolEntryId(account) === String(out.active_account_id || "")) ||
      (isManualStrategy ? null : firstEnabledAccount);
    const preferredToken = preferredTokenAccount?.enabled === false ? null : preferredTokenAccount?.token || null;
    const currentTokenEntryId = deriveCodexPoolEntryIdFromToken(out.token || null);
    if (preferredToken) {
      const preferredTokenEntryId = getCodexPoolEntryId(preferredTokenAccount);
      if (!out.token || currentTokenEntryId !== preferredTokenEntryId) {
        out.token = preferredToken;
        changed = true;
      }
    } else if (out.token) {
      out.token = null;
      changed = true;
    }

    if (tokenBackedEntryId && !tokenBackedAccountEnabled && currentTokenEntryId === tokenBackedEntryId) {
      out.token = preferredToken;
      changed = true;
    }

    if (normalizeCodexAccountSlots(out.accounts)) {
      changed = true;
    }

    return { store: out, changed };
  }

  function upsertCodexOAuthAccount(store, normalizedToken, extra = {}) {
    const accountId = deriveCodexAccountIdFromToken(normalizedToken);
    const planType =
      normalizePlanType(extra.planType) || extractPlanType(normalizedToken?.access_token || "");
    const entryId = deriveCodexPoolEntryIdFromToken(normalizedToken, { planType });
    const tokenEmail = extractEmail(normalizedToken?.access_token || "");
    const label = typeof extra.label === "string" ? extra.label.trim() : "";
    const slot = parseSlotValue(extra.slot);
    const forceReplaceSlot =
      extra.force === true || extra.force === 1 || String(extra.force || "").trim() === "1";
    const nowSec = Math.floor(Date.now() / 1000);
    const usageSnapshot = extra.usageSnapshot && typeof extra.usageSnapshot === "object" ? extra.usageSnapshot : null;
    if (!Array.isArray(store.accounts)) store.accounts = [];

    const existingIdx = store.accounts.findIndex((account) => getCodexPoolEntryId(account) === entryId);
    const slotIdx = slot ? store.accounts.findIndex((account) => Number(account.slot || 0) === slot) : -1;

    let targetIdx = existingIdx;
    if (targetIdx < 0 && slotIdx >= 0 && forceReplaceSlot) {
      targetIdx = slotIdx;
    }

    let action = "created";
    let resolvedIncomingSlot = slot;
    if (existingIdx < 0 && slotIdx >= 0 && !forceReplaceSlot) {
      resolvedIncomingSlot = null;
      action = "created_reassigned_slot";
    }
    if (targetIdx >= 0) {
      const isSameAccountUpdate = existingIdx >= 0;
      if (isSameAccountUpdate) {
        const currentSlot = Number(store.accounts[targetIdx].slot || 0) || null;
        const requestedDifferentSlot =
          resolvedIncomingSlot !== null && currentSlot !== null && resolvedIncomingSlot !== currentSlot;
        action =
          requestedDifferentSlot && !forceReplaceSlot
            ? "already_exists_same_account"
            : "updated_existing_account";
      } else {
        action = "replaced_slot";
      }

      const currentLabel =
        typeof store.accounts[targetIdx].label === "string" && store.accounts[targetIdx].label.trim().length > 0
          ? store.accounts[targetIdx].label.trim()
          : "";
      const currentSlot = Number(store.accounts[targetIdx].slot || 0) || null;
      const keepSlotBecauseSameAccount =
        isSameAccountUpdate &&
        resolvedIncomingSlot !== null &&
        currentSlot !== null &&
        resolvedIncomingSlot !== currentSlot &&
        !forceReplaceSlot;
      const resolvedLabel = isSameAccountUpdate
        ? currentLabel || tokenEmail || accountId
        : label || currentLabel || tokenEmail || accountId;
      store.accounts[targetIdx] = {
        ...store.accounts[targetIdx],
        identity_id: entryId,
        account_id: accountId,
        token: normalizeToken(normalizedToken, store.accounts[targetIdx].token),
        enabled: true,
        label: resolvedLabel,
        slot: keepSlotBecauseSameAccount
          ? currentSlot
          : resolvedIncomingSlot ?? store.accounts[targetIdx].slot ?? null,
        last_error: "",
        last_status_code: 0,
        token_invalidated_at: 0,
        cooldown_until: 0,
        usage_snapshot: usageSnapshot || store.accounts[targetIdx].usage_snapshot || null,
        usage_updated_at: usageSnapshot
          ? Number(usageSnapshot.fetched_at || nowSec) || nowSec
          : Number(store.accounts[targetIdx].usage_updated_at || 0)
      };
    } else {
      store.accounts.push({
        identity_id: entryId,
        account_id: accountId,
        label: label || tokenEmail || accountId,
        slot: resolvedIncomingSlot ?? null,
        enabled: true,
        token: normalizeToken(normalizedToken, normalizedToken),
        created_at: nowSec,
        last_used_at: 0,
        failure_count: 0,
        cooldown_until: 0,
        last_error: "",
        last_status_code: 0,
        token_invalidated_at: 0,
        usage_snapshot: usageSnapshot,
        usage_updated_at: usageSnapshot ? Number(usageSnapshot.fetched_at || nowSec) || nowSec : 0
      });
    }

    store.active_account_id = entryId;
    store.token = normalizedToken;
    store.rotation = store.rotation || { next_index: 0 };
    if (!Number.isFinite(store.rotation.next_index)) store.rotation.next_index = 0;

    if (extra.skipSlotNormalization !== true) {
      normalizeCodexAccountSlots(store.accounts);
    }

    const resolvedAccount = store.accounts.find((account) => getCodexPoolEntryId(account) === entryId);
    const resolvedSlot = Number(resolvedAccount?.slot || 0) || null;

    return { accountId, entryId, slot: resolvedSlot, action, email: tokenEmail || null, planType, account: resolvedAccount || null };
  }

  function findCodexPoolAccountByRef(accounts, ref) {
    const needle = String(ref || "").trim();
    if (!needle) return null;
    const pool = Array.isArray(accounts) ? accounts : [];
    return pool.find((account) => getCodexPoolEntryId(account) === needle) ||
      pool.find((account) => String(account?.account_id || "") === needle) ||
      null;
  }

  function selectCodexAccountForLogout(store, explicitRef = "") {
    const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
    if (accounts.length === 0) return null;
    const explicit = String(explicitRef || "").trim();
    if (explicit) {
      const byExplicit = findCodexPoolAccountByRef(accounts, explicit);
      if (byExplicit) return byExplicit;
    }
    const activeRef = String(store?.active_account_id || "").trim();
    if (activeRef) {
      const byActive = findCodexPoolAccountByRef(accounts, activeRef);
      if (byActive) return byActive;
    }
    return accounts[0] || null;
  }

  function removeCodexPoolAccountFromStore(storeInput, accountRef = "", options = {}) {
    const normalized = ensureCodexOAuthStoreShape(storeInput);
    const store = normalized.store;
    const target = selectCodexAccountForLogout(store, accountRef);
    if (!target) {
      return {
        removed: false,
        blocked: null,
        removedEntryId: null,
        removedAccountId: null,
        remainingAccounts: Array.isArray(store.accounts) ? store.accounts.length : 0,
        activeEntryId: String(store.active_account_id || "").trim() || null,
        store
      };
    }

    const targetEntryId = getCodexPoolEntryId(target);
    const targetAccountId = String(target.account_id || "").trim() || null;
    const leaseChecker =
      typeof options.isAccountLeased === "function" ? options.isAccountLeased : isAccountLeased;
    const leased = options.ignoreLease === true ? false : Boolean(leaseChecker?.(targetEntryId, target));
    if (leased) {
      return {
        removed: false,
        blocked: "leased",
        blockedEntryId: targetEntryId || null,
        blockedAccountId: targetAccountId,
        removedEntryId: null,
        removedAccountId: null,
        remainingAccounts: Array.isArray(store.accounts) ? store.accounts.length : 0,
        activeEntryId: String(store.active_account_id || "").trim() || null,
        store
      };
    }

    const nextAccounts = (store.accounts || []).filter((account) => getCodexPoolEntryId(account) !== targetEntryId);
    store.accounts = nextAccounts;

    const currentTokenEntryId = deriveCodexPoolEntryIdFromToken(store.token || null);
    if (currentTokenEntryId === targetEntryId) {
      store.token = null;
    }

    if (store.active_account_id === targetEntryId) {
      store.active_account_id = null;
    }

    if (nextAccounts.length > 0) {
      let nextActive = null;
      const currentActiveRef = String(store.active_account_id || "").trim();
      if (currentActiveRef) {
        nextActive = findCodexPoolAccountByRef(nextAccounts, currentActiveRef);
      }
      if (!nextActive) {
        nextActive = nextAccounts.find((account) => account && account.enabled !== false) || nextAccounts[0] || null;
      }
      const nextActiveEntryId = nextActive ? getCodexPoolEntryId(nextActive) : null;
      store.active_account_id = nextActiveEntryId || null;
      store.token = nextActive?.token || null;
      store.rotation = store.rotation || { next_index: 0 };
      if (!Number.isFinite(store.rotation.next_index)) store.rotation.next_index = 0;
      if (nextAccounts.length > 0) {
        store.rotation.next_index = store.rotation.next_index % nextAccounts.length;
      }
    } else {
      store.active_account_id = null;
      store.token = null;
      store.rotation = { next_index: 0 };
    }

    return {
      removed: true,
      removedEntryId: targetEntryId,
      removedAccountId: targetAccountId,
      remainingAccounts: store.accounts.length,
      activeEntryId: String(store.active_account_id || "").trim() || null,
      store
    };
  }

  return {
    deriveCodexAccountIdFromToken,
    buildCodexPoolEntryId,
    deriveCodexPoolEntryIdFromToken,
    getCodexPoolEntryId,
    createDefaultCodexAccountPoolStore,
    sanitizeCodexAccountEntry,
    normalizeCodexAccountSlots,
    ensureCodexOAuthStoreShape,
    upsertCodexOAuthAccount,
    findCodexPoolAccountByRef,
    selectCodexAccountForLogout,
    removeCodexPoolAccountFromStore
  };
}
