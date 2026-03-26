import express from "express";

import { isProxyApiPath } from "../http/audit.js";
import { authorizeProxyApiRequest } from "../http/proxy-api-key-auth.js";

export function registerCommonMiddleware(app, context) {
  const {
    config,
    hasActiveManagedProxyApiKeys,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    recordManagedProxyApiKeyUsage
  } = context;

  app.use((req, res, next) => {
    const pathName = String(req.path || req.url || "");
    if (!isProxyApiPath(pathName)) {
      next();
      return;
    }

    const authorization = authorizeProxyApiRequest(req, {
      config,
      hasActiveManagedProxyApiKeys,
      extractProxyApiKeyFromRequest,
      findManagedProxyApiKeyByValue,
      recordManagedProxyApiKeyUsage
    });
    if (authorization.ok) {
      res.locals.proxyApiKeyId = authorization.proxyApiKeyId;
      next();
      return;
    }

    res.status(authorization.statusCode).json(authorization.payload);
  });
}

export function registerSystemRoutes(app, context) {
  const { publicDir } = context;

  app.use("/dashboard", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  app.use("/dashboard", express.static(publicDir));
  app.get("/dashboard", (_req, res) => {
    res.redirect("/dashboard/");
  });
}
