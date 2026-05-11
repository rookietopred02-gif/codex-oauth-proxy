import { getRequestBodyErrorStatus, isRequestBodyTooLargeError } from "../../http/request-body.js";
import { mapResponsesUsageToChatUsage } from "../../http/token-usage.js";

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
    openCodexConversationStreamViaOAuth,
    runCodexConversationViaOAuth,
    pipeCodexSseAsChatCompletions
  } = context;

  function sendOpenAICompatRequestBodyError(res, err) {
    res.status(getRequestBodyErrorStatus(err, 413)).json({
      error: err?.code || "invalid_request",
      message: err?.message || "Invalid request body."
    });
  }

  async function handleAnthropicOpenAICompatWithCodex(req, res) {
    let chatReq;
    try {
      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        if (isRequestBodyTooLargeError(err)) {
          sendOpenAICompatRequestBodyError(res, err);
          return;
        }
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

        if (streamSession.bufferedCompletion) {
          const completion = buildOpenAIChatCompletion({
            model: modelRoute.requestedModel,
            text: Array.isArray(streamSession.bufferedCompletion?.output)
              ? (
                  streamSession.bufferedCompletion.output.find(
                    (item) => item?.type === "message" && item.role === "assistant"
                  )?.content || []
            )
                  .filter((part) => part?.type === "output_text" && typeof part.text === "string")
                  .map((part) => part.text)
                  .join("")
              : "",
            finishReason: streamSession.bufferedCompletion?.status === "incomplete" ? "length" : "stop",
            usage: mapResponsesUsageToChatUsage(streamSession.bufferedCompletion?.usage)
          });
          res.locals.tokenUsage = completion.usage;
          sendOpenAICompletionAsSse(res, completion, { heartbeatMs: 0 });
          await streamSession.markSuccess();
          return;
        }

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
        const statusCode = resolveCompatErrorStatusCode(err, 502);
        await streamSession?.markFailure?.(err.message, statusCode);
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
