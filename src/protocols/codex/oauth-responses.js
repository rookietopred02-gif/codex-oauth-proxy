export function createCodexOAuthResponsesHelpers(context) {
  const {
    config,
    truncate,
    getValidAuthContext,
    getCodexOriginator,
    parseResponsesResultFromSse,
    extractCompletedResponseFromJson,
    normalizeTokenUsage,
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
    toResponsesInputFromChatMessages
  } = context;

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
    reasoningSummary,
    reasoningEffort,
    reasoningContext = null
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
    reasoningSummary,
    reasoningEffort,
    reasoningContext = null
  }) {
    let auth = await getValidAuthContext();
    if (!auth.accountId) {
      throw new Error("Could not extract chatgpt_account_id from OAuth token.");
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
      reasoningSummary,
      reasoningEffort,
      reasoningContext
    });
    const resolvedRequestedModel = route.requestedModel;
    const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;

    const executeOnce = async (currentAuth) => {
      if (!currentAuth.accountId) {
        const accountErr = new Error("Could not extract chatgpt_account_id from OAuth token.");
        accountErr.statusCode = 401;
        throw accountErr;
      }

      const sendCodexRequest = async (body, acceptHeader) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${currentAuth.accessToken}`,
            "chatgpt-account-id": currentAuth.accountId,
            "openai-beta": "responses=experimental",
            originator: getCodexOriginator(),
            accept: acceptHeader,
            "content-type": "application/json",
            "user-agent": "codex-pro-max-local-compat"
          },
          body: JSON.stringify(body)
        });
        const raw = await response.text();
        return { response, raw };
      };

      const parseRequestResult = (result, expectSse = false) => {
        if (expectSse) {
          const parsedSse = parseResponsesResultFromSse(result.raw);
          if (parsedSse.failed) {
            const upstreamErr = new Error(parsedSse.failed.message);
            upstreamErr.statusCode = Number(parsedSse.failed.statusCode || 502) || 502;
            throw upstreamErr;
          }
          return parsedSse.completed;
        }
        return extractCompletedResponseFromJson(result.raw);
      };

      let activeBody = { ...baseBody };
      let requestResult = await sendCodexRequest(activeBody, "application/json");
      if (!requestResult.response.ok && isUnsupportedMaxOutputTokensError(requestResult.response.status, requestResult.raw)) {
        const fallbackBody = { ...baseBody };
        delete fallbackBody.max_output_tokens;
        activeBody = fallbackBody;
        requestResult = await sendCodexRequest(activeBody, "application/json");
      }
      if (!requestResult.response.ok) {
        const maybeStreamOnly =
          requestResult.response.status === 400 &&
          /(stream|event-stream|sse)/i.test(requestResult.raw || "");
        if (maybeStreamOnly) {
          activeBody = { ...baseBody, stream: true };
          requestResult = await sendCodexRequest(activeBody, "text/event-stream");
        }
      }
      if (!requestResult.response.ok) {
        const requestErr = new Error(
          `Upstream request failed: HTTP ${requestResult.response.status}: ${truncate(requestResult.raw, 400)}`
        );
        requestErr.statusCode = requestResult.response.status;
        throw requestErr;
      }

      await maybeCaptureCodexUsageFromHeaders(currentAuth, requestResult.response.headers, "response").catch(() => {});

      const contentType = requestResult.response.headers.get("content-type") || "";
      let completed = parseRequestResult(
        requestResult,
        activeBody.stream === true || contentType.includes("text/event-stream")
      );

      if (!completed && activeBody.stream !== true) {
        activeBody = { ...baseBody, stream: true };
        requestResult = await sendCodexRequest(activeBody, "text/event-stream");
        if (!requestResult.response.ok) {
          const streamErr = new Error(
            `Upstream request failed: HTTP ${requestResult.response.status}: ${truncate(requestResult.raw, 400)}`
          );
          streamErr.statusCode = requestResult.response.status;
          throw streamErr;
        }
        completed = parseRequestResult(requestResult, true);
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
        auth = await getValidAuthContext();
        if (!auth.accountId) {
          const accountErr = new Error("Could not extract chatgpt_account_id from OAuth token.");
          accountErr.statusCode = 401;
          lastError = accountErr;
          break;
        }
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
      text: extractAssistantTextFromResponse(result.completed),
      finishReason: mapResponsesStatusToChatFinishReason(result.completed?.status),
      usage,
      authAccountId: result.authAccountId
    };
  }

  return {
    buildCodexResponsesRequestBody,
    executeCodexResponsesViaOAuth,
    runCodexConversationViaOAuth
  };
}
