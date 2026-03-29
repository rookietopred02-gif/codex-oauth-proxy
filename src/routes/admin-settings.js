import { buildAdminConfigSnapshot } from "./admin-shared.js";

export function registerAdminSettingsRoutes(app, context) {
  const {
    config,
    cloudflaredRuntime,
    runtimeStats,
    recentRequestsStore,
    persistProxyConfigEnv,
    readJsonBody,
    normalizeUpstreamMode,
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

  function setActiveUpstreamBaseUrlForConfig(targetConfig, nextBaseUrl) {
    if (targetConfig.upstreamMode === "gemini-v1beta") {
      targetConfig.gemini.baseUrl = nextBaseUrl;
      return;
    }
    if (targetConfig.upstreamMode === "anthropic-v1") {
      targetConfig.anthropic.baseUrl = nextBaseUrl;
      return;
    }
    targetConfig.upstreamBaseUrl = nextBaseUrl;
  }

  app.post("/admin/requests/clear", async (_req, res) => {
    runtimeStats.recentRequests = recentRequestsStore.clear().recentRequests;
    await recentRequestsStore.flush();
    res.json({ ok: true, cleared: true });
  });

  app.post("/admin/config", async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const nextConfig = structuredClone(config);
      const nextCloudflaredRuntime = {
        ...cloudflaredRuntime,
        process: cloudflaredRuntime.process || null,
        outputTail: Array.isArray(cloudflaredRuntime.outputTail) ? [...cloudflaredRuntime.outputTail] : []
      };
      if (typeof body.upstreamMode === "string") {
        const value = normalizeUpstreamMode(body.upstreamMode);
        if (value !== "codex-chatgpt" && value !== "gemini-v1beta" && value !== "anthropic-v1") {
          throw new Error("upstreamMode must be codex-chatgpt, gemini-v1beta, or anthropic-v1");
        }
        nextConfig.upstreamMode = value;
      }
      if (typeof body.upstreamBaseUrl === "string" && body.upstreamBaseUrl.trim().length > 0) {
        setActiveUpstreamBaseUrlForConfig(nextConfig, body.upstreamBaseUrl.trim());
      }
      if (typeof body.defaultModel === "string" && body.defaultModel.trim().length > 0) {
        nextConfig.codex.defaultModel = body.defaultModel.trim();
      }
      if (body.defaultInstructions === null) {
        nextConfig.codex.defaultInstructions = "";
      } else if (typeof body.defaultInstructions === "string") {
        nextConfig.codex.defaultInstructions = body.defaultInstructions.trim();
      }
      if (typeof body.defaultServiceTier === "string") {
        nextConfig.codex.defaultServiceTier = normalizeCodexServiceTier(body.defaultServiceTier, "default");
      }
      if (typeof body.defaultReasoningEffort === "string") {
        const normalized = parseReasoningEffortOrFallback(body.defaultReasoningEffort, null, {
          allowAdaptive: true
        });
        if (!normalized) {
          throw new Error("defaultReasoningEffort must be one of: none, low, medium, high, xhigh, adaptive");
        }
        nextConfig.codex.defaultReasoningEffort = normalized;
      }
      if (typeof body.multiAccountEnabled === "boolean") {
        nextConfig.codexOAuth.multiAccountEnabled = body.multiAccountEnabled;
      }
      if (typeof body.multiAccountStrategy === "string") {
        const strategy = body.multiAccountStrategy.trim().toLowerCase();
        if (!validMultiAccountStrategies.has(strategy)) {
          throw new Error(`multiAccountStrategy must be one of: ${multiAccountStrategyList}`);
        }
        nextConfig.codexOAuth.multiAccountStrategy = strategy;
      }
      if (typeof body.autoLogoutExpiredAccounts === "boolean") {
        nextConfig.expiredAccountCleanup.enabled = body.autoLogoutExpiredAccounts;
      }
      const runtimePortValue = body.runtimePort ?? body.publicAccessLocalPort;
      if (runtimePortValue !== undefined) {
        const parsed = parseNumberEnv(runtimePortValue, NaN, {
          min: 1,
          max: 65535,
          integer: true
        });
        if (!Number.isFinite(parsed)) {
          throw new Error("runtimePort must be a number between 1 and 65535.");
        }
        nextConfig.runtimePort = parsed;
      }
      if (typeof body.publicAccessMode === "string") {
        const mode = String(body.publicAccessMode || "").trim().toLowerCase();
        if (mode !== "quick" && mode !== "auth") {
          throw new Error("publicAccessMode must be one of: quick, auth.");
        }
        nextConfig.publicAccess.defaultMode = mode;
        nextCloudflaredRuntime.mode = mode;
      }
      if (body.publicAccessUseHttp2 !== undefined) {
        const useHttp2 = Boolean(body.publicAccessUseHttp2);
        nextConfig.publicAccess.defaultUseHttp2 = useHttp2;
        nextCloudflaredRuntime.useHttp2 = useHttp2;
      }
      if (body.publicAccessAutoInstall !== undefined) {
        nextConfig.publicAccess.autoInstall = Boolean(body.publicAccessAutoInstall);
      }
      if (body.publicAccessToken !== undefined) {
        nextConfig.publicAccess.defaultTunnelToken = String(body.publicAccessToken || "").trim();
        nextCloudflaredRuntime.tunnelToken = nextConfig.publicAccess.defaultTunnelToken;
      }
      if (typeof body.modelRouterEnabled === "boolean") {
        nextConfig.modelRouter.enabled = body.modelRouterEnabled;
      }
      if (body.modelMappings !== undefined) {
        nextConfig.modelRouter.customMappings = sanitizeModelMappings(body.modelMappings);
      }

      await persistProxyConfigEnv(nextConfig);

      Object.assign(config, nextConfig);
      Object.assign(cloudflaredRuntime, nextCloudflaredRuntime);

      if (typeof body.autoLogoutExpiredAccounts === "boolean") {
        expiredAccountCleanupController.configure({
          enabled: config.expiredAccountCleanup.enabled,
          intervalSeconds: config.expiredAccountCleanup.intervalSeconds
        });
        if (config.expiredAccountCleanup.enabled) {
          expiredAccountCleanupController.run("config_update").catch((err) => {
            console.warn(`[auth-pool] account auto-rm failed after config update: ${err?.message || err}`);
          });
        }
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
      const body = await readJsonBody(req);
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

  app.get("/admin/temp-mail/status", async (_req, res) => {
    try {
      const result = await tempMailController.refreshRunner(false);
      res.json({ ok: true, tempMail: result });
    } catch (err) {
      res.status(400).json({
        error: "temp_mail_status_failed",
        message: String(err?.message || err || "Failed to refresh Temp Mail status."),
        tempMail: tempMailController.getState()
      });
    }
  });

  app.post("/admin/temp-mail/start", async (req, res) => {
    try {
      const body = await readJsonBody(req);
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
