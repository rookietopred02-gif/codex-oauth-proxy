import crypto from "node:crypto";

const OFFICIAL_RESPONSES_BUILT_IN_TOOL_TYPES = new Set([
  "web_search",
  "file_search",
  "mcp",
  "image_generation",
  "code_interpreter",
  "shell",
  "computer"
]);

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
    } else if (
      typeof tool.type === "string" &&
      OFFICIAL_RESPONSES_BUILT_IN_TOOL_TYPES.has(tool.type)
    ) {
      converted.push(structuredClone(tool));
    } else {
      converted.push(structuredClone(tool));
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
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    !Array.isArray(toolChoice) &&
    typeof toolChoice.type === "string" &&
    OFFICIAL_RESPONSES_BUILT_IN_TOOL_TYPES.has(toolChoice.type)
  ) {
    return structuredClone(toolChoice);
  }
  return structuredClone(toolChoice);
}

export function createResponsesInputConversionHelpers() {
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

  return {
    normalizeResponsesInput,
    normalizeChatTools,
    normalizeChatToolChoice,
    toResponsesInputFromChatMessages
  };
}
