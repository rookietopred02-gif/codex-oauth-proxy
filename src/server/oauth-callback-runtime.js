import crypto from "node:crypto";
import http from "node:http";

function truncate(text, maxLen) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function describeOAuthUpsertAction(action) {
  switch (String(action || "")) {
    case "created":
      return "new account added";
    case "created_reassigned_slot":
      return "new account added (requested slot occupied, reassigned)";
    case "updated_existing_account":
      return "existing account token refreshed";
    case "already_exists_same_account":
      return "same account + same plan detected (not added again)";
    case "replaced_slot":
      return "slot owner replaced";
    case "unexpected_account_email":
      return "login returned a different account than requested";
    default:
      return "updated";
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createCodexOAuthCallbackRuntime({
  config,
  OAUTH_CALLBACK_SUCCESS_HTML,
  logger,
  getActiveOAuthRuntime,
  normalizeToken,
  extractOpenAICodexAccountId,
  extractOpenAICodexPrincipalId,
  extractOpenAICodexEmail,
  extractOpenAICodexOrganizationIds,
  parseSlotValue,
  ensureCodexOAuthStoreShape,
  normalizeOpenAICodexPlanType,
  extractOpenAICodexPlanType,
  withTimeout,
  fetchCodexUsageSnapshotForAccount,
  upsertCodexOAuthAccount,
  saveTokenStore,
  clearAuthContextCache,
  exchangeCodeForToken
}) {
  const pendingAuth = new Map();
  let codexCallbackServer = null;
  let codexCallbackServerStartPromise = null;

  function uniqueNonEmpty(values) {
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = String(value || "").trim();
      if (!normalized || out.includes(normalized)) continue;
      out.push(normalized);
    }
    return out;
  }

  async function completeOAuthCallback({ code, state }) {
    const pending = pendingAuth.get(state);
    if (!pending) {
      throw new Error("Invalid OAuth callback: missing/expired state.");
    }
    pendingAuth.delete(state);

    const oauthRuntime = getActiveOAuthRuntime();
    if (!oauthRuntime) {
      throw new Error("OAuth runtime is unavailable in current auth mode.");
    }
    if (pending.mode !== config.authMode) {
      throw new Error(`OAuth state mode mismatch: expected ${pending.mode}, got ${config.authMode}.`);
    }

    const token = await exchangeCodeForToken(code, pending.verifier, oauthRuntime.oauth);
    const normalizedToken = normalizeToken(token, oauthRuntime.store.token);
    if (config.authMode !== "codex-oauth") {
      oauthRuntime.store.token = normalizedToken;
    }
    const expectedEmail = String(pending.expectedEmail || "").trim().toLowerCase();

    let callbackSummary = {
      accountId: extractOpenAICodexAccountId(normalizedToken.access_token || "") || null,
      entryId: extractOpenAICodexPrincipalId(normalizedToken.access_token || "") || null,
      email: extractOpenAICodexEmail(normalizedToken.access_token || "") || null,
      slot: parseSlotValue(pending.slot),
      action: "updated"
    };
    const actualEmail = String(callbackSummary.email || "").trim().toLowerCase();
    if (config.authMode === "codex-oauth" && expectedEmail && actualEmail !== expectedEmail) {
      return {
        ...callbackSummary,
        action: "unexpected_account_email",
        expectedEmail,
        actualEmail: callbackSummary.email || ""
      };
    }

    if (config.authMode === "codex-oauth") {
      const shaped = ensureCodexOAuthStoreShape(oauthRuntime.store);
      Object.keys(oauthRuntime.store).forEach((key) => delete oauthRuntime.store[key]);
      Object.assign(oauthRuntime.store, shaped.store);
      const tokenAccountId = String(callbackSummary.accountId || "").trim();
      const tokenPlanType =
        normalizeOpenAICodexPlanType(callbackSummary?.planType) ||
        extractOpenAICodexPlanType(normalizedToken.access_token || "");
      const candidateAccountIds = uniqueNonEmpty([
        tokenAccountId,
        ...(typeof extractOpenAICodexOrganizationIds === "function"
          ? extractOpenAICodexOrganizationIds(normalizedToken.id_token || "")
          : []),
        ...(typeof extractOpenAICodexOrganizationIds === "function"
          ? extractOpenAICodexOrganizationIds(normalizedToken.access_token || "")
          : [])
      ]);
      const probeResults = [];
      let primaryProbeError = "";

      for (const [index, candidateAccountId] of candidateAccountIds.entries()) {
        let probedSnapshot = null;
        let usageFetched = false;
        let usageFetchError = "";
        let detectedPlanType =
          tokenPlanType;

        try {
          probedSnapshot = await withTimeout(
            fetchCodexUsageSnapshotForAccount(
              {
                token: normalizeToken(normalizedToken, normalizedToken),
                account_id: candidateAccountId || null,
                identity_id: callbackSummary.entryId || null,
                usage_snapshot: null
              },
              oauthRuntime.oauth
            ),
            12000,
            "Usage probe timed out."
          );
          detectedPlanType =
            normalizeOpenAICodexPlanType(probedSnapshot?.plan_type) || detectedPlanType;
          usageFetched = true;
        } catch (err) {
          usageFetchError = String(err?.message || err || "usage_probe_failed");
          if (!primaryProbeError && candidateAccountId === tokenAccountId) {
            primaryProbeError = usageFetchError;
          }
        }

        if (!usageFetched && index !== 0 && candidateAccountId !== tokenAccountId) {
          continue;
        }

        probeResults.push({
          candidateAccountId,
          detectedPlanType,
          usageFetched,
          usageFetchError,
          usageSnapshot: probedSnapshot,
          isPrimaryCandidate: index === 0 || candidateAccountId === tokenAccountId
        });
      }

      const successfulProbeResults = probeResults.filter((result) => result.usageFetched);
      const selectedProbeResult =
        successfulProbeResults.find((result) => result.candidateAccountId === tokenAccountId) ||
        successfulProbeResults.find((result) => result.detectedPlanType === tokenPlanType) ||
        successfulProbeResults[0] ||
        probeResults.find((result) => result.isPrimaryCandidate) ||
        null;

      if (selectedProbeResult) {
        const upsert = upsertCodexOAuthAccount(oauthRuntime.store, normalizedToken, {
          label: pending.label || "",
          slot: pending.slot,
          force: pending.force,
          planType: selectedProbeResult.detectedPlanType || tokenPlanType || null,
          usageSnapshot: selectedProbeResult.usageSnapshot,
          accountId: selectedProbeResult.candidateAccountId || tokenAccountId || null
        });
        callbackSummary = {
          accountId: upsert.accountId,
          entryId: upsert.entryId || callbackSummary.entryId,
          email: upsert.email || callbackSummary.email,
          slot: upsert.slot,
          action: upsert.action,
          planType: upsert.planType || selectedProbeResult.detectedPlanType || tokenPlanType || null,
          usageFetched: selectedProbeResult.usageFetched,
          usageFetchError: selectedProbeResult.usageFetchError
        };
        oauthRuntime.store.active_account_id =
          callbackSummary.entryId || oauthRuntime.store.active_account_id || null;
      } else {
        callbackSummary.usageFetched = false;
        callbackSummary.usageFetchError = primaryProbeError || "usage_probe_failed";
      }

      const normalizedAfterUpsert = ensureCodexOAuthStoreShape(oauthRuntime.store);
      Object.keys(oauthRuntime.store).forEach((key) => delete oauthRuntime.store[key]);
      Object.assign(oauthRuntime.store, normalizedAfterUpsert.store);
    }

    await saveTokenStore(oauthRuntime.oauth.tokenStorePath, oauthRuntime.store);
    clearAuthContextCache();
    return callbackSummary;
  }

  function buildOAuthCallbackMessage(summary) {
    const accountId = summary?.accountId || "unknown";
    const entryId = summary?.entryId || "";
    const email = summary?.email || "";
    const action = summary?.action || "updated";
    const slot = summary?.slot || "-";
    const planType = String(summary?.planType || "").trim();
    const usageFetched = summary?.usageFetched === true;
    const usageFetchError = String(summary?.usageFetchError || "").trim();
    const expectedEmail = String(summary?.expectedEmail || "").trim();
    const actualEmail = String(summary?.actualEmail || email || "").trim();
    const actionLabel = describeOAuthUpsertAction(action);
    const emailLine = email ? `<p>Email: ${escapeHtml(email)}</p>` : "";
    const entryLine = entryId ? `<p>Entry: ${escapeHtml(truncate(String(entryId), 80))}</p>` : "";
    const planLine = planType ? `<p>Detected Plan: ${escapeHtml(planType)}</p>` : "";
    const usageLine = usageFetched
      ? `<p>Usage Snapshot: refreshed</p>`
      : usageFetchError
        ? `<p style="color:#b45309"><strong>Usage probe:</strong> ${escapeHtml(usageFetchError)}</p>`
        : "";
    const warning =
      action === "already_exists_same_account"
        ? `<p style="color:#b45309"><strong>Notice:</strong> This login returned the same ChatGPT account and plan variant, so no new account was added.</p><p style="color:#b45309">Use another browser profile/incognito or a different plan/account if you want a separate pool entry.</p>`
        : action === "unexpected_account_email"
          ? `<p style="color:#b91c1c"><strong>Requested:</strong> ${escapeHtml(expectedEmail || "(unspecified)")}</p><p style="color:#b91c1c"><strong>Returned:</strong> ${escapeHtml(actualEmail || "(unknown)")}</p><p style="color:#b91c1c"><strong>Notice:</strong> This login returned a different ChatGPT account, so the account pool was not changed.</p>`
        : "";
    return `<p>Account: ${escapeHtml(accountId)}</p>${entryLine}${emailLine}<p>Action: ${escapeHtml(actionLabel)}</p><p>Slot: ${escapeHtml(String(slot))}</p>${planLine}${usageLine}${warning}`;
  }

  async function ensureCodexOAuthCallbackServer() {
    if (config.authMode !== "codex-oauth") return;
    if (codexCallbackServer && codexCallbackServer.listening) return;
    if (codexCallbackServerStartPromise) {
      await codexCallbackServerStartPromise;
      return;
    }

    codexCallbackServerStartPromise = new Promise((resolve, reject) => {
      const host = config.codexOAuth.callbackBindHost;
      const port = config.codexOAuth.callbackPort;
      const callbackPath = config.codexOAuth.callbackPath;
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "", "http://localhost");
          if (url.pathname !== callbackPath) {
            res.statusCode = 404;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Not found");
            return;
          }

          const state = String(url.searchParams.get("state") || "");
          const code = String(url.searchParams.get("code") || "");
          const error = String(url.searchParams.get("error") || "");

          if (error) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(
              `<h1>OAuth failed</h1><p>${escapeHtml(error)}</p><p>Return to dashboard and try login again.</p>`
            );
            return;
          }
          if (!state || !code) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end("<h1>OAuth failed</h1><p>Missing code/state in callback.</p>");
            return;
          }

          try {
            const summary = await completeOAuthCallback({ code, state });
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            const msg = buildOAuthCallbackMessage(summary);
            res.end(OAUTH_CALLBACK_SUCCESS_HTML.replace("</body>", `${msg}</body>`));
          } catch (err) {
            logger.error("Codex OAuth callback handling failed:", err);
            res.statusCode = 500;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(
              `<h1>Token exchange failed</h1><p>${escapeHtml(err.message)}</p><p>Return to dashboard and retry.</p>`
            );
          }
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(`Internal callback error: ${err.message}`);
        }
      });

      server.once("error", (err) => {
        if (codexCallbackServer === server) codexCallbackServer = null;
        reject(
          new Error(
            `Failed to bind codex callback server at http://${host}:${port}${callbackPath}: ${err.message}`
          )
        );
      });

      server.listen(port, host, () => {
        codexCallbackServer = server;
        resolve();
      });
    });

    try {
      await codexCallbackServerStartPromise;
    } finally {
      codexCallbackServerStartPromise = null;
    }
  }

  async function stopCodexOAuthCallbackServer() {
    const server = codexCallbackServer;
    codexCallbackServer = null;
    codexCallbackServerStartPromise = null;
    if (!server) return;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  function cleanupPendingStates() {
    const now = Date.now();
    for (const [state, value] of pendingAuth.entries()) {
      if (now - value.createdAt > 10 * 60 * 1000) pendingAuth.delete(state);
    }
  }

  function randomBase64Url(bytes) {
    return crypto.randomBytes(bytes).toString("base64url");
  }

  function sha256base64url(text) {
    return crypto.createHash("sha256").update(text).digest("base64url");
  }

  return {
    buildOAuthCallbackMessage,
    cleanupPendingStates,
    completeOAuthCallback,
    ensureCodexOAuthCallbackServer,
    getCodexOAuthCallbackServer: () => codexCallbackServer,
    pendingAuth,
    randomBase64Url,
    sha256base64url,
    stopCodexOAuthCallbackServer,
    truncate
  };
}
