export function createCodexOAuthResponsesHelpers(context) {
  const {
    config,
    truncate,
    getValidAuthContext,
    getCodexOriginator,
    fetchWithUpstreamRetry,
    readUpstreamTextOrThrow,
    parseResponsesResultFromSse,
    extractCompletedResponseFromJson,
    normalizeTokenUsage,
    extractAssistantDisplayTextFromResponse,
    extractAssistantTextFromResponse,
    mapResponsesStatusToChatFinishReason,
    resolveReasoningEffort,
    resolveCodexCompatibleRoute,
    isUnsupportedMaxOutputTokensError,
    isCodexPoolRetryEnabled,
    shouldRotateCodexAccountForStatus,
    maybeMarkCodexPoolFailure,
    maybeMarkCodexPoolSuccess,
    maybeCaptureCodexUsageFromHeaders,
    toResponsesInputFromChatMessages,
    applyAdditionalResponsesCreateFields
  } = context;
  const getAssistantDisplayTextFromResponse =
    typeof extractAssistantDisplayTextFromResponse === "function"
      ? extractAssistantDisplayTextFromResponse
      : extractAssistantTextFromResponse;

  function createMissingAccountIdError() {
    const err = new Error("Could not extract chatgpt_account_id from OAuth token.");
    err.statusCode = 401;
    return err;
  }

  function getCodexResponsesUrl() {
    return `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;
  }

  function getCodexStreamRequestTimeoutMs() {
    return Math.max(0, Number(config?.upstreamStreamIdleTimeoutMs || 0));
  }

  function buildCodexRequestError(response, raw) {
    const err = new Error(
      `Upstream request failed: HTTP ${response.status}: ${truncate(raw, 400)}`
    );
    err.statusCode = response.status;
    return err;
  }

  function extractCompletedResponseFromBufferedPayload(raw, contentType = "") {
    const normalizedContentType = String(contentType || "").toLowerCase();
    if (normalizedContentType.includes("text/event-stream") || /(^|\n)\s*(event:|data:)/.test(String(raw || ""))) {
      const parsedSse = parseResponsesResultFromSse(raw);
      if (parsedSse.failed) {
        const upstreamErr = new Error(parsedSse.failed.message);
        upstreamErr.statusCode = Number(parsedSse.failed.statusCode || 502) || 502;
        throw upstreamErr;
      }
      return parsedSse.completed || null;
    }

    return extractCompletedResponseFromJson(raw) || null;
  }

  async function sendCodexResponsesRequest(currentAuth, url, body, acceptHeader) {
    const normalizedAcceptHeader = String(acceptHeader || "").trim();
    const requestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${currentAuth.accessToken}`,
        "chatgpt-account-id": currentAuth.accountId,
        "openai-beta": "responses=experimental",
        originator: getCodexOriginator(),
        accept: normalizedAcceptHeader,
        "content-type": "application/json",
        ...(normalizedAcceptHeader.toLowerCase().includes("text/event-stream")
          ? { "accept-encoding": "identity" }
          : {}),
        "user-agent": "codex-pro-max-local-compat"
      },
      body: JSON.stringify(body)
    };
    return await fetchWithUpstreamRetry(url, requestInit, {
      requestTimeoutMs: getCodexStreamRequestTimeoutMs()
    });
  }

  function buildCodexResponsesRequestBody({
    model,
    requestedModel,
    upstreamModel,
    instructions,
    input,
    stop,
    tools,
    toolChoice,
    include,
    max_tokens,
    temperature,
    top_p,
    reasoningSummary,
    reasoningEffort,
    reasoningContext = null,
    additionalCreateFields = null
  }) {
    const route =
      typeof upstreamModel === "string" && upstreamModel.trim().length > 0
        ? {
            requestedModel:
              typeof requestedModel === "string" && requestedModel.trim().length > 0
                ? requestedModel.trim()
                : model || config.codex.defaultModel,
            mappedModel: upstreamModel.trim()
          }
        : resolveCodexCompatibleRoute(model || config.codex.defaultModel);
    const resolvedRequestedModel = route.requestedModel;
    const resolvedUpstreamModel = route.mappedModel;
    const resolvedInstructions =
      typeof instructions === "string" && instructions.trim().length > 0
        ? instructions
        : config.codex.defaultInstructions;
    const resolvedInput =
      Array.isArray(input) && input.length > 0
        ? input
        : [{ role: "user", content: [{ type: "input_text", text: "" }] }];
    const reasoning = {
      effort: resolveReasoningEffort(
        reasoningEffort,
        reasoningContext || {
          input: resolvedInput,
          tools,
          tool_choice: toolChoice,
          instructions: resolvedInstructions
        },
        resolvedUpstreamModel
      )
    };
    if (typeof reasoningSummary === "string" && reasoningSummary.trim().length > 0) {
      reasoning.summary = reasoningSummary.trim();
    }

    const body = {
      model: resolvedUpstreamModel,
      stream: false,
      store: false,
      instructions: resolvedInstructions,
      reasoning,
      input: resolvedInput
    };

    if (Array.isArray(stop) && stop.length > 0) body.stop = stop;
    else if (typeof stop === "string" && stop.length > 0) body.stop = [stop];
    if (Array.isArray(tools)) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (Array.isArray(include) && include.length > 0) body.include = include;
    if (max_tokens !== undefined) body.max_output_tokens = max_tokens;
    applyAdditionalResponsesCreateFields?.(body, additionalCreateFields);

    return {
      route: {
        requestedModel: resolvedRequestedModel,
        mappedModel: resolvedUpstreamModel
      },
      body
    };
  }

  async function executeCodexResponsesViaOAuth({
    model,
    requestedModel,
    upstreamModel,
    instructions,
    input,
    stop,
    tools,
    toolChoice,
    include,
    max_tokens,
    temperature,
    top_p,
    reasoningSummary,
    reasoningEffort,
    reasoningContext = null,
    additionalCreateFields = null
  }) {
    let auth = await getValidAuthContext({ retainLease: true });
    let releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};
    try {
      if (!auth.accountId) {
        throw createMissingAccountIdError();
      }

      const { route, body: baseBody } = buildCodexResponsesRequestBody({
        model,
        requestedModel,
        upstreamModel,
        instructions,
        input,
        stop,
        tools,
        toolChoice,
        include,
        max_tokens,
        temperature,
        top_p,
        reasoningSummary,
        reasoningEffort,
        reasoningContext,
        additionalCreateFields
      });
      const resolvedRequestedModel = route.requestedModel;
      const url = getCodexResponsesUrl();

      const executeOnce = async (currentAuth) => {
        if (!currentAuth.accountId) {
          throw createMissingAccountIdError();
        }

        const sendCodexRequest = async (body, acceptHeader) => {
          const { response } = await sendCodexResponsesRequest(currentAuth, url, body, acceptHeader);
          const raw = await readUpstreamTextOrThrow(response);
          return { response, raw };
        };

        const parseRequestResult = (result, expectSse = false) => {
          if (!expectSse) {
            return extractCompletedResponseFromJson(result.raw);
          }
          return extractCompletedResponseFromBufferedPayload(
            result.raw,
            result.response?.headers?.get?.("content-type") || ""
          );
        };

        let activeBody = { ...baseBody, stream: true };
        let requestResult = await sendCodexRequest(activeBody, "text/event-stream");

        if (
          !requestResult.response.ok &&
          isUnsupportedMaxOutputTokensError(requestResult.response.status, requestResult.raw)
        ) {
          const fallbackBody = { ...activeBody };
          delete fallbackBody.max_output_tokens;
          activeBody = fallbackBody;
          requestResult = await sendCodexRequest(activeBody, "text/event-stream");
        }

        if (!requestResult.response.ok) {
          throw buildCodexRequestError(requestResult.response, requestResult.raw);
        }

        await maybeCaptureCodexUsageFromHeaders(currentAuth, requestResult.response.headers, "response").catch(
          () => {}
        );

        const contentType = requestResult.response.headers.get("content-type") || "";
        const looksLikeSse =
          contentType.includes("text/event-stream") || /(^|\n)\s*(event:|data:)/.test(requestResult.raw);
        let completed = parseRequestResult(requestResult, looksLikeSse);

        if (!completed && activeBody.stream === true && !looksLikeSse) {
          activeBody = { ...baseBody, stream: false };
          requestResult = await sendCodexRequest(activeBody, "application/json");
          if (!requestResult.response.ok) {
            throw buildCodexRequestError(requestResult.response, requestResult.raw);
          }
          completed = parseRequestResult(requestResult, false);
        }

        if (!completed) {
          const parseErr = new Error("Could not parse completed response from upstream.");
          parseErr.statusCode = 502;
          throw parseErr;
        }

        return completed;
      };

      const canRetryWithPool = isCodexPoolRetryEnabled();
      const maxAttempts = canRetryWithPool ? 2 : 1;
      let completed = null;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          completed = await executeOnce(auth);
          await maybeMarkCodexPoolSuccess(auth).catch(() => {});
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const statusCode = Number(err?.statusCode || 0);
          const canRotateNow =
            canRetryWithPool &&
            attempt < maxAttempts &&
            Boolean(auth?.poolAccountId) &&
            shouldRotateCodexAccountForStatus(statusCode);

          if (!canRotateNow) {
            if (canRetryWithPool && shouldRotateCodexAccountForStatus(statusCode)) {
              await maybeMarkCodexPoolFailure(auth, err.message, statusCode).catch(() => {});
            }
            break;
          }

          await maybeMarkCodexPoolFailure(auth, err.message, statusCode).catch(() => {});
          let nextAuth;
          try {
            nextAuth = await getValidAuthContext({ retainLease: true });
          } catch (leaseErr) {
            lastError = leaseErr;
            break;
          }
          if (!nextAuth.accountId) {
            nextAuth.releaseLease?.();
            lastError = createMissingAccountIdError();
            break;
          }
          releaseAuthLease();
          auth = nextAuth;
          releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};
        }
      }

      if (!completed) {
        throw lastError || new Error("Upstream request failed.");
      }

      return {
        model: resolvedRequestedModel,
        completed,
        authAccountId: auth.poolAccountId || auth.accountId || null
      };
    } finally {
      releaseAuthLease();
    }
  }

  async function openCodexResponsesStreamViaOAuth({
    model,
    requestedModel,
    upstreamModel,
    instructions,
    input,
    stop,
    tools,
    toolChoice,
    include,
    max_tokens,
    temperature,
    top_p,
    reasoningSummary,
    reasoningEffort,
    reasoningContext = null,
    additionalCreateFields = null
  }) {
    let auth = await getValidAuthContext({ retainLease: true });
    let releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};
    let shouldReleaseLease = true;

    const release = () => {
      if (!shouldReleaseLease) return;
      shouldReleaseLease = false;
      releaseAuthLease();
    };

    try {
      if (!auth.accountId) {
        throw createMissingAccountIdError();
      }

      const { route, body: baseBody } = buildCodexResponsesRequestBody({
        model,
        requestedModel,
        upstreamModel,
        instructions,
        input,
        stop,
        tools,
        toolChoice,
        include,
        max_tokens,
        temperature,
        top_p,
        reasoningSummary,
        reasoningEffort,
        reasoningContext,
        additionalCreateFields
      });
      const resolvedRequestedModel = route.requestedModel;
      const url = getCodexResponsesUrl();

      const openOnce = async (currentAuth) => {
        if (!currentAuth.accountId) {
          throw createMissingAccountIdError();
        }

        let activeBody = { ...baseBody, stream: true };
        let requestResult = await sendCodexResponsesRequest(currentAuth, url, activeBody, "text/event-stream");
        let response = requestResult.response;

        if (!response.ok) {
          let raw = await readUpstreamTextOrThrow(response);
          if (isUnsupportedMaxOutputTokensError(response.status, raw)) {
            const fallbackBody = { ...activeBody };
            delete fallbackBody.max_output_tokens;
            activeBody = fallbackBody;
            requestResult = await sendCodexResponsesRequest(currentAuth, url, activeBody, "text/event-stream");
            response = requestResult.response;
            if (!response.ok) {
              raw = await readUpstreamTextOrThrow(response);
              throw buildCodexRequestError(response, raw);
            }
          } else {
            throw buildCodexRequestError(response, raw);
          }
        }

        await maybeCaptureCodexUsageFromHeaders(currentAuth, response.headers, "response").catch(() => {});

        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("text/event-stream")) {
          return {
            upstream: response,
            bufferedCompletion: null
          };
        }

        const raw = await readUpstreamTextOrThrow(response);
        const bufferedCompletion = extractCompletedResponseFromBufferedPayload(raw, contentType);
        if (bufferedCompletion) {
          return {
            upstream: null,
            bufferedCompletion
          };
        }

        const unsupportedStreamErr = new Error(
          `Upstream stream request returned non-SSE content-type: ${contentType || "unknown"}`
        );
        unsupportedStreamErr.statusCode = 502;
        unsupportedStreamErr.upstreamBody = raw;
        throw unsupportedStreamErr;
      };

      const canRetryWithPool = isCodexPoolRetryEnabled();
      const maxAttempts = canRetryWithPool ? 2 : 1;
      let opened = null;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          opened = await openOnce(auth);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          const statusCode = Number(err?.statusCode || 0);
          const canRotateNow =
            canRetryWithPool &&
            attempt < maxAttempts &&
            Boolean(auth?.poolAccountId) &&
            shouldRotateCodexAccountForStatus(statusCode);

          if (!canRotateNow) {
            break;
          }

          await maybeMarkCodexPoolFailure(auth, err.message, statusCode).catch(() => {});
          let nextAuth;
          try {
            nextAuth = await getValidAuthContext({ retainLease: true });
          } catch (leaseErr) {
            lastError = leaseErr;
            break;
          }
          if (!nextAuth.accountId) {
            nextAuth.releaseLease?.();
            lastError = createMissingAccountIdError();
            break;
          }
          releaseAuthLease();
          auth = nextAuth;
          releaseAuthLease = typeof auth?.releaseLease === "function" ? auth.releaseLease : () => {};
        }
      }

      if (!opened) {
        throw lastError || new Error("Upstream request failed.");
      }

      return {
        model: resolvedRequestedModel,
        upstream: opened.upstream,
        bufferedCompletion: opened.bufferedCompletion,
        authAccountId: auth.poolAccountId || auth.accountId || null,
        authContext: auth,
        async markSuccess() {
          await maybeMarkCodexPoolSuccess(auth).catch(() => {});
        },
        async markFailure(message, statusCode = 0) {
          await maybeMarkCodexPoolFailure(auth, message, statusCode).catch(() => {});
        },
        release
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  async function runCodexConversationViaOAuth({
    model,
    requestedModel,
    upstreamModel,
    systemText,
    conversation,
    max_tokens,
    temperature,
    top_p,
    stop
  }) {
    const messages = [];
    if (typeof systemText === "string" && systemText.trim().length > 0) {
      messages.push({ role: "system", content: systemText });
    }
    for (const msg of Array.isArray(conversation) ? conversation : []) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const text = typeof msg.text === "string" && msg.text.length > 0 ? msg.text : " ";
      messages.push({ role, content: text });
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: " " });
    }

    const instructions =
      typeof systemText === "string" && systemText.trim().length > 0
        ? systemText
        : config.codex.defaultInstructions;
    const input = toResponsesInputFromChatMessages(messages);
    const result = await executeCodexResponsesViaOAuth({
      model,
      requestedModel,
      upstreamModel,
      instructions,
      input,
      max_tokens,
      temperature,
      top_p,
      stop,
      reasoningContext: {
        messages,
        input,
        instructions
      }
    });

    const usageNormalized = normalizeTokenUsage(result.completed?.usage);
    const usage = {
      prompt_tokens: Number(usageNormalized?.inputTokens || result.completed?.usage?.input_tokens || 0),
      completion_tokens: Number(usageNormalized?.outputTokens || result.completed?.usage?.output_tokens || 0),
      total_tokens: Number(
        usageNormalized?.totalTokens ||
          result.completed?.usage?.total_tokens ||
          Number(usageNormalized?.inputTokens || 0) + Number(usageNormalized?.outputTokens || 0)
      )
    };
    return {
      model: result.model,
      text: getAssistantDisplayTextFromResponse(result.completed),
      finishReason: mapResponsesStatusToChatFinishReason(result.completed?.status),
      usage,
      authAccountId: result.authAccountId
    };
  }

  async function openCodexConversationStreamViaOAuth({
    model,
    requestedModel,
    upstreamModel,
    systemText,
    conversation,
    max_tokens,
    temperature,
    top_p,
    stop
  }) {
    const messages = [];
    if (typeof systemText === "string" && systemText.trim().length > 0) {
      messages.push({ role: "system", content: systemText });
    }
    for (const msg of Array.isArray(conversation) ? conversation : []) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const text = typeof msg.text === "string" && msg.text.length > 0 ? msg.text : " ";
      messages.push({ role, content: text });
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: " " });
    }

    const instructions =
      typeof systemText === "string" && systemText.trim().length > 0
        ? systemText
        : config.codex.defaultInstructions;
    const input = toResponsesInputFromChatMessages(messages);
    return await openCodexResponsesStreamViaOAuth({
      model,
      requestedModel,
      upstreamModel,
      instructions,
      input,
      max_tokens,
      temperature,
      top_p,
      stop,
      reasoningContext: {
        messages,
        input,
        instructions
      }
    });
  }

  return {
    buildCodexResponsesRequestBody,
    executeCodexResponsesViaOAuth,
    openCodexResponsesStreamViaOAuth,
    openCodexConversationStreamViaOAuth,
    runCodexConversationViaOAuth
  };
}
