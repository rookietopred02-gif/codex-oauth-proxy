export function assertCodexOAuthMode(config, res, featureName) {
  if (config.authMode === "codex-oauth") return true;
  res.status(400).json({
    error: "unsupported_mode",
    message: `${featureName} is only available in AUTH_MODE=codex-oauth.`
  });
  return false;
}

export function buildAdminConfigSnapshot({
  config,
  cloudflaredRuntime,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  apiKeyEnforced = false
}) {
  return {
    authMode: config.authMode,
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl(),
    defaultModel: config.codex.defaultModel,
    defaultInstructions: config.codex.defaultInstructions,
    defaultServiceTier: config.codex.defaultServiceTier,
    defaultReasoningEffort: config.codex.defaultReasoningEffort,
    sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
    apiKeyEnforced,
    multiAccountEnabled: isCodexMultiAccountEnabled(),
    multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
    autoLogoutExpiredAccounts: config.expiredAccountCleanup.enabled === true,
    modelRouterEnabled: config.modelRouter.enabled,
    modelMappings: config.modelRouter.customMappings,
    recentRequestsPath: config.requestAudit.historyPath,
    publicAccess: {
      mode: cloudflaredRuntime.mode || config.publicAccess.defaultMode,
      useHttp2: cloudflaredRuntime.useHttp2 !== false,
      autoInstall: config.publicAccess.autoInstall !== false,
      localPort: Number(cloudflaredRuntime.localPort || config.port)
    }
  };
}
