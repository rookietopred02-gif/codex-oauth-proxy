import { createResponsesInputConversionHelpers } from "./responses-input-conversion.js";
import { assertResponsesCreateFieldSupported } from "./responses-create-compat.js";
import {
  extractDeveloperInstructionTextFromMessages,
  normalizeToolChoiceForMode,
  resolveResponsesCollaborationMode,
  resolveResponsesDeveloperInstructions,
  stripPlanOnlyToolsForMode,
  prepareResponsesCollaborationModeForCodexUpstream
} from "./plan-mode-detection.js";

export function createOpenAIRequestNormalizationHelpers(context) {
  const {
    config,
    resolveCodexCompatibleRoute
  } = context;

  const {
    normalizeResponsesInput,
    normalizeChatTools,
    normalizeChatToolChoice,
    toResponsesInputFromChatMessages
  } = createResponsesInputConversionHelpers();

  function ensureResponsesInclude(requestBody, value) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
    const existing = Array.isArray(requestBody.include) ? requestBody.include : [];
    if (existing.includes(value)) {
      return;
    }
    requestBody.include = [...existing, value];
  }

  function hasResponsesWebSearchTool(tools) {
    if (!Array.isArray(tools)) return false;
    return tools.some((tool) => {
      const type = typeof tool?.type === "string" ? tool.type.trim() : "";
      return /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(type);
    });
  }

  function assertCodexResponsesCreateFieldsSupported(requestBody) {
    for (const fieldName of Object.keys(requestBody)) {
      assertResponsesCreateFieldSupported(fieldName, "codexResponses", "OpenAI Responses create requests");
    }
  }

  function getExplicitReasoningEffort(requestBody) {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      return { has: false, value: undefined };
    }
    const reasoning =
      requestBody.reasoning && typeof requestBody.reasoning === "object" && !Array.isArray(requestBody.reasoning)
        ? requestBody.reasoning
        : null;
    if (reasoning && Object.prototype.hasOwnProperty.call(reasoning, "effort")) {
      return { has: true, value: reasoning.effort };
    }
    if (Object.prototype.hasOwnProperty.call(requestBody, "reasoning_effort")) {
      return { has: true, value: requestBody.reasoning_effort };
    }
    return { has: false, value: undefined };
  }

  function preserveExplicitReasoningEffort(target, source) {
    const explicit = getExplicitReasoningEffort(source);
    if (!explicit.has) return;
    const reasoning =
      target.reasoning && typeof target.reasoning === "object" && !Array.isArray(target.reasoning)
        ? { ...target.reasoning }
        : {};
    reasoning.effort = explicit.value;
    target.reasoning = reasoning;
  }

  function applyConfiguredServiceTierDefault(target, source) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return;
    if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "service_tier")) {
      target.service_tier = source.service_tier;
      return;
    }
    const configuredTier = String(config?.codex?.defaultServiceTier || "").trim().toLowerCase();
    if (configuredTier) {
      target.service_tier = configuredTier;
    }
  }

  function orderResponsesCreateControlFields(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    const priorityFields = ["model", "service_tier", "stream", "store"];
    const ordered = {};
    for (const field of priorityFields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        ordered[field] = source[field];
      }
    }
    for (const [field, value] of Object.entries(source)) {
      if (!priorityFields.includes(field)) {
        ordered[field] = value;
      }
    }
    return ordered;
  }

  function hasExplicitResponsesInstructionOverride(requestBody, options = {}) {
    const settings =
      requestBody && typeof requestBody === "object" && !Array.isArray(requestBody) && requestBody.settings &&
      typeof requestBody.settings === "object" && !Array.isArray(requestBody.settings)
        ? requestBody.settings
        : null;
    if (settings && Object.prototype.hasOwnProperty.call(settings, "developer_instructions")) {
      return true;
    }
    if (
      requestBody &&
      typeof requestBody === "object" &&
      !Array.isArray(requestBody) &&
      Object.prototype.hasOwnProperty.call(requestBody, "instructions")
    ) {
      return true;
    }
    if (options.allowMessageInstructions !== true) return false;
    return typeof options.messageInstructions === "string" && options.messageInstructions.length > 0;
  }

  function normalizeCodexResponsesRequestBody(rawBody, options = {}) {
    if (!rawBody || rawBody.length === 0) {
      const modelRoute = resolveCodexCompatibleRoute(config.codex.defaultModel);
      const fallbackInstructions = config.codex.defaultInstructions;
      const json = {
        model: modelRoute.mappedModel,
        service_tier: config.codex.defaultServiceTier,
        stream: true,
        store: false,
        instructions: fallbackInstructions,
        input: [{ role: "user", content: [{ type: "input_text", text: "" }] }]
      };
      ensureResponsesInclude(json, "reasoning.encrypted_content");
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
    assertCodexResponsesCreateFieldsSupported(parsed);
    const normalized = { ...parsed };
    const hasExplicitStream = Object.prototype.hasOwnProperty.call(parsed, "stream");
    const hasExplicitStore = Object.prototype.hasOwnProperty.call(parsed, "store");
    const hasExplicitInclude = Object.prototype.hasOwnProperty.call(parsed, "include");
    const modelRoute = resolveCodexCompatibleRoute(normalized.model || config.codex.defaultModel);
    normalized.model = modelRoute.mappedModel;
    if (!hasExplicitStream) normalized.stream = true;
    if (!hasExplicitStore) normalized.store = false;
    applyConfiguredServiceTierDefault(normalized, parsed);
    const collaborationMode = resolveResponsesCollaborationMode(normalized);
    const hasOfficialPrompt = Object.prototype.hasOwnProperty.call(normalized, "prompt");
    const useMessagesAlias = normalized.input === undefined && !hasOfficialPrompt && Array.isArray(normalized.messages);
    const messageInstructions = useMessagesAlias ? extractDeveloperInstructionTextFromMessages(normalized.messages) : "";
    normalized.instructions = resolveResponsesDeveloperInstructions(normalized, config, {
      messageInstructions
    });
    const previousResponseId =
      typeof normalized.previous_response_id === "string" ? normalized.previous_response_id.trim() : "";
    const isPreviousResponseContinuation =
      previousResponseId.length > 0 || options.previousResponseContinuation === true;
    const explicitInstructionOverride = hasExplicitResponsesInstructionOverride(parsed, {
      messageInstructions,
      allowMessageInstructions: !isPreviousResponseContinuation
    });
    if (
      (isPreviousResponseContinuation || hasOfficialPrompt) &&
      !explicitInstructionOverride &&
      !collaborationMode.explicit
    ) {
      delete normalized.instructions;
    }
    if (useMessagesAlias) {
      normalized.input = toResponsesInputFromChatMessages(normalized.messages);
    } else {
      normalized.input = normalizeResponsesInput(normalized.input);
    }
    normalized.tools = stripPlanOnlyToolsForMode(normalized.tools, collaborationMode.mode);
    const normalizedToolChoice = normalizeToolChoiceForMode(
      normalized.tool_choice,
      collaborationMode.mode,
      normalized.tools
    );
    if (normalizedToolChoice === undefined) delete normalized.tool_choice;
    else normalized.tool_choice = normalizedToolChoice;
    if (!hasExplicitInclude && normalized.store === false) {
      ensureResponsesInclude(normalized, "reasoning.encrypted_content");
    }
    if (hasResponsesWebSearchTool(normalized.tools) && (!hasExplicitInclude || Array.isArray(normalized.include))) {
      ensureResponsesInclude(normalized, "web_search_call.action.sources");
    }
    preserveExplicitReasoningEffort(normalized, parsed);
    delete normalized.generate;
    delete normalized.messages;
    delete normalized.reasoning_effort;
    prepareResponsesCollaborationModeForCodexUpstream(normalized, {
      mode: collaborationMode.mode,
      explicit: collaborationMode.explicit,
      originalRequestBody: parsed
    });
    const upstreamJson = orderResponsesCreateControlFields(normalized);

    return {
      body: Buffer.from(JSON.stringify(upstreamJson), "utf8"),
      json: upstreamJson,
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
    const collaborationMode = resolveResponsesCollaborationMode(parsed);
    const baseInstructions = resolveResponsesDeveloperInstructions(parsed, config, {
      messageInstructions: extractDeveloperInstructionTextFromMessages(messages)
    });
    const modelRoute = resolveCodexCompatibleRoute(parsed.model || config.codex.defaultModel);
    const upstreamBody = {
      model: modelRoute.mappedModel,
      stream: true,
      store: false,
      instructions: baseInstructions,
      input: toResponsesInputFromChatMessages(messages)
    };
    preserveExplicitReasoningEffort(upstreamBody, parsed);

    if (parsed.max_completion_tokens !== undefined) upstreamBody.max_output_tokens = parsed.max_completion_tokens;
    else if (parsed.max_tokens !== undefined) upstreamBody.max_output_tokens = parsed.max_tokens;
    const normalizedChatTools = stripPlanOnlyToolsForMode(normalizeChatTools(parsed.tools), collaborationMode.mode);
    const normalizedChatToolChoice = normalizeToolChoiceForMode(
      normalizeChatToolChoice(parsed.tool_choice),
      collaborationMode.mode,
      normalizedChatTools
    );
    if (normalizedChatToolChoice !== undefined) upstreamBody.tool_choice = normalizedChatToolChoice;
    if (parsed.tools !== undefined) upstreamBody.tools = normalizedChatTools;
    if (hasResponsesWebSearchTool(upstreamBody.tools)) {
      ensureResponsesInclude(upstreamBody, "web_search_call.action.sources");
    }
    applyConfiguredServiceTierDefault(upstreamBody, parsed);
    const upstreamJson = orderResponsesCreateControlFields(upstreamBody);

    return {
      body: Buffer.from(JSON.stringify(upstreamJson), "utf8"),
      json: upstreamJson,
      wantsStream,
      model: modelRoute.requestedModel,
      modelRoute
    };
  }

  return {
    normalizeCodexResponsesRequestBody,
    normalizeChatCompletionsRequestBody,
    toResponsesInputFromChatMessages
  };
}
