// @ts-check

import { createPoolRenderer } from "../renderers/pool.js";

export function createPoolFeature(deps) {
  const { $, api, t, tt, escapeHtml, fmtUnixSec, fmtCooldown, shortId, setTextAndPulse } = deps;
  const renderer = createPoolRenderer({ t, tt, escapeHtml, fmtUnixSec, fmtCooldown, shortId });

  let lastAccounts = [];
  let lastActiveEntryId = "";
  let usageRefreshInFlight = false;
  let lastUsageRefreshAtMs = 0;

  function syncRefreshControls() {
    const busy = usageRefreshInFlight === true;
    const toolbarBtn = $("refreshUsageBtn");
    if (toolbarBtn instanceof HTMLButtonElement) toolbarBtn.disabled = busy;
    const iconBtn = $("refreshAllAccountsBtn");
    if (!(iconBtn instanceof HTMLButtonElement)) return;
    const label = t(busy ? "all_accounts_refreshing" : "all_accounts_refresh");
    iconBtn.disabled = busy;
    iconBtn.title = label;
    iconBtn.setAttribute("aria-label", label);
    iconBtn.classList.toggle("is-spinning", busy);
  }

  function getNextAccountSlot(minSlot = 2) {
    const occupied = new Set();
    for (let i = 0; i < lastAccounts.length; i += 1) {
      const slot = renderer.getAccountSlotNumber(lastAccounts[i], i);
      if (Number.isFinite(slot) && slot > 0) occupied.add(slot);
    }
    let slot = Math.max(1, Number(minSlot) || 1);
    while (occupied.has(slot)) slot += 1;
    return slot;
  }

  function render(state) {
    const accounts = Array.isArray(state.auth?.accounts) ? state.auth.accounts : [];
    lastAccounts = accounts;
    const enabledCount = Number(state.auth?.enabledAccountCount || 0);
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
    const avgPrimaryRemaining =
      Number.isFinite(Number(poolMetrics.avgPrimaryRemaining)) ? Math.round(Number(poolMetrics.avgPrimaryRemaining)) : null;
    const avgSecondaryRemaining =
      Number.isFinite(Number(poolMetrics.avgSecondaryRemaining)) ? Math.round(Number(poolMetrics.avgSecondaryRemaining)) : null;
    const lowQuotaCount =
      Number.isFinite(Number(poolMetrics.lowQuotaCount))
        ? Number(poolMetrics.lowQuotaCount)
        : decorated.filter((item) => item.lowQuota === true).length;

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

    const recommendationLimit = Math.min(4, decorated.length);
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
    const minIntervalMs = Number(options.minIntervalMs || 0);
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
    if (!hasAccounts) {
      win.open("/auth/login?prompt=login", "_blank");
      return;
    }
    const slot = getNextAccountSlot(2);
    win.open(`/auth/login?slot=${slot}&label=acc${slot}&prompt=login`, "_blank");
  }

  return {
    getLastAccounts: () => [...lastAccounts],
    getLastActiveEntryId: () => lastActiveEntryId,
    openAccountLoginFlow,
    refreshAllAccountStatuses,
    refreshUsage,
    render,
    syncRefreshControls,
    switchCurrentAccount,
    switchCurrentAccountTo,
    logoutAccountByEntry
  };
}
