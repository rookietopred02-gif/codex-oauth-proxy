// @ts-check

export function createPoolRenderer(deps) {
  const { t, tt, escapeHtml, fmtUnixSec, fmtCooldown, shortId } = deps;

  function healthDisplayLabel(label) {
    const raw = String(label || "").trim();
    if (!raw) return "-";
    const key = `account_status_${raw.replaceAll("-", "_")}`;
    const localized = t(key);
    return localized === key ? raw : localized;
  }

  function getAccountIdentity(account) {
    return String(account?.entryId || account?.accountId || "");
  }

  function safePercent(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function resolveAccountHealth(account, activeAccountId) {
    const nowSec = Math.floor(Date.now() / 1000);
    const enabled = account?.enabled !== false;
    const isActive = getAccountIdentity(account) === String(activeAccountId || "");
    const serverStatus = String(account?.healthStatus || "").trim().toLowerCase();
    if (serverStatus) {
      if (serverStatus === "healthy") return { label: "healthy", tone: "ok", isActive };
      if (serverStatus === "limited") {
        const tone = account?.hardLimited ? "bad" : "warn";
        return { label: account?.hardLimited ? "limited-hard" : "limited", tone, isActive };
      }
      if (serverStatus === "cooldown") return { label: "cooldown", tone: "warn", isActive };
      if (serverStatus === "expiring") return { label: "expiring", tone: "warn", isActive };
      if (serverStatus === "expired") return { label: "expired", tone: "bad", isActive };
      if (serverStatus === "disabled") return { label: "disabled", tone: "bad", isActive };
    }

    const cooldownUntil = Number(account?.cooldownUntil || 0);
    const expiresAt = Number(account?.expiresAt || 0);
    const inCooldown = cooldownUntil > nowSec;
    const expired = expiresAt > 0 && expiresAt <= nowSec;
    const expiringSoon = expiresAt > nowSec && expiresAt - nowSec < 180;
    const usageView = resolveUsageWindows(account);
    const planType = String(usageView?.usage?.plan_type || "").trim().toLowerCase();
    const lowQuotaThreshold = usageView?.singleWindowMode || planType === "free" ? 30 : 20;
    const primaryRemaining = usageView?.primaryRemaining;
    const secondaryRemaining = usageView?.secondaryRemaining;
    const hardLimited =
      Number.isFinite(primaryRemaining) &&
      (!Number.isFinite(secondaryRemaining) ? primaryRemaining <= 0 : primaryRemaining <= 0 && secondaryRemaining <= 0);
    const lowQuota =
      (Number.isFinite(primaryRemaining) && primaryRemaining <= lowQuotaThreshold) ||
      (Number.isFinite(secondaryRemaining) && secondaryRemaining <= 20);

    if (!enabled) return { label: "disabled", tone: "bad", isActive };
    if (expired) return { label: "expired", tone: "bad", isActive };
    if (inCooldown) return { label: "cooldown", tone: "warn", isActive };
    if (hardLimited) return { label: "limited-hard", tone: "bad", isActive };
    if (expiringSoon) return { label: "expiring", tone: "warn", isActive };
    if (lowQuota) return { label: "limited", tone: "warn", isActive };
    return { label: "healthy", tone: "ok", isActive };
  }

  function computeAccountScore(account, activeAccountId) {
    if (Number.isFinite(Number(account?.healthScore))) {
      return Math.max(0, Math.min(100, Math.round(Number(account.healthScore))));
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const health = resolveAccountHealth(account, activeAccountId);
    const failureCount = Number(account?.failureCount || 0);
    const cooldownUntil = Number(account?.cooldownUntil || 0);
    const expiresAt = Number(account?.expiresAt || 0);
    const primaryUsed = safePercent(account?.usageSnapshot?.primary?.used_percent);
    const secondaryUsed = safePercent(account?.usageSnapshot?.secondary?.used_percent);

    let score = 100;
    if (account?.enabled === false) score -= 90;
    if (health.label === "expired") score -= 80;
    if (health.label === "cooldown") score -= 35;
    if (health.label === "expiring") score -= 15;
    if (health.label === "limited-hard") score -= 28;
    if (health.label === "limited") score -= 12;
    if (primaryUsed !== null) score -= Math.round(primaryUsed * 0.35);
    if (secondaryUsed !== null) score -= Math.round(secondaryUsed * 0.15);
    score -= Math.min(55, failureCount * 11);
    if (cooldownUntil > nowSec) {
      const remain = cooldownUntil - nowSec;
      score -= Math.min(18, Math.floor(remain / 20));
    }
    if (expiresAt > nowSec && expiresAt - nowSec < 180) {
      score -= 8;
    }
    if (health.isActive) score += 4;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function scoreTone(score) {
    if (score >= 80) return "ok";
    if (score >= 45) return "warn";
    return "bad";
  }

  function remainingTone(percentRemaining) {
    if (!Number.isFinite(percentRemaining)) return "neutral";
    if (percentRemaining >= 70) return "ok";
    if (percentRemaining >= 35) return "warn";
    return "bad";
  }

  function windowMinutesOrNull(windowObj) {
    const n = Number(windowObj?.window_minutes);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function hasUsageWindow(windowObj) {
    if (!windowObj || typeof windowObj !== "object") return false;
    if (windowMinutesOrNull(windowObj) !== null) return true;
    const resetAt = Number(windowObj.reset_at);
    if (Number.isFinite(resetAt) && resetAt > 0) return true;
    const resetAfter = Number(windowObj.reset_after_seconds);
    if (Number.isFinite(resetAfter) && resetAfter > 0) return true;
    const used = safePercent(windowObj.used_percent);
    if (used !== null && used > 0) return true;
    const remaining = safePercent(windowObj.remaining_percent);
    if (remaining !== null && remaining < 100) return true;
    return false;
  }

  function longWindowLabel(minutes, fallbackLabel) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
    if (minutes >= 9000) return t("limit_weekly");
    if (minutes >= 295 && minutes <= 305) return t("limit_5h");
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      if (hours >= 1 && hours <= 24) return tt("limit_hour", { hours });
    }
    return tt("limit_minute", { minutes });
  }

  function shortWindowLabel(minutes, fallbackLabel) {
    if (!Number.isFinite(minutes) || minutes <= 0) return fallbackLabel;
    if (minutes >= 9000) return t("limit_short_weekly");
    if (minutes >= 295 && minutes <= 305) return t("limit_short_5h");
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      if (hours >= 1 && hours <= 24) return tt("limit_short_hour", { hours });
    }
    return tt("limit_short_minute", { minutes });
  }

  function resolveUsageWindows(account) {
    const usage = account?.usageSnapshot || null;
    const primaryHasWindow = hasUsageWindow(usage?.primary) || Number.isFinite(safePercent(account?.primaryRemaining));
    const secondaryHasWindow =
      hasUsageWindow(usage?.secondary) || Number.isFinite(safePercent(account?.secondaryRemaining));
    const primaryUsed = primaryHasWindow ? safePercent(usage?.primary?.used_percent) : null;
    const secondaryUsed = secondaryHasWindow ? safePercent(usage?.secondary?.used_percent) : null;
    const primaryRemainingRaw = primaryHasWindow ? safePercent(account?.primaryRemaining ?? usage?.primary?.remaining_percent) : null;
    const secondaryRemainingRaw = secondaryHasWindow
      ? safePercent(account?.secondaryRemaining ?? usage?.secondary?.remaining_percent)
      : null;
    const primaryRemaining =
      primaryRemainingRaw !== null
        ? primaryRemainingRaw
        : primaryUsed !== null
          ? Math.max(0, Math.min(100, 100 - primaryUsed))
          : null;
    const secondaryRemaining =
      secondaryRemainingRaw !== null
        ? secondaryRemainingRaw
        : secondaryUsed !== null
          ? Math.max(0, Math.min(100, 100 - secondaryUsed))
          : null;
    const primaryWindowMinutes = windowMinutesOrNull(usage?.primary);
    const secondaryWindowMinutes = windowMinutesOrNull(usage?.secondary);
    const singleWindowMode = primaryHasWindow && !secondaryHasWindow;
    return {
      usage,
      singleWindowMode,
      primaryLabel: longWindowLabel(primaryWindowMinutes, singleWindowMode ? t("limit_primary") : t("limit_5h")),
      secondaryLabel: longWindowLabel(secondaryWindowMinutes, t("limit_weekly")),
      primaryShortLabel: shortWindowLabel(primaryWindowMinutes, singleWindowMode ? t("limit_short_primary") : t("limit_short_5h")),
      secondaryShortLabel: shortWindowLabel(secondaryWindowMinutes, t("limit_short_weekly")),
      primaryUsed,
      secondaryUsed,
      primaryRemaining,
      secondaryRemaining
    };
  }

  function limitPairTone(primaryRemaining, secondaryRemaining, fallbackScore) {
    const values = [primaryRemaining, secondaryRemaining].filter(Number.isFinite);
    if (values.length === 0) return scoreTone(fallbackScore);
    return remainingTone(Math.min(...values));
  }

  function fmtLimitPair(usageView) {
    const p = Number.isFinite(usageView?.primaryRemaining) ? usageView.primaryRemaining : "-";
    const w = Number.isFinite(usageView?.secondaryRemaining) ? usageView.secondaryRemaining : "-";
    const asPercent = (value) => (Number.isFinite(value) ? `${value}%` : "-");
    if (usageView?.singleWindowMode) {
      if (Number.isFinite(p)) return asPercent(p);
      if (Number.isFinite(w)) return asPercent(w);
      return "-";
    }
    return `${asPercent(p)}/${asPercent(w)}`;
  }

  function getAccountSlotNumber(account, fallbackIndex = 0) {
    const raw = Number(account?.slot || account?._slot || 0);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    const idx = Number(fallbackIndex);
    return Number.isFinite(idx) && idx >= 0 ? idx + 1 : null;
  }

  function buildAccountCardHtml(account, activeAccountId, compact = false) {
    const health = resolveAccountHealth(account, activeAccountId);
    const score = computeAccountScore(account, activeAccountId);
    const slotNumber = getAccountSlotNumber(account);
    const accountRef = getAccountIdentity(account);
    const canSwitchToThis = compact && !health.isActive && account.enabled !== false && Boolean(accountRef);
    const canLogoutThis = compact && Boolean(accountRef);
    const pills = [`<span class="pill ${health.tone}">${escapeHtml(healthDisplayLabel(health.label))}</span>`];
    if (health.isActive) pills.push(`<span class="pill neutral">${escapeHtml(t("account_status_active"))}</span>`);

    const usageView = resolveUsageWindows(account);
    const { usage, singleWindowMode, primaryLabel, secondaryLabel, primaryUsed, secondaryUsed, primaryRemaining, secondaryRemaining } =
      usageView;
    const primaryTone = remainingTone(primaryRemaining);
    const secondaryTone = remainingTone(secondaryRemaining);
    const pairTone = limitPairTone(primaryRemaining, secondaryRemaining, score);
    const pairText = fmtLimitPair(usageView);

    const usageHtml =
      primaryUsed === null && secondaryUsed === null && primaryRemaining === null && secondaryRemaining === null
        ? `<div class="account-empty account-empty--compact">${escapeHtml(t("account_usage_not_fetched"))}</div>`
        : `<div class="usage-stack">
            ${
              primaryUsed === null && primaryRemaining === null
                ? ""
                : `<div class="usage-item">
                    <div class="label"><span>${escapeHtml(primaryLabel)}</span><span class="v">${
                      primaryUsed !== null
                        ? escapeHtml(tt("remaining_used", { remaining: primaryRemaining ?? "-", used: primaryUsed }))
                        : escapeHtml(tt("remaining_only", { remaining: primaryRemaining ?? "-" }))
                    }</span></div>
                    <div class="usage-track"><div class="usage-fill ${primaryTone}" style="width:${primaryRemaining ?? 0}%"></div></div>
                  </div>`
            }
            ${
              singleWindowMode || (secondaryUsed === null && secondaryRemaining === null)
                ? ""
                : `<div class="usage-item">
                    <div class="label"><span>${escapeHtml(secondaryLabel)}</span><span class="v">${
                      secondaryUsed !== null
                        ? escapeHtml(tt("remaining_used", { remaining: secondaryRemaining ?? "-", used: secondaryUsed }))
                        : escapeHtml(tt("remaining_only", { remaining: secondaryRemaining ?? "-" }))
                    }</span></div>
                    <div class="usage-track"><div class="usage-fill ${secondaryTone}" style="width:${secondaryRemaining ?? 0}%"></div></div>
                  </div>`
            }
          </div>`;

    const errorHtml =
      typeof account.lastError === "string" && account.lastError.trim().length > 0
        ? `<div class="account-error">${escapeHtml(t("account_error_prefix"))}: ${escapeHtml(account.lastError)}</div>`
        : "";
    const actionHtml = compact
      ? `<div class="account-card-actions">
          <button
            class="secondary account-switch-btn"
            data-switch-entry="${escapeHtml(accountRef || "")}"
            ${canSwitchToThis ? "" : "disabled"}
            title="${
              canSwitchToThis
                ? escapeHtml(t("account_title_switch_tooltip_enabled"))
                : health.isActive
                  ? escapeHtml(t("account_title_switch_tooltip_active"))
                  : account.enabled === false
                    ? escapeHtml(t("account_title_switch_tooltip_disabled"))
                    : escapeHtml(t("account_title_switch_tooltip_unresolved"))
            }"
          >${t("switch_to_this_account")}</button>
          <button
            class="secondary account-logout-btn"
            data-logout-entry="${escapeHtml(accountRef || "")}"
            ${canLogoutThis ? "" : "disabled"}
            title="${
              canLogoutThis
                ? escapeHtml(t("account_title_logout_tooltip_enabled"))
                : escapeHtml(t("account_title_logout_tooltip_unresolved"))
            }"
          >${escapeHtml(t("account_logout"))}</button>
        </div>`
      : "";

    return `<article class="account-card ${health.isActive ? "active" : ""} ${compact ? "compact" : "account-card--current"}">
      <div class="account-head">
        <div class="account-main">
          <div class="account-name">${escapeHtml(account.label || t("account_name_unknown"))}</div>
          <div class="account-id" title="${escapeHtml(account.accountId || "-")}">${escapeHtml(shortId(account.accountId || "-"))}</div>
          <div class="account-id" title="${escapeHtml(account.entryId || "-")}">${escapeHtml(t("account_entry_prefix"))} ${escapeHtml(shortId(account.entryId || "-"))}</div>
        </div>
        <div class="pill-row">
          ${pills.join("")}
          <span class="pill ${pairTone}" title="${escapeHtml(t("quota_remaining_percent_title"))}">${escapeHtml(pairText)}</span>
        </div>
      </div>
      <div class="account-meta">
        <div class="meta-item"><div class="k">${escapeHtml(t("account_slot"))}</div><div class="v">${slotNumber ? `#${slotNumber}` : "-"}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_expires"))}</div><div class="v">${fmtUnixSec(Number(account.expiresAt || 0))}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_last_used"))}</div><div class="v">${fmtUnixSec(Number(account.lastUsedAt || 0))}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_failures"))}</div><div class="v">${Number(account.failureCount || 0)}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_cooldown"))}</div><div class="v">${fmtCooldown(Number(account.cooldownUntil || 0))}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_plan"))}</div><div class="v">${escapeHtml(String(usage?.plan_type || "-"))}</div></div>
        <div class="meta-item"><div class="k">${escapeHtml(t("account_usage_updated"))}</div><div class="v">${fmtUnixSec(Number(account.usageUpdatedAt || usage?.fetched_at || 0))}</div></div>
      </div>
      ${usageHtml}
      ${errorHtml}
      ${actionHtml}
    </article>`;
  }

  return {
    buildAccountCardHtml,
    computeAccountScore,
    fmtLimitPair,
    getAccountIdentity,
    getAccountSlotNumber,
    healthDisplayLabel,
    limitPairTone,
    resolveAccountHealth,
    resolveUsageWindows
  };
}
