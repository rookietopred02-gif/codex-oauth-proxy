import { createResponsesInputConversionHelpers } from "./responses-input-conversion.js";
import { assertResponsesCreateFieldSupported } from "./responses-create-compat.js";
import {
  extractDeveloperInstructionTextFromMessages,
  isPlanModeResponsesRequest,
  normalizeToolChoiceForMode,
  resolveResponsesCollaborationMode,
  resolveResponsesDeveloperInstructions,
  stripPlanOnlyToolsForMode,
  prepareResponsesCollaborationModeForCodexUpstream
} from "./plan-mode-detection.js";

export function createOpenAIRequestNormalizationHelpers(context) {
  const {
    config,
    resolveCodexCompatibleRoute,
    resolveReasoningEffort,
    applyReasoningEffortDefaults
  } = context;

  const {
    normalizeResponsesInput,
    normalizeChatTools,
    normalizeChatToolChoice,
    toResponsesInputFromChatMessages
  } = createResponsesInputConversionHelpers();

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

  function assertCodexResponsesCreateFieldsSupported(requestBody) {
    for (const fieldName of Object.keys(requestBody)) {
      assertResponsesCreateFieldSupported(fieldName, "codexResponses", "OpenAI Responses create requests");
    }
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
          effort: resolveReasoningEffort(
            undefined,
            {
              input: [{ role: "user", content: [{ type: "input_text", text: "" }] }],
              instructions: fallbackInstructions
            },
            modelRoute.mappedModel
          )
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
    assertCodexResponsesCreateFieldsSupported(parsed);
    const normalized = { ...parsed };
    const modelRoute = resolveCodexCompatibleRoute(normalized.model || config.codex.defaultModel);
    normalized.model = modelRoute.mappedModel;
    normalized.stream = true;
    normalized.store = false;
    const collaborationMode = resolveResponsesCollaborationMode(normalized);
    normalized.instructions = resolveResponsesDeveloperInstructions(normalized, config, {
      messageInstructions: extractDeveloperInstructionTextFromMessages(normalized.messages)
    });
    if (normalized.input === undefined && Array.isArray(normalized.messages)) {
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
    delete normalized.temperature;
    delete normalized.top_p;
    ensureResponsesInclude(normalized, "reasoning.encrypted_content");
    const planModeReasoningEffort = isPlanModeResponsesRequest(normalized)
      ? String(config?.codex?.planModeReasoningEffort || "").trim().toLowerCase()
      : "";
    const hasExplicitReasoningEffort =
      Object.prototype.hasOwnProperty.call(normalized, "reasoning_effort") ||
      Boolean(
        normalized.reasoning &&
          typeof normalized.reasoning === "object" &&
          !Array.isArray(normalized.reasoning) &&
          Object.prototype.hasOwnProperty.call(normalized.reasoning, "effort")
      );
    const defaultReasoningEffort =
      !hasExplicitReasoningEffort && planModeReasoningEffort.length > 0
        ? planModeReasoningEffort
        : normalized.reasoning_effort;
    applyReasoningEffortDefaults(
      normalized,
      defaultReasoningEffort,
      {
        input: normalized.input,
        tools: normalized.tools,
        instructions: normalized.instructions,
        collaborationMode: collaborationMode.mode,
        planModeReasoningEffort
      },
      modelRoute.mappedModel
    );
    if (
      !Object.prototype.hasOwnProperty.call(parsed, "service_tier") &&
      config.codex.defaultServiceTier === "priority"
    ) {
      normalized.service_tier = "priority";
    }
    delete normalized.messages;
    delete normalized.reasoning_effort;
    prepareResponsesCollaborationModeForCodexUpstream(normalized, {
      mode: collaborationMode.mode,
      explicit: collaborationMode.explicit,
      originalRequestBody: parsed
    });

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
    const collaborationMode = resolveResponsesCollaborationMode(parsed);
    const baseInstructions = resolveResponsesDeveloperInstructions(parsed, config, {
      messageInstructions: extractDeveloperInstructionTextFromMessages(messages)
    });
    const planModeReasoningEffort =
      collaborationMode.mode === "plan"
        ? String(config?.codex?.planModeReasoningEffort || "").trim().toLowerCase()
        : "";

    const modelRoute = resolveCodexCompatibleRoute(parsed.model || config.codex.defaultModel);
    const upstreamBody = {
      model: modelRoute.mappedModel,
      stream: true,
      store: false,
      instructions: baseInstructions,
      reasoning: {
        effort: resolveReasoningEffort(
          parsed.reasoning_effort,
          {
            messages,
            tools: parsed.tools,
            tool_choice: parsed.tool_choice,
            instructions: baseInstructions,
            collaborationMode: collaborationMode.mode,
            planModeReasoningEffort
          },
          modelRoute.mappedModel
        )
      },
      input: toResponsesInputFromChatMessages(messages)
    };

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

  return {
    normalizeCodexResponsesRequestBody,
    normalizeChatCompletionsRequestBody,
    toResponsesInputFromChatMessages
  };
}
