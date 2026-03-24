export function createAnthropicOpenAICompatHelpers(context) {
  const {
    config,
    readJsonBody,
    resolveCodexCompatibleRoute,
    resolveCompatErrorStatusCode,
    parseOpenAIChatCompletionsLikeRequest,
    splitSystemAndConversation,
    buildOpenAIChatCompletion,
    openCodexConversationStreamViaOAuth,
    runCodexConversationViaOAuth,
    pipeCodexSseAsChatCompletions
  } = context;

  async function handleAnthropicOpenAICompatWithCodex(req, res) {
    let chatReq;
    try {
      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
      chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.anthropic.defaultModel, parsedBody);
    } catch (err) {
      res.status(400).json({ error: "invalid_request", message: err.message });
      return;
    }

    const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
    const modelRoute = resolveCodexCompatibleRoute(chatReq.model || config.anthropic.defaultModel);
    res.locals.modelRoute = modelRoute;

    if (chatReq.stream === true) {
      let streamSession;
      try {
        streamSession = await openCodexConversationStreamViaOAuth({
          requestedModel: modelRoute.requestedModel,
          upstreamModel: modelRoute.mappedModel,
          systemText,
          conversation,
          max_tokens: chatReq.max_tokens,
          temperature: chatReq.temperature,
          top_p: chatReq.top_p,
          stop: chatReq.stop
        });
        res.locals.authAccountId = streamSession.authAccountId || null;

        if (streamSession.upstream?.body) {
          const streamResult = await pipeCodexSseAsChatCompletions(
            streamSession.upstream,
            res,
            modelRoute.requestedModel
          );
          if (streamResult?.usage) {
            res.locals.tokenUsage = streamResult.usage;
          }
          await streamSession.markSuccess();
          return;
        }
        const missingSseErr = new Error("Upstream stream request did not return an SSE body.");
        missingSseErr.statusCode = 502;
        throw missingSseErr;
      } catch (err) {
        await streamSession?.markFailure?.(err.message, err?.statusCode || 502);
        const statusCode = resolveCompatErrorStatusCode(err, 502);
        if (!res.headersSent) {
          res.status(statusCode).json({
            error: statusCode === 429 ? "usage_limit_reached" : "unauthorized",
            message: err.message,
            hint:
              statusCode === 401
                ? config.authMode === "profile-store"
                  ? "Run profile store login first."
                  : "Open /auth/login first."
                : null
          });
        } else {
          res.end();
        }
        streamSession?.release?.();
        return;
      } finally {
        streamSession?.release?.();
      }
    }

    let result;
    try {
      result = await runCodexConversationViaOAuth({
        requestedModel: modelRoute.requestedModel,
        upstreamModel: modelRoute.mappedModel,
        systemText,
        conversation,
        max_tokens: chatReq.max_tokens,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p,
        stop: chatReq.stop
      });
    } catch (err) {
      const statusCode = resolveCompatErrorStatusCode(err, 502);
      res.status(statusCode).json({
        error: statusCode === 429 ? "usage_limit_reached" : "unauthorized",
        message: err.message,
        hint:
          statusCode === 401
            ? config.authMode === "profile-store"
              ? "Run profile store login first."
              : "Open /auth/login first."
            : null
      });
      return;
    }

    const completion = buildOpenAIChatCompletion({
      model: modelRoute.requestedModel,
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage
    });
    res.locals.authAccountId = result.authAccountId || null;
    res.locals.tokenUsage = completion.usage;
    res.status(200).json(completion);
  }

  return {
    handleAnthropicOpenAICompatWithCodex
  };
}
