import { buildAdminConfigSnapshot } from "./admin-shared.js";

export function registerAdminSettingsRoutes(app, context) {
  const {
    config,
    cloudflaredRuntime,
    runtimeStats,
    recentRequestsStore,
    parseJsonBody,
    normalizeUpstreamMode,
    setActiveUpstreamBaseUrl,
    normalizeCodexServiceTier,
    parseReasoningEffortOrFallback,
    validMultiAccountStrategies,
    multiAccountStrategyList,
    expiredAccountCleanupController,
    sanitizeModelMappings,
    getActiveUpstreamBaseUrl,
    isCodexMultiAccountEnabled,
    runDirectChatCompletionTest,
    tempMailController,
    parseNumberEnv
  } = context;

  app.post("/admin/requests/clear", async (_req, res) => {
    runtimeStats.recentRequests = recentRequestsStore.clear().recentRequests;
    res.json({ ok: true, cleared: true });
  });

  app.post("/admin/config", async (req, res) => {
    try {
      const body = parseJsonBody(req);
      if (typeof body.upstreamMode === "string") {
        const value = normalizeUpstreamMode(body.upstreamMode);
        if (value !== "codex-chatgpt" && value !== "gemini-v1beta" && value !== "anthropic-v1") {
          throw new Error("upstreamMode must be codex-chatgpt, gemini-v1beta, or anthropic-v1");
        }
        config.upstreamMode = value;
      }
      if (typeof body.upstreamBaseUrl === "string" && body.upstreamBaseUrl.trim().length > 0) {
        setActiveUpstreamBaseUrl(body.upstreamBaseUrl.trim());
      }
      if (typeof body.defaultModel === "string" && body.defaultModel.trim().length > 0) {
        config.codex.defaultModel = body.defaultModel.trim();
      }
      if (body.defaultInstructions === null) {
        config.codex.defaultInstructions = "";
      } else if (typeof body.defaultInstructions === "string") {
        config.codex.defaultInstructions = body.defaultInstructions.trim();
      }
      if (typeof body.defaultServiceTier === "string") {
        config.codex.defaultServiceTier = normalizeCodexServiceTier(body.defaultServiceTier, "default");
      }
      if (typeof body.defaultReasoningEffort === "string") {
        const normalized = parseReasoningEffortOrFallback(body.defaultReasoningEffort, null, {
          allowAdaptive: true
        });
        if (!normalized) {
          throw new Error("defaultReasoningEffort must be one of: none, low, medium, high, xhigh, adaptive");
        }
        config.codex.defaultReasoningEffort = normalized;
      }
      if (typeof body.multiAccountEnabled === "boolean") {
        config.codexOAuth.multiAccountEnabled = body.multiAccountEnabled;
      }
      if (typeof body.multiAccountStrategy === "string") {
        const strategy = body.multiAccountStrategy.trim().toLowerCase();
        if (!validMultiAccountStrategies.has(strategy)) {
          throw new Error(`multiAccountStrategy must be one of: ${multiAccountStrategyList}`);
        }
        config.codexOAuth.multiAccountStrategy = strategy;
      }
      if (typeof body.autoLogoutExpiredAccounts === "boolean") {
        config.expiredAccountCleanup.enabled = body.autoLogoutExpiredAccounts;
        expiredAccountCleanupController.configure({
          enabled: config.expiredAccountCleanup.enabled,
          intervalSeconds: config.expiredAccountCleanup.intervalSeconds
        });
        if (config.expiredAccountCleanup.enabled) {
          expiredAccountCleanupController.run("config_update").catch((err) => {
            console.warn(`[auth-pool] expired account cleanup failed after config update: ${err?.message || err}`);
          });
        }
      }
      if (typeof body.publicAccessMode === "string") {
        const mode = String(body.publicAccessMode || "").trim().toLowerCase();
        if (mode !== "quick" && mode !== "auth") {
          throw new Error("publicAccessMode must be one of: quick, auth.");
        }
        config.publicAccess.defaultMode = mode;
        cloudflaredRuntime.mode = mode;
      }
      if (body.publicAccessUseHttp2 !== undefined) {
        const useHttp2 = Boolean(body.publicAccessUseHttp2);
        config.publicAccess.defaultUseHttp2 = useHttp2;
        cloudflaredRuntime.useHttp2 = useHttp2;
      }
      if (body.publicAccessAutoInstall !== undefined) {
        config.publicAccess.autoInstall = true;
      }
      if (body.publicAccessLocalPort !== undefined) {
        const parsed = parseNumberEnv(body.publicAccessLocalPort, NaN, {
          min: 1,
          max: 65535,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("publicAccessLocalPort must be a number between 1 and 65535.");
        }
        config.publicAccess.localPort = parsed;
        cloudflaredRuntime.localPort = parsed;
      }
      if (body.publicAccessToken !== undefined) {
        config.publicAccess.defaultTunnelToken = String(body.publicAccessToken || "").trim();
        cloudflaredRuntime.tunnelToken = config.publicAccess.defaultTunnelToken;
      }
      if (body.preheatCooldownSeconds !== undefined) {
        const parsed = parseNumberEnv(body.preheatCooldownSeconds, NaN, {
          min: 30,
          max: 86400,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("preheatCooldownSeconds must be a number between 30 and 86400.");
        }
        config.codexPreheat.cooldownSeconds = parsed;
      }
      if (body.preheatBatchSize !== undefined) {
        const parsed = parseNumberEnv(body.preheatBatchSize, NaN, {
          min: 1,
          max: 32,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("preheatBatchSize must be a number between 1 and 32.");
        }
        config.codexPreheat.batchSize = parsed;
      }
      if (body.preheatMinPrimaryRemaining !== undefined) {
        const parsed = parseNumberEnv(body.preheatMinPrimaryRemaining, NaN, {
          min: 0,
          max: 100,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("preheatMinPrimaryRemaining must be a number between 0 and 100.");
        }
        config.codexPreheat.minPrimaryRemaining = parsed;
      }
      if (body.preheatMinSecondaryRemaining !== undefined) {
        const parsed = parseNumberEnv(body.preheatMinSecondaryRemaining, NaN, {
          min: 0,
          max: 100,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("preheatMinSecondaryRemaining must be a number between 0 and 100.");
        }
        config.codexPreheat.minSecondaryRemaining = parsed;
      }
      if (typeof body.modelRouterEnabled === "boolean") {
        config.modelRouter.enabled = body.modelRouterEnabled;
      }
      if (body.modelMappings !== undefined) {
        config.modelRouter.customMappings = sanitizeModelMappings(body.modelMappings);
      }
      res.json({
        ok: true,
        config: buildAdminConfigSnapshot({
          config,
          cloudflaredRuntime,
          getActiveUpstreamBaseUrl,
          isCodexMultiAccountEnabled
        })
      });
    } catch (err) {
      res.status(400).json({ error: "invalid_config", message: err.message });
    }
  });

  app.post("/admin/test", async (req, res) => {
    try {
      const body = parseJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : "Reply with one short sentence: proxy test passed.";
      const result = await runDirectChatCompletionTest(prompt);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ error: "test_failed", message: err.message });
    }
  });

  app.post("/admin/temp-mail/start", async (req, res) => {
    try {
      const body = parseJsonBody(req);
      const result = await tempMailController.start(body || {});
      res.json({ ok: true, tempMail: result });
    } catch (err) {
      res.status(400).json({
        error: "temp_mail_start_failed",
        message: String(err?.message || err || "Failed to start Temp Mail.")
      });
    }
  });

  app.post("/admin/temp-mail/stop", async (_req, res) => {
    try {
      const result = await tempMailController.stop();
      res.json({ ok: true, tempMail: result });
    } catch (err) {
      res.status(400).json({
        error: "temp_mail_stop_failed",
        message: String(err?.message || err || "Failed to stop Temp Mail.")
      });
    }
  });
}
