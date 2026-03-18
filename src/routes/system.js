import express from "express";

import { isProxyApiPath } from "../http/audit.js";

export function registerCommonMiddleware(app, context) {
  const {
    config,
    hasActiveManagedProxyApiKeys,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    recordManagedProxyApiKeyUsage
  } = context;

  app.use((req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      req.rawBody = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
      next();
    });
    req.on("error", next);
  });

  app.use((req, res, next) => {
    const pathName = String(req.path || req.url || "");
    if (!isProxyApiPath(pathName)) {
      next();
      return;
    }

    const managedEnabled = hasActiveManagedProxyApiKeys();
    const legacyKey = String(config.codexOAuth.sharedApiKey || "").trim();
    if (!managedEnabled && !legacyKey) {
      next();
      return;
    }

    const provided = extractProxyApiKeyFromRequest(req);
    const managedMatch = findManagedProxyApiKeyByValue(provided);
    if (managedMatch) {
      recordManagedProxyApiKeyUsage(managedMatch);
      res.locals.proxyApiKeyId = managedMatch.id;
      next();
      return;
    }
    if (!managedEnabled && legacyKey && provided === legacyKey) {
      next();
      return;
    }
    if (managedEnabled && legacyKey && provided === legacyKey) {
      next();
      return;
    }

    res.status(401).json({
      error: "invalid_api_key",
      message:
        "Invalid API key. Use one of: Authorization: Bearer <your_proxy_api_key>, x-api-key, x-goog-api-key, or ?key=<your_proxy_api_key>."
    });
  });
}

export function registerSystemRoutes(app, context) {
  const {
    publicDir,
    config,
    getAuthStatus,
    getActiveUpstreamBaseUrl,
    isCodexMultiAccountEnabled
  } = context;

  app.use("/dashboard", express.static(publicDir));
  app.get("/dashboard", (_req, res) => {
    res.redirect("/dashboard/");
  });

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
