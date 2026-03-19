export function createGeminiLocalCompatHelpers(context) {
  const {
    config,
    readJsonBody,
    resolveCodexCompatibleRoute,
    resolveCompatErrorStatusCode,
    parseOpenAIChatCompletionsLikeRequest,
    splitSystemAndConversation,
    buildOpenAIChatCompletion,
    sendOpenAICompletionAsSse,
    mapOpenAIFinishReasonToGemini,
    runCodexConversationViaOAuth,
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

  function sendGeminiSseResponse(res, payload) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
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
      const wantsSse = String(incoming.searchParams.get("alt") || "").toLowerCase() === "sse";
      if (wantsSse) {
        sendGeminiSseResponse(res, payload);
        return;
      }
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
    parseGeminiNativeBody,
    buildGeminiModelDescriptor,
    buildGeminiGenerateContentResponse,
    handleGeminiNativeCompat,
    handleGeminiOpenAICompatWithCodex
  };
}
