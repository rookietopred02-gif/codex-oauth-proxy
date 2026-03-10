function flattenTokenCandidates(items) {
  const out = [];
  for (const rawItem of Array.isArray(items) ? items : []) {
    if (rawItem && typeof rawItem === "object" && Array.isArray(rawItem.tokens)) {
      for (const nested of rawItem.tokens) out.push(nested);
      continue;
    }
    if (rawItem && typeof rawItem === "object" && rawItem.payload && typeof rawItem.payload === "object") {
      out.push(rawItem.payload);
      continue;
    }
    out.push(rawItem);
  }
  return out;
}

export async function importCodexOAuthTokens({
  store,
  items,
  replace = false,
  probeUsage = true,
  ensureStoreShape,
  normalizeToken,
  upsertAccount,
  findAccountByRef,
  refreshUsageSnapshot,
  normalizePlanType,
  parseSlotValue
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("tokens[] is required.");
  }

  if (typeof ensureStoreShape !== "function") throw new Error("ensureStoreShape is required.");
  if (typeof normalizeToken !== "function") throw new Error("normalizeToken is required.");
  if (typeof upsertAccount !== "function") throw new Error("upsertAccount is required.");
  if (typeof findAccountByRef !== "function") throw new Error("findAccountByRef is required.");
  if (typeof refreshUsageSnapshot !== "function") throw new Error("refreshUsageSnapshot is required.");
  if (typeof normalizePlanType !== "function") throw new Error("normalizePlanType is required.");
  if (typeof parseSlotValue !== "function") throw new Error("parseSlotValue is required.");

  const normalized = ensureStoreShape(store);
  const nextStore = normalized?.store || { token: null, accounts: [] };

  if (replace) {
    nextStore.accounts = [];
    nextStore.active_account_id = null;
    nextStore.rotation = { next_index: 0 };
    nextStore.token = null;
  }

  let imported = 0;
  const importedRefs = [];
  for (const raw of flattenTokenCandidates(items)) {
    if (!raw || typeof raw !== "object") continue;

    const accessToken = String(raw.access_token || raw.accessToken || "").trim();
    if (!accessToken) continue;

    const rawUsageSnapshot =
      raw.usage_snapshot && typeof raw.usage_snapshot === "object"
        ? raw.usage_snapshot
        : raw.usageSnapshot && typeof raw.usageSnapshot === "object"
          ? raw.usageSnapshot
          : null;

    const upsert = upsertAccount(
      nextStore,
      normalizeToken(
        {
          access_token: accessToken,
          refresh_token: raw.refresh_token || raw.refreshToken || null,
          token_type: raw.token_type || raw.tokenType || "Bearer",
          scope: raw.scope || null,
          expires_at: raw.expires_at || raw.expiresAt || null,
          expires_in: raw.expires_in || raw.expiresIn || null
        },
        raw
      ),
      {
        label:
          (typeof raw.label === "string" && raw.label.trim()) ||
          (typeof raw.email === "string" && raw.email.trim()) ||
          (typeof raw.name === "string" && raw.name.trim()) ||
          "",
        slot: parseSlotValue(raw.slot),
        force: raw.force === true,
        planType:
          normalizePlanType(raw.plan_type) ||
          normalizePlanType(raw.planType) ||
          normalizePlanType(rawUsageSnapshot?.plan_type),
        usageSnapshot: rawUsageSnapshot
      }
    );

    if (raw.enabled === false) {
      const importedAccount = findAccountByRef(nextStore.accounts, upsert.entryId);
      if (importedAccount) importedAccount.enabled = false;
    }

    if (upsert.entryId) importedRefs.push(String(upsert.entryId));
    imported += 1;
  }

  if (imported === 0) {
    throw new Error("No valid token entries in tokens[].");
  }

  let usageProbed = 0;
  let usageProbeFailed = 0;
  const usageProbeErrors = [];
  if (probeUsage) {
    const uniqueRefs = [...new Set(importedRefs.filter(Boolean))];
    for (const ref of uniqueRefs) {
      const target = findAccountByRef(nextStore.accounts, ref);
      if (!target || target.enabled === false) continue;
      try {
        const probe = await refreshUsageSnapshot(nextStore, ref);
        if (probe?.ok) {
          usageProbed += 1;
        } else {
          usageProbeFailed += 1;
          usageProbeErrors.push({
            entryId: probe?.entryId || ref,
            error: String(probe?.error || probe?.skipped || "usage_probe_failed")
          });
        }
      } catch (err) {
        usageProbeFailed += 1;
        usageProbeErrors.push({
          entryId: ref,
          error: String(err?.message || err || "usage_probe_failed")
        });
      }
    }
  }

  const renormalized = ensureStoreShape(nextStore);
  return {
    store: renormalized?.store || nextStore,
    imported,
    accountPoolSize: Array.isArray(nextStore.accounts) ? nextStore.accounts.length : 0,
    importedRefs,
    usageProbe: {
      enabled: probeUsage,
      probed: usageProbed,
      failed: usageProbeFailed,
      errors: usageProbeErrors
    }
  };
}

export { flattenTokenCandidates };
