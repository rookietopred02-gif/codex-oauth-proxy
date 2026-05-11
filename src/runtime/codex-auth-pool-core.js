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

  function normalizeNonEmptyString(value) {
    const text = String(value || "").trim();
    return text.length > 0 ? text : "";
  }

  function toIntegerNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) ? value : fallback;
    }
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  function toNonNegativeIntegerNumber(value, fallback = 0) {
    const parsed = toIntegerNumber(value, null);
    return parsed !== null && parsed >= 0 ? parsed : fallback;
  }

  function toPositiveIntegerNumber(value, fallback = 0) {
    const parsed = toIntegerNumber(value, null);
    return parsed !== null && parsed > 0 ? parsed : fallback;
  }

  function toNonNegativeInteger(value, fallback = 0) {
    return toNonNegativeIntegerNumber(value, fallback);
  }

  function toHttpStatusCode(value, fallback = 0) {
    if (typeof value === "number") {
      return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
    }
    if (typeof value === "string" && /^[1-5]\d{2}$/.test(value)) {
      return Number(value);
    }
    return fallback;
  }

  function readSlotValue(value) {
    try {
      return parseSlotValue(value);
    } catch {
      return null;
    }
  }

  function extractTokenAccountId(tokenLike) {
    const accessToken = tokenLike?.access_token || tokenLike?.access || "";
    return normalizeNonEmptyString(extractAccountId(accessToken));
  }

  function extractTokenPlanType(tokenLike) {
    const accessToken = tokenLike?.access_token || tokenLike?.access || "";
    return normalizePlanType(extractPlanType(accessToken));
  }

  function extractEmailFromTokenLike(tokenLike) {
    const candidates = [
      tokenLike?.access_token,
      tokenLike?.access,
      tokenLike?.id_token,
      tokenLike?.id
    ];
    for (const candidate of candidates) {
      const email = normalizeNonEmptyString(extractEmail(candidate || ""));
      if (email) return email;
    }
    return "";
  }

  function normalizeEmailLike(value) {
    const text = normalizeNonEmptyString(value);
    return text.includes("@") ? text.toLowerCase() : "";
  }

  function isGeneratedCodexAccountLabel(value) {
    const text = normalizeNonEmptyString(value);
    if (!text) return false;
    return (
      /^(?:acc|account|slot)[-_\s]*\d+$/i.test(text) ||
      /^unnamed(?:-account)?$/i.test(text) ||
      /^generated-key$/i.test(text)
    );
  }

  function normalizeUserFacingCodexAccountLabel(value, { accountId = "", entryId = "" } = {}) {
    const text = normalizeNonEmptyString(value);
    if (!text || isGeneratedCodexAccountLabel(text)) return "";
    if (text === normalizeNonEmptyString(accountId) || text === normalizeNonEmptyString(entryId)) return "";
    return text;
  }

  function resolveCodexAccountLabel({ currentLabel = "", incomingLabel = "", tokenLike = null, accountId = "", entryId = "" } = {}) {
    const tokenEmail = extractEmailFromTokenLike(tokenLike);
    const normalizedTokenEmail = normalizeEmailLike(tokenEmail);
    const normalizedCurrentEmail = normalizeEmailLike(currentLabel);
    return (
      (normalizedCurrentEmail && normalizedTokenEmail && normalizedCurrentEmail !== normalizedTokenEmail
        ? ""
        : normalizeUserFacingCodexAccountLabel(currentLabel, { accountId, entryId })) ||
      normalizeUserFacingCodexAccountLabel(incomingLabel, { accountId, entryId }) ||
      tokenEmail
    );
  }

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

  function stripCodexPoolPlanSuffix(value) {
    const raw = normalizeNonEmptyString(value);
    if (!raw) return "";
    const marker = "::plan:";
    const markerIndex = raw.lastIndexOf(marker);
    return markerIndex >= 0 ? raw.slice(0, markerIndex) : raw;
  }

  function hasCodexPoolPlanSuffix(value) {
    return stripCodexPoolPlanSuffix(value) !== normalizeNonEmptyString(value);
  }

  function readCodexEntryBaseId(value) {
    return stripCodexPoolPlanSuffix(value);
  }

  function readCodexEntryPrincipalRoot(value) {
    const baseId = readCodexEntryBaseId(value);
    if (!baseId) return "";
    const separatorIndex = baseId.indexOf("__");
    return separatorIndex >= 0 ? baseId.slice(0, separatorIndex) : baseId;
  }

  function readCodexEntryAccountSuffix(value) {
    const baseId = readCodexEntryBaseId(value);
    if (!baseId) return "";
    const separatorIndex = baseId.indexOf("__");
    return separatorIndex >= 0 ? baseId.slice(separatorIndex + 2) : "";
  }

  function readCodexPlanTypeFromEntryId(value) {
    const raw = normalizeNonEmptyString(value);
    if (!raw) return null;
    const marker = "::plan:";
    const markerIndex = raw.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    return normalizePlanType(raw.slice(markerIndex + marker.length));
  }

  function resolveCodexAccountPlanType(account, entryId = getCodexPoolEntryId(account)) {
    return (
      readCodexPlanTypeFromEntryId(entryId) ||
      normalizePlanType(account?.usage_snapshot?.plan_type) ||
      normalizePlanType(account?.plan_type) ||
      null
    );
  }

  function resolveStoredCodexAccountId(tokenLike, incomingAccountId = "", planType = null) {
    const explicitAccountId = normalizeNonEmptyString(incomingAccountId);
    const tokenAccountId = extractTokenAccountId(tokenLike);
    const normalizedPlanType = normalizePlanType(planType);
    const tokenPlanType = extractTokenPlanType(tokenLike);

    if (!explicitAccountId) return tokenAccountId;
    if (!tokenAccountId || explicitAccountId === tokenAccountId) return explicitAccountId;
    if (normalizedPlanType && tokenPlanType && normalizedPlanType !== tokenPlanType) {
      return explicitAccountId;
    }
    return tokenAccountId;
  }

  function buildCodexAccountLegacyKey(accountId = "", entryId = "") {
    const principalRoot = readCodexEntryPrincipalRoot(entryId);
    if (principalRoot) return `principal:${principalRoot}`;
    const baseEntryId = readCodexEntryBaseId(entryId);
    return baseEntryId ? `entry:${baseEntryId}` : "";
  }

  function buildCodexAccountVariantKey(accountId = "", entryId = "", planType = null) {
    const legacyKey = buildCodexAccountLegacyKey(accountId, entryId);
    if (!legacyKey) return "";
    const normalizedPlanType = normalizePlanType(planType);
    return normalizedPlanType ? `${legacyKey}::plan:${normalizedPlanType}` : legacyKey;
  }

  function sameCodexAccountToken(left, right) {
    const leftAccessToken = normalizeNonEmptyString(left?.access_token || left?.access);
    const rightAccessToken = normalizeNonEmptyString(right?.access_token || right?.access);
    if (leftAccessToken && rightAccessToken && leftAccessToken === rightAccessToken) return true;

    const leftRefreshToken = normalizeNonEmptyString(left?.refresh_token || left?.refresh);
    const rightRefreshToken = normalizeNonEmptyString(right?.refresh_token || right?.refresh);
    if (leftRefreshToken && rightRefreshToken && leftRefreshToken === rightRefreshToken) return true;

    return false;
  }

  function countMeaningfulObjectValues(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.values(value).reduce((count, entry) => {
      if (entry === null || entry === undefined) return count;
      if (typeof entry === "string" && entry.trim().length === 0) return count;
      return count + 1;
    }, 0);
  }

  function choosePreferredCodexEntryId(existing, incoming, preferredAccountId = "") {
    const existingId = getCodexPoolEntryId(existing);
    const incomingId = getCodexPoolEntryId(incoming);
    if (!existingId) return incomingId;
    if (!incomingId) return existingId;

    const existingBase = stripCodexPoolPlanSuffix(existingId);
    const incomingBase = stripCodexPoolPlanSuffix(incomingId);
    if (existingBase && existingBase === incomingBase) {
      const existingHasPlan = hasCodexPoolPlanSuffix(existingId);
      const incomingHasPlan = hasCodexPoolPlanSuffix(incomingId);
      if (existingHasPlan !== incomingHasPlan) {
        return incomingHasPlan ? incomingId : existingId;
      }
    }

    const normalizedPreferredAccountId = normalizeNonEmptyString(preferredAccountId);
    if (normalizedPreferredAccountId) {
      const existingMatchesPreferred = readCodexEntryAccountSuffix(existingId) === normalizedPreferredAccountId;
      const incomingMatchesPreferred = readCodexEntryAccountSuffix(incomingId) === normalizedPreferredAccountId;
      if (existingMatchesPreferred !== incomingMatchesPreferred) {
        return incomingMatchesPreferred ? incomingId : existingId;
      }
    }

    return incomingId.length > existingId.length ? incomingId : existingId;
  }

  function pickRicherCodexUsageSnapshot(existing, incoming) {
    const existingScore = countMeaningfulObjectValues(existing);
    const incomingScore = countMeaningfulObjectValues(incoming);
    if (incomingScore > existingScore) return incoming;
    if (existingScore > 0) return existing;
    return incomingScore > 0 ? incoming : null;
  }

  function mergeSanitizedCodexAccountEntries(existing, incoming) {
    const token = incoming?.token ? normalizeToken(incoming.token, existing?.token || null) : existing?.token || null;
    const usageSnapshot = pickRicherCodexUsageSnapshot(existing?.usage_snapshot, incoming?.usage_snapshot);
    const planType =
      resolveCodexAccountPlanType(incoming) ||
      resolveCodexAccountPlanType(existing) ||
      null;
    const accountId = resolveStoredCodexAccountId(
      token,
      normalizeNonEmptyString(incoming?.account_id) || normalizeNonEmptyString(existing?.account_id),
      planType
    );
    const identityId = choosePreferredCodexEntryId(existing, incoming, accountId);
    const createdAtCandidates = [existing?.created_at, incoming?.created_at]
      .map((value) => toPositiveIntegerNumber(value, null))
      .filter((value) => value !== null);
    const createdAt =
      createdAtCandidates.length > 0
        ? Math.min(...createdAtCandidates)
        : Math.floor(Date.now() / 1000);

    return {
      ...existing,
      ...incoming,
      identity_id: identityId,
      account_id: accountId,
      label: resolveCodexAccountLabel({
        currentLabel: existing?.label,
        incomingLabel: incoming?.label,
        tokenLike: token,
        accountId,
        entryId: identityId
      }),
      enabled: existing?.enabled !== false || incoming?.enabled !== false,
      token,
      slot: readSlotValue(existing?.slot) ?? readSlotValue(incoming?.slot),
      created_at: createdAt,
      last_used_at: Math.max(
        toNonNegativeIntegerNumber(existing?.last_used_at, 0),
        toNonNegativeIntegerNumber(incoming?.last_used_at, 0)
      ),
      failure_count: Math.max(
        toNonNegativeIntegerNumber(existing?.failure_count, 0),
        toNonNegativeIntegerNumber(incoming?.failure_count, 0)
      ),
      cooldown_until: Math.max(
        toNonNegativeIntegerNumber(existing?.cooldown_until, 0),
        toNonNegativeIntegerNumber(incoming?.cooldown_until, 0)
      ),
      last_error: normalizeNonEmptyString(incoming?.last_error) || normalizeNonEmptyString(existing?.last_error),
      last_status_code: toHttpStatusCode(incoming?.last_status_code || existing?.last_status_code || 0, 0),
      token_invalidated_at: Math.max(
        toNonNegativeIntegerNumber(existing?.token_invalidated_at, 0),
        toNonNegativeIntegerNumber(incoming?.token_invalidated_at, 0)
      ),
      usage_snapshot: usageSnapshot,
      usage_updated_at: Math.max(
        toNonNegativeIntegerNumber(existing?.usage_updated_at, 0),
        toNonNegativeIntegerNumber(incoming?.usage_updated_at, 0),
        toNonNegativeIntegerNumber(usageSnapshot?.fetched_at, 0)
      )
    };
  }

  function dedupeSanitizedCodexAccounts(accounts) {
    const deduped = [];
    let changed = false;

    function buildDeduplicationState() {
      const indexByVariantKey = new Map();
      const planlessIndexByLegacyKey = new Map();
      const variantIndexesByLegacyKey = new Map();

      deduped.forEach((account, index) => {
        const entryId = getCodexPoolEntryId(account);
        const accountId = normalizeNonEmptyString(account?.account_id);
        const planType = resolveCodexAccountPlanType(account, entryId);
        const legacyKey = buildCodexAccountLegacyKey(accountId, entryId);
        const variantKey = buildCodexAccountVariantKey(accountId, entryId, planType);
        if (variantKey) {
          indexByVariantKey.set(variantKey, index);
        }
        if (!legacyKey) return;
        if (planType) {
          const existingIndexes = variantIndexesByLegacyKey.get(legacyKey) || new Set();
          existingIndexes.add(index);
          variantIndexesByLegacyKey.set(legacyKey, existingIndexes);
          return;
        }
        planlessIndexByLegacyKey.set(legacyKey, index);
      });

      return {
        indexByVariantKey,
        planlessIndexByLegacyKey,
        variantIndexesByLegacyKey
      };
    }

    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (!account) continue;
      const entryId = getCodexPoolEntryId(account);
      const accountId = normalizeNonEmptyString(account?.account_id);
      const planType = resolveCodexAccountPlanType(account, entryId);
      const legacyKey = buildCodexAccountLegacyKey(accountId, entryId);
      const variantKey = buildCodexAccountVariantKey(accountId, entryId, planType);

      let existingIndex = -1;
      const dedupeState = buildDeduplicationState();

      if (variantKey && dedupeState.indexByVariantKey.has(variantKey)) {
        existingIndex = dedupeState.indexByVariantKey.get(variantKey);
      } else if (legacyKey) {
        if (planType) {
          const planlessIndex = dedupeState.planlessIndexByLegacyKey.get(legacyKey);
          if (planlessIndex !== undefined) {
            existingIndex = planlessIndex;
          }
        } else {
          const planfulIndexes = [...(dedupeState.variantIndexesByLegacyKey.get(legacyKey) || new Set())];
          const tokenMatchedPlanfulIndexes = planfulIndexes.filter((index) =>
            sameCodexAccountToken(deduped[index]?.token, account?.token)
          );
          if (tokenMatchedPlanfulIndexes.length === 1) {
            existingIndex = tokenMatchedPlanfulIndexes[0];
          } else if (tokenMatchedPlanfulIndexes.length === 0 && planfulIndexes.length === 1) {
            existingIndex = planfulIndexes[0];
          } else {
            const planlessIndex = dedupeState.planlessIndexByLegacyKey.get(legacyKey);
            if (planlessIndex !== undefined) {
              existingIndex = planlessIndex;
            }
          }
        }
      }

      if (existingIndex < 0 && normalizeNonEmptyString(account?.token?.access_token)) {
        existingIndex = deduped.findIndex((existing) => {
          if (!sameCodexAccountToken(existing?.token, account?.token)) return false;
          const existingEntryId = getCodexPoolEntryId(existing);
          const existingAccountId = normalizeNonEmptyString(existing?.account_id);
          const existingPlanType = resolveCodexAccountPlanType(existing, existingEntryId);
          const existingLegacyKey = buildCodexAccountLegacyKey(existingAccountId, existingEntryId);
          const existingVariantKey = buildCodexAccountVariantKey(existingAccountId, existingEntryId, existingPlanType);
          if (variantKey) return existingVariantKey === variantKey;
          if (legacyKey) return existingLegacyKey === legacyKey && !existingPlanType;
          return !existingLegacyKey && !existingVariantKey;
        });
      }

      if (existingIndex < 0 && !variantKey && !legacyKey) {
        deduped.push(account);
        continue;
      }
      if (existingIndex < 0) {
        deduped.push(account);
        continue;
      }

      deduped[existingIndex] = mergeSanitizedCodexAccountEntries(deduped[existingIndex], account);
      changed = true;
    }

    return { accounts: deduped, changed };
  }

  function deriveCodexPoolEntryIdFromToken(tokenLike, extra = {}) {
    const accessToken = tokenLike?.access_token || tokenLike?.access || "";
    const tokenAccountId = extractAccountId(accessToken);
    const accountId = normalizeNonEmptyString(extra.accountId) || tokenAccountId;
    let principalId = extractPrincipalId(accessToken);
    if (
      principalId &&
      accountId &&
      tokenAccountId &&
      principalId.endsWith(`__${tokenAccountId}`)
    ) {
      principalId = `${principalId.slice(0, -tokenAccountId.length)}${accountId}`;
    }
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
    const fallbackAccountId = String(raw.account_id || raw.accountId || "").trim();
    const persistedPlanType =
      normalizePlanType(raw?.usage_snapshot?.plan_type) ||
      normalizePlanType(raw?.plan_type);
    const accountId = resolveStoredCodexAccountId(normalizedToken, fallbackAccountId, persistedPlanType);
    const tokenEntryId = deriveCodexPoolEntryIdFromToken(normalizedToken, {
      planType: persistedPlanType,
      accountId: accountId || null
    });
    const fallbackEntryId = String(raw.identity_id || raw.entry_id || raw.account_id || "").trim();
    const entryId = tokenEntryId || fallbackEntryId;
    if (!accountId || !entryId) return null;
    const label = resolveCodexAccountLabel({
      currentLabel: raw.label,
      tokenLike: normalizedToken,
      accountId,
      entryId
    });
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      identity_id: entryId,
      account_id: accountId,
      label,
      slot: readSlotValue(raw.slot),
      enabled: raw.enabled !== false,
      token: normalizedToken,
      created_at: toPositiveIntegerNumber(raw.created_at || raw.createdAt || nowSec, nowSec),
      last_used_at: toNonNegativeIntegerNumber(raw.last_used_at || raw.lastUsedAt || 0, 0),
      failure_count: toNonNegativeIntegerNumber(raw.failure_count || raw.failureCount || 0, 0),
      cooldown_until: toNonNegativeIntegerNumber(raw.cooldown_until || raw.cooldownUntil || 0, 0),
      last_error: typeof raw.last_error === "string" ? raw.last_error : "",
      last_status_code: toHttpStatusCode(raw.last_status_code || raw.lastStatusCode || 0, 0),
      token_invalidated_at: toNonNegativeIntegerNumber(raw.token_invalidated_at || raw.tokenInvalidatedAt || 0, 0),
      usage_snapshot:
        raw.usage_snapshot && typeof raw.usage_snapshot === "object" ? raw.usage_snapshot : null,
      usage_updated_at: toNonNegativeIntegerNumber(raw.usage_updated_at || raw.usageUpdatedAt || 0, 0)
    };
  }

  function normalizeCodexAccountSlots(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return false;

    let changed = false;
    const used = new Set();
    const needsAssignment = [];

    for (const account of accounts) {
      const slot = readSlotValue(account?.slot);
      if (slot && !used.has(slot)) {
        if (toPositiveIntegerNumber(account.slot, null) !== slot) {
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
        next_index: toNonNegativeInteger(src?.rotation?.next_index || src?.rotation?.nextIndex || 0, 0)
      }
    };

    const originalAccounts = Array.isArray(src.accounts) ? src.accounts : [];
    const sanitizedAccounts = originalAccounts.map(sanitizeCodexAccountEntry).filter(Boolean);
    const dedupedAccounts = dedupeSanitizedCodexAccounts(sanitizedAccounts);
    out.accounts = dedupedAccounts.accounts;

    let changed =
      !Array.isArray(src.accounts) ||
      dedupedAccounts.changed ||
      out.accounts.length !== originalAccounts.length ||
      out.accounts.some((account, index) => {
        const raw = originalAccounts[index];
        return normalizeNonEmptyString(raw?.label) !== normalizeNonEmptyString(account?.label);
      });
    let tokenBackedEntryId = "";
    let tokenBackedAccountEnabled = false;
    let currentTokenEntryId = deriveCodexPoolEntryIdFromToken(out.token || null);

    if (src.token?.access_token) {
      const tokenNormalized = normalizeToken(src.token, src.token);
      const accountId = deriveCodexAccountIdFromToken(tokenNormalized);
      const activePlanType =
        normalizePlanType(src?.usage_snapshot?.plan_type) ||
        readCodexPlanTypeFromEntryId(src?.active_account_id);
      const entryId = deriveCodexPoolEntryIdFromToken(tokenNormalized, { planType: activePlanType });
      const entryBaseId = stripCodexPoolPlanSuffix(entryId);
      const entryPrincipalRoot = readCodexEntryPrincipalRoot(entryId);
      let idx = out.accounts.findIndex((account) => getCodexPoolEntryId(account) === entryId);
      if (idx < 0) {
        idx = out.accounts.findIndex((account) => sameCodexAccountToken(account?.token, tokenNormalized));
      }
      if (idx < 0 && out.active_account_id) {
        const activeRef = String(out.active_account_id || "").trim();
        idx = out.accounts.findIndex((account) => {
          if (getCodexPoolEntryId(account) !== activeRef) return false;
          if (accountId && normalizeNonEmptyString(account?.account_id) !== accountId) return false;
          return true;
        });
      }
      if (idx < 0 && entryBaseId) {
        const baseMatches = out.accounts
          .map((account, index) => ({ account, index }))
          .filter(({ account }) => stripCodexPoolPlanSuffix(getCodexPoolEntryId(account)) === entryBaseId);
        if (baseMatches.length === 1) {
          idx = baseMatches[0].index;
        }
      }
      if (idx < 0 && accountId) {
        const accountMatches = out.accounts
          .map((account, index) => ({ account, index }))
          .filter(({ account }) => {
            if (normalizeNonEmptyString(account?.account_id) !== accountId) return false;
            if (!entryPrincipalRoot) return true;
            return readCodexEntryPrincipalRoot(getCodexPoolEntryId(account)) === entryPrincipalRoot;
          });
        if (accountMatches.length === 1) {
          idx = accountMatches[0].index;
        }
      }
      if (idx >= 0) {
        const canonicalEntryId = choosePreferredCodexEntryId(out.accounts[idx], { identity_id: entryId });
        out.accounts[idx].identity_id = canonicalEntryId || entryId;
        out.accounts[idx].account_id = accountId;
        out.accounts[idx].token = tokenNormalized;
        tokenBackedEntryId = getCodexPoolEntryId(out.accounts[idx]);
        tokenBackedAccountEnabled = out.accounts[idx].enabled !== false;
      } else {
        tokenBackedEntryId = entryId;
        out.accounts.push({
          identity_id: entryId,
          account_id: accountId,
          label: resolveCodexAccountLabel({
            tokenLike: tokenNormalized,
            accountId,
            entryId
          }),
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
          const activeRefBase = stripCodexPoolPlanSuffix(activeRef);
          const byPlanVariant =
            activeRefBase && activeRefBase !== activeRef
              ? out.accounts.find((account) => stripCodexPoolPlanSuffix(getCodexPoolEntryId(account)) === activeRefBase)
              : null;
          if (byPlanVariant) {
            out.active_account_id = getCodexPoolEntryId(byPlanVariant);
            changed = true;
          } else {
            const activePrincipalRoot = readCodexEntryPrincipalRoot(activeRef);
            const activePlanType = readCodexPlanTypeFromEntryId(activeRef);
            const byPrincipalRoot =
              activePrincipalRoot
                ? out.accounts.filter((account) => {
                    if (readCodexEntryPrincipalRoot(getCodexPoolEntryId(account)) !== activePrincipalRoot) return false;
                    if (!activePlanType) return true;
                    return resolveCodexAccountPlanType(account) === activePlanType;
                  })
                : [];
            if (byPrincipalRoot.length === 1) {
              out.active_account_id = getCodexPoolEntryId(byPrincipalRoot[0]);
              changed = true;
            } else {
              const legacyAccountId = activeRef.startsWith("acct:") ? activeRef.slice("acct:".length).trim() : "";
              const byLegacyAccountId = out.accounts.find((account) => {
                const accountId = String(account.account_id || "").trim();
                return accountId === activeRef || (legacyAccountId && accountId === legacyAccountId);
              });
              if (byLegacyAccountId) {
                out.active_account_id = getCodexPoolEntryId(byLegacyAccountId);
                changed = true;
              }
            }
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
    if (preferredToken) {
      const preferredTokenEntryId = getCodexPoolEntryId(preferredTokenAccount);
      if (!out.token || currentTokenEntryId !== preferredTokenEntryId) {
        out.token = preferredToken;
        currentTokenEntryId = preferredTokenEntryId;
        changed = true;
      }
    } else if (out.token) {
      out.token = null;
      currentTokenEntryId = "";
      changed = true;
    }

    if (tokenBackedEntryId && !tokenBackedAccountEnabled && currentTokenEntryId === tokenBackedEntryId) {
      out.token = preferredToken;
      currentTokenEntryId = preferredTokenAccount ? getCodexPoolEntryId(preferredTokenAccount) : "";
      changed = true;
    }

    if (normalizeCodexAccountSlots(out.accounts)) {
      changed = true;
    }

    return { store: out, changed };
  }

  function upsertCodexOAuthAccount(store, normalizedToken, extra = {}) {
    const planType =
      normalizePlanType(extra.planType) || extractPlanType(normalizedToken?.access_token || "");
    const accountId =
      resolveStoredCodexAccountId(normalizedToken, normalizeNonEmptyString(extra.accountId), planType) ||
      deriveCodexAccountIdFromToken(normalizedToken);
    const entryId = deriveCodexPoolEntryIdFromToken(normalizedToken, { planType, accountId });
    const tokenEmail = extractEmailFromTokenLike(normalizedToken);
    const label = typeof extra.label === "string" ? extra.label.trim() : "";
    const slot = readSlotValue(extra.slot);
    const forceReplaceSlot =
      extra.force === true || extra.force === 1 || String(extra.force || "").trim() === "1";
    const nowSec = Math.floor(Date.now() / 1000);
    const usageSnapshot = extra.usageSnapshot && typeof extra.usageSnapshot === "object" ? extra.usageSnapshot : null;
    if (!Array.isArray(store.accounts)) store.accounts = [];

    const existingIdx = store.accounts.findIndex((account) => getCodexPoolEntryId(account) === entryId);
    const slotIdx = slot ? store.accounts.findIndex((account) => toPositiveIntegerNumber(account.slot, null) === slot) : -1;

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
        const currentSlot = toPositiveIntegerNumber(store.accounts[targetIdx].slot, null);
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
      const currentSlot = toPositiveIntegerNumber(store.accounts[targetIdx].slot, null);
      const keepSlotBecauseSameAccount =
        isSameAccountUpdate &&
        resolvedIncomingSlot !== null &&
        currentSlot !== null &&
        resolvedIncomingSlot !== currentSlot &&
        !forceReplaceSlot;
      const resolvedLabel = isSameAccountUpdate
        ? resolveCodexAccountLabel({
            currentLabel,
            incomingLabel: label,
            tokenLike: normalizedToken,
            accountId,
            entryId
          })
        : resolveCodexAccountLabel({
            currentLabel: "",
            incomingLabel: label,
            tokenLike: normalizedToken,
            accountId,
            entryId
          });
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
          ? toPositiveIntegerNumber(usageSnapshot.fetched_at || nowSec, nowSec)
          : toNonNegativeIntegerNumber(store.accounts[targetIdx].usage_updated_at, 0)
      };
    } else {
      store.accounts.push({
        identity_id: entryId,
        account_id: accountId,
        label: resolveCodexAccountLabel({
          currentLabel: label,
          tokenLike: normalizedToken,
          accountId,
          entryId
        }),
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
        usage_updated_at: usageSnapshot ? toPositiveIntegerNumber(usageSnapshot.fetched_at || nowSec, nowSec) : 0
      });
    }

    store.active_account_id = entryId;
    store.token = normalizedToken;
    store.rotation = store.rotation || { next_index: 0 };
    store.rotation.next_index = toNonNegativeInteger(store.rotation.next_index, 0);

    if (extra.skipSlotNormalization !== true) {
      normalizeCodexAccountSlots(store.accounts);
    }

    const resolvedAccount = store.accounts.find((account) => getCodexPoolEntryId(account) === entryId);
    const resolvedSlot = toPositiveIntegerNumber(resolvedAccount?.slot, null);

    return { accountId, entryId, slot: resolvedSlot, action, email: tokenEmail || null, planType, account: resolvedAccount || null };
  }

  function findCodexPoolAccountByRef(accounts, ref) {
    const needle = String(ref || "").trim();
    if (!needle) return null;
    const pool = Array.isArray(accounts) ? accounts : [];
    const byEntryId = pool.find((account) => getCodexPoolEntryId(account) === needle);
    if (byEntryId) return byEntryId;
    const byAccountId = pool.filter((account) => String(account?.account_id || "") === needle);
    return byAccountId.length === 1 ? byAccountId[0] : null;
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
      store.rotation.next_index = toNonNegativeInteger(store.rotation.next_index, 0);
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
    resolveCodexAccountLabel,
    ensureCodexOAuthStoreShape,
    upsertCodexOAuthAccount,
    findCodexPoolAccountByRef,
    selectCodexAccountForLogout,
    removeCodexPoolAccountFromStore
  };
}
