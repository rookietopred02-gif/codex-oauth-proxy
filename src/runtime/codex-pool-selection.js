import { randomInt as defaultRandomInt } from "node:crypto";

export function createCodexPoolSelectionHelpers(options) {
  const {
    getEntryId: getEntryIdOption,
    getCodexPoolEntryId,
    isAccountLeased: isAccountLeasedOption,
    isCodexAccountLeased,
    normalizePlanType,
    getStrategy,
    getPoolFilter,
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
  const getPoolFilterSafe = typeof getPoolFilter === "function" ? getPoolFilter : () => "all";

  const SMART_ACTIVE_STICKY_SECONDARY_MARGIN = 8;
  const SMART_ACTIVE_STICKY_PRIMARY_MARGIN = 12;
  const SMART_LOW_QUOTA_PAUSE_SEC = 15 * 60;
  const MODEL_CAPABILITY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

  function toFiniteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value !== "string") return fallback;
    const normalized = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return fallback;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toPositiveFiniteNumber(value, fallback = null) {
    const parsed = toFiniteNumber(value, null);
    return parsed !== null && parsed > 0 ? parsed : fallback;
  }

  function firstPositiveFiniteNumber(values, fallback = 0) {
    for (const value of Array.isArray(values) ? values : []) {
      const parsed = toPositiveFiniteNumber(value, null);
      if (parsed !== null) return parsed;
    }
    return fallback;
  }

  function toIntegerNumber(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : fallback;
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  function toPositiveInteger(value, fallback = null) {
    const parsed = toIntegerNumber(value, null);
    return parsed !== null && parsed > 0 ? parsed : fallback;
  }

  function toNonNegativeIntegerNumber(value, fallback = 0) {
    const parsed = toIntegerNumber(value, null);
    return parsed !== null && parsed >= 0 ? parsed : fallback;
  }

  function parsePercentOrNull(value) {
    const n = toFiniteNumber(value, null);
    if (n === null) return null;
    return Math.max(0, Math.min(100, n));
  }

  function normalizeCodexPoolFilter(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "exclude-free") return "exclude-free";
    if (normalized === "standard-only") return "standard-only";
    if (normalized === "team-only") return "team-only";
    if (normalized === "free-only") return "free-only";
    return "all";
  }

  function readCodexPlanTypeFromEntryId(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    const marker = "::plan:";
    const markerIndex = raw.lastIndexOf(marker);
    if (markerIndex < 0) return "";
    return raw.slice(markerIndex + marker.length).trim();
  }

  function readCodexAccountPlanType(account) {
    return (
      normalizePlanTypeSafe(
        account?.usage_snapshot?.plan_type ||
          account?.usageSnapshot?.plan_type ||
          account?.plan_type ||
          account?.planType ||
          readCodexPlanTypeFromEntryId(getEntryId?.(account)) ||
          readCodexPlanTypeFromEntryId(account?.identity_id) ||
          readCodexPlanTypeFromEntryId(account?.entry_id) ||
          readCodexPlanTypeFromEntryId(account?.entryId)
      ) || ""
    )
      .trim()
      .toLowerCase();
  }

  function matchesCodexPoolFilter(account, filter) {
    const normalizedFilter = normalizeCodexPoolFilter(filter);
    if (normalizedFilter === "all") return true;

    const planType = readCodexAccountPlanType(account);
    const isFree = planType === "free";
    const isTeam = planType.includes("team");
    const isStandard = Boolean(planType) && !isFree && !isTeam;

    if (normalizedFilter === "exclude-free") return !isFree;
    if (normalizedFilter === "standard-only") return isStandard;
    if (normalizedFilter === "team-only") return isTeam;
    if (normalizedFilter === "free-only") return isFree;
    return true;
  }

  function filterCodexPoolAccounts(accounts, filter = getPoolFilterSafe()) {
    const normalizedFilter = normalizeCodexPoolFilter(filter);
    if (normalizedFilter === "all") return Array.isArray(accounts) ? [...accounts] : [];
    return (Array.isArray(accounts) ? accounts : []).filter((account) => matchesCodexPoolFilter(account, normalizedFilter));
  }

  function hasCodexUsageWindow(usageWindow) {
    if (!usageWindow || typeof usageWindow !== "object") return false;
    const windowMinutes = toPositiveFiniteNumber(usageWindow.window_minutes, null);
    if (windowMinutes !== null) return true;

    const resetAt = toPositiveFiniteNumber(usageWindow.reset_at, null);
    if (resetAt !== null) return true;

    const resetAfterSec = toPositiveFiniteNumber(usageWindow.reset_after_seconds, null);
    if (resetAfterSec !== null) return true;

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
    let primaryWindowMinutes = toPositiveFiniteNumber(usage?.primary?.window_minutes, null);
    let secondaryWindowMinutes = toPositiveFiniteNumber(usage?.secondary?.window_minutes, null);
    const planType = String(normalizePlanTypeSafe(usage?.plan_type) || "").trim().toLowerCase();

    if (planType === "free") {
      const windows = [];
      if (primaryHasWindow) {
        windows.push({
          remaining: primaryRemaining,
          used: primaryUsed,
          minutes: primaryWindowMinutes
        });
      }
      if (secondaryHasWindow) {
        windows.push({
          remaining: secondaryRemaining,
          used: secondaryUsed,
          minutes: secondaryWindowMinutes
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
      primaryWindowMinutes = toPositiveFiniteNumber(preferred?.minutes, 10080);
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
      primaryWindowMinutes,
      secondaryWindowMinutes,
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

  function getCodexUsageWindowResetAt(usageWindow, snapshotTimestampSec = 0) {
    const resetAt = toPositiveFiniteNumber(usageWindow?.reset_at, null);
    if (resetAt !== null) return Math.floor(resetAt);

    const resetAfterSec = toPositiveFiniteNumber(usageWindow?.reset_after_seconds, null);
    if (resetAfterSec === null) return null;

    const baseTimestamp =
      Number.isFinite(snapshotTimestampSec) && snapshotTimestampSec > 0
        ? Math.floor(snapshotTimestampSec)
        : Math.floor(Date.now() / 1000);
    return baseTimestamp + Math.floor(resetAfterSec);
  }

  function getCodexSmartQuotaPauseUntil(account, nowSec = Math.floor(Date.now() / 1000), usage = null) {
    const usageStats = usage || getCodexUsageWindowStats(account);
    const usageSnapshot = account?.usage_snapshot && typeof account.usage_snapshot === "object" ? account.usage_snapshot : null;
    const snapshotTimestamp = firstPositiveFiniteNumber([account?.usage_updated_at, usageSnapshot?.fetched_at], 0);
    if (snapshotTimestamp <= 0) return 0;

    const lowQuotaThreshold = resolveCodexLowQuotaThreshold(usageStats);
    const impactedResetTimes = [];

    const primaryResetAt = getCodexUsageWindowResetAt(usageSnapshot?.primary, snapshotTimestamp);
    const secondaryResetAt = getCodexUsageWindowResetAt(usageSnapshot?.secondary, snapshotTimestamp);

    if (
      Number.isFinite(usageStats.primaryRemaining) &&
      usageStats.primaryRemaining !== null &&
      usageStats.primaryRemaining <= lowQuotaThreshold &&
      Number.isFinite(primaryResetAt)
    ) {
      impactedResetTimes.push(primaryResetAt);
    }

    if (
      Number.isFinite(usageStats.secondaryRemaining) &&
      usageStats.secondaryRemaining !== null &&
      usageStats.secondaryRemaining <= lowQuotaThresholdDualWindow &&
      Number.isFinite(secondaryResetAt)
    ) {
      impactedResetTimes.push(secondaryResetAt);
    }

    const nearestResetAt = impactedResetTimes.length > 0 ? Math.min(...impactedResetTimes) : null;
    const hardLimited = usageStats.isSingleWindow
      ? usageStats.primaryRemaining !== null && usageStats.primaryRemaining <= 0
      : (usageStats.primaryRemaining !== null && usageStats.primaryRemaining <= 0) ||
        (usageStats.secondaryRemaining !== null && usageStats.secondaryRemaining <= 0);
    if (hardLimited) {
      if (Number.isFinite(nearestResetAt) && nearestResetAt > nowSec) return nearestResetAt;
      return snapshotTimestamp + SMART_LOW_QUOTA_PAUSE_SEC;
    }

    const lowQuota =
      (usageStats.primaryRemaining !== null && usageStats.primaryRemaining <= lowQuotaThreshold) ||
      (usageStats.secondaryRemaining !== null && usageStats.secondaryRemaining <= lowQuotaThresholdDualWindow);
    if (!lowQuota) return 0;

    const shortPauseUntil = snapshotTimestamp + SMART_LOW_QUOTA_PAUSE_SEC;
    if (Number.isFinite(nearestResetAt) && nearestResetAt > nowSec) {
      return Math.min(nearestResetAt, shortPauseUntil);
    }
    return shortPauseUntil;
  }

  function classifyCodexPoolHealth(account, nowSec = Math.floor(Date.now() / 1000), usage = null) {
    const enabled = account?.enabled !== false;
    const cooldownUntil = toNonNegativeIntegerNumber(account?.cooldown_until, 0);
    const expiresAt = toNonNegativeIntegerNumber(account?.token?.expires_at, 0);
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
    const failureCount = toNonNegativeIntegerNumber(account?.failure_count, 0);
    const cooldownUntil = toNonNegativeIntegerNumber(account?.cooldown_until, 0);
    const expiresAt = toNonNegativeIntegerNumber(account?.token?.expires_at, 0);
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

    const aFailures = toNonNegativeIntegerNumber(a?.account?.failure_count, 0);
    const bFailures = toNonNegativeIntegerNumber(b?.account?.failure_count, 0);
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

    const healthScoreDiff = toFiniteNumber(b?.healthScore, 0) - toFiniteNumber(a?.healthScore, 0);
    if (healthScoreDiff !== 0) return healthScoreDiff;

    if ((b.secondaryUsed ?? -1) !== (a.secondaryUsed ?? -1)) {
      return (a.secondaryUsed ?? -1) - (b.secondaryUsed ?? -1);
    }
    if ((b.primaryUsed ?? -1) !== (a.primaryUsed ?? -1)) {
      return (a.primaryUsed ?? -1) - (b.primaryUsed ?? -1);
    }
    const aUsed = toNonNegativeIntegerNumber(a.account?.last_used_at, 0);
    const bUsed = toNonNegativeIntegerNumber(b.account?.last_used_at, 0);
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
    const selectionEligible = filterCodexPoolAccounts(
      enabled.map((account) => account.account),
      getPoolFilterSafe()
    );
    const healthy = decorated.filter((account) => account.healthStatus === "healthy");
    const cooldown = decorated.filter((account) => account.healthStatus === "cooldown");
    const atRisk = decorated.filter((account) =>
      ["disabled", "expired", "cooldown", "expiring", "limited"].includes(account.healthStatus)
    );
    const lowQuotaCount = decorated.filter((account) => account.lowQuota).length;
    const hardLimitedCount = decorated.filter((account) => account.hardLimited).length;
    const recommended = selectionEligible
      .map((account) => decorated.find((item) => item.account === account) || null)
      .filter(Boolean)
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
    const enabledAccounts = store.accounts.filter(
      (account) =>
        account &&
        account.enabled !== false &&
        toNonNegativeIntegerNumber(account.token_invalidated_at || account.tokenInvalidatedAt || 0, 0) <= 0
    );
    if (enabledAccounts.length === 0) return [];
    const filteredEnabledAccounts = filterCodexPoolAccounts(enabledAccounts, getPoolFilterSafe());
    if (filteredEnabledAccounts.length === 0) return [];
    const eligible = filteredEnabledAccounts.filter((account) => toNonNegativeIntegerNumber(account.cooldown_until, 0) <= nowSec);
    return eligible.filter((account) => {
      const health = classifyCodexPoolHealth(account, nowSec);
      return !health.hardLimited;
    });
  }

  function rotateListFromIndex(list, startIndex) {
    if (!Array.isArray(list) || list.length === 0) return [];
    const safeStart = Math.max(0, Math.min(toNonNegativeIntegerNumber(startIndex, 0), list.length - 1));
    return list.slice(safeStart).concat(list.slice(0, safeStart));
  }

  function normalizeCodexModelIds(values) {
    return [
      ...new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ].sort();
  }

  function readCachedCodexModelIds(account, nowMs = Date.now()) {
    const codexCapabilities = account?.model_capabilities?.codex;
    if (!codexCapabilities || typeof codexCapabilities !== "object" || Array.isArray(codexCapabilities)) {
      return null;
    }
    const fetchedAtRaw = toPositiveInteger(codexCapabilities.fetched_at, null);
    if (fetchedAtRaw === null) return null;
    const fetchedAtMs = fetchedAtRaw > 100000000000 ? fetchedAtRaw : fetchedAtRaw * 1000;
    if (
      !Number.isFinite(fetchedAtMs) ||
      fetchedAtMs <= 0 ||
      nowMs - fetchedAtMs > MODEL_CAPABILITY_CACHE_MAX_AGE_MS
    ) {
      return null;
    }
    const modelIds = normalizeCodexModelIds(codexCapabilities.supported_models || []);
    return modelIds.length > 0 ? modelIds : null;
  }

  function prioritizeCodexModelCapableAccounts(candidates, requestedModel) {
    const model = String(requestedModel || "").trim();
    const ordered = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!model || ordered.length === 0) return ordered;

    const nowMs = Date.now();
    const ranked = ordered.map((account, index) => {
      const cachedModels = readCachedCodexModelIds(account, nowMs);
      return {
        account,
        index,
        rank: !cachedModels ? 1 : cachedModels.includes(model) ? 0 : 2
      };
    });
    return ranked
      .filter((item) => item.rank < 2)
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((item) => item.account);
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
    const requestedModel = typeof options.requestedModel === "string" ? options.requestedModel.trim() : "";
    const strategy =
      typeof options.strategy === "string" && options.strategy.trim().length > 0
        ? options.strategy.trim()
        : typeof getStrategy === "function"
          ? String(getStrategy() || "").trim()
          : "";
    const nowSec = Math.floor(Date.now() / 1000);

    let candidates;
    if (strategy === "smart") {
      if (enabled.length === 0) return [];
      const smartEligible = enabled.filter((account) => {
        const usage = getCodexUsageWindowStats(account);
        const pauseUntil = getCodexSmartQuotaPauseUntil(account, nowSec, usage);
        return !Number.isFinite(pauseUntil) || pauseUntil <= nowSec;
      });
      if (smartEligible.length === 0) return [];
      const decorated = smartEligible.map((account) => decorateCodexPoolAccount(account, store.active_account_id || ""));
      const ranked = [...decorated].sort(compareCodexSmartDecorated);
      candidates = ranked.map((account) => account.account);
    } else if (strategy === "manual") {
      const activeRef = String(store.active_account_id || "").trim();
      const pool = filterCodexPoolAccounts(Array.isArray(store.accounts) ? store.accounts : [], getPoolFilterSafe());
      const activeAccount = pool.find((account) => account && getEntryId?.(account) === activeRef) || null;
      candidates =
        activeAccount &&
        activeAccount.enabled !== false &&
        toNonNegativeIntegerNumber(activeAccount.token_invalidated_at || activeAccount.tokenInvalidatedAt || 0, 0) <= 0 &&
        toNonNegativeIntegerNumber(activeAccount.cooldown_until, 0) <= nowSec &&
        !classifyCodexPoolHealth(activeAccount, nowSec).hardLimited
          ? [activeAccount]
          : [];
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
      const start = toNonNegativeIntegerNumber(store?.rotation?.next_index, 0) % enabled.length;
      candidates = rotateListFromIndex(enabled, start);
    }

    candidates = prioritizeCodexModelCapableAccounts(candidates, requestedModel);

    if (strategy === "manual") {
      return candidates;
    }

    if (!preferredPoolEntryId) {
      return prioritizeUnleasedCodexAccounts(candidates);
    }

    const preferred = candidates.find((account) => getEntryId?.(account) === preferredPoolEntryId);
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
    filterCodexPoolAccounts,
    readUsageRemainingPercent,
    readUsageUsedPercent,
    resolveCodexLowQuotaThreshold,
    getCodexSmartQuotaPauseUntil
  };
}
