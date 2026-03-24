import {
  consumeSseBlocks,
  createSseSession,
  parseSseJsonEventBlock
} from "../../http/sse-runtime.js";
import {
  isResponsesFailureEventType,
  isResponsesSuccessTerminalEventType
} from "../openai/responses-contract.js";

export function createGeminiLocalCompatHelpers(context) {
  const {
    config,
    readJsonBody,
    resolveCodexCompatibleRoute,
    resolveCompatErrorStatusCode,
    parseOpenAIChatCompletionsLikeRequest,
    splitSystemAndConversation,
    buildOpenAIChatCompletion,
    openCodexConversationStreamViaOAuth,
    mapOpenAIFinishReasonToGemini,
    runCodexConversationViaOAuth,
    pipeCodexSseAsChatCompletions,
    getOpenAICompatibleModelIds
  } = context;

  function collectGeminiTextParts(parts) {
    if (!Array.isArray(parts)) return "";
    const texts = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string" && part.text.length > 0) {
        texts.push(part.text);
        continue;
      }
      if (part.inlineData || part.inline_data || part.fileData || part.file_data || part.image_url) {
        texts.push("[image]");
      }
    }
    return texts.join("\n");
  }

  function parseGeminiNativeBody(rawBody, fallbackModel, parsedBody = undefined) {
    if ((!rawBody || rawBody.length === 0) && parsedBody === undefined) {
      throw new Error("Gemini request body is required.");
    }
    let parsed = parsedBody;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new Error("Invalid JSON body for Gemini endpoint.");
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Gemini request body must be a JSON object.");
    }

    const systemText = collectGeminiTextParts(parsed?.systemInstruction?.parts || parsed?.system_instruction?.parts);
    const contents = Array.isArray(parsed.contents) ? parsed.contents : [];
    const conversation = [];
    for (const item of contents) {
      if (!item || typeof item !== "object") continue;
      const role = String(item.role || "").toLowerCase() === "model" ? "assistant" : "user";
      const text = collectGeminiTextParts(item.parts);
      if (text.trim().length === 0) continue;
      conversation.push({ role, text });
    }
    if (conversation.length === 0) {
      conversation.push({ role: "user", text: " " });
    }

    const generationConfig =
      parsed.generationConfig && typeof parsed.generationConfig === "object" ? parsed.generationConfig : {};

    return {
      model: typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model : fallbackModel,
      systemText,
      conversation,
      stream: false,
      max_tokens: generationConfig.maxOutputTokens,
      temperature: generationConfig.temperature,
      top_p: generationConfig.topP,
      stop: Array.isArray(generationConfig.stopSequences)
        ? generationConfig.stopSequences
        : typeof generationConfig.stopSequences === "string"
          ? [generationConfig.stopSequences]
          : undefined
    };
  }

  function buildGeminiModelDescriptor(model) {
    return {
      name: `models/${model}`,
      version: "proxy-local",
      displayName: model,
      description: "Local Gemini-compatible facade powered by Codex OAuth.",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      temperature: 1,
      maxTemperature: 2,
      topP: 0.95,
      topK: 40
    };
  }

  function buildGeminiGenerateContentResponse({ model, text, finishReason, usage }) {
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: text || "" }]
          },
          finishReason: mapOpenAIFinishReasonToGemini(finishReason),
          index: 0
        }
      ],
      usageMetadata: {
        promptTokenCount: Number(usage?.prompt_tokens || 0),
        candidatesTokenCount: Number(usage?.completion_tokens || 0),
        totalTokenCount: Number(usage?.total_tokens || 0)
      },
      modelVersion: model
    };
  }

  function extractBufferedAssistantText(response) {
    const messageItem = Array.isArray(response?.output)
      ? response.output.find((item) => item?.type === "message" && item.role === "assistant")
      : null;
    const textPart = Array.isArray(messageItem?.content)
      ? messageItem.content.find((part) => part?.type === "output_text" && typeof part.text === "string")
      : null;
    return textPart?.text || "";
  }

  function toOpenAIUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    return {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    };
  }

  function mapResponsesStatusToGeminiFinishReason(status) {
    return mapOpenAIFinishReasonToGemini(status === "incomplete" ? "length" : "stop");
  }

  async function pipeCodexSseAsGeminiSse(upstream, res, model) {
    if (!upstream?.body) {
      throw new Error("No upstream SSE body.");
    }

    const reader = upstream.body.getReader();
    const idleTimeoutMs = Math.max(0, Number(config?.upstreamStreamIdleTimeoutMs || 0));
    const textStateByItemId = new Map();
    let emittedAnyPayload = false;
    let emittedTerminal = false;
    let finalUsage = null;

    const session = createSseSession(res, {
      upstream,
      heartbeatMs: 15000,
      prepareResponse() {
        res.status(200);
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
      }
    });
    session.attachReader(reader);
    session.startHeartbeat();

    const writePayload = (payload) => {
      const wrote = session.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (wrote) emittedAnyPayload = true;
      return wrote;
    };

    const emitTextDelta = (text) => {
      if (typeof text !== "string" || text.length === 0) return;
      writePayload({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text }]
            },
            index: 0
          }
        ],
        modelVersion: model
      });
    };

    const emitTrackedTextDelta = (itemId, text, { final = false } = {}) => {
      const normalizedText = typeof text === "string" ? text : "";
      if (!normalizedText) return;

      const key = itemId || "__default__";
      const state = textStateByItemId.get(key) || { emittedText: "" };
      let deltaText = normalizedText;
      if (final) {
        if (state.emittedText.length > 0 && !normalizedText.startsWith(state.emittedText)) {
          state.emittedText = normalizedText;
          textStateByItemId.set(key, state);
          return;
        }
        deltaText = normalizedText.slice(state.emittedText.length);
        state.emittedText = normalizedText;
      } else {
        state.emittedText += deltaText;
      }
      textStateByItemId.set(key, state);
      if (!deltaText) return;
      emitTextDelta(deltaText);
    };

    const emitCompleted = (response) => {
      const usage = toOpenAIUsage(response?.usage);
      finalUsage = usage;
      writePayload({
        candidates: [
          {
            content: {
              role: "model",
              parts: []
            },
            finishReason: mapResponsesStatusToGeminiFinishReason(response?.status),
            index: 0
          }
        ],
        ...(usage
          ? {
              usageMetadata: {
                promptTokenCount: Number(usage.prompt_tokens || 0),
                candidatesTokenCount: Number(usage.completion_tokens || 0),
                totalTokenCount: Number(usage.total_tokens || 0)
              }
            }
          : {}),
        modelVersion: model
      });
      emittedTerminal = true;
    };

    const handleSseBlock = (block) => {
      const event = parseSseJsonEventBlock(block);
      if (!event) return;

      if (isResponsesFailureEventType(event.type)) {
        const err = new Error(event.response?.error?.message || "Codex response failed.");
        err.statusCode = Number(event.response?.status_code || event.status_code || 502) || 502;
        throw err;
      }

      if (event.type === "response.output_text.delta") {
        const deltaText = typeof event.delta === "string" ? event.delta : "";
        emitTrackedTextDelta(typeof event.item_id === "string" ? event.item_id : "", deltaText);
        return;
      }

      if (event.type === "response.output_text.done") {
        emitTrackedTextDelta(
          typeof event.item_id === "string" ? event.item_id : "",
          typeof event.text === "string" ? event.text : "",
          { final: true }
        );
        return;
      }

      if (isResponsesSuccessTerminalEventType(event.type)) {
        if (!emittedAnyPayload) {
          emitTextDelta(extractBufferedAssistantText(event.response));
        }
        emitCompleted(event.response || {});
      }
    };

    try {
      await consumeSseBlocks(upstream, {
        reader,
        timeoutMs: idleTimeoutMs,
        isClosed: () => session.isClosed(),
        onBlock: handleSseBlock
      });

      if (!session.isClosed() && !emittedTerminal) {
        throw new Error("Upstream SSE ended before a terminal response event.");
      }

      if (!session.isClosed()) {
        session.end();
      }
      return { usage: finalUsage };
    } finally {
      session.cleanup();
      reader.releaseLock?.();
    }
  }

  async function handleGeminiNativeCompat(req, res) {
    res.locals.protocolType = "gemini-v1beta-native";
    const incoming = new URL(req.originalUrl, "http://localhost");
    const pathname = incoming.pathname;

    if (req.method === "GET" && (pathname === "/v1beta/models" || pathname === "/v1beta/models/")) {
      const modelIds = getOpenAICompatibleModelIds();
      res.status(200).json({
        models: modelIds.map((id) => buildGeminiModelDescriptor(id))
      });
      return;
    }

    const modelDetailMatch = pathname.match(/^\/v1beta\/models\/([^/:]+)$/);
    if (req.method === "GET" && modelDetailMatch) {
      const modelId = decodeURIComponent(modelDetailMatch[1]);
      res.status(200).json(buildGeminiModelDescriptor(modelId));
      return;
    }

    const generateMatch = pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
    if (!generateMatch || req.method !== "POST") {
      res.status(400).json({
        error: {
          code: 400,
          message:
            "In local Gemini compatibility mode, supported endpoints are GET /v1beta/models, GET /v1beta/models/{model}, POST /v1beta/models/{model}:generateContent, POST /v1beta/models/{model}:streamGenerateContent.",
          status: "INVALID_ARGUMENT"
        }
      });
      return;
    }

    const modelFromPath = decodeURIComponent(generateMatch[1]);
    const action = generateMatch[2];
    let parsedReq;
    try {
      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
      parsedReq = parseGeminiNativeBody(req.rawBody, modelFromPath || config.gemini.defaultModel, parsedBody);
    } catch (err) {
      res.status(400).json({
        error: {
          code: 400,
          message: err.message,
          status: "INVALID_ARGUMENT"
        }
      });
      return;
    }
    parsedReq.model = modelFromPath || parsedReq.model;
    const codexRoute = resolveCodexCompatibleRoute(parsedReq.model);
    res.locals.modelRoute = codexRoute;

    if (action === "streamGenerateContent" && String(incoming.searchParams.get("alt") || "").toLowerCase() === "sse") {
      let streamSession;
      try {
        streamSession = await openCodexConversationStreamViaOAuth({
          ...parsedReq,
          requestedModel: codexRoute.requestedModel,
          upstreamModel: codexRoute.mappedModel
        });
        res.locals.authAccountId = streamSession.authAccountId || null;

        if (streamSession.upstream?.body) {
          const streamResult = await pipeCodexSseAsGeminiSse(
            streamSession.upstream,
            res,
            codexRoute.requestedModel
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
            error: {
              code: statusCode,
              message: err.message,
              status: statusCode === 401 ? "UNAUTHENTICATED" : "INTERNAL"
            }
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
        ...parsedReq,
        requestedModel: codexRoute.requestedModel,
        upstreamModel: codexRoute.mappedModel
      });
    } catch (err) {
      const statusCode = resolveCompatErrorStatusCode(err, 502);
      res.status(statusCode).json({
        error: {
          code: statusCode,
          message: err.message,
          status: statusCode === 401 ? "UNAUTHENTICATED" : "INTERNAL"
        }
      });
      return;
    }

    const payload = buildGeminiGenerateContentResponse({
      model: result.model,
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage
    });
    res.locals.authAccountId = result.authAccountId || null;

    if (action === "streamGenerateContent") {
      res.status(200).json([payload]);
      return;
    }

    res.status(200).json(payload);
  }

  async function handleGeminiOpenAICompatWithCodex(req, res) {
    let chatReq;
    try {
      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
      chatReq = parseOpenAIChatCompletionsLikeRequest(req.rawBody, config.gemini.defaultModel, parsedBody);
    } catch (err) {
      res.status(400).json({ error: "invalid_request", message: err.message });
      return;
    }

    const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
    const modelRoute = resolveCodexCompatibleRoute(chatReq.model || config.gemini.defaultModel);
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
    parseGeminiNativeBody,
    buildGeminiModelDescriptor,
    buildGeminiGenerateContentResponse,
    handleGeminiNativeCompat,
    handleGeminiOpenAICompatWithCodex
  };
}
