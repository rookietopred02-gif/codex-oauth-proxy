import { assertCodexOAuthMode } from "./admin-shared.js";

function sanitizeExportSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

export function registerAdminPoolRoutes(app, context) {
  const {
    config,
    readJsonBody,
    getCodexOAuthStore,
    setCodexOAuthStore,
    ensureCodexOAuthStoreShape,
    saveTokenStore,
    clearAuthContextCache,
    buildCodexPoolMetrics,
    isCodexMultiAccountEnabled,
    getCodexPoolEntryId,
    findCodexPoolAccountByRef,
    removeCodexPoolAccountFromStore,
    importIntoCodexAuthPool,
    extractCodexOAuthImportItems,
    normalizeOpenAICodexPlanType,
    refreshCodexUsageSnapshotInStore,
    runCodexPreheat,
    getCodexPreheatState
  } = context;

  async function syncCodexOAuthStore({ persistIfChanged = false } = {}) {
    const normalized = ensureCodexOAuthStoreShape(getCodexOAuthStore());
    setCodexOAuthStore(normalized.store);
    if (persistIfChanged && normalized.changed) {
      await saveTokenStore(config.codexOAuth.tokenStorePath, normalized.store);
    }
    return normalized;
  }

  app.get("/admin/auth-pool", async (_req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const normalized = await syncCodexOAuthStore({ persistIfChanged: true });
    const store = normalized.store;
    const activeEntryId = store.active_account_id || null;
    const metrics = buildCodexPoolMetrics(store.accounts || [], activeEntryId || "");
    res.json({
      ok: true,
      multiAccountEnabled: isCodexMultiAccountEnabled(),
      strategy: config.codexOAuth.multiAccountStrategy,
      sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
      activeEntryId,
      activeAccountId:
        (store.accounts || []).find((x) => getCodexPoolEntryId(x) === String(activeEntryId || ""))?.account_id ||
        null,
      rotation: store.rotation || { next_index: 0 },
      poolMetrics: metrics.summary,
      accounts: (metrics.decorated || []).map((d, idx) => {
        const account = d.account;
        return {
          entryId: d.entryId,
          accountId: account.account_id,
          label: account.label || "",
          slot: Number(account.slot || 0) || idx + 1,
          enabled: account.enabled !== false,
          expiresAt: account.token?.expires_at || null,
          lastUsedAt: account.last_used_at || 0,
          failureCount: account.failure_count || 0,
          cooldownUntil: account.cooldown_until || 0,
          lastError: account.last_error || "",
          usageSnapshot: account.usage_snapshot || null,
          usageUpdatedAt: account.usage_updated_at || 0,
          healthScore: d.healthScore,
          healthStatus: d.healthStatus,
          primaryRemaining: d.primaryRemaining,
          secondaryRemaining: d.secondaryRemaining,
          lowQuota: d.lowQuota,
          hardLimited: d.hardLimited
        };
      })
    });
  });

  app.post("/admin/auth-pool/toggle", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const body = await readJsonBody(req);
    const accountRef = String(body.entryId || body.accountId || "").trim();
    const enabled = body.enabled !== false;
    if (!accountRef) {
      res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
      return;
    }

    const { store } = await syncCodexOAuthStore();
    const target = findCodexPoolAccountByRef(store.accounts || [], accountRef);
    if (!target) {
      res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
      return;
    }

    target.enabled = enabled;
    const targetEntryId = getCodexPoolEntryId(target);
    if (!enabled && store.active_account_id === targetEntryId) {
      store.active_account_id = null;
    }
    await saveTokenStore(config.codexOAuth.tokenStorePath, store);
    clearAuthContextCache();
    res.json({ ok: true, entryId: targetEntryId, accountId: target.account_id, enabled });
  });

  app.post("/admin/auth-pool/activate", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const body = await readJsonBody(req);
    const accountRef = String(body.entryId || body.accountId || "").trim();
    if (!accountRef) {
      res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
      return;
    }

    const { store } = await syncCodexOAuthStore();
    const target = findCodexPoolAccountByRef(store.accounts || [], accountRef);
    if (!target) {
      res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
      return;
    }
    target.enabled = true;
    target.cooldown_until = 0;
    target.last_error = "";
    const targetEntryId = getCodexPoolEntryId(target);
    store.active_account_id = targetEntryId;
    await saveTokenStore(config.codexOAuth.tokenStorePath, store);
    clearAuthContextCache();
    res.json({ ok: true, entryId: targetEntryId, accountId: target.account_id });
  });

  app.post("/admin/auth-pool/remove", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const body = await readJsonBody(req);
    const accountRef = String(body.entryId || body.accountId || "").trim();
    if (!accountRef) {
      res.status(400).json({ error: "invalid_request", message: "entryId/accountId is required." });
      return;
    }

    const result = removeCodexPoolAccountFromStore(getCodexOAuthStore(), accountRef);
    if (!result.removed) {
      if (result.blocked === "leased") {
        res.status(409).json({
          error: "account_in_use",
          message: "Account is currently serving an in-flight request.",
          entryId: result.blockedEntryId || null,
          accountId: result.blockedAccountId || null
        });
        return;
      }
      res.status(404).json({ error: "not_found", message: `Account not found: ${accountRef}` });
      return;
    }
    setCodexOAuthStore(result.store);
    await saveTokenStore(config.codexOAuth.tokenStorePath, result.store);
    clearAuthContextCache();
    res.json({
      ok: true,
      entryId: result.removedEntryId,
      accountId: result.removedAccountId,
      removed: true,
      remainingAccounts: result.remainingAccounts,
      activeEntryId: result.activeEntryId
    });
  });

  app.post("/admin/auth-pool/import", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const body = await readJsonBody(req);
    try {
      const importItems = extractCodexOAuthImportItems({
        items: Array.isArray(body.tokens) ? body.tokens : [],
        files: Array.isArray(body.files) ? body.files : []
      });
      const result = await importIntoCodexAuthPool(importItems, {
        replace: body.replace === true,
        probeUsage: body.probeUsage !== false
      });
      res.json({
        ok: true,
        imported: result.imported,
        accountPoolSize: result.accountPoolSize,
        usageProbe: result.usageProbe
      });
    } catch (err) {
      res.status(400).json({
        error: "invalid_request",
        message: String(err?.message || err || "Token import failed.")
      });
    }
  });

  app.get("/admin/auth-pool/export", async (_req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const { store } = await syncCodexOAuthStore();
    const accounts = Array.isArray(store.accounts) ? store.accounts : [];
    const files = accounts.map((account, index) => {
      const entryId = getCodexPoolEntryId(account) || `entry_${index + 1}`;
      const slot = Number(account?.slot || 0) || index + 1;
      const labelPart = sanitizeExportSegment(account?.label || "", "account");
      const accountPart = sanitizeExportSegment(account?.account_id || "", `slot-${slot}`);
      const fileName = `slot-${slot}-${labelPart}-${accountPart}`.slice(0, 96) + ".json";
      const token = account?.token || {};
      const usageSnapshot =
        account?.usage_snapshot && typeof account.usage_snapshot === "object" ? account.usage_snapshot : null;
      const planType = normalizeOpenAICodexPlanType(usageSnapshot?.plan_type || account?.plan_type);
      return {
        fileName,
        payload: {
          label: typeof account?.label === "string" ? account.label : "",
          slot,
          enabled: account?.enabled !== false,
          entry_id: entryId,
          account_id: account?.account_id || null,
          plan_type: planType || null,
          usage_snapshot: usageSnapshot,
          usage_updated_at: Number(account?.usage_updated_at || 0) || 0,
          access_token: token?.access_token || "",
          refresh_token: token?.refresh_token || null,
          token_type: token?.token_type || "Bearer",
          scope: token?.scope || null,
          expires_at: Number(token?.expires_at || 0) || 0
        }
      };
    });

    res.json({
      ok: true,
      exported: files.length,
      generatedAt: new Date().toISOString(),
      files
    });
  });

  app.post("/admin/auth-pool/refresh-usage", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Account pool management")) return;

    const body = await readJsonBody(req);
    const accountRef = String(body.entryId || body.accountId || "").trim();
    const includeDisabled = body.includeDisabled === true;

    const { store } = await syncCodexOAuthStore();
    let targets = Array.isArray(store.accounts) ? [...store.accounts] : [];
    if (!includeDisabled) {
      targets = targets.filter((x) => x.enabled !== false);
    }
    if (accountRef) {
      targets = targets.filter(
        (x) => getCodexPoolEntryId(x) === accountRef || String(x.account_id || "") === accountRef
      );
    }
    if (targets.length === 0) {
      res.status(404).json({
        error: "not_found",
        message: accountRef
          ? `No matching account to refresh: ${accountRef}`
          : "No eligible accounts to refresh usage."
      });
      return;
    }

    const results = [];
    let refreshed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const probe = await refreshCodexUsageSnapshotInStore(
        store,
        getCodexPoolEntryId(target),
        config.codexOAuth,
        { includeDisabled }
      );
      if (probe.ok) {
        refreshed += 1;
        results.push({
          entryId: probe.entryId,
          accountId: probe.accountId,
          ok: true,
          usage: probe.snapshot
        });
      } else {
        results.push({
          entryId: probe.entryId || getCodexPoolEntryId(target),
          accountId: probe.accountId || target.account_id || null,
          ok: false,
          error: String(probe.error || probe.skipped || "usage_probe_failed")
        });
      }
      if (i < targets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    if (targets[0]?.token?.access_token) {
      store.token = targets[0].token;
    }
    const normalizedAfterRefresh = ensureCodexOAuthStoreShape(store);
    setCodexOAuthStore(normalizedAfterRefresh.store);
    await saveTokenStore(config.codexOAuth.tokenStorePath, normalizedAfterRefresh.store);
    clearAuthContextCache();
    res.json({
      ok: true,
      refreshed,
      total: targets.length,
      results
    });
  });

  app.get("/admin/preheat/state", (_req, res) => {
    if (!assertCodexOAuthMode(config, res, "Preheat")) return;
    res.json({
      ok: true,
      preheat: getCodexPreheatState()
    });
  });

  app.post("/admin/preheat/run", async (req, res) => {
    if (!assertCodexOAuthMode(config, res, "Preheat")) return;
    try {
      const body = await readJsonBody(req);
      const summary = await runCodexPreheat("manual", {
        model: typeof body.model === "string" ? body.model : "",
        allModels: body.allModels === true
      });
      res.json({
        ok: true,
        summary,
        preheat: getCodexPreheatState()
      });
    } catch (err) {
      res.status(400).json({
        error: "preheat_failed",
        message: err.message,
        preheat: getCodexPreheatState()
      });
    }
  });
}
