import crypto from "node:crypto";
import { buildAdminConfigSnapshot } from "./admin-shared.js";

export function registerAdminCoreRoutes(app, context) {
  const {
    config,
    runtimeStats,
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
    validCloudflaredModes,
    getOfficialModelCandidateIds,
    getOfficialCodexModelCandidateIds
  } = context;

  app.get("/admin/state", async (_req, res) => {
    try {
      const authStatus = await getAuthStatus();
      await checkCloudflaredInstalled(false).catch(() => {});
      await tempMailController.refreshRunner(false).catch(() => {});
      const apiKeySummary = buildApiKeySummary();
      res.json({
        ok: true,
        startedAt: runtimeStats.startedAt,
        uptimeMs: Date.now() - runtimeStats.startedAt,
        config: buildAdminConfigSnapshot({
          config,
          cloudflaredRuntime,
          getActiveUpstreamBaseUrl,
          isCodexMultiAccountEnabled,
          apiKeyEnforced: apiKeySummary.enforced
        }),
        auth: authStatus,
        apiKeys: apiKeySummary,
        publicAccess: getCloudflaredStatus(),
        preheat: getCodexPreheatState(),
        expiredAccountCleanup: expiredAccountCleanupController.getState(),
        tempMail: tempMailController.getState(),
        stats: {
          totalRequests: runtimeStats.totalRequests,
          okRequests: runtimeStats.okRequests,
          errorRequests: runtimeStats.errorRequests,
          recentRequestsPath: config.requestAudit.historyPath,
          recentRequests: runtimeStats.recentRequests
        }
      });
    } catch (err) {
      res.status(500).json({ error: "state_failed", message: err.message });
    }
  });

  app.get("/admin/api-keys", async (_req, res) => {
    const summary = buildApiKeySummary();
    res.json({
      ok: true,
      ...summary
    });
  });

  app.post("/admin/api-keys/generate", async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const nowSec = Math.floor(Date.now() / 1000);
      const label = sanitizeProxyApiKeyLabel(body?.label);
      const expiresInDaysRaw = Number(body?.expiresInDays);
      const expiresInDays = Number.isFinite(expiresInDaysRaw)
        ? Math.max(0, Math.min(3650, Math.floor(expiresInDaysRaw)))
        : 0;
      const expiresAt = expiresInDays > 0 ? nowSec + expiresInDays * 86400 : 0;
      const apiKey = createProxyApiKey();
      const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
      const entry = {
        id,
        label,
        prefix: apiKey.slice(0, 10),
        value: apiKey,
        hash: hashProxyApiKey(apiKey),
        created_at: nowSec,
        last_used_at: 0,
        use_count: 0,
        revoked_at: 0,
        expires_at: expiresAt
      };

      const proxyApiKeyStore = getProxyApiKeyStore();
      if (!Array.isArray(proxyApiKeyStore.keys)) proxyApiKeyStore.keys = [];
      proxyApiKeyStore.keys.unshift(entry);
      await persistProxyApiKeyStore(proxyApiKeyStore);

      res.json({
        ok: true,
        apiKey,
        key: {
          id: entry.id,
          label: entry.label,
          prefix: entry.prefix,
          value: entry.value,
          createdAt: entry.created_at,
          expiresAt: entry.expires_at > 0 ? entry.expires_at : null,
          active: true
        },
        summary: buildApiKeySummary()
      });
    } catch (err) {
      res.status(400).json({
        error: "api_key_generate_failed",
        message: err.message
      });
    }
  });

  app.post("/admin/api-keys/revoke", async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const id = String(body?.id || "").trim();
      if (!id) {
        throw new Error("id is required.");
      }
      const proxyApiKeyStore = getProxyApiKeyStore();
      const keys = Array.isArray(proxyApiKeyStore.keys) ? proxyApiKeyStore.keys : [];
      const targetIdx = keys.findIndex((x) => String(x?.id || "") === id);
      if (targetIdx < 0) {
        res.status(404).json({
          error: "api_key_not_found",
          message: "API key not found."
        });
        return;
      }
      keys.splice(targetIdx, 1);
      await persistProxyApiKeyStore(proxyApiKeyStore);
      res.json({
        ok: true,
        id,
        summary: buildApiKeySummary()
      });
    } catch (err) {
      res.status(400).json({
        error: "api_key_revoke_failed",
        message: err.message
      });
    }
  });

  app.get("/admin/public-access/status", async (_req, res) => {
    await checkCloudflaredInstalled(false).catch(() => {});
    res.json({
      ok: true,
      status: getCloudflaredStatus()
    });
  });

  app.post("/admin/public-access/install", async (_req, res) => {
    try {
      const result = await context.installCloudflaredBinary();
      res.json({
        ok: true,
        result,
        status: getCloudflaredStatus()
      });
    } catch (err) {
      res.status(400).json({
        error: "public_access_install_failed",
        message: err.message,
        status: getCloudflaredStatus()
      });
    }
  });

  app.post("/admin/public-access/start", async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const modeRaw = String(body?.mode || "").trim().toLowerCase();
      const mode = validCloudflaredModes.has(modeRaw)
        ? modeRaw
        : cloudflaredRuntime.mode || config.publicAccess.defaultMode;
      const token = body?.token === undefined ? undefined : String(body.token || "").trim();
      const useHttp2 = body?.useHttp2 === undefined ? undefined : Boolean(body.useHttp2);
      const autoInstall = body?.autoInstall === undefined ? undefined : Boolean(body.autoInstall);

      const status = await startCloudflaredTunnel({
        mode,
        token,
        useHttp2,
        autoInstall
      });

      config.publicAccess.defaultMode = status.mode;
      config.publicAccess.defaultUseHttp2 = status.useHttp2 !== false;
      config.publicAccess.defaultTunnelToken = cloudflaredRuntime.tunnelToken || "";
      config.publicAccess.localPort = Number(status.localPort || config.port);

      res.json({
        ok: true,
        status
      });
    } catch (err) {
      res.status(400).json({
        error: "public_access_start_failed",
        message: err.message
      });
    }
  });

  app.post("/admin/public-access/stop", async (_req, res) => {
    try {
      const status = await stopCloudflaredTunnel();
      res.json({
        ok: true,
        status
      });
    } catch (err) {
      res.status(400).json({
        error: "public_access_stop_failed",
        message: err.message
      });
    }
  });

  app.get("/admin/model-candidates", async (req, res) => {
    const forceRefresh = String(req.query.refresh || "").trim() === "1";
    const [models, codexModels] = await Promise.all([
      getOfficialModelCandidateIds({ forceRefresh }),
      getOfficialCodexModelCandidateIds({ forceRefresh })
    ]);
    res.json({
      ok: true,
      models,
      codexModels,
      wildcardPresets: ["gpt-*", "gpt-4*", "gpt-5*", "claude-*", "gemini-*"]
    });
  });
}
