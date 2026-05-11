import { refreshAccessToken as defaultRefreshAccessToken } from "./oauth-token-client.js";
import { resetCodexAccountHealth } from "../services/codex-account-state.js";

function isExpiredOrNearExpirySec(expiresAtSec) {
  if (!Number.isFinite(expiresAtSec)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAtSec - nowSec < 60;
}

function createPinnedAccountUnavailableError() {
  const error = new Error("The response_id is pinned to a pooled account that is not currently selectable.");
  error.statusCode = 409;
  error.error = "response_id_account_unavailable";
  return error;
}

function createModelAccountUnavailableError(requestedModel) {
  const model = String(requestedModel || "").trim();
  const error = new Error(
    model
      ? `No selectable OAuth account is known to support the requested model "${model}".`
      : "No selectable OAuth account is known to support the requested model."
  );
  error.statusCode = 409;
  error.error = "model_account_unavailable";
  error.requestedModel = model;
  return error;
}

function toIntegerNumber(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : fallback;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const parsed = toIntegerNumber(value, fallback);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
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

export function createAuthContextRuntime({
  config,
  logger = console,
  ensureCodexOAuthStoreShape,
  saveTokenStore,
  normalizeToken,
  extractOpenAICodexAccountId,
  extractOpenAICodexPrincipalId,
  deriveCodexPoolEntryIdFromToken,
  upsertCodexOAuthAccount,
  pickCodexAccountCandidates,
  getCodexEnabledAccounts,
  getCodexPoolEntryId,
  clearAuthContextCache,
  expiredAccountCleanupController,
  isCodexTokenInvalidatedError,
  applyCodexInvalidatedAccountState,
  refreshAccessToken = defaultRefreshAccessToken
}) {
  function isCodexMultiAccountEnabled() {
    return config.authMode === "codex-oauth" && config.codexOAuth.multiAccountEnabled === true;
  }

  function shouldUseSingleCandidateForStrategy(strategy) {
    return String(strategy || "").trim().toLowerCase() === "smart";
  }

  async function getValidAuthContextFromOAuthStore(store, oauthConfig) {
    if (!store.token?.access_token) {
      throw new Error("No token in store. Login required.");
    }

    if (!isExpiredOrNearExpirySec(store.token.expires_at)) {
      return {
        accessToken: store.token.access_token,
        accountId: extractOpenAICodexAccountId(store.token.access_token) || null,
        principalId: extractOpenAICodexPrincipalId(store.token.access_token) || null
      };
    }

    if (!store.token.refresh_token) {
      throw new Error("Access token expired and no refresh token available.");
    }

    const refreshed = await refreshAccessToken(store.token.refresh_token, oauthConfig);
    store.token = normalizeToken(refreshed, store.token);
    await saveTokenStore(oauthConfig.tokenStorePath, store);
    return {
      accessToken: store.token.access_token,
      accountId: extractOpenAICodexAccountId(store.token.access_token) || null,
      principalId: extractOpenAICodexPrincipalId(store.token.access_token) || null
    };
  }

  async function getValidAuthContextFromCodexOAuthStore(store, oauthConfig, options = {}) {
    const normalized = ensureCodexOAuthStoreShape(store);
    if (normalized.changed) {
      Object.assign(store, normalized.store);
      await saveTokenStore(oauthConfig.tokenStorePath, store);
    } else {
      Object.assign(store, normalized.store);
    }

    if (!isCodexMultiAccountEnabled()) {
      const context = await getValidAuthContextFromOAuthStore(store, oauthConfig);
      const upsert = upsertCodexOAuthAccount(store, store.token, {
        label: context.principalId || context.accountId || ""
      });
      await saveTokenStore(oauthConfig.tokenStorePath, store);
      return {
        ...context,
        poolAccountId: upsert.entryId,
        poolEntryId: upsert.entryId
      };
    }

    const preferredPoolEntryId =
      typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";
    const requestedModel = typeof options.requestedModel === "string" ? options.requestedModel.trim() : "";
    const strategy = String(config.codexOAuth.multiAccountStrategy || "").trim().toLowerCase();
    let candidates = pickCodexAccountCandidates(store, {
      preferredPoolEntryId,
      requestedModel,
      strategy
    });
    if (preferredPoolEntryId) {
      candidates = candidates.filter((account) => getCodexPoolEntryId(account) === preferredPoolEntryId);
      if (candidates.length === 0) {
        throw createPinnedAccountUnavailableError();
      }
    }
    if (candidates.length === 0) {
      if (requestedModel) {
        const modelAgnosticCandidates = pickCodexAccountCandidates(store, {
          preferredPoolEntryId,
          strategy
        });
        if (modelAgnosticCandidates.length > 0) {
          throw createModelAccountUnavailableError(requestedModel);
        }
      }
      if (strategy === "manual") {
        const activeRef = String(store?.active_account_id || "").trim();
        if (!activeRef) {
          throw new Error("Manual account strategy requires selecting a current account. No fallback account will be used.");
        }
        throw new Error(
          `Manual account strategy is pinned to "${activeRef}", but that account is unavailable. No fallback account will be used.`
        );
      }
      throw new Error("No enabled OAuth accounts available in account pool.");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const selectedCandidates =
      preferredPoolEntryId || shouldUseSingleCandidateForStrategy(strategy) ? candidates.slice(0, 1) : candidates;
    const errors = [];
    let sawInvalidatedFailure = false;
    for (const account of selectedCandidates) {
      try {
        if (!account.token?.access_token) {
          throw new Error("Missing access token.");
        }

        if (isExpiredOrNearExpirySec(account.token.expires_at)) {
          if (!account.token.refresh_token) {
            throw new Error("Access token expired and no refresh token available.");
          }
          const refreshed = await refreshAccessToken(account.token.refresh_token, oauthConfig);
          account.token = normalizeToken(refreshed, account.token);
        }

        const accountIdFromToken =
          account.account_id || extractOpenAICodexAccountId(account.token.access_token) || null;
        const currentPlanType =
          account?.usage_snapshot?.plan_type ||
          account?.plan_type ||
          (() => {
            const rawEntryId = String(account?.identity_id || "").trim();
            const marker = "::plan:";
            const markerIndex = rawEntryId.lastIndexOf(marker);
            return markerIndex >= 0 ? rawEntryId.slice(markerIndex + marker.length) : null;
          })();
        const entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token, {
          accountId: accountIdFromToken,
          planType: currentPlanType
        });
        const principalIdFromToken =
          extractOpenAICodexPrincipalId(account.token.access_token) || entryIdFromToken;
        account.identity_id = entryIdFromToken;
        account.account_id = accountIdFromToken;
        resetCodexAccountHealth(account);
        account.last_used_at = nowSec;
        store.token = account.token;
        store.active_account_id = entryIdFromToken;
        store.rotation = store.rotation || { next_index: 0 };
        if (selectedCandidates.length > 1 && strategy === "round-robin") {
          const enabled = getCodexEnabledAccounts(store);
          const idx = enabled.findIndex((x) => getCodexPoolEntryId(x) === entryIdFromToken);
          store.rotation.next_index = idx >= 0 ? (idx + 1) % enabled.length : 0;
        }
        await saveTokenStore(oauthConfig.tokenStorePath, store);
        return {
          accessToken: account.token.access_token,
          accountId: accountIdFromToken,
          principalId: principalIdFromToken,
          poolAccountId: entryIdFromToken,
          poolEntryId: entryIdFromToken
        };
      } catch (err) {
        const failureCount = toNonNegativeInteger(account.failure_count, 0) + 1;
        account.failure_count = failureCount;
        account.last_error = String(err.message || err);
        account.last_status_code = toHttpStatusCode(err?.statusCode, 0);
        const tokenInvalidated = isCodexTokenInvalidatedError(account.last_status_code, account.last_error);
        if (tokenInvalidated) {
          applyCodexInvalidatedAccountState(store, account, nowSec);
          sawInvalidatedFailure = true;
        } else {
          const cooldownSeconds = Math.min(120, 10 * failureCount);
          account.cooldown_until = nowSec + cooldownSeconds;
          account.token_invalidated_at = 0;
        }
        errors.push(`${getCodexPoolEntryId(account) || account.account_id}: ${account.last_error}`);
      }
    }

    await saveTokenStore(oauthConfig.tokenStorePath, store);
    clearAuthContextCache();
    if (sawInvalidatedFailure && config.expiredAccountCleanup.enabled) {
      await expiredAccountCleanupController.run("token_invalidated").catch((err) => {
        logger.warn?.(`[auth-pool] account auto-rm failed after refresh failure: ${err?.message || err}`);
      });
    }
    if (preferredPoolEntryId) {
      throw createPinnedAccountUnavailableError();
    }
    if (shouldUseSingleCandidateForStrategy(strategy)) {
      throw new Error(`Selected pooled OAuth account failed. ${errors.join(" | ")}`);
    }
    throw new Error(`All pooled OAuth accounts failed. ${errors.join(" | ")}`);
  }

  return {
    getValidAuthContextFromCodexOAuthStore,
    getValidAuthContextFromOAuthStore
  };
}
