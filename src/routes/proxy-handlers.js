import { isResponsesCreatePath } from "../protocols/openai/responses-contract.js";

export function createProxyRouteHandlers(context) {
  const {
    config,
    runtimeStats,
    recentRequestsStore,
    hopByHop,
    readJsonBody,
    readRawBody,
    getCachedJsonBody,
    extractPreviousResponseId,
    extractUpstreamTransportError,
    isPreviousResponseIdUnsupportedError,
    formatPayloadForAudit,
    inferProtocolType,
    isProxyApiPath,
    parseContentType,
    sanitizeAuditPath,
    toChunkBuffer,
    normalizeCherryAnthropicAgentOriginalUrl,
    isGeminiNativeAliasPath,
    chooseProtocolForV1ChatCompletions,
    handleGeminiProtocol,
    handleAnthropicProtocol,
    getValidAuthContext,
    getCodexOriginator,
    noteUpstreamRetry,
    noteCompatibilityHint,
    noteUpstreamRequestAudit,
    fetchUpstreamWithRetry,
    pipeUpstreamBodyToResponse,
    readUpstreamTextOrThrow,
    normalizeCodexResponsesRequestBody,
    normalizeChatCompletionsRequestBody,
    parseJsonLoose,
    buildResponsesChainEntry,
    codexResponsesChain,
    expandResponsesRequestBodyFromChain,
    bridgeCodexResponsesCollaborationMode,
    isCodexMultiAccountEnabled,
    isCodexPoolRetryEnabled,
    shouldRotateCodexAccountForStatus,
    maybeMarkCodexPoolFailure,
    maybeCaptureCodexUsageFromHeaders,
    maybeMarkCodexPoolSuccess,
    truncate,
    parseResponsesResultFromSse,
    extractCompletedResponseFromJson,
    convertResponsesToChatCompletion,
    pipeCodexSseAsChatCompletions,
    pipeSseAndCaptureTokenUsage,
    handleGeminiNativeProxy,
    handleAnthropicNativeProxy,
    normalizeTokenUsage,
    extractTokenUsageFromAuditResponse,
    estimateOpenAIChatCompletionTokens,
    mergeNormalizedTokenUsage,
    resolveAuditAccountLabel,
    handleAnthropicModelsList,
    isAnthropicNativeRequest,
    getExecutableModelCandidateIds,
    getOfficialModelCandidateIds,
    getOpenAICompatibleModelIds,
    isCodexTokenInvalidatedError,
    codexResponseAffinity,
    getAuthModeHint
  } = context;

  function getCodexEndpointKind(pathname) {
    if (
      pathname === "/v1/responses" ||
      pathname.startsWith("/v1/responses/") ||
      pathname === "/v1/codex/responses" ||
      pathname.startsWith("/v1/codex/responses/")
    ) {
      return "responses";
    }
    if (/^\/v1\/chat\/completions\/v1\/messages(\/count_tokens)?\/?$/.test(pathname)) {
      return null;
    }
    if (pathname === "/v1/chat/completions" || pathname.startsWith("/v1/chat/completions/")) {
      return "chat-completions";
    }
    return null;
  }

  function isResponsesCompactPath(pathname) {
    return /^\/v1(?:\/codex)?\/responses\/compact\/?$/.test(String(pathname || ""));
  }

  function extractStringField(value, fieldName) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const raw = value[fieldName];
    return typeof raw === "string" ? raw.trim() : "";
  }

  function extractJsonBodyResponseId(rawBody, fieldNames = []) {
    if (!rawBody || rawBody.length === 0) return "";
    const parsed = parseJsonLoose(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    for (const fieldName of fieldNames) {
      const responseId = extractStringField(parsed, fieldName);
      if (responseId) return responseId;
    }
    return "";
  }

  function extractResponsesPathResponseId(pathname) {
    const match = String(pathname || "").match(/^\/v1(?:\/codex)?\/responses\/([^/?#]+)(?:\/|$)/);
    if (!match) return "";
    const responseId = decodeURIComponent(match[1] || "").trim();
    if (!responseId || responseId === "compact" || responseId === "input_tokens") return "";
    return responseId;
  }

  function extractResponsesAffinityLookupId(req, target, rawBody, pathname = "") {
    if (!target || target.endpointKind !== "responses") return "";
    if (req?.method === "POST" && isResponsesCreatePath(pathname)) {
      return extractPreviousResponseId(rawBody);
    }
    if (req?.method === "POST" && isResponsesCompactPath(pathname)) {
      return extractJsonBodyResponseId(rawBody, ["response_id", "previous_response_id"]);
    }
    return extractResponsesPathResponseId(pathname);
  }

  function buildUpstreamTarget(originalUrl) {
    const incoming = new URL(originalUrl, "http://localhost");
    const endpointKind = getCodexEndpointKind(incoming.pathname);
    if (!endpointKind) {
      throw new Error(
        "In UPSTREAM_MODE=codex-chatgpt, supported endpoints are /v1/responses and /v1/chat/completions."
      );
    }

    let mappedPath;
    if (endpointKind === "responses") {
      if (incoming.pathname === "/v1/codex/responses" || incoming.pathname.startsWith("/v1/codex/responses/")) {
        mappedPath = incoming.pathname.replace(/^\/v1/, "");
      } else {
        mappedPath = incoming.pathname.replace(/^\/v1\/responses/, "/codex/responses");
      }
    } else {
      mappedPath = incoming.pathname.replace(/^\/v1\/chat\/completions/, "/codex/responses");
    }

    const base = config.upstreamBaseUrl.replace(/\/+$/, "");
    return {
      url: `${base}${mappedPath}${incoming.search}`,
      endpointKind
    };
  }

  function resolvePinnedCodexPoolEntryId(req, target, rawBody, pathname = "") {
    if (config.authMode !== "codex-oauth" || !isCodexMultiAccountEnabled() || !isCodexPoolRetryEnabled()) return "";
    if (!target || target.endpointKind !== "responses") return "";
    const responseId = extractResponsesAffinityLookupId(req, target, rawBody, pathname);
    if (!responseId) return "";
    const affinity = codexResponseAffinity.lookup(responseId);
    return typeof affinity?.poolEntryId === "string" ? affinity.poolEntryId : "";
  }

  function shouldCaptureAuditPackets() {
    return config?.requestAudit?.capturePackets === true;
  }

  function getAuditPacketCharLimit() {
    const limit = Number(config?.requestAudit?.maxPacketChars || 0);
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    return Math.max(1, Math.floor(limit));
  }

  function recordAuditError(err, details = {}) {
    const message = String(err?.message || err || "Proxy audit hook failed.");
    const code = String(err?.code || err?.name || "audit_error");
    let safePath = String(details.rawPath || details.path || "");
    try {
      safePath = sanitizeAuditPath(safePath);
    } catch {}
    const auditError = {
      type: "audit_error",
      at: Date.now(),
      code: code || "audit_error",
      message: message.slice(0, 1000),
      method: String(details.method || ""),
      path: safePath,
      statusCode: Number(details.statusCode || 0) || 0,
      transportType: String(details.transportType || ""),
      phase: String(details.phase || "")
    };
    try {
      runtimeStats.auditErrors = (Number(runtimeStats.auditErrors || 0) || 0) + 1;
      runtimeStats.lastAuditError = auditError;
    } catch {}
    try {
      console.warn(
        `[audit_error] ${auditError.transportType || "unknown"} ${auditError.method || ""} ${
          auditError.path || ""
        } ${auditError.statusCode || ""}: ${auditError.message}`
      );
    } catch {}
    return auditError;
  }

  function recordRecentProxyRequest({
    startedAt = Date.now(),
    method = "GET",
    rawPath = "",
    statusCode = 200,
    requestBody = Buffer.alloc(0),
    requestContentType = "",
    upstreamRequestBody = Buffer.alloc(0),
    upstreamRequestContentType = "",
    responseBody = Buffer.alloc(0),
    responseContentType = "",
    protocolType = "",
    tokenUsage = null,
    modelRoute = null,
    authAccountId = null,
    proxyApiKeyId = null,
    proxyApiKeyLabel = "",
    upstreamRetryCount = 0,
    upstreamErrorCode = "",
    upstreamErrorDetail = "",
    compatibilityHint = "",
    transportType = ""
  } = {}) {
    const safePath = sanitizeAuditPath(rawPath);
    const resolvedProtocolType = inferProtocolType(safePath, protocolType, config.upstreamMode);
    const normalizedMethod = String(method || "GET").trim() || "GET";
    const normalizedTransportType =
      String(transportType || "").trim().toLowerCase() ||
      (normalizedMethod.toUpperCase() === "WS" ? "websocket" : "http");
    const normalizedResponseContentType = parseContentType(responseContentType);
    const capturePackets = shouldCaptureAuditPackets();
    const packetCharLimit = getAuditPacketCharLimit();
    const responsePacketForUsage = formatPayloadForAudit(responseBody, normalizedResponseContentType, 0);
    const responsePacket = capturePackets
      ? formatPayloadForAudit(responseBody, normalizedResponseContentType, packetCharLimit)
      : "";
    const providedTokenUsage = normalizeTokenUsage(tokenUsage);
    const packetTokenUsage =
      providedTokenUsage && providedTokenUsage.cachedInputTokens !== null
        ? null
        : extractTokenUsageFromAuditResponse({
            protocolType: resolvedProtocolType,
            responseContentType: normalizedResponseContentType,
            responsePacket: responsePacketForUsage
          });
    const normalizedTokenUsage = mergeNormalizedTokenUsage(
      providedTokenUsage,
      packetTokenUsage
    );
    const authAccountLabel = resolveAuditAccountLabel(authAccountId);

    runtimeStats.totalRequests += 1;
    if (statusCode >= 200 && statusCode < 400) runtimeStats.okRequests += 1;
    else runtimeStats.errorRequests += 1;

    const requestRow = {
      id: `req_${Date.now().toString(36)}_${context.nextRuntimeRequestSeq().toString(36)}`,
      ts: Date.now(),
      method: normalizedMethod,
      path: safePath,
      status: Number(statusCode || 0) || 0,
      durationMs: Math.max(0, Date.now() - Number(startedAt || Date.now())),
      inputTokens: normalizedTokenUsage?.inputTokens ?? null,
      cachedInputTokens: normalizedTokenUsage?.cachedInputTokens ?? null,
      outputTokens: normalizedTokenUsage?.outputTokens ?? null,
      totalTokens: normalizedTokenUsage?.totalTokens ?? null,
      requestedModel: modelRoute?.requestedModel ?? null,
      mappedModel: modelRoute?.mappedModel ?? null,
      routeType: modelRoute?.routeType ?? null,
      routeRule: modelRoute?.routeRule ?? null,
      protocolType: resolvedProtocolType,
      transportType: normalizedTransportType,
      upstreamMode: config.upstreamMode,
      authAccountId: authAccountId || null,
      authAccountLabel: authAccountLabel || null,
      proxyApiKeyId: proxyApiKeyId || null,
      proxyApiKeyLabel: String(proxyApiKeyLabel || "").trim() || null,
      upstreamRetryCount: Number.isFinite(Number(upstreamRetryCount)) ? Number(upstreamRetryCount) : 0,
      upstreamErrorCode: String(upstreamErrorCode || "").trim() || null,
      upstreamErrorDetail: String(upstreamErrorDetail || "").trim() || null,
      compatibilityHint: String(compatibilityHint || "").trim() || null,
      requestContentType: parseContentType(requestContentType) || null,
      upstreamRequestContentType: parseContentType(upstreamRequestContentType) || null,
      responseContentType: normalizedResponseContentType || null,
      requestPacket: capturePackets ? formatPayloadForAudit(requestBody, requestContentType, packetCharLimit) || "" : "",
      upstreamRequestPacket: capturePackets
        ? formatPayloadForAudit(upstreamRequestBody, upstreamRequestContentType, packetCharLimit) || ""
        : "",
      responsePacket: responsePacket || ""
    };

    const snapshot = recentRequestsStore.append(requestRow);
    if (Array.isArray(snapshot?.recentRequests)) {
      runtimeStats.recentRequests = snapshot.recentRequests;
    }
    return requestRow;
  }

  function recordRecentProxyRequestSafely(args = {}, details = {}) {
    try {
      return recordRecentProxyRequest(args);
    } catch (err) {
      recordAuditError(err, {
        method: args.method,
        rawPath: args.rawPath,
        statusCode: args.statusCode,
        transportType: args.transportType,
        phase: "record_recent_request",
        ...details
      });
      return null;
    }
  }

  function rememberCodexResponseAffinity(response, authContext) {
    if (config.authMode !== "codex-oauth" || !isCodexMultiAccountEnabled()) return;
    const responseId = typeof response?.id === "string" ? response.id.trim() : "";
    const poolEntryId =
      typeof authContext?.poolEntryId === "string" && authContext.poolEntryId.trim().length > 0
        ? authContext.poolEntryId.trim()
        : typeof authContext?.poolAccountId === "string"
          ? authContext.poolAccountId.trim()
          : "";
    if (!responseId || !poolEntryId) return;

    codexResponseAffinity.remember(responseId, {
      poolEntryId,
      accountId: typeof authContext?.accountId === "string" ? authContext.accountId : ""
    });
  }

  function maybeForgetPinnedCodexResponseAffinity(previousResponseId, statusCode, reason) {
    if (config.authMode !== "codex-oauth" || !isCodexMultiAccountEnabled()) return;
    if (!previousResponseId) return;
    if (!isCodexTokenInvalidatedError(statusCode, reason)) return;
    codexResponseAffinity.forget(previousResponseId);
  }

  function createRouteError(statusCode, error, message, extra = {}) {
    const err = new Error(message);
    err.statusCode = Number(statusCode || 500) || 500;
    err.error = error || "request_failed";
    Object.assign(err, extra);
    return err;
  }

  function prepareCodexResponsesCreateRequest(rawBody, parsedBody) {
    const previousResponseId = extractPreviousResponseId(rawBody);
    let requestJson = parsedBody;
    if (requestJson === undefined && rawBody.length > 0) {
      requestJson = parseJsonLoose(rawBody.toString("utf8"));
    }

    if (requestJson && typeof requestJson === "object" && !Array.isArray(requestJson)) {
      const normalizedRawBody = Buffer.from(JSON.stringify(requestJson), "utf8");
      return {
        previousResponseId,
        rawBody: normalizedRawBody,
        parsedBody: requestJson
      };
    }

    return {
      previousResponseId,
      rawBody,
      parsedBody
    };
  }

  function resolveCodexResponsesPreviousResponseReplay(preparedRequest) {
    const previousResponseId = String(preparedRequest?.previousResponseId || "").trim();
    if (!previousResponseId) {
      return {
        preparedRequest,
        previousResponseContinuation: false,
        compatibilityHint: ""
      };
    }

    const parsedBody =
      preparedRequest?.parsedBody !== undefined
        ? preparedRequest.parsedBody
        : parseJsonLoose(preparedRequest?.rawBody?.toString("utf8") || "");
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw createRouteError(
        400,
        "previous_response_id_requires_json",
        "previous_response_id requires a JSON Responses create request body."
      );
    }

    const previousEntry =
      codexResponsesChain && typeof codexResponsesChain.lookup === "function"
        ? codexResponsesChain.lookup(previousResponseId)
        : null;
    if (previousEntry && typeof expandResponsesRequestBodyFromChain === "function") {
      const expandedBody = expandResponsesRequestBodyFromChain(parsedBody, previousEntry);
      const expandedRawBody = Buffer.from(JSON.stringify(expandedBody || {}), "utf8");
      return {
        preparedRequest: prepareCodexResponsesCreateRequest(expandedRawBody, expandedBody),
        previousResponseContinuation: true,
        compatibilityHint: ""
      };
    }

    throw createRouteError(
      409,
      "previous_response_id_chain_missing",
      "previous_response_id cannot be resolved by this proxy. Retry with the full conversation input."
    );
  }

  function rememberCodexResponsesChainEntry(requestBody, completedResponse) {
    if (!codexResponsesChain || typeof codexResponsesChain.remember !== "function") return;
    if (typeof buildResponsesChainEntry !== "function") return;
    const entry = buildResponsesChainEntry(requestBody, completedResponse);
    if (!entry) return;
    codexResponsesChain.remember(entry);
  }

  function extractCompactSourceResponseId(requestBody, completedResponse) {
    const directResponseId = extractStringField(requestBody, "response_id");
    if (directResponseId) return directResponseId;
    const previousResponseId = extractStringField(requestBody, "previous_response_id");
    if (previousResponseId) return previousResponseId;
    return extractStringField(completedResponse, "previous_response_id");
  }

  function buildCompactChainRequestBody(requestBody, completedResponse) {
    const sourceResponseId = extractCompactSourceResponseId(requestBody, completedResponse);
    const sourceEntry =
      sourceResponseId && codexResponsesChain && typeof codexResponsesChain.lookup === "function"
        ? codexResponsesChain.lookup(sourceResponseId)
        : null;

    if (sourceEntry && typeof expandResponsesRequestBodyFromChain === "function") {
      const compactBody =
        requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
          ? { ...requestBody, previous_response_id: sourceResponseId }
          : { previous_response_id: sourceResponseId };
      return expandResponsesRequestBodyFromChain(compactBody, sourceEntry);
    }

    if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
      if (requestBody.input !== undefined || Array.isArray(requestBody.messages)) return requestBody;
    }

    return null;
  }

  function rememberCodexResponsesCompactChainEntry(requestBody, completedResponse) {
    const compactChainRequestBody = buildCompactChainRequestBody(requestBody, completedResponse);
    if (!compactChainRequestBody) return;
    rememberCodexResponsesChainEntry(compactChainRequestBody, completedResponse);
  }

  async function applyResponsesCollaborationModeBridge(preparedRequest) {
    if (typeof bridgeCodexResponsesCollaborationMode !== "function") {
      return preparedRequest;
    }

    const parsedBody =
      preparedRequest?.parsedBody !== undefined
        ? preparedRequest.parsedBody
        : parseJsonLoose(preparedRequest?.rawBody?.toString("utf8") || "");
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return preparedRequest;
    }

    const bridgedBody = await bridgeCodexResponsesCollaborationMode(parsedBody);
    if (!bridgedBody || typeof bridgedBody !== "object" || Array.isArray(bridgedBody)) {
      return preparedRequest;
    }

    return {
      ...preparedRequest,
      rawBody: Buffer.from(JSON.stringify(bridgedBody), "utf8"),
      parsedBody: bridgedBody
    };
  }

  function sendCompletedResponseAsSse(res, completed) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
    res.end();
  }

  function sendRawSseResponse(res, rawSse) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.write(rawSse);
    res.end();
  }

  function looksLikeSsePayload(rawText) {
    return typeof rawText === "string" && /(^|\n)\s*(event:|data:)/.test(rawText);
  }

  function buildForwardHeaders(requestHeaders = {}) {
    const headers = new Headers();
    for (const [key, rawValue] of Object.entries(requestHeaders || {})) {
      const normalizedKey = String(key || "").trim().toLowerCase();
      if (!normalizedKey) continue;
      if (hopByHop.has(normalizedKey)) continue;
      if (normalizedKey === "accept-encoding") continue;
      if (normalizedKey === "host") continue;
      if (normalizedKey === "cookie") continue;
      if (normalizedKey === "origin") continue;
      if (normalizedKey === "referer") continue;
      if (normalizedKey === "forwarded") continue;
      if (normalizedKey === "x-real-ip") continue;
      if (normalizedKey === "true-client-ip") continue;
      if (normalizedKey === "x-api-key") continue;
      if (normalizedKey === "x-goog-api-key") continue;
      if (normalizedKey.startsWith("cf-")) continue;
      if (normalizedKey.startsWith("x-forwarded-")) continue;
      if (normalizedKey.startsWith("sec-websocket-")) continue;
      const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      if (typeof value !== "string") continue;
      headers.set(key, value);
    }
    return headers;
  }

  function applyCodexAuthHeaders(headers, authContext) {
    headers.set("authorization", `Bearer ${authContext.accessToken}`);
    if (config.upstreamMode !== "codex-chatgpt") return true;
    if (!authContext.accountId) return false;
    headers.set("chatgpt-account-id", authContext.accountId);
    if (!headers.has("openai-beta")) headers.set("openai-beta", "responses=experimental");
    if (!headers.has("originator")) headers.set("originator", getCodexOriginator());
    if (!headers.has("user-agent")) headers.set("user-agent", "codex-pro-max");
    headers.set("accept", "text/event-stream");
    headers.set("accept-encoding", "identity");
    return true;
  }

  async function openResponsesCreateProxySession(req, res, options = {}) {
    if (config.upstreamMode !== "codex-chatgpt") {
      throw createRouteError(
        400,
        "unsupported_endpoint",
        "Responses WebSocket mode is currently only supported when UPSTREAM_MODE=codex-chatgpt."
      );
    }

    const originalUrl = String(options.originalUrl || req?.originalUrl || req?.url || "/v1/responses");
    const incoming = new URL(originalUrl, "http://localhost");
    const requestBody = Buffer.isBuffer(options.requestBody)
      ? options.requestBody
      : Buffer.from(options.requestBody || "", "utf8");
    const parsedRequestBody =
      options.parsedRequestBody === undefined ? getCachedJsonBody(req) : options.parsedRequestBody;
    const requestAcceptsEventStream = String(req?.headers?.accept || "")
      .toLowerCase()
      .includes("text/event-stream");
    const requestHasExplicitStreamFlag = Boolean(
      parsedRequestBody &&
        typeof parsedRequestBody === "object" &&
        !Array.isArray(parsedRequestBody) &&
        Object.prototype.hasOwnProperty.call(parsedRequestBody, "stream")
    );

    let target;
    try {
      target = buildUpstreamTarget(originalUrl);
    } catch (err) {
      throw createRouteError(400, "unsupported_endpoint", err.message);
    }
    if (target.endpointKind !== "responses" || req?.method !== "POST" || !isResponsesCreatePath(incoming.pathname)) {
      throw createRouteError(400, "unsupported_endpoint", "WebSocket mode only supports POST /v1/responses.");
    }

    let preparedRequest = {
      rawBody: requestBody,
      parsedBody: parsedRequestBody
    };
    preparedRequest = await applyResponsesCollaborationModeBridge(preparedRequest);
    preparedRequest = prepareCodexResponsesCreateRequest(preparedRequest.rawBody, preparedRequest.parsedBody);
    const previousResponseId = preparedRequest.previousResponseId;
    const replayPreparation = resolveCodexResponsesPreviousResponseReplay(preparedRequest);
    preparedRequest = replayPreparation.preparedRequest;
    const preferredPoolEntryId = resolvePinnedCodexPoolEntryId(req, target, requestBody, incoming.pathname);

    let auth;
    let releaseAuthLease = () => {};
    try {
      try {
        auth = await getValidAuthContext({ preferredPoolEntryId, retainLease: true });
      } catch (err) {
        throw createRouteError(401, "unauthorized", err.message, {
          hint: getAuthModeHint()
        });
      }
      releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};

      const pinnedCodexRequest =
        preferredPoolEntryId.length > 0 &&
        (auth.poolEntryId === preferredPoolEntryId || auth.poolAccountId === preferredPoolEntryId);

      const headers = buildForwardHeaders(req?.headers);
      if (!applyCodexAuthHeaders(headers, auth)) {
        throw createRouteError(401, "missing_account_id", "Could not extract chatgpt_account_id from OAuth token.");
      }

      const normalized = normalizeCodexResponsesRequestBody(preparedRequest.rawBody, {
        parsedBody: preparedRequest.parsedBody,
        previousResponseContinuation: replayPreparation.previousResponseContinuation
      });
      let normalizedResponsesRequest = normalized.json || parseJsonLoose(normalized.body.toString("utf8"));
      let upstreamBody = normalized.body;
      const canRewriteNormalizedRequest =
        normalizedResponsesRequest && typeof normalizedResponsesRequest === "object" && !Array.isArray(normalizedResponsesRequest);
      const shouldStripPreviousResponseId =
        canRewriteNormalizedRequest && Object.prototype.hasOwnProperty.call(normalizedResponsesRequest, "previous_response_id");
      const shouldForceWebSocketStream = canRewriteNormalizedRequest && !res && normalizedResponsesRequest.stream !== true;
      if (shouldStripPreviousResponseId || shouldForceWebSocketStream) {
        normalizedResponsesRequest = { ...normalizedResponsesRequest };
        if (shouldStripPreviousResponseId) delete normalizedResponsesRequest.previous_response_id;
        if (shouldForceWebSocketStream) normalizedResponsesRequest.stream = true;
        upstreamBody = Buffer.from(JSON.stringify(normalizedResponsesRequest), "utf8");
      }
      const collectCompletedResponseAsJson = res
        ? requestAcceptsEventStream && !requestHasExplicitStreamFlag
          ? false
          : normalized.collectCompletedResponseAsJson
        : false;
      if (normalized.modelRoute && res?.locals) {
        res.locals.modelRoute = normalized.modelRoute;
      }

      headers.set("content-type", "application/json");
      if (replayPreparation.compatibilityHint) {
        noteCompatibilityHint(res, replayPreparation.compatibilityHint);
      }
      noteUpstreamRequestAudit(res, normalizedResponsesRequest || normalized.json || upstreamBody, "application/json");

      const init = {
        method: "POST",
        headers,
        body: upstreamBody,
        redirect: "manual"
      };
      const retryState = res && res.locals ? res : { locals: {} };
      const canRetryWithPool = isCodexPoolRetryEnabled() && !pinnedCodexRequest;
      const maxAttempts = canRetryWithPool ? 2 : 1;
      let upstream = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          upstream = await fetchUpstreamWithRetry(target.url, init, retryState);
        } catch (err) {
          const details = extractUpstreamTransportError(err);
          throw createRouteError(502, "upstream_unreachable", details.message || err.message, {
            code: details.code || details.name || null,
            detail: details.detail || null,
            retry_count: Number(retryState?.locals?.upstreamRetryCount || 0)
          });
        }

        const shouldRetry =
          canRetryWithPool &&
          attempt < maxAttempts &&
          shouldRotateCodexAccountForStatus(upstream.status) &&
          Boolean(auth?.poolAccountId);
        if (!shouldRetry) {
          break;
        }

        await maybeMarkCodexPoolFailure(
          auth,
          `Upstream HTTP ${upstream.status} on POST ${originalUrl}`,
          upstream.status
        ).catch(() => {});

        let nextAuth;
        let nextReleaseLease = () => {};
        try {
          nextAuth = await getValidAuthContext({ retainLease: true });
          nextReleaseLease = typeof nextAuth?.releaseLease === "function" ? nextAuth.releaseLease : () => {};
        } catch {
          break;
        }
        if (!applyCodexAuthHeaders(headers, nextAuth)) {
          nextReleaseLease();
          break;
        }
        releaseAuthLease();
        auth = nextAuth;
        releaseAuthLease = nextReleaseLease;
      }

      if (!upstream) {
        throw createRouteError(502, "upstream_unreachable", "No upstream response received.");
      }

      await maybeCaptureCodexUsageFromHeaders(auth, upstream.headers, "response").catch(() => {});

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseAuthLease();
      };

      return {
        authContext: auth,
        collectCompletedResponseAsJson,
        normalizedResponsesRequest,
        previousResponseId,
        modelRoute: normalized.modelRoute || null,
        authAccountId: auth.poolAccountId || auth.accountId || null,
        compatibilityHint: replayPreparation.compatibilityHint || "",
        upstreamRequestBody: normalizedResponsesRequest || normalized.json || upstreamBody,
        upstreamRequestContentType: "application/json",
        responseModel: normalized.model || config.codex.defaultModel,
        retryCount: Number(retryState?.locals?.upstreamRetryCount || 0),
        upstream,
        async markFailure(message, statusCode = 0) {
          await maybeMarkCodexPoolFailure(auth, message, statusCode).catch(() => {});
        },
        async markSuccess() {
          await maybeMarkCodexPoolSuccess(auth).catch(() => {});
        },
        rememberCompletion(completed) {
          rememberCodexResponseAffinity(completed, auth);
          rememberCodexResponsesChainEntry(normalizedResponsesRequest, completed);
        },
        forgetPinnedAffinity(statusCode, reason) {
          maybeForgetPinnedCodexResponseAffinity(previousResponseId, statusCode, reason);
        },
        release
      };
    } catch (err) {
      releaseAuthLease();
      throw err;
    }
  }

  async function handleV1ModelsListRoute(req, res) {
    if (isAnthropicNativeRequest(req)) {
      await handleAnthropicModelsList(req, res);
      return;
    }

    let modelIds = null;
    if (typeof getExecutableModelCandidateIds === "function") {
      try {
        const executableModelIds = await getExecutableModelCandidateIds();
        if (Array.isArray(executableModelIds)) {
          modelIds = executableModelIds;
        }
      } catch {}
    }
    if (!Array.isArray(modelIds) && typeof getOfficialModelCandidateIds === "function") {
      try {
        const officialModelIds = await getOfficialModelCandidateIds();
        if (Array.isArray(officialModelIds) && officialModelIds.length > 0) {
          modelIds = officialModelIds;
        }
      } catch {}
    }
    if (!Array.isArray(modelIds)) {
      modelIds = getOpenAICompatibleModelIds();
    }

    const now = Math.floor(Date.now() / 1000);
    const models = modelIds.map((id) => ({
      id,
      object: "model",
      created: now,
      owned_by: "codex-pro-max"
    }));
    res.json({
      object: "list",
      data: models
    });
  }

  function proxyRequestAuditMiddleware(req, res, next) {
    const pathName = String(req.path || req.originalUrl || req.url || "");
    if (!isProxyApiPath(pathName)) {
      next();
      return;
    }

    const startedAt = Date.now();
    const reqContentType = parseContentType(req.headers?.["content-type"]);

    const responseChunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    function captureResponseChunk(chunk, encoding) {
      if (chunk === undefined || chunk === null) return;
      const buffer = toChunkBuffer(chunk, encoding);
      if (!buffer || buffer.length === 0) return;
      responseChunks.push(buffer);
    }

    res.write = function patchedWrite(chunk, encoding, cb) {
      captureResponseChunk(chunk, encoding);
      return originalWrite(chunk, encoding, cb);
    };
    res.end = function patchedEnd(chunk, encoding, cb) {
      captureResponseChunk(chunk, encoding);
      return originalEnd(chunk, encoding, cb);
    };

    res.on("finish", () => {
      const rawPath = req.originalUrl || req.url || "";
      try {
        const requestBodyForAudit = getCachedJsonBody(req) ?? req.rawBody ?? Buffer.alloc(0);
        const responseContentType = parseContentType(res.getHeader("content-type"));
        const rawResponseBody = Buffer.concat(responseChunks);
        const safePath = sanitizeAuditPath(rawPath);
        const protocolType = inferProtocolType(safePath, res.locals?.protocolType, config.upstreamMode);
        const responsePacket = formatPayloadForAudit(rawResponseBody, responseContentType, 0);
        const providedTokenUsage = normalizeTokenUsage(res.locals?.tokenUsage);
        const packetTokenUsage =
          providedTokenUsage && providedTokenUsage.cachedInputTokens !== null
            ? null
            : extractTokenUsageFromAuditResponse({
                protocolType,
                responseContentType,
                responsePacket
              });
        const observedTokenUsage = mergeNormalizedTokenUsage(
          providedTokenUsage,
          packetTokenUsage
        );
        const estimatedChatInputTokens =
          req.method === "POST" &&
          res.statusCode >= 400 &&
          (safePath === "/v1/chat/completions" || safePath.startsWith("/v1/chat/completions/"))
            ? estimateOpenAIChatCompletionTokens(req.rawBody, getCachedJsonBody(req))
            : 0;
        const estimatedRequestUsage =
          estimatedChatInputTokens > 0
            ? {
                inputTokens: estimatedChatInputTokens,
                cachedInputTokens: 0,
                outputTokens: 0,
                totalTokens: estimatedChatInputTokens
              }
            : null;
        const tokenUsage = mergeNormalizedTokenUsage(estimatedRequestUsage, observedTokenUsage);
        recordRecentProxyRequestSafely({
          startedAt,
          method: req.method,
          rawPath,
          statusCode: res.statusCode,
          requestBody: requestBodyForAudit,
          requestContentType: reqContentType,
          upstreamRequestBody: res.locals?.upstreamRequestBody,
          upstreamRequestContentType: res.locals?.upstreamRequestContentType,
          responseBody: rawResponseBody,
          responseContentType,
          protocolType,
          tokenUsage,
          modelRoute: res.locals?.modelRoute || null,
          authAccountId: res.locals?.authAccountId || null,
          proxyApiKeyId: res.locals?.proxyApiKeyId || null,
          proxyApiKeyLabel: res.locals?.proxyApiKeyLabel || "",
          upstreamRetryCount: res.locals?.upstreamRetryCount,
          upstreamErrorCode: res.locals?.upstreamErrorCode,
          upstreamErrorDetail: res.locals?.upstreamErrorDetail,
          compatibilityHint: res.locals?.compatibilityHint,
          transportType: "http"
        });
      } catch (err) {
        recordAuditError(err, {
          method: req.method,
          rawPath,
          statusCode: res.statusCode,
          transportType: "http",
          phase: "response_finish"
        });
      }
    });

    next();
  }

  async function handleV1BetaProxyRoute(req, res) {
    await handleGeminiNativeProxy(req, res);
  }

  async function handleV1MessagesProxyRoute(req, res) {
    await handleAnthropicNativeProxy(req, res);
  }

  async function handleV1ProxyRoute(req, res) {
    res.locals.protocolType = "openai-v1";
    const normalizedAnthropicUrl = normalizeCherryAnthropicAgentOriginalUrl(req.originalUrl);
    if (normalizedAnthropicUrl) {
      const previousOriginalUrl = req.originalUrl;
      req.originalUrl = normalizedAnthropicUrl;
      try {
        await handleAnthropicNativeProxy(req, res);
      } finally {
        req.originalUrl = previousOriginalUrl;
      }
      return;
    }
    const incoming = new URL(req.originalUrl, "http://localhost");

    if (isGeminiNativeAliasPath(incoming.pathname)) {
      res.locals.protocolType = "gemini-v1beta-native";
      const aliasedOriginalUrl = req.originalUrl.replace(/^\/v1\/models\//, "/v1beta/models/");
      const previousOriginalUrl = req.originalUrl;
      req.originalUrl = aliasedOriginalUrl;
      try {
        await handleGeminiNativeProxy(req, res);
      } finally {
        req.originalUrl = previousOriginalUrl;
      }
      return;
    }

    if (incoming.pathname === "/v1/chat/completions" && req.method === "POST") {
      await readRawBody(req);
      if (getCachedJsonBody(req) === undefined) {
        try {
          await readJsonBody(req);
        } catch {
          // preserve downstream invalid-request behavior
        }
      }
    }

    const selectedProtocol =
      incoming.pathname === "/v1/chat/completions" && req.method === "POST"
        ? chooseProtocolForV1ChatCompletions(req)
        : config.upstreamMode;

    if (selectedProtocol === "gemini-v1beta") {
      await handleGeminiProtocol(req, res);
      return;
    }

    if (selectedProtocol === "anthropic-v1") {
      await handleAnthropicProtocol(req, res);
      return;
    }

    let target;
    try {
      target = buildUpstreamTarget(req.originalUrl);
    } catch (err) {
      res.status(400).json({
        error: "unsupported_endpoint",
        message: err.message
      });
      return;
    }

    const requestBody =
      req.method !== "GET" && req.method !== "HEAD" ? await readRawBody(req) : Buffer.alloc(0);
    let parsedRequestBody = getCachedJsonBody(req);
    if (parsedRequestBody === undefined && requestBody.length > 0) {
      try {
        parsedRequestBody = await readJsonBody(req);
      } catch {
        parsedRequestBody = undefined;
      }
    }
    const isResponsesCreateRequest =
      target?.endpointKind === "responses" &&
      req.method === "POST" &&
      isResponsesCreatePath(incoming.pathname);
    const isResponsesCompactRequest =
      target?.endpointKind === "responses" &&
      req.method === "POST" &&
      isResponsesCompactPath(incoming.pathname);
    const previousResponseId = isResponsesCreateRequest ? extractPreviousResponseId(requestBody) : "";
    const affinityLookupResponseId = extractResponsesAffinityLookupId(req, target, requestBody, incoming.pathname);

    let auth;
    let releaseAuthLease = () => {};
    let responsesCreateSession = null;
    try {
      let collectCompletedResponseAsJson = false;
      let streamChatCompletionsAsSse = false;
      let responseShape = "responses";
      let responseModel = config.codex.defaultModel;
      let normalizedResponsesRequest = null;
      let upstream;
      const markPoolFailure = async (message, statusCode = 0) => {
        if (!auth) return;
        if (responsesCreateSession) {
          await responsesCreateSession.markFailure(message, statusCode);
          return;
        }
        await maybeMarkCodexPoolFailure(auth, message, statusCode).catch(() => {});
      };
      const markPoolSuccess = async () => {
        if (!auth) return;
        if (responsesCreateSession) {
          await responsesCreateSession.markSuccess();
          return;
        }
        await maybeMarkCodexPoolSuccess(auth).catch(() => {});
      };
      const rememberCompletion = (completed) => {
        if (!completed) return;
        if (responsesCreateSession) {
          responsesCreateSession.rememberCompletion(completed);
          return;
        }
        rememberCodexResponseAffinity(completed, auth);
        if (isResponsesCompactRequest) {
          rememberCodexResponsesCompactChainEntry(parsedRequestBody, completed);
        }
      };
      const forgetPinnedAffinity = (statusCode, reason) => {
        if (responsesCreateSession) {
          responsesCreateSession.forgetPinnedAffinity(statusCode, reason);
          return;
        }
        maybeForgetPinnedCodexResponseAffinity(previousResponseId || affinityLookupResponseId, statusCode, reason);
      };

      if (isResponsesCreateRequest) {
        try {
          responsesCreateSession = await openResponsesCreateProxySession(req, res, {
            originalUrl: req.originalUrl,
            requestBody,
            parsedRequestBody
          });
        } catch (err) {
          const statusCode = Number(err?.statusCode || 500) || 500;
          if (statusCode === 401) {
            res.status(401).json({
              error: err.error || "unauthorized",
              message: err.message,
              ...(err?.hint ? { hint: err.hint } : {})
            });
            return;
          }
          res.status(statusCode).json({
            error: err.error || "upstream_request_failed",
            message: err.message,
            ...(err?.code ? { code: err.code } : {}),
            ...(err?.detail ? { detail: err.detail } : {}),
            ...(Number.isFinite(Number(err?.retry_count)) ? { retry_count: Number(err.retry_count) } : {})
          });
          return;
        }

        auth = responsesCreateSession.authContext;
        releaseAuthLease = responsesCreateSession.release;
        res.locals.authAccountId = auth?.poolAccountId || auth?.accountId || null;
        collectCompletedResponseAsJson = responsesCreateSession.collectCompletedResponseAsJson;
        normalizedResponsesRequest = responsesCreateSession.normalizedResponsesRequest;
        responseModel = responsesCreateSession.responseModel || responseModel;
        upstream = responsesCreateSession.upstream;
      }

      if (!isResponsesCreateRequest) {
        let body = requestBody;
        let upstreamAuditBody = parsedRequestBody ?? body;
        const headers = buildForwardHeaders(req.headers);
        const preferredPoolEntryId = resolvePinnedCodexPoolEntryId(req, target, requestBody, incoming.pathname);
        let pinnedCodexRequest = false;

        try {
          auth = await getValidAuthContext({ preferredPoolEntryId, retainLease: true });
          releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};
          res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
          pinnedCodexRequest =
            preferredPoolEntryId.length > 0 &&
            (auth.poolEntryId === preferredPoolEntryId || auth.poolAccountId === preferredPoolEntryId);
          if (preferredPoolEntryId.length > 0 && !pinnedCodexRequest) {
            res.status(409).json({
              error: "response_id_account_unavailable",
              message: "The response_id is pinned to a pooled account that is not currently selectable."
            });
            return;
          }
        } catch (err) {
          res.status(401).json({
            error: "unauthorized",
            message: err.message,
            hint: getAuthModeHint()
          });
          return;
        }

        if (!applyCodexAuthHeaders(headers, auth)) {
          res.status(401).json({
            error: "missing_account_id",
            message: "Could not extract chatgpt_account_id from OAuth token."
          });
          return;
        }

        if (req.method !== "GET" && req.method !== "HEAD") {
          try {
            if (config.upstreamMode === "codex-chatgpt" && target.endpointKind === "chat-completions") {
              const normalized = normalizeChatCompletionsRequestBody(body, {
                parsedBody: parsedRequestBody
              });
              body = normalized.body;
              streamChatCompletionsAsSse = normalized.wantsStream;
              collectCompletedResponseAsJson = !streamChatCompletionsAsSse;
              responseShape = "chat-completions";
              responseModel = normalized.model || responseModel;
              if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
              upstreamAuditBody = normalized.json || body;
              headers.set("content-type", "application/json");
            }
          } catch (err) {
            res.status(400).json({
              error: "invalid_request",
              message: err.message
            });
            return;
          }
        }

        const init = {
          method: req.method,
          headers,
          redirect: "manual"
        };
        if (body.length > 0) {
          init.body = body;
        }
        noteUpstreamRequestAudit(
          res,
          upstreamAuditBody,
          headers.get("content-type") || req.headers?.["content-type"] || ""
        );

        const canRetryWithPool = isCodexPoolRetryEnabled() && !pinnedCodexRequest;
        const maxAttempts = canRetryWithPool ? 2 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            upstream = await fetchUpstreamWithRetry(target.url, init, res);
          } catch (err) {
            const details = extractUpstreamTransportError(err);
            res.status(502).json({
              error: "upstream_unreachable",
              message: details.message || err.message,
              code: details.code || details.name || null,
              detail: details.detail || null,
              retry_count: Number(res.locals?.upstreamRetryCount || 0)
            });
            return;
          }

          const shouldRetry =
            canRetryWithPool &&
            attempt < maxAttempts &&
            shouldRotateCodexAccountForStatus(upstream.status) &&
            Boolean(auth?.poolAccountId);
          if (!shouldRetry) {
            break;
          }

          await maybeMarkCodexPoolFailure(
            auth,
            `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}`,
            upstream.status
          ).catch(() => {});

          let nextAuth;
          let nextReleaseLease = () => {};
          try {
            nextAuth = await getValidAuthContext({ retainLease: true });
            nextReleaseLease = typeof nextAuth?.releaseLease === "function" ? nextAuth.releaseLease : () => {};
          } catch {
            break;
          }
          if (!applyCodexAuthHeaders(headers, nextAuth)) {
            nextReleaseLease();
            break;
          }
          releaseAuthLease();
          auth = nextAuth;
          releaseAuthLease = nextReleaseLease;
          res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
        }

        await maybeCaptureCodexUsageFromHeaders(auth, upstream.headers, "response").catch(() => {});
      }

      if (!upstream) {
        res.status(502).json({
          error: "upstream_unreachable",
          message: "No upstream response received."
        });
        return;
      }

      if (collectCompletedResponseAsJson) {
        let raw;
        try {
          raw = await readUpstreamTextOrThrow(upstream);
        } catch (err) {
          const details = extractUpstreamTransportError(err);
          noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
          await markPoolFailure(`Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
          res.status(502).json({
            error: "upstream_body_read_failed",
            message: err.message,
            code: details.code || details.name || null,
            detail: details.detail || null,
            retry_count: Number(res.locals?.upstreamRetryCount || 0)
          });
          return;
        }
        if (!upstream.ok) {
          if (isPreviousResponseIdUnsupportedError(upstream.status, raw)) {
            noteCompatibilityHint(res, "previous_response_id_unsupported");
          }
          await markPoolFailure(
            `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
            upstream.status
          );
          forgetPinnedAffinity(upstream.status, raw);
          res.status(upstream.status);
          upstream.headers.forEach((value, key) => {
            if (!hopByHop.has(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          });
          res.send(raw);
          return;
        }

        const parsedResponse = parseResponsesResultFromSse(raw);
        if (parsedResponse.failed) {
          await markPoolFailure(
            `Upstream SSE response failed on ${req.method} ${req.originalUrl}: ${truncate(parsedResponse.failed.message, 200)}`,
            parsedResponse.failed.statusCode
          );
          res.status(parsedResponse.failed.statusCode || 502).json({
            error: "upstream_response_failed",
            message: parsedResponse.failed.message,
            retry_count: Number(res.locals?.upstreamRetryCount || 0)
          });
          return;
        }

        const completed = parsedResponse.completed || extractCompletedResponseFromJson(raw);
        if (!completed) {
          await markPoolFailure(`Invalid upstream SSE on ${req.method} ${req.originalUrl}`, 502);
          res.status(502).json({
            error: "invalid_upstream_sse",
            message: "Could not parse completed response from codex SSE stream."
          });
          return;
        }
        rememberCompletion(completed);
        await markPoolSuccess();
        if (responseShape === "chat-completions") {
          const converted = convertResponsesToChatCompletion(completed);
          converted.model = responseModel;
          res.locals.tokenUsage = converted.usage;
          res.status(200).json(converted);
        } else {
          completed.model = responseModel;
          res.locals.tokenUsage = completed.usage || null;
          res.status(200).json(completed);
        }
        return;
      }

      if (streamChatCompletionsAsSse) {
        if (!upstream.ok) {
          let raw;
          try {
            raw = await readUpstreamTextOrThrow(upstream);
          } catch (err) {
            const details = extractUpstreamTransportError(err);
            noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
            await markPoolFailure(`Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
            res.status(502).json({
              error: "upstream_body_read_failed",
              message: err.message,
              code: details.code || details.name || null,
              detail: details.detail || null,
              retry_count: Number(res.locals?.upstreamRetryCount || 0)
            });
            return;
          }
          if (isPreviousResponseIdUnsupportedError(upstream.status, raw)) {
            noteCompatibilityHint(res, "previous_response_id_unsupported");
          }
          await markPoolFailure(
            `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
            upstream.status
          );
          forgetPinnedAffinity(upstream.status, raw);
          res.status(upstream.status);
          upstream.headers.forEach((value, key) => {
            if (!hopByHop.has(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          });
          res.send(raw);
          return;
        }

        try {
          const streamResult = await pipeCodexSseAsChatCompletions(upstream, res, responseModel);
          if (streamResult?.usage) {
            res.locals.tokenUsage = streamResult.usage;
          }
          await markPoolSuccess();
        } catch (err) {
          noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
          await markPoolFailure(`Invalid upstream SSE on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
          if (!res.headersSent) {
            res.status(502).json({
              error: "invalid_upstream_sse",
              message: err.message,
              code: err?.code || err?.cause?.code || null,
              detail: extractUpstreamTransportError(err).detail || null,
              retry_count: Number(res.locals?.upstreamRetryCount || 0)
            });
          } else {
            res.end();
          }
        }
        return;
      }

      const upstreamContentType = parseContentType(upstream.headers.get("content-type") || "");

      if (isResponsesCompactRequest && upstream.ok && !upstreamContentType.includes("event-stream")) {
        let raw;
        try {
          raw = await readUpstreamTextOrThrow(upstream);
        } catch (err) {
          const details = extractUpstreamTransportError(err);
          noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
          await markPoolFailure(`Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
          res.status(502).json({
            error: "upstream_body_read_failed",
            message: err.message,
            code: details.code || details.name || null,
            detail: details.detail || null,
            retry_count: Number(res.locals?.upstreamRetryCount || 0)
          });
          return;
        }

        const completed = extractCompletedResponseFromJson(raw);
        if (completed?.id) {
          res.locals.tokenUsage = completed.usage || null;
          rememberCompletion(completed);
        }
        await markPoolSuccess();
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (!hopByHop.has(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        });
        res.send(raw);
        return;
      }

      if (
        isResponsesCreateRequest &&
        !collectCompletedResponseAsJson &&
        upstream.ok &&
        !upstreamContentType.includes("event-stream")
      ) {
        let raw;
        try {
          raw = await readUpstreamTextOrThrow(upstream);
        } catch (err) {
          const details = extractUpstreamTransportError(err);
          noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
          await markPoolFailure(`Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
          res.status(502).json({
            error: "upstream_body_read_failed",
            message: err.message,
            code: details.code || details.name || null,
            detail: details.detail || null,
            retry_count: Number(res.locals?.upstreamRetryCount || 0)
          });
          return;
        }

        if (looksLikeSsePayload(raw)) {
          const parsedResponse = parseResponsesResultFromSse(raw);
          if (parsedResponse.failed) {
            await markPoolFailure(
              `Upstream SSE response failed on ${req.method} ${req.originalUrl}: ${truncate(parsedResponse.failed.message, 200)}`,
              parsedResponse.failed.statusCode
            );
            sendRawSseResponse(res, raw);
            return;
          }

          if (!parsedResponse.completed) {
            await markPoolFailure(`Invalid upstream SSE on ${req.method} ${req.originalUrl}`, 502);
            res.status(502).json({
              error: "invalid_upstream_sse",
              message: "Upstream SSE ended before a terminal response event."
            });
            return;
          }

          parsedResponse.completed.model = responseModel;
          res.locals.tokenUsage = parsedResponse.completed.usage || null;
          rememberCompletion(parsedResponse.completed);
          await markPoolSuccess();
          sendRawSseResponse(res, raw);
          return;
        }

        const completed = extractCompletedResponseFromJson(raw);
        if (!completed) {
          await markPoolFailure(`Invalid upstream SSE on ${req.method} ${req.originalUrl}`, 502);
          res.status(502).json({
            error: "invalid_upstream_sse",
            message: "Stream request returned a non-SSE body without a completed response payload."
          });
          return;
        }

        completed.model = responseModel;
        res.locals.tokenUsage = completed.usage || null;
        rememberCompletion(completed);
        await markPoolSuccess();
        sendCompletedResponseAsSse(res, completed);
        return;
      }

      res.status(upstream.status);
      if (!upstream.ok) {
        await markPoolFailure(`Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}`, upstream.status);
      }
      upstream.headers.forEach((value, key) => {
        if (!hopByHop.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      if (upstream.ok && upstreamContentType.includes("event-stream")) {
        try {
          const streamResult = await pipeSseAndCaptureTokenUsage(upstream, res);
          if (streamResult?.usage) {
            res.locals.tokenUsage = streamResult.usage;
          }
          if (streamResult?.failed) {
            await markPoolFailure(
              `Upstream SSE response failed on ${req.method} ${req.originalUrl}: ${truncate(streamResult.failed.message, 200)}`,
              streamResult.failed.statusCode
            );
            return;
          }
          if (target.endpointKind === "responses" && streamResult?.completed) {
            rememberCompletion(streamResult.completed);
          }
          await markPoolSuccess();
        } catch (err) {
          noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
          await markPoolFailure(`Invalid upstream SSE on ${req.method} ${req.originalUrl}: ${err.message}`, 502);
          if (!res.headersSent) {
            res.status(502).json({
              error: "invalid_upstream_sse",
              message: err.message,
              code: err?.code || err?.cause?.code || null,
              detail: extractUpstreamTransportError(err).detail || null,
              retry_count: Number(res.locals?.upstreamRetryCount || 0)
            });
          } else {
            res.end();
          }
        }
        return;
      }

      await pipeUpstreamBodyToResponse(upstream, res);
      if (upstream.ok) {
        await markPoolSuccess();
      }
    } finally {
      releaseAuthLease();
    }
  }

  return {
    modelsList: handleV1ModelsListRoute,
    auditMiddleware: proxyRequestAuditMiddleware,
    geminiNativeProxy: handleV1BetaProxyRoute,
    anthropicNativeProxy: handleV1MessagesProxyRoute,
    recordRecentProxyRequest,
    recordAuditError,
    openResponsesCreateProxySession,
    openAIProxy: handleV1ProxyRoute
  };
}
