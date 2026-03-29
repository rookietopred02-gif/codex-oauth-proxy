function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

function extractDashboardClientAddress(req) {
  return (
    String(req?.socket?.remoteAddress || "").trim() ||
    String(req?.connection?.remoteAddress || "").trim() ||
    "unknown"
  );
}

function requestOriginatesLocally(req) {
  const address = extractDashboardClientAddress(req);
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.toLowerCase() === "localhost"
  );
}

function writeDashboardAuthError(res, authResult) {
  setNoStoreHeaders(res);
  res.status(401).json({
    error: authResult?.error || "dashboard_auth_required",
    message: authResult?.message || "Dashboard authentication required."
  });
}

function requiresDashboardAuth(pathName) {
  const path = String(pathName || "");
  if (path.startsWith("/admin")) return true;
  return path === "/auth/status" || path === "/auth/login" || path === "/auth/logout";
}

export function registerDashboardAuthProtection(app, context) {
  const { dashboardAuth } = context;

  app.use((req, res, next) => {
    const pathName = String(req.path || req.url || "");
    if (!requiresDashboardAuth(pathName)) {
      next();
      return;
    }

    setNoStoreHeaders(res);
    const authResult = dashboardAuth.authenticateRequest(req);
    if (authResult.ok) {
      next();
      return;
    }

    dashboardAuth.clearSessionCookie(res, req);
    writeDashboardAuthError(res, authResult);
  });
}

export function registerDashboardAuthRoutes(app, context) {
  const { dashboardAuth, readJsonBody } = context;

  app.get("/dashboard-auth/status", async (req, res) => {
    setNoStoreHeaders(res);
    res.json(dashboardAuth.getPublicStatus(req));
  });

  app.post("/dashboard-auth/login", async (req, res) => {
    setNoStoreHeaders(res);
    try {
      const body = await readJsonBody(req);
      const password = typeof body?.password === "string" ? body.password : "";
      await dashboardAuth.attemptLogin(req, password);
      dashboardAuth.appendSessionCookie(res, req);
      res.json({
        ...dashboardAuth.getPublicStatus(req),
        authenticated: true
      });
    } catch (err) {
      if (err?.code === "dashboard_auth_rate_limited") {
        if (Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0) {
          res.setHeader("Retry-After", String(Math.floor(err.retryAfterSeconds)));
        }
        res.status(429).json({
          error: err.code,
          message: err.message
        });
        return;
      }
      res.status(401).json({
        error: err?.code || "dashboard_auth_login_failed",
        message: err?.message || "Dashboard login failed."
      });
    }
  });

  app.post("/dashboard-auth/logout", async (req, res) => {
    setNoStoreHeaders(res);
    const authResult = dashboardAuth.authenticateRequest(req);
    if (!authResult.ok && dashboardAuth.isEnabled()) {
      dashboardAuth.clearSessionCookie(res, req);
      writeDashboardAuthError(res, authResult);
      return;
    }

    dashboardAuth.clearSessionCookie(res, req);
    res.json({
      ok: true,
      enabled: dashboardAuth.isEnabled(),
      configured: dashboardAuth.isConfigured(),
      authenticated: false
    });
  });

  app.post("/dashboard-auth/config", async (req, res) => {
    setNoStoreHeaders(res);
    const authResult = dashboardAuth.authenticateRequest(req);
    if (!dashboardAuth.isEnabled() && !requestOriginatesLocally(req)) {
      res.status(403).json({
        error: "dashboard_auth_local_only",
        message: "Initial dashboard password configuration is only allowed from the local machine."
      });
      return;
    }
    if (dashboardAuth.isEnabled() && !authResult.ok) {
      dashboardAuth.clearSessionCookie(res, req);
      writeDashboardAuthError(res, authResult);
      return;
    }

    try {
      const body = await readJsonBody(req);
      const enabled = body?.enabled;
      const password = typeof body?.password === "string" ? body.password : undefined;
      const nextState = await dashboardAuth.configure({
        enabled: typeof enabled === "boolean" ? enabled : undefined,
        password
      });
      if (nextState.enabled) {
        dashboardAuth.appendSessionCookie(res, req);
      } else {
        dashboardAuth.clearSessionCookie(res, req);
      }
      res.json({
        ok: true,
        enabled: nextState.enabled,
        configured: nextState.configured,
        authenticated: nextState.enabled
      });
    } catch (err) {
      res.status(400).json({
        error: "dashboard_auth_config_invalid",
        message: err?.message || "Invalid dashboard authentication settings."
      });
    }
  });
}
