import crypto from "node:crypto";

import { setNoStoreHeaders } from "../http/cache-headers.js";
import { getRequestBodyErrorStatus, isRequestBodyError } from "../http/request-body.js";
import { buildAdminConfigSnapshot } from "./admin-shared.js";

export function registerAdminCoreRoutes(app, context) {
  const {
    config,
    runtimeStats,
    recentRequestsStore,
    cloudflaredRuntime,
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

  function buildRequestDetailSummary(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const summary = { ...row };
    const packetFields = ["requestPacket", "upstreamRequestPacket", "responsePacket"];
    summary.packetInfo = Object.fromEntries(
      packetFields.map((field) => {
        const text = typeof row[field] === "string" ? row[field] : "";
        return [
          field,
          {
            chars: text.length,
            bytes: Buffer.byteLength(text, "utf8")
          }
        ];
      })
    );
    for (const field of packetFields) {
      delete summary[field];
    }
    return summary;
  }

  function getCloudflaredSecretValues(extraValues = []) {
    return [
      config?.publicAccess?.defaultTunnelToken,
      cloudflaredRuntime?.tunnelToken,
      ...(Array.isArray(extraValues) ? extraValues : [extraValues])
    ]
      .map((value) => String(value || "").trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
  }

  function redactCloudflaredText(value, extraValues = []) {
    if (typeof value !== "string") return value;
    let redacted = value;
    for (const secret of getCloudflaredSecretValues(extraValues)) {
      redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted.replace(/(--token(?:=|\s+))\S+/gi, "$1[redacted]");
  }

  function sanitizeCloudflaredStatus(status) {
    if (!status || typeof status !== "object" || Array.isArray(status)) return status;
    const { token, tunnelToken, defaultTunnelToken, ...safeStatus } = status;
    const statusSecretValues = [token, tunnelToken, defaultTunnelToken];
    if (typeof safeStatus.error === "string") safeStatus.error = redactCloudflaredText(safeStatus.error, statusSecretValues);
    if (typeof safeStatus.installMessage === "string") {
      safeStatus.installMessage = redactCloudflaredText(safeStatus.installMessage, statusSecretValues);
    }
    if (Array.isArray(safeStatus.outputTail)) {
      safeStatus.outputTail = safeStatus.outputTail.map((value) => redactCloudflaredText(value, statusSecretValues));
    }
    return safeStatus;
  }

  function sanitizeCloudflaredErrorMessage(err, extraValues = []) {
    return redactCloudflaredText(String(err?.message || err || "Cloudflared operation failed."), extraValues);
  }

  function writeRequestBodyError(res, err) {
    if (!isRequestBodyError(err)) return false;
    res.status(getRequestBodyErrorStatus(err)).json({
      error: err?.code || "invalid_request",
      message: err?.message || "Invalid request body."
    });
    return true;
  }

  function readBoundedInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parse = (candidate) => {
      if (candidate === null || candidate === undefined || candidate === "") return null;
      if (typeof candidate === "number") {
        if (!Number.isSafeInteger(candidate)) return null;
        return Math.min(max, Math.max(min, candidate));
      }
      if (typeof candidate !== "string" || !/^[+-]?\d+$/.test(candidate.trim())) return null;
      const parsed = Number(candidate.trim());
      if (!Number.isSafeInteger(parsed)) return null;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };
    const parsed = parse(value);
    if (parsed !== null) return parsed;
    return parse(fallback) ?? min;
  }

  function readBoundedQueryInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    return readBoundedInteger(value, fallback, 0, max);
  }

  function readBoundedPort(value, fallback) {
    return readBoundedInteger(value, fallback, 1, 65535);
  }

  app.get("/admin/state", async (_req, res) => {
    setNoStoreHeaders(res);
    try {
      const authStatus = await getAuthStatus();
      void checkCloudflaredInstalled(false).catch(() => {});
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
        publicAccess: sanitizeCloudflaredStatus(getCloudflaredStatus()),
        preheat: getCodexPreheatState(),
        expiredAccountCleanup: expiredAccountCleanupController.getState(),
        stats: {
          totalRequests: runtimeStats.totalRequests,
          okRequests: runtimeStats.okRequests,
          errorRequests: runtimeStats.errorRequests,
          auditErrors: runtimeStats.auditErrors,
          lastAuditError: runtimeStats.lastAuditError,
          recentRequestsPath: config.requestAudit.historyPath,
          recentRequests: runtimeStats.recentRequests
        }
      });
    } catch (err) {
      res.status(500).json({ error: "state_failed", message: err.message });
    }
  });

  app.get("/admin/requests/:requestId", async (req, res) => {
    setNoStoreHeaders(res);
    const requestId = String(req.params?.requestId || "").trim();
    if (!requestId) {
      res.status(400).json({
        error: "request_id_required",
        message: "requestId is required."
      });
      return;
    }

    const detailSummary =
      typeof recentRequestsStore.getDetailSummaryById === "function"
        ? await recentRequestsStore.getDetailSummaryById(requestId)
        : buildRequestDetailSummary(await recentRequestsStore.getById(requestId));
    if (!detailSummary) {
      res.status(404).json({
        error: "request_not_found",
        message: "Recent request detail not found."
      });
      return;
    }

    res.json({
      ok: true,
      request: detailSummary
    });
  });

  app.get("/admin/requests/:requestId/packet", async (req, res) => {
    setNoStoreHeaders(res);
    const requestId = String(req.params?.requestId || "").trim();
    const field = String(req.query?.field || "").trim();
    const offset = readBoundedQueryInteger(req.query?.offset, 0);
    const limit = readBoundedQueryInteger(req.query?.limit, 65536, 20_000_000);
    if (!requestId) {
      res.status(400).json({
        error: "request_id_required",
        message: "requestId is required."
      });
      return;
    }
    if (!["requestPacket", "upstreamRequestPacket", "responsePacket"].includes(field)) {
      res.status(400).json({
        error: "invalid_packet_field",
        message: "field must be requestPacket, upstreamRequestPacket, or responsePacket."
      });
      return;
    }

    const packet =
      typeof recentRequestsStore.getPacketSliceById === "function"
        ? await recentRequestsStore.getPacketSliceById(requestId, field, { offset, limit })
        : null;
    if (!packet) {
      res.status(404).json({
        error: "request_packet_not_found",
        message: "Recent request packet detail not found."
      });
      return;
    }

    res.json({
      ok: true,
      packet
    });
  });

  app.get("/admin/api-keys", async (_req, res) => {
    setNoStoreHeaders(res);
    const summary = buildApiKeySummary();
    res.json({
      ok: true,
      ...summary
    });
  });

  app.post("/admin/api-keys/generate", async (req, res) => {
    setNoStoreHeaders(res);
    try {
      const body = await readJsonBody(req);
      const nowSec = Math.floor(Date.now() / 1000);
      const label = sanitizeProxyApiKeyLabel(body?.label);
      const expiresInDays = readBoundedInteger(body?.expiresInDays, 0, 0, 3650);
      const expiresAt = expiresInDays > 0 ? nowSec + expiresInDays * 86400 : 0;
      const apiKey = createProxyApiKey();
      const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
      const entry = {
        id,
        label,
        prefix: apiKey.slice(0, 10),
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
          createdAt: entry.created_at,
          expiresAt: entry.expires_at > 0 ? entry.expires_at : null,
          active: true
        },
        summary: buildApiKeySummary()
      });
    } catch (err) {
      if (writeRequestBodyError(res, err)) return;
      res.status(400).json({
        error: "api_key_generate_failed",
        message: err.message
      });
    }
  });

  app.post("/admin/api-keys/revoke", async (req, res) => {
    setNoStoreHeaders(res);
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
      if (writeRequestBodyError(res, err)) return;
      res.status(400).json({
        error: "api_key_revoke_failed",
        message: err.message
      });
    }
  });

  app.get("/admin/public-access/status", async (_req, res) => {
    setNoStoreHeaders(res);
    await checkCloudflaredInstalled(false).catch(() => {});
    res.json({
      ok: true,
      status: sanitizeCloudflaredStatus(getCloudflaredStatus())
    });
  });

  app.post("/admin/public-access/install", async (_req, res) => {
    setNoStoreHeaders(res);
    try {
      const result = await context.installCloudflaredBinary();
      res.json({
        ok: true,
        result,
        status: sanitizeCloudflaredStatus(getCloudflaredStatus())
      });
    } catch (err) {
      res.status(400).json({
        error: "public_access_install_failed",
        message: sanitizeCloudflaredErrorMessage(err),
        status: sanitizeCloudflaredStatus(getCloudflaredStatus())
      });
    }
  });

  app.post("/admin/public-access/start", async (req, res) => {
    setNoStoreHeaders(res);
    let requestedTunnelToken = "";
    try {
      const body = await readJsonBody(req);
      const modeRaw = String(body?.mode || "").trim().toLowerCase();
      const mode = validCloudflaredModes.has(modeRaw)
        ? modeRaw
        : cloudflaredRuntime.mode || config.publicAccess.defaultMode;
      const token = body?.token === undefined ? undefined : String(body.token || "").trim();
      requestedTunnelToken = token || "";
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
      if (status.mode === "auth") {
        config.publicAccess.defaultTunnelToken = cloudflaredRuntime.tunnelToken || "";
      }
      config.publicAccess.localPort = readBoundedPort(status.localPort, config.port);

      res.json({
        ok: true,
        status: sanitizeCloudflaredStatus(status)
      });
    } catch (err) {
      if (writeRequestBodyError(res, err)) return;
      res.status(400).json({
        error: "public_access_start_failed",
        message: sanitizeCloudflaredErrorMessage(err, [requestedTunnelToken])
      });
    }
  });

  app.post("/admin/public-access/stop", async (_req, res) => {
    setNoStoreHeaders(res);
    try {
      const status = await stopCloudflaredTunnel();
      res.json({
        ok: true,
        status: sanitizeCloudflaredStatus(status)
      });
    } catch (err) {
      res.status(400).json({
        error: "public_access_stop_failed",
        message: sanitizeCloudflaredErrorMessage(err)
      });
    }
  });

  app.get("/admin/model-candidates", async (req, res) => {
    setNoStoreHeaders(res);
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
