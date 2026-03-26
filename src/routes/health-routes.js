export function registerHealthRoutes(app, context) {
  const { config, getAuthStatus, getActiveUpstreamBaseUrl, isCodexMultiAccountEnabled } = context;

  app.get("/", async (_req, res) => {
    const status = await getAuthStatus();
    res.json({
      name: "codex-pro-max",
      mode: config.authMode,
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
      multiAccountEnabled: isCodexMultiAccountEnabled(),
      multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
      authenticated: status.authenticated,
      status: "/auth/status",
      login:
        config.authMode === "profile-store"
          ? "login via profile store"
          : `http://${config.host}:${config.port}/auth/login`,
      proxyBase: "/v1/*",
      dashboard: `http://${config.host}:${config.port}/dashboard/`
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      ts: Date.now(),
      mode: config.authMode,
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl()
    });
  });
}
