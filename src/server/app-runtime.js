import { startConfiguredServer } from "../bootstrap/lifecycle.js";
import { attachResponsesWebSocketServer } from "../http/responses-websocket-server.js";
import { registerAdminRoutes } from "../routes/admin-routes.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerDashboardAuthProtection, registerDashboardAuthRoutes } from "../routes/dashboard-auth.js";
import { registerHealthRoutes } from "../routes/health-routes.js";
import { createProxyRouteHandlers } from "../routes/proxy-handlers.js";
import { registerProviderRoutes } from "../routes/provider-routes.js";
import { registerCommonMiddleware, registerSystemRoutes } from "../routes/system.js";

export function registerServerApp({
  app,
  config,
  publicDir,
  dashboardAuth,
  hasActiveManagedProxyApiKeys,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  recordManagedProxyApiKeyUsage,
  getAuthStatus,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  getActiveOAuthRuntime,
  ensureCodexOAuthCallbackServer,
  randomBase64Url,
  sha256base64url,
  pendingAuth,
  cleanupPendingStates,
  parseSlotValue,
  completeOAuthCallback,
  buildOAuthCallbackMessage,
  oauthCallbackSuccessHtml,
  readJsonBody,
  removeCodexPoolAccountFromStore,
  isCodexAccountLeased,
  saveTokenStore,
  clearAuthContextCache,
  replaceActiveOAuthStore,
  runtimeStats,
  recentRequestsStore,
  cloudflaredRuntime,
  tempMailController,
  expiredAccountCleanupController,
  getProxyApiKeyStore,
  checkCloudflaredInstalled,
  buildApiKeySummary,
  getCloudflaredStatus,
  getCodexPreheatState,
  createProxyApiKey,
  hashProxyApiKey,
  sanitizeProxyApiKeyLabel,
  persistProxyApiKeyStore,
  startCloudflaredTunnel,
  stopCloudflaredTunnel,
  installCloudflaredBinary,
  validCloudflaredModes,
  parseNumberEnv,
  getOfficialModelCandidateIds,
  getOfficialCodexModelCandidateIds,
  getCodexOAuthStore,
  setCodexOAuthStore,
  ensureCodexOAuthStoreShape,
  buildCodexPoolMetrics,
  getCodexPoolEntryId,
  findCodexPoolAccountByRef,
  importIntoCodexAuthPool,
  normalizeOpenAICodexPlanType,
  refreshCodexUsageSnapshotInStore,
  refreshCodexTokensInStore,
  runCodexPreheat,
  persistProxyConfigEnv,
  envFilePath,
  normalizeUpstreamMode,
  setActiveUpstreamBaseUrl,
  normalizeCodexServiceTier,
  parseReasoningEffortOrFallback,
  validMultiAccountStrategies,
  multiAccountStrategyList,
  sanitizeModelMappings,
  runDirectChatCompletionTest,
  proxyRouteHandlerDeps
}) {
  registerCommonMiddleware(app, {
    config,
    hasActiveManagedProxyApiKeys,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    recordManagedProxyApiKeyUsage
  });
  registerDashboardAuthRoutes(app, {
    dashboardAuth,
    readJsonBody
  });
  registerDashboardAuthProtection(app, {
    dashboardAuth
  });

  registerSystemRoutes(app, { publicDir });
  registerHealthRoutes(app, {
    config,
    getAuthStatus,
    getActiveUpstreamBaseUrl,
    isCodexMultiAccountEnabled
  });

  registerAuthRoutes(app, {
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
    isCodexAccountLeased,
    saveTokenStore,
    clearAuthContextCache,
    replaceActiveOAuthStore
  });

  registerAdminRoutes(app, {
    core: {
      config,
      runtimeStats,
      recentRequestsStore,
      cloudflaredRuntime,
      tempMailController,
      expiredAccountCleanupController,
      getProxyApiKeyStore,
      getAuthStatus,
      checkCloudflaredInstalled,
      buildApiKeySummary,
      getActiveUpstreamBaseUrl,
      isCodexMultiAccountEnabled,
      getCloudflaredStatus,
      getCodexPreheatState,
      createProxyApiKey,
      hashProxyApiKey,
      sanitizeProxyApiKeyLabel,
      persistProxyApiKeyStore,
      readJsonBody,
      startCloudflaredTunnel,
      stopCloudflaredTunnel,
      installCloudflaredBinary,
      validCloudflaredModes,
      parseNumberEnv,
      getOfficialModelCandidateIds,
      getOfficialCodexModelCandidateIds
    },
    pool: {
      config,
      readJsonBody,
      getCodexOAuthStore,
      setCodexOAuthStore,
      ensureCodexOAuthStoreShape,
      saveTokenStore,
      clearAuthContextCache,
      buildCodexPoolMetrics: (...args) => buildCodexPoolMetrics(...args),
      isCodexMultiAccountEnabled,
      getCodexPoolEntryId,
      findCodexPoolAccountByRef,
      removeCodexPoolAccountFromStore,
      isCodexAccountLeased,
      importIntoCodexAuthPool,
      extractCodexOAuthImportItems: proxyRouteHandlerDeps.extractCodexOAuthImportItems,
      normalizeOpenAICodexPlanType,
      refreshCodexUsageSnapshotInStore,
      refreshCodexTokensInStore,
      runCodexPreheat,
      getCodexPreheatState
    },
    settings: {
      config,
      cloudflaredRuntime,
      runtimeStats,
      recentRequestsStore,
      persistProxyConfigEnv: async (nextConfig) => await persistProxyConfigEnv(envFilePath, nextConfig),
      readJsonBody,
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
    }
  });

  const proxyRouteHandlers = createProxyRouteHandlers(proxyRouteHandlerDeps);
  registerProviderRoutes(app, { handlers: proxyRouteHandlers });
  return { proxyRouteHandlers };
}

