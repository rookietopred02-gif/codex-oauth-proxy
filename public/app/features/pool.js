// @ts-check

import { createPoolRenderer } from "../renderers/pool.js";

function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function toNonNegativeNumber(value, fallback = 0) {
  const n = toFiniteNumber(value, null);
  if (n === null || n < 0) return fallback;
  return n;
}

function toIntegerNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : fallback;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const n = toIntegerNumber(value, null);
  return n !== null && n >= 0 ? n : fallback;
}

export function createPoolFeature(deps) {
  const { $, api, t, tt, escapeHtml, fmtUnixSec, fmtCooldown, shortId, setTextAndPulse } = deps;
  const renderer = createPoolRenderer({ t, tt, escapeHtml, fmtUnixSec, fmtCooldown, shortId });

  let lastAccounts = [];
  let lastActiveEntryId = "";
  let usageRefreshInFlight = false;
  let lastUsageRefreshAtMs = 0;
  let tokenRefreshInFlight = false;
  let lastTokenRefreshAtMs = 0;
  let autoTokenRefreshEnabled = false;

  function syncRefreshControls() {
    const usageBusy = usageRefreshInFlight === true;
    const toolbarBtn = $("refreshUsageBtn");
    if (toolbarBtn instanceof HTMLButtonElement) toolbarBtn.disabled = usageBusy;
    const iconBtn = $("refreshAllAccountsBtn");
    if (iconBtn instanceof HTMLButtonElement) {
      const label = t(usageBusy ? "all_accounts_refreshing" : "all_accounts_refresh");
      iconBtn.disabled = usageBusy;
      iconBtn.title = label;
      iconBtn.setAttribute("aria-label", label);
      iconBtn.classList.toggle("is-spinning", usageBusy);
    }

    const tokenBusy = tokenRefreshInFlight === true;
    const refreshTokensBtn = $("refreshAllTokensBtn");
    if (refreshTokensBtn instanceof HTMLButtonElement) {
      refreshTokensBtn.disabled = tokenBusy;
      refreshTokensBtn.textContent = t(tokenBusy ? "token_refresh_running" : "token_refresh_run");
    }
    const toggleAutoTokensBtn = $("toggleAutoRefreshTokensBtn");
    if (toggleAutoTokensBtn instanceof HTMLButtonElement) {
      toggleAutoTokensBtn.disabled = tokenBusy;
      toggleAutoTokensBtn.textContent = t(
        autoTokenRefreshEnabled ? "token_refresh_auto_disable" : "token_refresh_auto_enable"
      );
      toggleAutoTokensBtn.classList.toggle("button-strong", autoTokenRefreshEnabled);
    }
  }

  function getNextAccountSlot(minSlot = 2) {
    const occupied = new Set();
    for (let i = 0; i < lastAccounts.length; i += 1) {
      const slot = renderer.getAccountSlotNumber(lastAccounts[i], i);
      if (Number.isFinite(slot) && slot > 0) occupied.add(slot);
    }
    let slot = Math.max(1, toNonNegativeInteger(minSlot, 1) || 1);
    while (occupied.has(slot)) slot += 1;
    return slot;
  }

  function readExpectedAccountEmail(win = window) {
    if (typeof win?.prompt !== "function") return "";
    const raw = win.prompt(t("runtime_connect_account_email_hint"), "");
    if (raw === null) return null;
    return String(raw || "").trim();
  }

  function render(state) {
    const accounts = Array.isArray(state.auth?.accounts) ? state.auth.accounts : [];
    lastAccounts = accounts;
    const enabledCount = toNonNegativeInteger(state.auth?.enabledAccountCount, 0);
    const activeAccount = state.auth?.activeEntryId || state.auth?.activeAccountId || "";
    lastActiveEntryId = String(activeAccount || "");
    const poolEnabled = state.auth?.multiAccountEnabled === true;

    const decorated = accounts
      .map((account, idx) => {
        const health = renderer.resolveAccountHealth(account, activeAccount);
        const score = renderer.computeAccountScore(account, activeAccount);
        return { ...account, _health: health, _score: score, _slot: renderer.getAccountSlotNumber(account, idx) || 999 };
      })
      .sort((a, b) => {
        if (a._slot !== b._slot) return a._slot - b._slot;
        return String(a.label || a.accountId || "").localeCompare(String(b.label || b.accountId || ""));
      });

    const healthyCount = decorated.filter((item) => item._health.label === "healthy").length;
    const cooldownCount = decorated.filter((item) => item._health.label === "cooldown").length;
    const riskCount = decorated.filter((item) => ["disabled", "expired", "cooldown", "expiring"].includes(item._health.label)).length;
    const healthyRatio = enabledCount > 0 ? Math.round((healthyCount / enabledCount) * 100) : 0;
    const poolMetrics = state.auth?.poolMetrics || {};
    const avgPrimaryRemainingValue = toFiniteNumber(poolMetrics.avgPrimaryRemaining, null);
    const avgSecondaryRemainingValue = toFiniteNumber(poolMetrics.avgSecondaryRemaining, null);
    const avgPrimaryRemaining = avgPrimaryRemainingValue === null ? null : Math.round(avgPrimaryRemainingValue);
    const avgSecondaryRemaining = avgSecondaryRemainingValue === null ? null : Math.round(avgSecondaryRemainingValue);
    const lowQuotaFallback = decorated.filter((item) => item.lowQuota === true).length;
    const lowQuotaCount = toNonNegativeInteger(poolMetrics.lowQuotaCount, lowQuotaFallback);

    setTextAndPulse("poolTotal", String(accounts.length));
    setTextAndPulse("poolHealthyRatio", `${healthyRatio}%`);
    setTextAndPulse("poolPrimaryAvg", avgPrimaryRemaining === null ? "-" : `${avgPrimaryRemaining}%`);
    setTextAndPulse("poolSecondaryAvg", avgSecondaryRemaining === null ? "-" : `${avgSecondaryRemaining}%`);
    setTextAndPulse("poolCooldownCount", String(cooldownCount));
    setTextAndPulse("poolRiskCount", String(riskCount));
    setTextAndPulse("poolLowQuotaCount", String(lowQuotaCount));

    $("poolRiskHint").textContent = poolEnabled
      ? tt("pool_risk_hint_enabled", { enabled: enabledCount, total: accounts.length })
      : t("pool_risk_hint_disabled");
    $("allAccountsTitle").textContent = tt("all_accounts_with_count", { count: decorated.length });

    const activeItem = decorated.find((item) => renderer.getAccountIdentity(item) === String(activeAccount || "")) || decorated[0] || null;
    const currentCard = $("currentAccountCard");
    if (currentCard instanceof HTMLElement) {
      if (activeItem) {
        currentCard.className = "current-account-shell";
        currentCard.innerHTML = renderer.buildAccountCardHtml(activeItem, activeAccount);
      } else {
        currentCard.className = "account-empty";
        currentCard.textContent = t("account_no_active");
      }
    }

    const recommendationLimit = Math.min(5, decorated.length);
    let recommendations = [];
    if (Array.isArray(poolMetrics.recommendedEntryIds) && poolMetrics.recommendedEntryIds.length > 0) {
      recommendations = poolMetrics.recommendedEntryIds
        .map((id) => decorated.find((item) => renderer.getAccountIdentity(item) === String(id)))
        .filter(Boolean);
      if (recommendations.length < recommendationLimit) {
        const picked = new Set(recommendations.map((item) => renderer.getAccountIdentity(item)));
        const more = decorated
          .filter((item) => item.enabled !== false && !picked.has(renderer.getAccountIdentity(item)))
          .sort((a, b) => b._score - a._score)
          .slice(0, recommendationLimit - recommendations.length);
        recommendations = recommendations.concat(more);
      }
      recommendations = recommendations.slice(0, recommendationLimit);
    } else {
      recommendations = decorated.filter((item) => item.enabled !== false).sort((a, b) => b._score - a._score).slice(0, recommendationLimit);
    }

    $("recommendList").innerHTML =
      recommendations.length === 0
        ? `<div class="account-empty">${escapeHtml(t("account_no_recommendation_available"))}</div>`
        : recommendations
            .map((account) => {
              const usageView = renderer.resolveUsageWindows(account);
              const tone = renderer.limitPairTone(usageView.primaryRemaining, usageView.secondaryRemaining, account._score);
              const pairText = renderer.fmtLimitPair(usageView);
              const planTypeRaw = String(account?.usageSnapshot?.plan_type || "").trim();
              const planType = planTypeRaw.length > 0 ? planTypeRaw : null;
              const localizedHealth = renderer.healthDisplayLabel(account.healthStatus || "");
              const statusLine = account.healthStatus
                ? `${planType ? `${escapeHtml(planType)} · ` : ""}${escapeHtml(localizedHealth)}${
                    pairText !== "-" ? ` · ${escapeHtml(pairText)}` : ""
                  }`
                : escapeHtml(shortId(account.accountId || "-"));
              return `<div class="recommend-item">
                <div>
                  <div class="recommend-name">${escapeHtml(account.label || t("account_name_unknown"))}</div>
                  <div class="recommend-sub">${statusLine}</div>
                </div>
                <span class="pill ${tone}" title="${escapeHtml(t("quota_remaining_percent_title"))}">${escapeHtml(pairText)}</span>
              </div>`;
            })
            .join("");

    $("accountPoolCards").innerHTML =
      decorated.length === 0
        ? `<div class="account-empty">${escapeHtml(t("account_no_pool_accounts"))}</div>`
        : decorated.map((account) => renderer.buildAccountCardHtml(account, activeAccount, true)).join("");

    syncRefreshControls();
  }

  async function refreshUsage(force = false, options = {}) {
    if (typeof options.isLocked === "function" && options.isLocked()) return false;
    if (usageRefreshInFlight) return false;
    const minIntervalMs = toNonNegativeNumber(options.minIntervalMs, 0);
    const now = Date.now();
    if (!force && minIntervalMs > 0 && now - lastUsageRefreshAtMs < minIntervalMs) {
      return false;
    }

    usageRefreshInFlight = true;
    syncRefreshControls();
    try {
      await api("/admin/auth-pool/refresh-usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeDisabled: true })
      });
      lastUsageRefreshAtMs = Date.now();
      return true;
    } finally {
      usageRefreshInFlight = false;
      syncRefreshControls();
    }
  }

  function renderTokenRefreshStatus(summary = null) {
    const statusEl = $("tokenRefreshStatus");
    if (!(statusEl instanceof HTMLElement)) return;

    if (!summary) {
      statusEl.className = "preheat-status";
      statusEl.textContent = t("token_refresh_idle");
      return;
    }

    if (summary.state === "running") {
      statusEl.className = "preheat-status";
      statusEl.textContent = t("token_refresh_running");
      return;
    }

    if (summary.state === "error") {
      statusEl.className = "preheat-status bad";
      statusEl.textContent = tt("token_refresh_failed", { message: summary.message || "token_refresh_failed" });
      return;
    }

    const refreshed = toNonNegativeInteger(summary.refreshed, 0);
    const total = toNonNegativeInteger(summary.total, 0);
    const ok = refreshed === total;
    statusEl.className = `preheat-status ${ok ? "ok" : "bad"}`;
    statusEl.textContent = tt("token_refresh_status", {
      refreshed,
      total,
      mode: autoTokenRefreshEnabled ? t("token_refresh_mode_auto") : t("token_refresh_mode_manual")
    });
  }

  async function refreshTokens(force = false, options = {}) {
    if (typeof options.isLocked === "function" && options.isLocked()) return null;
    if (tokenRefreshInFlight) return null;
    const minIntervalMs = toNonNegativeNumber(options.minIntervalMs, 0);
    const now = Date.now();
    if (!force && minIntervalMs > 0 && now - lastTokenRefreshAtMs < minIntervalMs) {
      return null;
    }

    tokenRefreshInFlight = true;
    renderTokenRefreshStatus({ state: "running" });
    syncRefreshControls();
    try {
      const result = await api("/admin/auth-pool/refresh-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeDisabled: true })
      });
      lastTokenRefreshAtMs = Date.now();
      renderTokenRefreshStatus({
        state: "done",
        refreshed: toNonNegativeInteger(result?.refreshed, 0),
        total: toNonNegativeInteger(result?.total, 0)
      });
      return result;
    } catch (err) {
      renderTokenRefreshStatus({ state: "error", message: err.message });
      throw err;
    } finally {
      tokenRefreshInFlight = false;
      syncRefreshControls();
    }
  }

  function setAutoTokenRefreshEnabled(enabled) {
    autoTokenRefreshEnabled = enabled === true;
    syncRefreshControls();
  }

  function isAutoTokenRefreshEnabled() {
    return autoTokenRefreshEnabled === true;
  }

  async function refreshAllAccountStatuses(options = {}) {
    const didRefresh = await refreshUsage(true, options);
    if (!didRefresh) return false;
    if (typeof options.refreshState === "function") {
      await options.refreshState(true);
    }
    return true;
  }

  async function switchCurrentAccountTo(targetRef, refreshState) {
    const ref = String(targetRef || "").trim();
    if (!ref) throw new Error(t("alert_switch_target_missing"));
    await api("/admin/auth-pool/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: ref })
    });
    if (typeof refreshState === "function") {
      await refreshState(true);
    }
  }

  async function logoutAccountByEntry(targetRef, refreshState) {
    const ref = String(targetRef || "").trim();
    if (!ref) throw new Error(t("alert_switch_target_missing"));
    await api("/admin/auth-pool/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: ref })
    });
    if (typeof refreshState === "function") {
      await refreshState(true);
    }
  }

  async function switchLocalCodexAccountTo(targetRef, refreshState) {
    const ref = String(targetRef || "").trim();
    if (!ref) throw new Error(t("alert_switch_target_missing"));
    const result = await api("/admin/auth-pool/switch-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: ref })
    });
    if (typeof refreshState === "function") {
      await refreshState(true);
    }
    return result;
  }

  async function switchCurrentAccount(refreshState) {
    const sorted = (Array.isArray(lastAccounts) ? lastAccounts : [])
      .map((account, idx) => ({ ...account, _slot: renderer.getAccountSlotNumber(account, idx) || 999 }))
      .sort((a, b) => {
        if (a._slot !== b._slot) return a._slot - b._slot;
        return String(a.label || a.accountId || "").localeCompare(String(b.label || b.accountId || ""));
      });
    const enabled = sorted.filter((account) => account.enabled !== false);
    if (enabled.length === 0) throw new Error(t("alert_switch_no_enabled"));
    if (enabled.length === 1) throw new Error(t("alert_switch_only_one"));

    const currentIdx = enabled.findIndex((account) => renderer.getAccountIdentity(account) === String(lastActiveEntryId || ""));
    const target = enabled[(currentIdx + 1 + enabled.length) % enabled.length];
    const targetRef = renderer.getAccountIdentity(target);
    if (!targetRef) throw new Error(t("alert_switch_target_missing"));
    await switchCurrentAccountTo(targetRef, refreshState);
  }

  function openAccountLoginFlow(win = window) {
    const hasAccounts = Array.isArray(lastAccounts) && lastAccounts.length > 0;
    const expectedEmail = readExpectedAccountEmail(win);
    if (expectedEmail === null) return;
    const params = new URLSearchParams();
    params.set("prompt", "login");
    if (expectedEmail) params.set("email", expectedEmail);
    if (!hasAccounts) {
      win.open(`/auth/login?${params.toString()}`, "_blank");
      return;
    }
    const slot = getNextAccountSlot(2);
    params.set("slot", String(slot));
    win.open(`/auth/login?${params.toString()}`, "_blank");
  }

  return {
    getLastAccounts: () => [...lastAccounts],
    getLastActiveEntryId: () => lastActiveEntryId,
    isAutoTokenRefreshEnabled,
    openAccountLoginFlow,
    refreshAllAccountStatuses,
    refreshTokens,
    refreshUsage,
    render,
    renderTokenRefreshStatus,
    setAutoTokenRefreshEnabled,
    syncRefreshControls,
    switchCurrentAccount,
    switchCurrentAccountTo,
    switchLocalCodexAccountTo,
    logoutAccountByEntry
  };
}
