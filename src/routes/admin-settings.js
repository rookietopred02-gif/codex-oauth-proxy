import { setNoStoreHeaders } from "../http/cache-headers.js";
import { getRequestBodyErrorStatus, isRequestBodyError } from "../http/request-body.js";
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
    validMultiAccountStrategies,
    multiAccountStrategyList,
    validMultiAccountPoolFilters,
    multiAccountPoolFilterList,
    expiredAccountCleanupController,
    sanitizeModelMappings,
    getActiveUpstreamBaseUrl,
    isCodexMultiAccountEnabled,
    runDirectChatCompletionTest,
    normalizeCodexServiceTier,
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

  function writeRequestBodyError(res, err) {
    res.status(getRequestBodyErrorStatus(err)).json({
      error: err?.code || "invalid_request",
      message: err?.message || "Invalid request body."
    });
  }

  app.post("/admin/requests/clear", async (_req, res) => {
    setNoStoreHeaders(res);
    runtimeStats.recentRequests = recentRequestsStore.clear().recentRequests;
    await recentRequestsStore.flush();
    res.json({ ok: true, cleared: true });
  });

  app.post("/admin/config", async (req, res) => {
    setNoStoreHeaders(res);
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
        nextConfig.codex.defaultServiceTier = normalizeCodexServiceTier(body.defaultServiceTier, "priority");
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
      if (typeof body.multiAccountPoolFilter === "string") {
        const filter = body.multiAccountPoolFilter.trim().toLowerCase();
        if (!validMultiAccountPoolFilters.has(filter)) {
          throw new Error(`multiAccountPoolFilter must be one of: ${multiAccountPoolFilterList}`);
        }
        nextConfig.codexOAuth.multiAccountPoolFilter = filter;
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
      if (isRequestBodyError(err)) {
        writeRequestBodyError(res, err);
        return;
      }
      res.status(400).json({ error: "invalid_config", message: err.message });
    }
  });

  app.post("/admin/test", async (req, res) => {
    setNoStoreHeaders(res);
    try {
      const body = await readJsonBody(req);
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : "Reply with one short sentence: proxy test passed.";
      const result = await runDirectChatCompletionTest(prompt);
      res.json({ ok: true, result });
    } catch (err) {
      if (isRequestBodyError(err)) {
        writeRequestBodyError(res, err);
        return;
      }
      res.status(400).json({ error: "test_failed", message: err.message });
    }
  });

}
