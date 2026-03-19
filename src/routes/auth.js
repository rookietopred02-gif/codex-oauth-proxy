export function registerAuthRoutes(app, context) {
  const {
    config,
    getAuthStatus,
    getActiveOAuthRuntime,
    ensureCodexOAuthCallbackServer,
    randomBase64Url,
    sha256base64url,
    pendingAuth,
    cleanupPendingStates,
    parseSlotValue,
    isCodexMultiAccountEnabled,
    completeOAuthCallback,
    buildOAuthCallbackMessage,
    oauthCallbackSuccessHtml,
    readJsonBody,
    removeCodexPoolAccountFromStore,
    saveTokenStore,
    clearAuthContextCache,
    replaceActiveOAuthStore
  } = context;

  app.get("/auth/status", async (_req, res) => {
    try {
      res.json(await getAuthStatus());
    } catch (err) {
      res.status(500).json({ error: "status_failed", message: err.message });
    }
  });

  app.get("/auth/login", async (req, res) => {
    if (config.authMode === "profile-store") {
      res.status(400).json({
        mode: "profile-store",
        message: "This mode uses Profile Store's existing OAuth session.",
        action: "Run: your external auth tool login flow",
        authStorePath: config.profileStore.authStorePath
      });
      return;
    }

    const oauthRuntime = getActiveOAuthRuntime();
    if (!oauthRuntime) {
      res.status(400).json({
        error: "oauth_unavailable",
        message: "AUTH_MODE is profile-store; use Profile Store login flow."
      });
      return;
    }

    if (config.authMode === "codex-oauth") {
      try {
        await ensureCodexOAuthCallbackServer();
      } catch (err) {
        res.status(500).json({
          error: "callback_server_failed",
          message: err.message
        });
        return;
      }
    }

    const state = randomBase64Url(24);
    const verifier = randomBase64Url(64);
    const challenge = sha256base64url(verifier);

    pendingAuth.set(state, {
      verifier,
      createdAt: Date.now(),
      mode: config.authMode,
      label: typeof req.query.label === "string" ? req.query.label.trim() : "",
      slot: parseSlotValue(req.query.slot),
      force: String(req.query.force || "").trim() === "1"
    });
    cleanupPendingStates();

    const authUrl = new URL(oauthRuntime.oauth.authorizeUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oauthRuntime.oauth.clientId);
    authUrl.searchParams.set("redirect_uri", oauthRuntime.oauth.redirectUri);
    authUrl.searchParams.set("scope", oauthRuntime.oauth.scopes.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (config.authMode === "codex-oauth") {
      authUrl.searchParams.set("id_token_add_organizations", "true");
      authUrl.searchParams.set("codex_cli_simplified_flow", "true");
      authUrl.searchParams.set("originator", config.codexOAuth.originator);
      authUrl.searchParams.set("max_age", "0");
    }

    if (req.query.prompt) {
      authUrl.searchParams.set("prompt", String(req.query.prompt));
    } else if (config.authMode === "codex-oauth" && isCodexMultiAccountEnabled()) {
      authUrl.searchParams.set("prompt", "login");
    }

    res.redirect(authUrl.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    if (config.authMode === "profile-store") {
      res.status(400).send("Callback is not used in AUTH_MODE=profile-store.");
      return;
    }
    if (config.authMode === "codex-oauth") {
      res
        .status(400)
        .send(
          `Callback in AUTH_MODE=codex-oauth is handled at ${config.codexOAuth.redirectUri}. Start login from /auth/login.`
        );
      return;
    }

    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");

    if (error) {
      res.status(400).send(`OAuth failed: ${error}`);
      return;
    }

    if (!code || !state || !pendingAuth.has(state)) {
      res.status(400).send("Invalid OAuth callback: missing code/state or expired state.");
      return;
    }

    try {
      const summary = await completeOAuthCallback({ code, state });
      const msg = buildOAuthCallbackMessage(summary);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(oauthCallbackSuccessHtml.replace("</body>", `${msg}</body>`));
    } catch (err) {
      console.error("OAuth callback exchange failed:", err);
      res.status(500).send(`Token exchange failed: ${err.message}`);
    }
  });

  app.post("/auth/logout", async (req, res) => {
    if (config.authMode === "profile-store") {
      res.status(400).json({
        mode: "profile-store",
        message: "Managed by Profile Store. Run `your external auth tool login flow` to change account."
      });
      return;
    }

    const oauthRuntime = getActiveOAuthRuntime();
    if (!oauthRuntime) {
      res.status(400).json({
        error: "oauth_unavailable",
        message: "No active OAuth runtime."
      });
      return;
    }

    if (config.authMode === "codex-oauth") {
      const body = await readJsonBody(req);
      const accountRef = String(body.entryId || body.accountId || "").trim();
      const removed = removeCodexPoolAccountFromStore(oauthRuntime.store, accountRef);
      if (!removed.removed) {
        res.status(404).json({
          error: "not_found",
          message: "No removable OAuth account was found."
        });
        return;
      }

      replaceActiveOAuthStore(removed.store);
      await saveTokenStore(oauthRuntime.oauth.tokenStorePath, removed.store);
      clearAuthContextCache();
      res.json({
        ok: true,
        mode: "codex-oauth",
        removedEntryId: removed.removedEntryId,
        removedAccountId: removed.removedAccountId,
        remainingAccounts: removed.remainingAccounts,
        activeEntryId: removed.activeEntryId
      });
      return;
    }

    const nextStore = {
      ...(oauthRuntime.store && typeof oauthRuntime.store === "object" ? oauthRuntime.store : {}),
      token: null
    };
    replaceActiveOAuthStore(nextStore);
    await saveTokenStore(oauthRuntime.oauth.tokenStorePath, nextStore);
    clearAuthContextCache();
    res.json({ ok: true, mode: config.authMode });
  });
}
