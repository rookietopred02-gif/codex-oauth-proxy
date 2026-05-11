import { setNoStoreHeaders } from "../http/cache-headers.js";
import { getRequestBodyErrorStatus, isRequestBodyError } from "../http/request-body.js";

function extractDashboardClientAddress(req) {
  return (
    String(req?.socket?.remoteAddress || "").trim() ||
    String(req?.connection?.remoteAddress || "").trim() ||
    "unknown"
  );
}

function hasProxyForwardingHeaders(req) {
  const headers = req?.headers && typeof req.headers === "object" ? req.headers : {};
  return [
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip"
  ].some((name) => String(headers[name] || "").trim().length > 0);
}

function requestOriginatesLocally(req) {
  const address = extractDashboardClientAddress(req);
  const loopback =
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.toLowerCase() === "localhost";
  return loopback && !hasProxyForwardingHeaders(req);
}

function writeDashboardAuthError(res, authResult) {
  setNoStoreHeaders(res);
  res.status(401).json({
    error: authResult?.error || "dashboard_auth_required",
    message: authResult?.message || "Dashboard authentication required."
  });
}

function writeDashboardBodyError(res, err) {
  res.status(getRequestBodyErrorStatus(err)).json({
    error: err?.code || "invalid_request",
    message: err?.message || "Invalid request body."
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
    const authResult = dashboardAuth.authenticateRequest(req, {
      allowDisabled: requestOriginatesLocally(req)
    });
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
      if (isRequestBodyError(err)) {
        writeDashboardBodyError(res, err);
        return;
      }
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
    if (!dashboardAuth.isEnabled() && !requestOriginatesLocally(req)) {
      res.status(403).json({
        error: "dashboard_auth_local_only",
        message: "Initial dashboard password configuration is only allowed from the local machine."
      });
      return;
    }
    const authResult = dashboardAuth.authenticateRequest(req, {
      allowDisabled: requestOriginatesLocally(req)
    });
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
      if (isRequestBodyError(err)) {
        writeDashboardBodyError(res, err);
        return;
      }
      res.status(400).json({
        error: "dashboard_auth_config_invalid",
        message: err?.message || "Invalid dashboard authentication settings."
      });
    }
  });
}
