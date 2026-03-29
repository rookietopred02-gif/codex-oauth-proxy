import crypto from "node:crypto";

export function createOpenAIRequestNormalizationHelpers(context) {
  const {
    config,
    resolveCodexCompatibleRoute,
    resolveReasoningEffort,
    applyReasoningEffortDefaults
  } = context;

  function ensureResponsesInclude(requestBody, value) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
    const existing = Array.isArray(requestBody.include)
      ? requestBody.include.filter((item) => typeof item === "string" && item.length > 0)
      : [];
    if (existing.includes(value)) {
      requestBody.include = existing;
      return;
    }
    requestBody.include = [...existing, value];
  }

  function normalizeResponsesReasoningItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning") {
      return null;
    }

    const normalized = {
      type: "reasoning",
      summary: []
    };
    if (typeof item.id === "string" && item.id.length > 0) {
      normalized.id = item.id;
    }
    if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
      normalized.encrypted_content = item.encrypted_content;
    }

    const summary = [];
    for (const part of Array.isArray(item.summary) ? item.summary : []) {
      if (!part || typeof part !== "object" || Array.isArray(part) || part.type !== "summary_text") continue;
      summary.push({
        type: "summary_text",
        text: typeof part.text === "string" ? part.text : ""
      });
    }
    if (summary.length > 0) {
      normalized.summary = summary;
    }

    return normalized.id || normalized.encrypted_content || summary.length > 0 ? normalized : null;
  }

  function normalizeResponsesMessageContentPart(part, role) {
    if (!part || typeof part !== "object" || Array.isArray(part)) return null;
    if (role === "assistant" && part.type === "refusal") {
      const text =
        typeof part.refusal === "string" ? part.refusal : typeof part.text === "string" ? part.text : "";
      return { type: "output_text", text };
    }
    return structuredClone(part);
  }

  function normalizeResponsesMessageItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "message") {
      return null;
    }
    const normalized = structuredClone(item);
    if (Array.isArray(item.content)) {
      normalized.content = item.content
        .map((part) => normalizeResponsesMessageContentPart(part, item.role))
        .filter(Boolean);
    }
    return normalized;
  }

  function normalizeResponsesInputItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;

    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "reasoning") {
      return normalizeResponsesReasoningItem(item);
    }
    if (itemType === "message") {
      return normalizeResponsesMessageItem(item);
    }
    if (itemType) {
      return structuredClone(item);
    }

    if (item.role === "system" || item.role === "developer") {
      return structuredClone(item);
    }

    if (item.role === "assistant" || item.role === "user" || item.role === "tool") {
      return toResponsesInputFromChatMessages([item])[0] || null;
    }

    return structuredClone(item);
  }

  function normalizeResponsesInput(input) {
    if (typeof input === "string") {
      return [{ role: "user", content: [{ type: "input_text", text: input }] }];
    }
    if (Array.isArray(input)) {
      const normalized = input.map((item) => normalizeResponsesInputItem(item)).filter(Boolean);
      return normalized.length > 0
        ? normalized
        : [{ role: "user", content: [{ type: "input_text", text: "" }] }];
    }
    return input;
  }

  function normalizeCodexResponsesRequestBody(rawBody, options = {}) {
    if (!rawBody || rawBody.length === 0) {
      const modelRoute = resolveCodexCompatibleRoute(config.codex.defaultModel);
      const fallbackInstructions = config.codex.defaultInstructions;
      const json = {
        model: modelRoute.mappedModel,
        stream: true,
        store: false,
        instructions: fallbackInstructions,
        reasoning: {
          effort: resolveReasoningEffort(undefined, {
            input: [{ role: "user", content: [{ type: "input_text", text: "" }] }],
            instructions: fallbackInstructions
          }, modelRoute.mappedModel)
        },
        input: [{ role: "user", content: [{ type: "input_text", text: "" }] }]
      };
      ensureResponsesInclude(json, "reasoning.encrypted_content");
      if (config.codex.defaultServiceTier === "priority") {
        json.service_tier = "priority";
      }
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        collectCompletedResponseAsJson: true,
        model: modelRoute.requestedModel,
        modelRoute,
        json
      };
    }

    let parsed = options.parsedBody;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return {
          body: rawBody,
          json: null,
          collectCompletedResponseAsJson: false
        };
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        body: rawBody,
        json: null,
        collectCompletedResponseAsJson: false,
        model: config.codex.defaultModel,
        modelRoute: null
      };
    }

    const wantsStream = parsed.stream === true;
    const normalized = { ...parsed };
    const modelRoute = resolveCodexCompatibleRoute(normalized.model || config.codex.defaultModel);
    normalized.model = modelRoute.mappedModel;
    normalized.stream = true;
    normalized.store = false;
    if (!normalized.instructions || String(normalized.instructions).trim() === "") {
      normalized.instructions = config.codex.defaultInstructions;
    }
    if (normalized.input === undefined && Array.isArray(normalized.messages)) {
      normalized.input = toResponsesInputFromChatMessages(normalized.messages);
    } else {
      normalized.input = normalizeResponsesInput(normalized.input);
    }
    delete normalized.temperature;
    delete normalized.top_p;
    ensureResponsesInclude(normalized, "reasoning.encrypted_content");
    applyReasoningEffortDefaults(normalized, normalized.reasoning_effort, {
      input: normalized.input,
      tools: normalized.tools,
      instructions: normalized.instructions
    }, modelRoute.mappedModel);
    if (
      !Object.prototype.hasOwnProperty.call(parsed, "service_tier") &&
      config.codex.defaultServiceTier === "priority"
    ) {
      normalized.service_tier = "priority";
    }
    delete normalized.messages;
    delete normalized.reasoning_effort;

    return {
      body: Buffer.from(JSON.stringify(normalized), "utf8"),
      json: normalized,
      collectCompletedResponseAsJson: !wantsStream,
      model: modelRoute.requestedModel,
      modelRoute
    };
  }

  function normalizeChatCompletionsRequestBody(rawBody, options = {}) {
    if (!rawBody || rawBody.length === 0) {
      throw new Error("/v1/chat/completions requires a JSON body.");
    }

    let parsed = options.parsedBody;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new Error("Invalid JSON body for /v1/chat/completions.");
      }
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid JSON object body for /v1/chat/completions.");
    }
    const wantsStream = parsed.stream === true;

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const systemMessages = messages
      .filter((msg) => msg && (msg.role === "system" || msg.role === "developer"))
      .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
      .filter((text) => text.length > 0);

    const modelRoute = resolveCodexCompatibleRoute(parsed.model || config.codex.defaultModel);
    const upstreamBody = {
      model: modelRoute.mappedModel,
      stream: true,
      store: false,
      instructions: systemMessages.join("\n\n") || config.codex.defaultInstructions,
      reasoning: {
        effort: resolveReasoningEffort(parsed.reasoning_effort, {
          messages,
          tools: parsed.tools,
          tool_choice: parsed.tool_choice,
          instructions: systemMessages.join("\n\n") || config.codex.defaultInstructions
        }, modelRoute.mappedModel)
      },
      input: toResponsesInputFromChatMessages(messages)
    };

    if (parsed.max_completion_tokens !== undefined) upstreamBody.max_output_tokens = parsed.max_completion_tokens;
    else if (parsed.max_tokens !== undefined) upstreamBody.max_output_tokens = parsed.max_tokens;
    if (parsed.tool_choice !== undefined) upstreamBody.tool_choice = normalizeChatToolChoice(parsed.tool_choice);
    if (parsed.tools !== undefined) upstreamBody.tools = normalizeChatTools(parsed.tools);
    if (Object.prototype.hasOwnProperty.call(parsed, "service_tier")) {
      upstreamBody.service_tier = parsed.service_tier;
    } else if (config.codex.defaultServiceTier === "priority") {
      upstreamBody.service_tier = "priority";
    }

    return {
      body: Buffer.from(JSON.stringify(upstreamBody), "utf8"),
      json: upstreamBody,
      wantsStream,
      model: modelRoute.requestedModel,
      modelRoute
    };
  }

  function toResponsesInputFromChatMessages(messages) {
    const converted = [];
    for (const raw of messages) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "function_call" || raw.type === "function_call_output") {
        converted.push(structuredClone(raw));
        continue;
      }
      if (raw.type === "reasoning") {
        const normalizedReasoning = normalizeResponsesReasoningItem(raw);
        if (normalizedReasoning) {
          converted.push(normalizedReasoning);
        }
        continue;
      }
      if (raw.role === "system" || raw.role === "developer") continue;

      if (raw.role === "assistant" && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
        const assistantText = normalizeChatMessageContent(raw.content, "assistant");
        if (assistantText.length > 0) {
          converted.push({ role: "assistant", content: assistantText });
        }
        for (const toolCall of raw.tool_calls) {
          if (!toolCall || toolCall.type !== "function") continue;
          const callId =
            typeof toolCall.id === "string" && toolCall.id.length > 0
              ? toolCall.id
              : `call_${crypto.randomUUID().replace(/-/g, "")}`;
          const name = typeof toolCall.function?.name === "string" ? toolCall.function.name : "";
          const argumentsText =
            typeof toolCall.function?.arguments === "string" ? toolCall.function.arguments : "{}";
          if (!name) continue;
          converted.push({ type: "function_call", call_id: callId, name, arguments: argumentsText });
        }
        continue;
      }

      if (raw.role === "tool") {
        const callId = typeof raw.tool_call_id === "string" ? raw.tool_call_id : "";
        if (!callId) continue;
        converted.push({ type: "function_call_output", call_id: callId, output: extractToolOutputText(raw.content) });
        continue;
      }

      const role = normalizeChatRole(raw.role);
      const normalizedContent = normalizeChatMessageContent(raw.content, role);
      if (normalizedContent.length === 0) continue;
      converted.push({ role, content: normalizedContent });
    }

    return converted.length > 0
      ? converted
      : [{ role: "user", content: [{ type: "input_text", text: "" }] }];
  }

  function normalizeChatRole(role) {
    return role === "assistant" ? "assistant" : "user";
  }

  function normalizeChatMessageContent(content, role) {
    const targetType = role === "assistant" ? "output_text" : "input_text";
    if (typeof content === "string") return [{ type: targetType, text: content }];
    if (content && typeof content === "object" && !Array.isArray(content)) content = [content];
    if (!Array.isArray(content)) return [];

    const converted = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "refusal" && role === "assistant") {
        const refusalText =
          typeof item.refusal === "string" ? item.refusal : typeof item.text === "string" ? item.text : "";
        if (refusalText) converted.push({ type: targetType, text: refusalText });
        continue;
      }
      if (role !== "assistant" && (item.type === "image_url" || item.type === "input_image")) {
        const imageUrl =
          typeof item.image_url === "string"
            ? item.image_url
            : typeof item.image_url?.url === "string"
              ? item.image_url.url
              : "";
        if (imageUrl) converted.push({ type: "input_image", image_url: imageUrl });
        continue;
      }
      const text =
        typeof item.text === "string" ? item.text : typeof item.output_text === "string" ? item.output_text : "";
      if (!text) continue;
      if (item.type === "text" || item.type === "input_text" || item.type === "output_text") {
        converted.push({ type: targetType, text });
      }
    }
    return converted;
  }

  function extractToolOutputText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.output_text === "string") parts.push(item.output_text);
    }
    return parts.length > 0 ? parts.join("") : JSON.stringify(content);
  }

  function normalizeChatTools(tools) {
    if (!Array.isArray(tools)) return tools;
    const converted = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.type === "function" && tool.function && typeof tool.function === "object") {
        const name = typeof tool.function.name === "string" ? tool.function.name : "";
        if (!name) continue;
        converted.push({
          type: "function",
          name,
          ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}),
          ...(tool.function.parameters ? { parameters: tool.function.parameters } : {})
        });
      } else {
        converted.push(tool);
      }
    }
    return converted;
  }

  function normalizeChatToolChoice(toolChoice) {
    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      toolChoice.type === "function" &&
      toolChoice.function &&
      typeof toolChoice.function === "object"
    ) {
      const name = typeof toolChoice.function.name === "string" ? toolChoice.function.name : "";
      return name ? { type: "function", name } : "auto";
    }
    return toolChoice;
  }

  return {
    normalizeCodexResponsesRequestBody,
    normalizeChatCompletionsRequestBody,
    toResponsesInputFromChatMessages
  };
}
