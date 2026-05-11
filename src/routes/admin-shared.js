export function assertCodexOAuthMode(config, res, featureName) {
  if (config.authMode === "codex-oauth") return true;
  res.status(400).json({
    error: "unsupported_mode",
    message: `${featureName} is only available in AUTH_MODE=codex-oauth.`
  });
  return false;
}

function readSnapshotPort(value, fallback = 8787) {
  const parse = (candidate) => {
    if (candidate === null || candidate === undefined || candidate === "") return null;
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) return null;
      return Math.min(65535, Math.max(1, candidate));
    }
    if (typeof candidate !== "string" || !/^[+-]?\d+$/.test(candidate.trim())) return null;
    const parsed = Number(candidate.trim());
    if (!Number.isSafeInteger(parsed)) return null;
    return Math.min(65535, Math.max(1, parsed));
  };

  return parse(value) ?? parse(fallback) ?? 8787;
}

export function buildAdminConfigSnapshot({
  config,
  cloudflaredRuntime,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  apiKeyEnforced = false
}) {
  const activeRuntimePort = readSnapshotPort(config.port, 8787);
  const runtimePort = readSnapshotPort(config.runtimePort, activeRuntimePort);

  return {
    authMode: config.authMode,
    runtimeHost: config.host,
    activeRuntimePort,
    runtimePort,
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl(),
    defaultModel: config.codex.defaultModel,
    defaultInstructions: config.codex.defaultInstructions,
    defaultServiceTier: config.codex.defaultServiceTier,
    sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
    apiKeyEnforced,
    multiAccountEnabled: isCodexMultiAccountEnabled(),
    multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
    multiAccountPoolFilter: config.codexOAuth.multiAccountPoolFilter || "all",
    autoLogoutExpiredAccounts: config.expiredAccountCleanup.enabled === true,
    modelRouterEnabled: config.modelRouter.enabled,
    modelMappings: config.modelRouter.customMappings,
    recentRequestsPath: config.requestAudit.historyPath,
    publicAccess: {
      mode: cloudflaredRuntime.mode || config.publicAccess.defaultMode,
      useHttp2: cloudflaredRuntime.useHttp2 !== false,
      autoInstall: config.publicAccess.autoInstall !== false,
      localPort: readSnapshotPort(cloudflaredRuntime.localPort, activeRuntimePort)
    }
  };
}
