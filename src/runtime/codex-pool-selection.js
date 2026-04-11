import { randomInt as defaultRandomInt } from "node:crypto";

export function createCodexPoolSelectionHelpers(options) {
  const {
    getEntryId: getEntryIdOption,
    getCodexPoolEntryId,
    isAccountLeased: isAccountLeasedOption,
    isCodexAccountLeased,
    normalizePlanType,
    getStrategy,
    lowQuotaThresholdDualWindow,
    lowQuotaThresholdSingleWindow,
    randomInt = defaultRandomInt
  } = options || {};

  const getEntryId =
    typeof getEntryIdOption === "function"
      ? getEntryIdOption
      : typeof getCodexPoolEntryId === "function"
        ? getCodexPoolEntryId
        : () => "";
  const isAccountLeased =
    typeof isAccountLeasedOption === "function"
      ? isAccountLeasedOption
      : typeof isCodexAccountLeased === "function"
        ? isCodexAccountLeased
        : () => false;
  const normalizePlanTypeSafe =
    typeof normalizePlanType === "function" ? normalizePlanType : (value) => String(value || "").trim().toLowerCase() || null;

  const SMART_ACTIVE_STICKY_SECONDARY_MARGIN = 8;
  const SMART_ACTIVE_STICKY_PRIMARY_MARGIN = 12;

  function parsePercentOrNull(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
  }

  function hasCodexUsageWindow(usageWindow) {
    if (!usageWindow || typeof usageWindow !== "object") return false;
    const windowMinutes = Number(usageWindow.window_minutes);
    if (Number.isFinite(windowMinutes) && windowMinutes > 0) return true;

    const resetAt = Number(usageWindow.reset_at);
    if (Number.isFinite(resetAt) && resetAt > 0) return true;

    const resetAfterSec = Number(usageWindow.reset_after_seconds);
    if (Number.isFinite(resetAfterSec) && resetAfterSec > 0) return true;

    const usedPercent = parsePercentOrNull(usageWindow.used_percent);
    if (usedPercent !== null && usedPercent > 0) return true;

    const remainingPercent = parsePercentOrNull(usageWindow.remaining_percent);
    if (remainingPercent !== null && remainingPercent < 100) return true;

    return false;
  }

  function readUsageRemainingPercent(usageWindow) {
    const direct = parsePercentOrNull(usageWindow?.remaining_percent);
    if (direct !== null) return direct;
    const used = parsePercentOrNull(usageWindow?.used_percent);
    if (used === null) return null;
    return Math.max(0, Math.min(100, 100 - used));
  }

  function readUsageUsedPercent(usageWindow) {
    const direct = parsePercentOrNull(usageWindow?.used_percent);
    if (direct !== null) return direct;
    const remaining = parsePercentOrNull(usageWindow?.remaining_percent);
    if (remaining === null) return null;
    return Math.max(0, Math.min(100, 100 - remaining));
  }

  function getCodexUsageWindowStats(account) {
    const usage = account?.usage_snapshot || null;
    let primaryHasWindow = hasCodexUsageWindow(usage?.primary);
    let secondaryHasWindow = hasCodexUsageWindow(usage?.secondary);
    let primaryRemaining = primaryHasWindow ? readUsageRemainingPercent(usage?.primary) : null;
    let secondaryRemaining = secondaryHasWindow ? readUsageRemainingPercent(usage?.secondary) : null;
    let primaryUsed = primaryHasWindow ? readUsageUsedPercent(usage?.primary) : null;
    let secondaryUsed = secondaryHasWindow ? readUsageUsedPercent(usage?.secondary) : null;
    let primaryWindowMinutes = Number(usage?.primary?.window_minutes);
    let secondaryWindowMinutes = Number(usage?.secondary?.window_minutes);
    const planType = String(normalizePlanTypeSafe(usage?.plan_type) || "").trim().toLowerCase();

    if (planType === "free") {
      const windows = [];
      if (primaryHasWindow) {
        windows.push({
          remaining: primaryRemaining,
          used: primaryUsed,
          minutes: Number.isFinite(primaryWindowMinutes) ? primaryWindowMinutes : null
        });
      }
      if (secondaryHasWindow) {
        windows.push({
          remaining: secondaryRemaining,
          used: secondaryUsed,
          minutes: Number.isFinite(secondaryWindowMinutes) ? secondaryWindowMinutes : null
        });
      }

      const pickScore = (windowStats) => {
        const remaining = Number.isFinite(windowStats?.remaining) ? windowStats.remaining : 100;
        const used = Number.isFinite(windowStats?.used) ? windowStats.used : 0;
        return used > 0 || remaining < 100 ? 1000 - remaining + used : 0;
      };
      const preferred = windows
        .map((windowStats) => ({ windowStats, score: pickScore(windowStats) }))
        .sort((left, right) => right.score - left.score)[0]?.windowStats;

      primaryHasWindow = Boolean(preferred);
      secondaryHasWindow = false;
      primaryRemaining = preferred?.remaining ?? null;
      primaryUsed = preferred?.used ?? null;
      primaryWindowMinutes = Number.isFinite(preferred?.minutes) ? preferred.minutes : 10080;
      secondaryRemaining = null;
      secondaryUsed = null;
      secondaryWindowMinutes = null;
    }

    const isSingleWindow = primaryHasWindow && !secondaryHasWindow;
    return {
      planType,
      isSingleWindow,
      primaryHasWindow,
      secondaryHasWindow,
      primaryWindowMinutes: Number.isFinite(primaryWindowMinutes) ? primaryWindowMinutes : null,
      secondaryWindowMinutes: Number.isFinite(secondaryWindowMinutes) ? secondaryWindowMinutes : null,
      primaryRemaining,
      secondaryRemaining,
      primaryUsed,
      secondaryUsed
    };
  }

  function resolveCodexLowQuotaThreshold(usageStats) {
    if (!usageStats || typeof usageStats !== "object") return lowQuotaThresholdDualWindow;
    if (usageStats.isSingleWindow) return lowQuotaThresholdSingleWindow;
    if (usageStats.planType === "free") return lowQuotaThresholdSingleWindow;
    return lowQuotaThresholdDualWindow;
  }

  function classifyCodexPoolHealth(account, nowSec = Math.floor(Date.now() / 1000), usage = null) {
    const enabled = account?.enabled !== false;
    const cooldownUntil = Number(account?.cooldown_until || 0);
    const expiresAt = Number(account?.token?.expires_at || 0);
    const inCooldown = cooldownUntil > nowSec;
    const expired = expiresAt > 0 && expiresAt <= nowSec;
    const expiringSoon = expiresAt > nowSec && expiresAt - nowSec < 180;
    const usageStats = usage || getCodexUsageWindowStats(account);
    const primaryRemaining = usageStats.primaryRemaining;
    const secondaryRemaining = usageStats.secondaryRemaining;
    const lowQuotaThreshold = resolveCodexLowQuotaThreshold(usageStats);
    const hardLimited = usageStats.isSingleWindow
      ? primaryRemaining !== null && primaryRemaining <= 0
      : (primaryRemaining !== null && primaryRemaining <= 0) ||
        (secondaryRemaining !== null && secondaryRemaining <= 0);
    const lowQuota =
      (primaryRemaining !== null && primaryRemaining <= lowQuotaThreshold) ||
      (secondaryRemaining !== null && secondaryRemaining <= lowQuotaThresholdDualWindow);

    if (!enabled) return { status: "disabled", hardLimited, lowQuota };
    if (expired) return { status: "expired", hardLimited, lowQuota };
    if (inCooldown) return { status: "cooldown", hardLimited, lowQuota };
    if (hardLimited) return { status: "limited", hardLimited, lowQuota };
    if (expiringSoon) return { status: "expiring", hardLimited, lowQuota };
    if (lowQuota) return { status: "limited", hardLimited, lowQuota };
    return { status: "healthy", hardLimited, lowQuota };
  }

  function computeCodexPoolHealthScore(
    account,
    activeEntryId = "",
    nowSec = Math.floor(Date.now() / 1000),
    usage = null,
    health = null
  ) {
    const usageStats = usage || getCodexUsageWindowStats(account);
    const healthMeta = health || classifyCodexPoolHealth(account, nowSec, usageStats);
    const failureCount = Number(account?.failure_count || 0);
    const cooldownUntil = Number(account?.cooldown_until || 0);
    const expiresAt = Number(account?.token?.expires_at || 0);
    const isActive = getEntryId?.(account) === String(activeEntryId || "");

    let score = 100;
    if (account?.enabled === false) score -= 90;
    if (healthMeta.status === "expired") score -= 80;
    if (healthMeta.status === "cooldown") score -= 35;
    if (healthMeta.status === "expiring") score -= 15;
    if (healthMeta.status === "limited") {
      if (healthMeta.hardLimited) score -= 28;
      else score -= usageStats.isSingleWindow ? 20 : 12;
    }
    if (usageStats.primaryUsed !== null) score -= Math.round(usageStats.primaryUsed * 0.35);
    if (usageStats.secondaryUsed !== null) score -= Math.round(usageStats.secondaryUsed * 0.15);
    score -= Math.min(55, failureCount * 11);
    if (cooldownUntil > nowSec) {
      const remain = cooldownUntil - nowSec;
      score -= Math.min(18, Math.floor(remain / 20));
    }
    if (expiresAt > nowSec && expiresAt - nowSec < 180) {
      score -= 8;
    }
    if (isActive) score += 3;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function decorateCodexPoolAccount(account, activeEntryId = "", nowSec = Math.floor(Date.now() / 1000)) {
    const usage = getCodexUsageWindowStats(account);
    const health = classifyCodexPoolHealth(account, nowSec, usage);
    const healthScore = computeCodexPoolHealthScore(account, activeEntryId, nowSec, usage, health);
    const entryId = getEntryId?.(account) || "";
    return {
      account,
      entryId,
      isActive: entryId === String(activeEntryId || ""),
      healthStatus: health.status,
      healthScore,
      primaryRemaining: usage.primaryRemaining,
      secondaryRemaining: usage.secondaryRemaining,
      primaryUsed: usage.primaryUsed,
      secondaryUsed: usage.secondaryUsed,
      hardLimited: health.hardLimited,
      lowQuota: health.lowQuota
    };
  }

  function getCodexSmartHealthPriority(decorated) {
    if (!decorated || typeof decorated !== "object") return 99;
    if (decorated.healthStatus === "healthy") return 0;
    if (decorated.healthStatus === "expiring") return 1;
    if (decorated.healthStatus === "limited") return decorated.hardLimited ? 3 : 2;
    if (decorated.healthStatus === "cooldown") return 4;
    if (decorated.healthStatus === "disabled") return 5;
    if (decorated.healthStatus === "expired") return 6;
    return 7;
  }

  function isWithinCodexSmartStickyMargin(activeValue, otherValue, margin) {
    if (!Number.isFinite(otherValue)) return true;
    if (!Number.isFinite(activeValue)) return false;
    return otherValue - activeValue <= margin;
  }

  function compareCodexSmartActiveStickiness(a, b) {
    const aIsActive = a?.isActive === true;
    const bIsActive = b?.isActive === true;
    if (aIsActive === bIsActive) return 0;

    const active = aIsActive ? a : b;
    const other = aIsActive ? b : a;
    const withinSecondary = isWithinCodexSmartStickyMargin(
      active?.secondaryRemaining,
      other?.secondaryRemaining,
      SMART_ACTIVE_STICKY_SECONDARY_MARGIN
    );
    const withinPrimary = isWithinCodexSmartStickyMargin(
      active?.primaryRemaining,
      other?.primaryRemaining,
      SMART_ACTIVE_STICKY_PRIMARY_MARGIN
    );

    if (withinSecondary && withinPrimary) {
      return aIsActive ? -1 : 1;
    }
    return 0;
  }

  function compareCodexSmartDecorated(a, b) {
    const healthPriorityDiff = getCodexSmartHealthPriority(a) - getCodexSmartHealthPriority(b);
    if (healthPriorityDiff !== 0) return healthPriorityDiff;

    const aFailures = Number(a?.account?.failure_count || 0);
    const bFailures = Number(b?.account?.failure_count || 0);
    const aFailureBlocked = aFailures >= 5 ? 1 : 0;
    const bFailureBlocked = bFailures >= 5 ? 1 : 0;
    if (aFailureBlocked !== bFailureBlocked) return aFailureBlocked - bFailureBlocked;
    if (aFailures !== bFailures) return aFailures - bFailures;

    const aHardLimited = a?.hardLimited === true ? 1 : 0;
    const bHardLimited = b?.hardLimited === true ? 1 : 0;
    if (aHardLimited !== bHardLimited) return aHardLimited - bHardLimited;

    const aLowQuota = a?.lowQuota === true ? 1 : 0;
    const bLowQuota = b?.lowQuota === true ? 1 : 0;
    if (aLowQuota !== bLowQuota) return aLowQuota - bLowQuota;

    const activeStickinessDiff = compareCodexSmartActiveStickiness(a, b);
    if (activeStickinessDiff !== 0) return activeStickinessDiff;

    if ((b.secondaryRemaining ?? -1) !== (a.secondaryRemaining ?? -1)) {
      return (b.secondaryRemaining ?? -1) - (a.secondaryRemaining ?? -1);
    }
    if ((b.primaryRemaining ?? -1) !== (a.primaryRemaining ?? -1)) {
      return (b.primaryRemaining ?? -1) - (a.primaryRemaining ?? -1);
    }

    const aIsActive = a?.isActive === true;
    const bIsActive = b?.isActive === true;
    if (aIsActive !== bIsActive) return aIsActive ? -1 : 1;

    const healthScoreDiff = Number(b?.healthScore || 0) - Number(a?.healthScore || 0);
    if (healthScoreDiff !== 0) return healthScoreDiff;

    if ((b.secondaryUsed ?? -1) !== (a.secondaryUsed ?? -1)) {
      return (a.secondaryUsed ?? -1) - (b.secondaryUsed ?? -1);
    }
    if ((b.primaryUsed ?? -1) !== (a.primaryUsed ?? -1)) {
      return (a.primaryUsed ?? -1) - (b.primaryUsed ?? -1);
    }
    const aUsed = Number(a.account?.last_used_at || 0);
    const bUsed = Number(b.account?.last_used_at || 0);
    if (aUsed !== bUsed) return aUsed - bUsed;
    return String(a.entryId || "").localeCompare(String(b.entryId || ""));
  }

  function buildCodexPoolMetrics(accounts, activeEntryId = "") {
    const nowSec = Math.floor(Date.now() / 1000);
    const decorated = (Array.isArray(accounts) ? accounts : []).map((account) =>
      decorateCodexPoolAccount(account, activeEntryId, nowSec)
    );
    const primaryValues = decorated
      .map((account) => account.primaryRemaining)
      .filter((value) => Number.isFinite(value));
    const secondaryValues = decorated
      .map((account) => account.secondaryRemaining)
      .filter((value) => Number.isFinite(value));
    const enabled = decorated.filter((account) => account.account?.enabled !== false);
    const healthy = decorated.filter((account) => account.healthStatus === "healthy");
    const cooldown = decorated.filter((account) => account.healthStatus === "cooldown");
    const atRisk = decorated.filter((account) =>
      ["disabled", "expired", "cooldown", "expiring", "limited"].includes(account.healthStatus)
    );
    const lowQuotaCount = decorated.filter((account) => account.lowQuota).length;
    const hardLimitedCount = decorated.filter((account) => account.hardLimited).length;
    const recommended = [...enabled]
      .sort(compareCodexSmartDecorated)
      .slice(0, 5)
      .map((account) => account.entryId);
    return {
      decorated,
      summary: {
        totalAccounts: decorated.length,
        enabledAccounts: enabled.length,
        healthyRatio: enabled.length > 0 ? Math.round((healthy.length / enabled.length) * 100) : 0,
        cooldownCount: cooldown.length,
        atRiskCount: atRisk.length,
        lowQuotaCount,
        hardLimitedCount,
        avgPrimaryRemaining:
          primaryValues.length > 0
            ? Math.round(primaryValues.reduce((left, right) => left + right, 0) / primaryValues.length)
            : null,
        avgSecondaryRemaining:
          secondaryValues.length > 0
            ? Math.round(secondaryValues.reduce((left, right) => left + right, 0) / secondaryValues.length)
            : null,
        recommendedEntryIds: recommended
      }
    };
  }

  function getCodexEnabledAccounts(store) {
    if (!Array.isArray(store?.accounts)) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    const enabledAccounts = store.accounts.filter((account) => account && account.enabled !== false);
    if (enabledAccounts.length === 0) return [];
    const eligible = enabledAccounts.filter((account) => Number(account.cooldown_until || 0) <= nowSec);
    return eligible.filter((account) => {
      const health = classifyCodexPoolHealth(account, nowSec);
      return !health.hardLimited;
    });
  }

  function rotateListFromIndex(list, startIndex) {
    if (!Array.isArray(list) || list.length === 0) return [];
    const safeStart = Math.max(0, Math.min(Number(startIndex || 0), list.length - 1));
    return list.slice(safeStart).concat(list.slice(0, safeStart));
  }

  function prioritizeUnleasedCodexAccounts(candidates, preferredPoolEntryId = "") {
    const ordered = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (ordered.length <= 1) return ordered;

    const preferredId = typeof preferredPoolEntryId === "string" ? preferredPoolEntryId.trim() : "";
    const preferred = preferredId
      ? ordered.find((account) => getEntryId?.(account) === preferredId) || null
      : null;
    const remaining = preferred
      ? ordered.filter((account) => getEntryId?.(account) !== preferredId)
      : ordered;

    const unleased = remaining.filter((account) => !isAccountLeased?.(getEntryId?.(account), account));
    if (unleased.length === 0) {
      return preferred ? [preferred, ...remaining] : remaining;
    }

    const leased = remaining.filter((account) => isAccountLeased?.(getEntryId?.(account), account));
    return preferred ? [preferred, ...unleased, ...leased] : [...unleased, ...leased];
  }

  function pickCodexAccountCandidates(store, options = {}) {
    const enabled = getCodexEnabledAccounts(store);
    const preferredPoolEntryId =
      typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";
    const strategy =
      typeof options.strategy === "string" && options.strategy.trim().length > 0
        ? options.strategy.trim()
        : typeof getStrategy === "function"
          ? String(getStrategy() || "").trim()
          : "";

    let candidates;
    if (strategy === "smart") {
      if (enabled.length === 0) return [];
      const decorated = enabled.map((account) => decorateCodexPoolAccount(account, store.active_account_id || ""));
      const ranked = [...decorated].sort(compareCodexSmartDecorated);
      candidates = ranked.map((account) => account.account);
    } else if (strategy === "manual") {
      const activeRef = String(store.active_account_id || "").trim();
      const pool = Array.isArray(store.accounts) ? store.accounts : [];
      const activeAccount = pool.find((account) => account && getEntryId?.(account) === activeRef) || null;
      candidates = activeAccount && activeAccount.enabled !== false ? [activeAccount] : [];
    } else if (strategy === "sticky" && store.active_account_id) {
      if (enabled.length === 0) return [];
      const primary = enabled.find((account) => getEntryId?.(account) === String(store.active_account_id));
      if (primary) {
        const primaryId = getEntryId?.(primary);
        candidates = [primary, ...enabled.filter((account) => getEntryId?.(account) !== primaryId)];
      }
    } else if (strategy === "random") {
      if (enabled.length === 0) return [];
      const shuffled = [...enabled];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = randomInt(0, index + 1);
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      candidates = shuffled;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      if (strategy === "manual") return [];
      if (enabled.length === 0) return [];
      const start = Number(store?.rotation?.next_index || 0) % enabled.length;
      candidates = rotateListFromIndex(enabled, start);
    }

    if (strategy === "manual") {
      return candidates;
    }

    if (!preferredPoolEntryId) {
      return prioritizeUnleasedCodexAccounts(candidates);
    }

    const preferredPool = (Array.isArray(store?.accounts) ? store.accounts : []).filter(
      (account) => account && account.enabled !== false
    );
    const preferred = preferredPool.find((account) => getEntryId?.(account) === preferredPoolEntryId);
    if (!preferred) return prioritizeUnleasedCodexAccounts(candidates);

    const preferredId = getEntryId?.(preferred);
    return prioritizeUnleasedCodexAccounts(
      [preferred, ...candidates.filter((account) => getEntryId?.(account) !== preferredId)],
      preferredId
    );
  }

  return {
    buildCodexPoolMetrics,
    classifyCodexPoolHealth,
    compareCodexSmartDecorated,
    computeCodexPoolHealthScore,
    decorateCodexPoolAccount,
    hasCodexUsageWindow,
    getCodexEnabledAccounts,
    getCodexUsageWindowStats,
    parsePercentOrNull,
    pickCodexAccountCandidates,
    readUsageRemainingPercent,
    readUsageUsedPercent,
    resolveCodexLowQuotaThreshold
  };
}
