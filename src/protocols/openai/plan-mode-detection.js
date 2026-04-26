const DEFAULT_COLLABORATION_MODE = "default";
const PLAN_COLLABORATION_MODE = "plan";
const PLAN_ONLY_TOOL_NAMES = new Set(["update_plan", "request_user_input"]);
const BUILT_IN_PLAN_MODE_INSTRUCTIONS = [
  "You are operating in Plan Mode.",
  "Focus on understanding the task, exploring context, and producing a concrete implementation plan before execution.",
  "Use request_user_input only when a blocking decision or missing information requires user input.",
  "Do not imply work is implemented unless it is actually implemented."
].join(" ");

function normalizeSettingObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function extractInstructionTextFromContent(content) {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content)
    ? content
    : content && typeof content === "object" && !Array.isArray(content)
      ? [content]
      : [];
  const textParts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    if (typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }
    if (typeof part.input_text === "string") {
      textParts.push(part.input_text);
      continue;
    }
    if (typeof part.output_text === "string") {
      textParts.push(part.output_text);
    }
  }
  return textParts.join("");
}

export function normalizeCollaborationMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === PLAN_COLLABORATION_MODE) return PLAN_COLLABORATION_MODE;
  if (normalized === DEFAULT_COLLABORATION_MODE) return DEFAULT_COLLABORATION_MODE;
  return "";
}

export function resolveResponsesCollaborationMode(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    return {
      mode: DEFAULT_COLLABORATION_MODE,
      explicit: false
    };
  }

  const directMode = normalizeCollaborationMode(requestBody.collaborationMode || requestBody.collaboration_mode);
  if (directMode) {
    return {
      mode: directMode,
      explicit: true
    };
  }

  const settings = normalizeSettingObject(requestBody.settings);
  const settingsMode = normalizeCollaborationMode(settings?.collaborationMode || settings?.collaboration_mode);
  if (settingsMode) {
    return {
      mode: settingsMode,
      explicit: true
    };
  }

  return {
    mode: DEFAULT_COLLABORATION_MODE,
    explicit: false
  };
}

export function getBuiltInDeveloperInstructionsForMode(mode, config) {
  const normalizedMode = normalizeCollaborationMode(mode) || DEFAULT_COLLABORATION_MODE;
  if (normalizedMode === PLAN_COLLABORATION_MODE) {
    return BUILT_IN_PLAN_MODE_INSTRUCTIONS;
  }
  return String(config?.codex?.defaultInstructions || "");
}

export function extractDeveloperInstructionTextFromMessages(messages) {
  if (!Array.isArray(messages)) return "";

  const instructionParts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = extractInstructionTextFromContent(message.content);
    if (text.length > 0) instructionParts.push(text);
  }

  return instructionParts.join("\n\n");
}

export function resolveResponsesDeveloperInstructions(requestBody, config, options = {}) {
  const { mode } = resolveResponsesCollaborationMode(requestBody);
  const settings = normalizeSettingObject(requestBody?.settings);
  const hasDeveloperInstructionsSetting = Boolean(
    settings && Object.prototype.hasOwnProperty.call(settings, "developer_instructions")
  );
  const messageInstructions =
    typeof options.messageInstructions === "string"
      ? options.messageInstructions
      : extractDeveloperInstructionTextFromMessages(requestBody?.messages);

  if (hasDeveloperInstructionsSetting) {
    if (settings.developer_instructions === null) {
      return getBuiltInDeveloperInstructionsForMode(mode, config);
    }
    if (typeof settings.developer_instructions === "string") {
      return settings.developer_instructions;
    }
  }

  if (typeof requestBody?.instructions === "string" && requestBody.instructions.length > 0) {
    return requestBody.instructions;
  }

  if (messageInstructions.length > 0) {
    return messageInstructions;
  }

  return getBuiltInDeveloperInstructionsForMode(mode, config);
}

export function prepareResponsesCollaborationModeForCodexUpstream(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return requestBody;

  delete requestBody.collaborationMode;
  delete requestBody.collaboration_mode;
  delete requestBody.settings;

  return requestBody;
}

export function stripResponsesCollaborationModeLocalFields(requestBody) {
  return prepareResponsesCollaborationModeForCodexUpstream(requestBody);
}

function normalizeToolFunctionName(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const directName = typeof tool.name === "string" ? tool.name : "";
  if (directName.trim().length > 0) return directName.trim();
  const nestedName = typeof tool.function?.name === "string" ? tool.function.name : "";
  return nestedName.trim();
}

function isPlanOnlyTool(tool) {
  const toolName = normalizeToolFunctionName(tool).toLowerCase();
  if (toolName && PLAN_ONLY_TOOL_NAMES.has(toolName)) return true;
  const toolType = typeof tool?.type === "string" ? tool.type.trim().toLowerCase() : "";
  return PLAN_ONLY_TOOL_NAMES.has(toolType);
}

export function stripPlanOnlyToolsForMode(tools, mode) {
  if (!Array.isArray(tools)) return tools;
  if (normalizeCollaborationMode(mode) === PLAN_COLLABORATION_MODE) {
    return tools.map((tool) => structuredClone(tool));
  }
  return tools.filter((tool) => !isPlanOnlyTool(tool)).map((tool) => structuredClone(tool));
}

export function normalizeToolChoiceForMode(toolChoice, mode, tools) {
  if (normalizeCollaborationMode(mode) === PLAN_COLLABORATION_MODE) {
    return toolChoice === undefined ? undefined : structuredClone(toolChoice);
  }
  const normalizedToolChoice =
    !toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)
      ? toolChoice === undefined
        ? undefined
        : structuredClone(toolChoice)
      : isPlanOnlyTool(toolChoice)
        ? undefined
        : structuredClone(toolChoice);
  if (normalizedToolChoice === "required" && Array.isArray(tools) && tools.length === 0) {
    return undefined;
  }
  return normalizedToolChoice;
}

export function isPlanModeResponsesRequest(requestBody) {
  return resolveResponsesCollaborationMode(requestBody).mode === PLAN_COLLABORATION_MODE;
}
