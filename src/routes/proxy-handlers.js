export function createProxyRouteHandlers(context) {
  const {
    config,
    runtimeStats,
    recentRequestsStore,
    hopByHop,
    runtimeAuditMaxBodyBytes,
    runtimeAuditMaxTextChars,
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
    isCodexMultiAccountEnabled,
    isCodexPoolRetryEnabled,
    shouldRotateCodexAccountForStatus,
    maybeMarkCodexPoolFailure,
    maybeCaptureCodexUsageFromHeaders,
    maybeMarkCodexPoolSuccess,
    truncate,
    extractCompletedResponseFromSse,
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

  function resolvePinnedCodexPoolEntryId(req, target) {
    if (config.authMode !== "codex-oauth" || !isCodexMultiAccountEnabled() || !isCodexPoolRetryEnabled()) return "";
    if (!target || target.endpointKind !== "responses") return "";
    if (req.method === "GET" || req.method === "HEAD") return "";
    const previousResponseId = extractPreviousResponseId(req.rawBody);
    if (!previousResponseId) return "";
    const affinity = codexResponseAffinity.lookup(previousResponseId);
    return typeof affinity?.poolEntryId === "string" ? affinity.poolEntryId : "";
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

  function rememberCodexResponseChain(response, requestBody) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
    const entry = buildResponsesChainEntry(requestBody, response);
    if (!entry) return;
    codexResponsesChain.remember(entry);
  }

  function maybeForgetPinnedCodexResponseAffinity(previousResponseId, statusCode, reason) {
    if (config.authMode !== "codex-oauth" || !isCodexMultiAccountEnabled()) return;
    if (!previousResponseId) return;
    if (!isCodexTokenInvalidatedError(statusCode, reason)) return;
    codexResponseAffinity.forget(previousResponseId);
  }

  async function handleV1ModelsListRoute(req, res) {
    if (isAnthropicNativeRequest(req)) {
      await handleAnthropicModelsList(req, res);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const models = getOpenAICompatibleModelIds().map((id) => ({
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
    const requestPacket = formatPayloadForAudit(req.rawBody, reqContentType, runtimeAuditMaxTextChars);

    const responseChunks = [];
    let responseBytes = 0;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    function captureResponseChunk(chunk, encoding) {
      if (chunk === undefined || chunk === null) return;
      if (responseBytes >= runtimeAuditMaxBodyBytes) return;
      const buffer = toChunkBuffer(chunk, encoding);
      if (!buffer || buffer.length === 0) return;
      const remaining = runtimeAuditMaxBodyBytes - responseBytes;
      if (remaining <= 0) return;
      const clipped = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      responseChunks.push(clipped);
      responseBytes += clipped.length;
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
      const responseContentType = parseContentType(res.getHeader("content-type"));
      const responsePacket = formatPayloadForAudit(
        Buffer.concat(responseChunks),
        responseContentType,
        runtimeAuditMaxTextChars
      );
      const rawPath = req.originalUrl || req.url || "";
      const safePath = sanitizeAuditPath(rawPath);
      const protocolType = inferProtocolType(safePath, res.locals?.protocolType, config.upstreamMode);
      const observedTokenUsage =
        normalizeTokenUsage(res.locals?.tokenUsage) ||
        extractTokenUsageFromAuditResponse({
          protocolType,
          responseContentType,
          responsePacket
        });
      const estimatedChatInputTokens =
        req.method === "POST" &&
        res.statusCode >= 400 &&
        (safePath === "/v1/chat/completions" || safePath.startsWith("/v1/chat/completions/"))
          ? estimateOpenAIChatCompletionTokens(req.rawBody)
          : 0;
      const estimatedRequestUsage =
        estimatedChatInputTokens > 0
          ? {
              inputTokens: estimatedChatInputTokens,
              outputTokens: 0,
              totalTokens: estimatedChatInputTokens
            }
          : null;
      const tokenUsage = mergeNormalizedTokenUsage(estimatedRequestUsage, observedTokenUsage);
      const modelRoute = res.locals?.modelRoute || null;
      const authAccountId = res.locals?.authAccountId || null;
      const authAccountLabel = resolveAuditAccountLabel(authAccountId);

      runtimeStats.totalRequests += 1;
      if (res.statusCode >= 200 && res.statusCode < 400) runtimeStats.okRequests += 1;
      else runtimeStats.errorRequests += 1;

      const requestRow = {
        id: `req_${Date.now().toString(36)}_${context.nextRuntimeRequestSeq().toString(36)}`,
        ts: Date.now(),
        method: req.method,
        path: safePath,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        inputTokens: tokenUsage?.inputTokens ?? null,
        outputTokens: tokenUsage?.outputTokens ?? null,
        totalTokens: tokenUsage?.totalTokens ?? null,
        requestedModel: modelRoute?.requestedModel ?? null,
        mappedModel: modelRoute?.mappedModel ?? null,
        routeType: modelRoute?.routeType ?? null,
        routeRule: modelRoute?.routeRule ?? null,
        protocolType,
        upstreamMode: config.upstreamMode,
        authAccountId,
        authAccountLabel: authAccountLabel || null,
        upstreamRetryCount: Number.isFinite(Number(res.locals?.upstreamRetryCount))
          ? Number(res.locals.upstreamRetryCount)
          : 0,
        upstreamErrorCode: String(res.locals?.upstreamErrorCode || "").trim() || null,
        upstreamErrorDetail: String(res.locals?.upstreamErrorDetail || "").trim() || null,
        compatibilityHint: String(res.locals?.compatibilityHint || "").trim() || null,
        requestContentType: reqContentType || null,
        upstreamRequestContentType: String(res.locals?.upstreamRequestContentType || "").trim() || null,
        responseContentType: responseContentType || null,
        requestPacket: requestPacket || "",
        upstreamRequestPacket: String(res.locals?.upstreamRequestPacket || ""),
        responsePacket: responsePacket || ""
      };

      runtimeStats.recentRequests = recentRequestsStore.append(requestRow).recentRequests;
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

    const previousResponseId = target?.endpointKind === "responses" ? extractPreviousResponseId(req.rawBody) : "";
    const preferredPoolEntryId = resolvePinnedCodexPoolEntryId(req, target);

    let auth;
    try {
      auth = await getValidAuthContext({ preferredPoolEntryId });
      res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
    } catch (err) {
      res.status(401).json({
        error: "unauthorized",
        message: err.message,
        hint: getAuthModeHint()
      });
      return;
    }
    const pinnedCodexRequest =
      preferredPoolEntryId.length > 0 &&
      (auth.poolEntryId === preferredPoolEntryId || auth.poolAccountId === preferredPoolEntryId);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hopByHop.has(k.toLowerCase()) && typeof v === "string") {
        headers.set(k, v);
      }
    }
    const applyAuthHeaders = (ctx) => {
      headers.set("authorization", `Bearer ${ctx.accessToken}`);
      if (config.upstreamMode !== "codex-chatgpt") return true;
      if (!ctx.accountId) return false;
      headers.set("chatgpt-account-id", ctx.accountId);
      if (!headers.has("openai-beta")) headers.set("openai-beta", "responses=experimental");
      if (!headers.has("originator")) headers.set("originator", getCodexOriginator());
      if (!headers.has("user-agent")) headers.set("user-agent", "codex-pro-max");
      if (!headers.has("accept")) headers.set("accept", "text/event-stream");
      return true;
    };
    if (!applyAuthHeaders(auth)) {
      res.status(401).json({
        error: "missing_account_id",
        message: "Could not extract chatgpt_account_id from OAuth token."
      });
      return;
    }

    const init = {
      method: req.method,
      headers,
      redirect: "manual"
    };

    let collectCompletedResponseAsJson = false;
    let streamChatCompletionsAsSse = false;
    let responseShape = "responses";
    let responseModel = config.codex.defaultModel;
    let normalizedResponsesRequest = null;
    let previousResponseChainEntry = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      let body = req.rawBody || Buffer.alloc(0);

      try {
        if (config.upstreamMode === "codex-chatgpt") {
          if (target.endpointKind === "responses") {
            const normalized = normalizeCodexResponsesRequestBody(body);
            body = normalized.body;
            collectCompletedResponseAsJson = normalized.collectCompletedResponseAsJson;
            responseShape = "responses";
            responseModel = normalized.model || responseModel;
            if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
            normalizedResponsesRequest = parseJsonLoose(body.toString("utf8"));
            if (previousResponseId && normalizedResponsesRequest && typeof normalizedResponsesRequest === "object") {
              previousResponseChainEntry = codexResponsesChain.lookup(previousResponseId);
              if (previousResponseChainEntry) {
                normalizedResponsesRequest = expandResponsesRequestBodyFromChain(
                  normalizedResponsesRequest,
                  previousResponseChainEntry
                );
                body = Buffer.from(JSON.stringify(normalizedResponsesRequest), "utf8");
                noteCompatibilityHint(res, "previous_response_id_emulated_locally");
              } else {
                noteCompatibilityHint(res, "previous_response_id_chain_missing");
                res.status(409).json({
                  detail: "previous_response_id local chain missing"
                });
                return;
              }
            }
            headers.set("content-type", "application/json");
          } else if (target.endpointKind === "chat-completions") {
            const normalized = normalizeChatCompletionsRequestBody(body);
            body = normalized.body;
            streamChatCompletionsAsSse = normalized.wantsStream;
            collectCompletedResponseAsJson = !streamChatCompletionsAsSse;
            responseShape = "chat-completions";
            responseModel = normalized.model || responseModel;
            if (normalized.modelRoute) res.locals.modelRoute = normalized.modelRoute;
            headers.set("content-type", "application/json");
          }
        }
      } catch (err) {
        res.status(400).json({
          error: "invalid_request",
          message: err.message
        });
        return;
      }

      init.body = body;
      noteUpstreamRequestAudit(
        res,
        body,
        headers.get("content-type") || req.headers?.["content-type"] || ""
      );
    }

    const canRetryWithPool = isCodexPoolRetryEnabled() && !pinnedCodexRequest;
    const maxAttempts = canRetryWithPool ? 2 : 1;
    let upstream;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
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
      try {
        nextAuth = await getValidAuthContext();
      } catch {
        break;
      }
      if (!applyAuthHeaders(nextAuth)) {
        break;
      }
      auth = nextAuth;
      res.locals.authAccountId = auth.poolAccountId || auth.accountId || null;
    }

    if (!upstream) {
      res.status(502).json({
        error: "upstream_unreachable",
        message: "No upstream response received."
      });
      return;
    }

    await maybeCaptureCodexUsageFromHeaders(auth, upstream.headers, "response").catch(() => {});

    if (upstream.ok) {
      await maybeMarkCodexPoolSuccess(auth).catch(() => {});
    }

    if (collectCompletedResponseAsJson) {
      let raw;
      try {
        raw = await readUpstreamTextOrThrow(upstream);
      } catch (err) {
        const details = extractUpstreamTransportError(err);
        noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
        await maybeMarkCodexPoolFailure(
          auth,
          `Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`,
          502
        ).catch(() => {});
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
        await maybeMarkCodexPoolFailure(
          auth,
          `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
          upstream.status
        ).catch(() => {});
        maybeForgetPinnedCodexResponseAffinity(previousResponseId, upstream.status, raw);
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (!hopByHop.has(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        });
        res.send(raw);
        return;
      }

      const completed = context.extractCompletedResponseFromSse(raw);
      if (!completed) {
        res.status(502).json({
          error: "invalid_upstream_sse",
          message: "Could not parse completed response from codex SSE stream."
        });
        return;
      }
      rememberCodexResponseAffinity(completed, auth);
      rememberCodexResponseChain(completed, normalizedResponsesRequest);
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
          await maybeMarkCodexPoolFailure(
            auth,
            `Upstream body read failed on ${req.method} ${req.originalUrl}: ${err.message}`,
            502
          ).catch(() => {});
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
        await maybeMarkCodexPoolFailure(
          auth,
          `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}: ${truncate(raw, 200)}`,
          upstream.status
        ).catch(() => {});
        maybeForgetPinnedCodexResponseAffinity(previousResponseId, upstream.status, raw);
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
      } catch (err) {
        noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
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

    res.status(upstream.status);
    if (!upstream.ok) {
      await maybeMarkCodexPoolFailure(
        auth,
        `Upstream HTTP ${upstream.status} on ${req.method} ${req.originalUrl}`,
        upstream.status
      ).catch(() => {});
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

    const upstreamContentType = parseContentType(upstream.headers.get("content-type") || "");
    if (upstream.ok && upstreamContentType.includes("event-stream")) {
      try {
        const streamResult = await pipeSseAndCaptureTokenUsage(upstream, res);
        if (streamResult?.usage) {
          res.locals.tokenUsage = streamResult.usage;
        }
      } catch (err) {
        noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
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
  }

  return {
    modelsList: handleV1ModelsListRoute,
    auditMiddleware: proxyRequestAuditMiddleware,
    geminiNativeProxy: handleV1BetaProxyRoute,
    anthropicNativeProxy: handleV1MessagesProxyRoute,
    openAIProxy: handleV1ProxyRoute
  };
}