function createSyncResolvedRuntimeAddress({
  config,
  hasExplicitCustomOAuthRedirectUri,
  hasExplicitCloudflaredLocalPort,
  cloudflaredRuntime
}) {
  return function syncResolvedRuntimeAddress({ port, requestedPort }) {
    if (!hasExplicitCustomOAuthRedirectUri) {
      config.customOAuth.redirectUri = `http://${config.host}:${config.port}/auth/callback`;
    }

    const currentCloudflaredPort = Number(cloudflaredRuntime.localPort || 0) || 0;
    if (!hasExplicitCloudflaredLocalPort || currentCloudflaredPort === 0 || currentCloudflaredPort === requestedPort) {
      config.publicAccess.localPort = port;
      cloudflaredRuntime.localPort = port;
    }
  };
}

export function createServerLifecycleRuntime({
  app,
  config,
  parseBooleanEnv,
  processEnv,
  hasExplicitCustomOAuthRedirectUri,
  hasExplicitCloudflaredLocalPort,
  cloudflaredRuntime,
  getActiveUpstreamBaseUrl,
  startExpiredAccountCleanupTimer,
  stopExpiredAccountCleanupTimer,
  expiredAccountCleanupController,
  hasActiveManagedProxyApiKeys,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  recordManagedProxyApiKeyUsage,
  proxyRouteHandlers,
  parseResponsesResultFromSse,
  readUpstreamTextOrThrow,
  parseJsonLoose,
  tempMailController,
  recentRequestsStore,
  flushProxyApiKeyStore,
  stopCloudflaredTunnel,
  stopCodexOAuthCallbackServer,
  runBoundedShutdownStep
}) {
  let responsesWebSocketRuntime = null;
  const shouldAutostartServer = !parseBooleanEnv(processEnv.CODEX_PRO_MAX_DISABLE_AUTOSTART, false);
  const syncResolvedAddress = createSyncResolvedRuntimeAddress({
    config,
    hasExplicitCustomOAuthRedirectUri,
    hasExplicitCloudflaredLocalPort,
    cloudflaredRuntime
  });

  const serverLifecycle = startConfiguredServer({
    app,
    config,
    shouldAutostart: shouldAutostartServer,
    installSignalHandlers: shouldAutostartServer,
    getActiveUpstreamBaseUrl,
    syncResolvedAddress,
    onStartup: ({ server }) => {
      responsesWebSocketRuntime = attachResponsesWebSocketServer(server, {
        config,
        hasActiveManagedProxyApiKeys,
        extractProxyApiKeyFromRequest,
        findManagedProxyApiKeyByValue,
        recordManagedProxyApiKeyUsage,
        recordRecentProxyRequest: proxyRouteHandlers.recordRecentProxyRequest,
        openResponsesCreateProxySession: proxyRouteHandlers.openResponsesCreateProxySession,
        parseResponsesResultFromSse,
        readUpstreamTextOrThrow,
        parseJsonLoose
      });
      startExpiredAccountCleanupTimer();
      if (config.authMode === "profile-store") {
        console.log(`source: ${config.profileStore.authStorePath}`);
        console.log(`profile:${config.profileStore.profileId}`);
      } else if (config.authMode === "codex-oauth") {
        console.log(`oauth-authorize: ${config.codexOAuth.authorizeUrl}`);
        console.log(`oauth-store:     ${config.codexOAuth.tokenStorePath}`);
        console.log(`login:           http://${config.host}:${config.port}/auth/login`);
      } else {
        console.log(`oauth-authorize: ${config.customOAuth.authorizeUrl}`);
        console.log(`oauth-store:     ${config.customOAuth.tokenStorePath}`);
        console.log(`login:           http://${config.host}:${config.port}/auth/login`);
      }
      console.log(`status:          http://${config.host}:${config.port}/auth/status`);
      console.log(`dashboard:       http://${config.host}:${config.port}/dashboard/`);
      console.log(`proxy:           http://${config.host}:${config.port}/v1/*`);
      console.log(
        `account-auto-rm: ${config.expiredAccountCleanup.enabled ? "enabled" : "disabled"} (${config.expiredAccountCleanup.intervalSeconds}s)`
      );
      if (config.expiredAccountCleanup.enabled) {
        expiredAccountCleanupController.run("startup").catch((err) => {
          console.warn(`[auth-pool] account auto-rm failed on startup: ${err?.message || err}`);
        });
      }
    },
    onShutdown: async () => {
      const runtime = responsesWebSocketRuntime;
      responsesWebSocketRuntime = null;
      stopExpiredAccountCleanupTimer();
      await Promise.allSettled([
        runBoundedShutdownStep("responses websocket runtime", async () => {
          await runtime?.close?.();
        }, 1500),
        runBoundedShutdownStep("codex oauth callback server", async () => {
          await stopCodexOAuthCallbackServer();
        }, 1500),
        runBoundedShutdownStep("temp mail controller", async () => {
          await tempMailController.shutdown();
        }, 2500),
        runBoundedShutdownStep("recent requests flush", async () => {
          await recentRequestsStore.flush();
        }, 1500),
        runBoundedShutdownStep("proxy api key flush", async () => {
          await flushProxyApiKeyStore();
        }, 1500),
        runBoundedShutdownStep("cloudflared tunnel", async () => {
          await stopCloudflaredTunnel();
        }, 2500)
      ]);
    }
  });

  return { serverLifecycle, shouldAutostartServer };
}
