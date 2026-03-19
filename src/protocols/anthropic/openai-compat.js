export function createAnthropicOpenAICompatHelpers(context) {
  const {
    config,
    readJsonBody,
    resolveCodexCompatibleRoute,
    resolveCompatErrorStatusCode,
    parseOpenAIChatCompletionsLikeRequest,
    splitSystemAndConversation,
    buildOpenAIChatCompletion,
    sendOpenAICompletionAsSse,
    runCodexConversationViaOAuth
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
    if (chatReq.stream === true) {
      sendOpenAICompletionAsSse(res, completion);
      return;
    }
    res.status(200).json(completion);
  }

  return {
    handleAnthropicOpenAICompatWithCodex
  };
}
