import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import {
  consumeSseBlocks,
  createSseSession,
  parseSseJsonEventBlock
} from "../../http/sse-runtime.js";

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"]
]);
const UNSUPPORTED_LOCAL_IMAGE_EXTENSIONS = new Set([".svg", ".tif", ".tiff", ".heic", ".heif", ".ico", ".avif"]);
const ANTHROPIC_PENDING_TOOL_BATCH_TTL_MS = 15 * 60 * 1000;
const ANTHROPIC_TOOL_USE_EMPTY_STRING_KEYS = {
  Edit: new Set(["old_string", "new_string"]),
  Write: new Set(["content"])
};

export function createAnthropicLocalCompatHelpers(context) {
  const {
    config,
    readJsonBody,
    readRawBody,
    parseJsonLoose,
    truncate,
    resolveReasoningEffort,
    resolveCodexCompatibleRoute,
    executeCodexResponsesViaOAuth,
    openCodexResponsesStreamViaOAuth,
    resolveCompatErrorStatusCode,
    mapHttpStatusToAnthropicErrorType,
    mapResponsesStatusToChatFinishReason,
    mapOpenAIFinishReasonToAnthropic
  } = context;

  const anthropicPendingToolBatches = new Map();

  function isRecordObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isAnthropicNativeMessagesPath(pathname) {
    const pathValue = String(pathname || "").replace(/\/+$/, "") || "/";
    return pathValue === "/v1/messages" || pathValue === "/v1/messages/count_tokens";
  }

  function normalizeCherryAnthropicAgentOriginalUrl(originalUrl) {
    const incoming = new URL(String(originalUrl || ""), "http://localhost");
    const match = incoming.pathname.match(/^\/v1\/chat\/completions\/v1\/messages(\/count_tokens)?\/?$/);
    if (!match) return null;
    return `/v1/messages${match[1] || ""}${incoming.search}`;
  }

  function parseAnthropicMessageText(content) {
    if (typeof content === "string") return content;
    if (!content || typeof content !== "object") return "";
    const chunks = Array.isArray(content) ? content : [content];
    const parts = [];
    for (const chunk of chunks) {
      const text = stringifyAnthropicLocalCompatContentBlock(chunk, { strict: false, context: "message" });
      if (text.length > 0) parts.push(text);
    }
    return parts.join("\n");
  }

  function stringifyAnthropicLocalCompatContentBlock(chunk, { strict = false, context = "message" } = {}) {
    if (!chunk || typeof chunk !== "object") return "";
    if (typeof chunk.text === "string") return chunk.text;

    if (chunk.type === "tool_result") {
      return parseAnthropicMessageText(chunk.content);
    }

    if (chunk.type === "tool_use") {
      const name = typeof chunk.name === "string" ? chunk.name : "tool";
      const inputText =
        chunk.input !== undefined
          ? typeof chunk.input === "string"
            ? chunk.input
            : JSON.stringify(chunk.input)
          : "";
      return `[tool_use:${name}]${inputText ? ` ${inputText}` : ""}`;
    }

    if (chunk.type === "server_tool_use") {
      const name = typeof chunk.name === "string" ? chunk.name : "server_tool";
      const inputText =
        chunk.input !== undefined
          ? typeof chunk.input === "string"
            ? chunk.input
            : JSON.stringify(chunk.input)
          : "";
      return `[server_tool_use:${name}]${inputText ? ` ${inputText}` : ""}`;
    }

    if (chunk.type === "web_search_tool_result") {
      return summarizeAnthropicWebSearchToolResultContent(chunk.content);
    }

    if (chunk.type === "image") {
      return "[image]";
    }

    if (strict) {
      const type = typeof chunk.type === "string" ? chunk.type : "unknown";
      throw new Error(`Unsupported Anthropic ${context} content block type "${type}" in local compatibility mode.`);
    }

    return "";
  }

  function parseAnthropicJsonBody(rawBody, parsedBody = undefined) {
    if ((!rawBody || rawBody.length === 0) && parsedBody === undefined) {
      throw new Error("Anthropic request body is required.");
    }
    let parsed = parsedBody;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new Error("Invalid JSON body for Anthropic endpoint.");
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Anthropic request body must be a JSON object.");
    }
    return parsed;
  }

  function parseAnthropicSystemTextContent(content) {
    if (content === undefined || content === null) return "";
    if (typeof content === "string") return content;

    const chunks = Array.isArray(content) ? content : [content];
    const parts = [];
    for (const chunk of chunks) {
      if (!isRecordObject(chunk)) {
        throw new Error("Anthropic system content blocks must be JSON objects.");
      }
      const type = typeof chunk.type === "string" ? chunk.type : "text";
      if (type !== "text") {
        throw new Error(`Unsupported Anthropic system content block type "${type}" in local compatibility mode.`);
      }
      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (text.length > 0) parts.push(text);
    }
    return parts.join("\n");
  }

  function parseAnthropicToolResultOutput(content) {
    if (typeof content === "string") return content;
    if (content === undefined || content === null) return "";

    if (Array.isArray(content)) {
      const parts = [];
      for (const chunk of content) {
        if (!isRecordObject(chunk)) {
          throw new Error(
            "Anthropic tool_result content arrays must contain content blocks in local compatibility mode."
          );
        }
        const text = stringifyAnthropicLocalCompatContentBlock(chunk, { strict: true, context: "tool_result" });
        if (text.length > 0) parts.push(text);
      }
      return parts.join("\n");
    }

    if (isRecordObject(content)) {
      if (typeof content.type === "string" || typeof content.text === "string") {
        return stringifyAnthropicLocalCompatContentBlock(content, { strict: true, context: "tool_result" });
      }
      return JSON.stringify(content);
    }

    return JSON.stringify(content);
  }

  function normalizeAnthropicWebSearchToolResultContent(content) {
    if (isRecordObject(content)) {
      if (content.type === "web_search_tool_result_error") {
        return {
          type: "web_search_tool_result_error",
          error_code:
            typeof content.error_code === "string" && content.error_code.trim().length > 0
              ? content.error_code.trim()
              : "unavailable"
        };
      }
      throw new Error(
        `Unsupported Anthropic web_search_tool_result content block type "${String(content.type || "<empty>")}" in local compatibility mode.`
      );
    }

    if (!Array.isArray(content)) {
      throw new Error(
        "Anthropic web_search_tool_result content must be an array of web_search_result blocks or an error object."
      );
    }

    const normalized = [];
    for (const chunk of content) {
      if (!isRecordObject(chunk) || chunk.type !== "web_search_result") {
        throw new Error(
          "Anthropic web_search_tool_result content arrays must contain web_search_result blocks."
        );
      }
      const url = typeof chunk.url === "string" ? chunk.url.trim() : "";
      if (!url) {
        throw new Error("Anthropic web_search_result blocks require a non-empty url.");
      }
      const result = {
        type: "web_search_result",
        url,
        title:
          typeof chunk.title === "string" && chunk.title.trim().length > 0 ? chunk.title.trim() : url,
        encrypted_content:
          typeof chunk.encrypted_content === "string" && chunk.encrypted_content.trim().length > 0
            ? chunk.encrypted_content.trim()
            : Buffer.from(url, "utf8").toString("base64url")
      };
      if (typeof chunk.page_age === "string" && chunk.page_age.trim().length > 0) {
        result.page_age = chunk.page_age.trim();
      }
      normalized.push(result);
    }
    return normalized;
  }

  function summarizeAnthropicWebSearchToolResultContent(content) {
    if (isRecordObject(content) && content.type === "web_search_tool_result_error") {
      return `Web search error: ${String(content.error_code || "unavailable")}`;
    }

    if (!Array.isArray(content) || content.length === 0) return "";
    return content
      .map((entry) => {
        if (!isRecordObject(entry) || entry.type !== "web_search_result") return "";
        const title =
          typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title.trim() : entry.url;
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (!url) return "";
        return `${title}\n${url}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function looksLikeAbsoluteLocalFilePath(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    return /^[A-Za-z]:[\\/]/.test(raw) || /^\/[^/]/.test(raw);
  }

  function normalizePathSeparators(value) {
    return String(value || "").replace(/\\/g, "/");
  }

  function splitPortablePathSegments(value) {
    return normalizePathSeparators(value)
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  function resolveLocalToolPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^[A-Za-z]:[\\/]/.test(raw)) {
      return path.win32.normalize(raw);
    }
    const normalized = normalizePathSeparators(raw);
    const driveMatch = normalized.match(/^\/([A-Za-z])\/(.*)$/);
    if (driveMatch) {
      const drive = `${driveMatch[1].toUpperCase()}:\\`;
      const tailSegments = splitPortablePathSegments(driveMatch[2]);
      return path.win32.join(drive, ...tailSegments);
    }
    return path.resolve(raw);
  }

  function getSupportedLocalImageMediaType(filePath) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    return SUPPORTED_LOCAL_IMAGE_EXTENSIONS.get(extension) || "";
  }

  function isKnownUnsupportedLocalImagePath(filePath) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    return UNSUPPORTED_LOCAL_IMAGE_EXTENSIONS.has(extension);
  }

  function classifyCherryAttachmentPath(filePath) {
    const resolvedPath = resolveLocalToolPath(filePath);
    const supportedMediaType = getSupportedLocalImageMediaType(resolvedPath);
    const hasKnownUnsupportedImageExtension = isKnownUnsupportedLocalImagePath(resolvedPath);

    if (!resolvedPath || !fsSync.existsSync(resolvedPath)) {
      return { status: "keep" };
    }

    let stat;
    try {
      stat = fsSync.statSync(resolvedPath);
    } catch (err) {
      throw new Error(`Could not access attached file "${resolvedPath}": ${err.message}`);
    }

    if (!stat.isFile()) {
      return { status: "keep" };
    }

    if (supportedMediaType) {
      try {
        fsSync.accessSync(resolvedPath, fsSync.constants.R_OK);
      } catch (err) {
        throw new Error(`Attached image file is not readable: "${resolvedPath}". ${err.message}`);
      }
      return {
        status: "promote",
        file_path: resolvedPath,
        media_type: supportedMediaType
      };
    }

    if (hasKnownUnsupportedImageExtension) {
      throw new Error(`Unsupported attached image format "${path.extname(resolvedPath)}" in local compatibility mode.`);
    }

    return { status: "keep" };
  }

  function normalizeAnthropicUserTextWithAttachments(text) {
    const source = typeof text === "string" ? text : String(text || "");
    if (!source) return [];

    const lines = source.split(/\r?\n/);
    const normalized = [];
    let textBuffer = [];

    const flushTextBuffer = () => {
      if (textBuffer.length === 0) return;
      const joined = textBuffer.join("\n");
      if (joined.length > 0) {
        normalized.push({ type: "text", text: joined });
      }
      textBuffer = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().toLowerCase() !== "attached files:") {
        textBuffer.push(line);
        continue;
      }

      let cursor = index + 1;
      const attachmentPaths = [];
      while (cursor < lines.length && looksLikeAbsoluteLocalFilePath(lines[cursor].trim())) {
        attachmentPaths.push(lines[cursor].trim());
        cursor += 1;
      }

      if (attachmentPaths.length === 0) {
        textBuffer.push(line);
        continue;
      }

      const promotedAttachments = attachmentPaths.map((filePath) => classifyCherryAttachmentPath(filePath));
      if (promotedAttachments.every((entry) => entry.status === "promote")) {
        flushTextBuffer();
        for (const entry of promotedAttachments) {
          normalized.push({
            type: "image",
            source: {
              type: "file",
              file_path: entry.file_path,
              media_type: entry.media_type
            }
          });
        }
        index = cursor - 1;
        continue;
      }

      textBuffer.push(line, ...attachmentPaths);
      index = cursor - 1;
    }

    flushTextBuffer();
    return normalized;
  }

  function normalizeAnthropicImageBlock(chunk, role) {
    if (role !== "user") {
      throw new Error("Anthropic image blocks are only supported in user messages.");
    }
    if (!isRecordObject(chunk.source)) {
      throw new Error("Anthropic image blocks require a source object.");
    }

    const sourceType = typeof chunk.source.type === "string" ? chunk.source.type.trim().toLowerCase() : "";
    if (sourceType === "base64") {
      const mediaType =
        typeof chunk.source.media_type === "string" ? chunk.source.media_type.trim().toLowerCase() : "";
      const data = typeof chunk.source.data === "string" ? chunk.source.data.trim() : "";
      if (!mediaType || ![...SUPPORTED_LOCAL_IMAGE_EXTENSIONS.values()].includes(mediaType)) {
        throw new Error(`Unsupported Anthropic image media_type "${chunk.source.media_type || "<empty>"}" in local compatibility mode.`);
      }
      if (!data) {
        throw new Error("Anthropic image blocks require non-empty base64 data.");
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data
        }
      };
    }

    throw new Error(`Unsupported Anthropic image source type "${chunk.source.type || "<empty>"}" in local compatibility mode.`);
  }

  function buildResponsesInputImagePart(block) {
    if (!isRecordObject(block) || block.type !== "image" || !isRecordObject(block.source)) {
      throw new Error("Expected a normalized Anthropic image block.");
    }

    if (block.source.type === "base64") {
      return {
        type: "input_image",
        image_url: `data:${block.source.media_type};base64,${block.source.data}`
      };
    }

    if (block.source.type === "file") {
      const resolvedPath = resolveLocalToolPath(block.source.file_path);
      const mediaType =
        typeof block.source.media_type === "string" && block.source.media_type.trim().length > 0
          ? block.source.media_type.trim().toLowerCase()
          : getSupportedLocalImageMediaType(resolvedPath);
      if (!resolvedPath || !mediaType) {
        throw new Error(`Unsupported attached image source "${block.source.file_path || "<empty>"}".`);
      }

      let bytes;
      try {
        bytes = fsSync.readFileSync(resolvedPath);
      } catch (err) {
        throw new Error(`Could not read attached image file "${resolvedPath}": ${err.message}`);
      }

      return {
        type: "input_image",
        image_url: `data:${mediaType};base64,${bytes.toString("base64")}`
      };
    }

    throw new Error(`Unsupported normalized image source type "${block.source.type || "<empty>"}".`);
  }

  function parseAnthropicMessageContentBlocks(content, role) {
    if (typeof content === "string") {
      if (role === "user") {
        return normalizeAnthropicUserTextWithAttachments(content);
      }
      return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    if (content === undefined || content === null) {
      return [];
    }

    const chunks = Array.isArray(content) ? content : [content];
    const normalized = [];
    for (const chunk of chunks) {
      if (!isRecordObject(chunk)) {
        throw new Error("Anthropic message content blocks must be JSON objects.");
      }

      const type = typeof chunk.type === "string" ? chunk.type : "text";
      if (type === "text") {
        const text = typeof chunk.text === "string" ? chunk.text : "";
        if (text.length > 0) {
          if (role === "user") {
            normalized.push(...normalizeAnthropicUserTextWithAttachments(text));
          } else {
            normalized.push({ type: "text", text });
          }
        }
        continue;
      }

      if (type === "image") {
        normalized.push(normalizeAnthropicImageBlock(chunk, role));
        continue;
      }

      if (type === "thinking") {
        if (role !== "assistant") {
          throw new Error("Anthropic thinking blocks are only supported in assistant messages.");
        }
        const thinking = typeof chunk.thinking === "string" ? chunk.thinking : "";
        if (thinking.length > 0) {
          normalized.push({
            type: "thinking",
            thinking,
            ...(typeof chunk.signature === "string" && chunk.signature.length > 0 ? { signature: chunk.signature } : {})
          });
        }
        continue;
      }

      if (type === "tool_result") {
        if (role !== "user") {
          throw new Error("Anthropic tool_result blocks are only supported in user messages.");
        }
        const toolUseId = typeof chunk.tool_use_id === "string" ? chunk.tool_use_id.trim() : "";
        if (!toolUseId) {
          throw new Error("Anthropic tool_result blocks require a non-empty tool_use_id.");
        }
        normalized.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: parseAnthropicToolResultOutput(chunk.content),
          is_error: chunk.is_error === true
        });
        continue;
      }

      if (type === "tool_use") {
        if (role !== "assistant") {
          throw new Error("Anthropic tool_use blocks are only supported in assistant messages.");
        }
        const id = typeof chunk.id === "string" ? chunk.id.trim() : "";
        const name = typeof chunk.name === "string" ? chunk.name.trim() : "";
        if (!id || !name) {
          throw new Error("Anthropic tool_use blocks require non-empty id and name.");
        }
        if (chunk.input !== undefined && !isRecordObject(chunk.input)) {
          throw new Error("Anthropic tool_use input must be a JSON object in local compatibility mode.");
        }
        normalized.push({
          type: "tool_use",
          id,
          name,
          input: isRecordObject(chunk.input) ? chunk.input : {}
        });
        continue;
      }

      if (type === "server_tool_use") {
        if (role !== "assistant") {
          throw new Error("Anthropic server_tool_use blocks are only supported in assistant messages.");
        }
        const id = typeof chunk.id === "string" ? chunk.id.trim() : "";
        const name = typeof chunk.name === "string" ? chunk.name.trim() : "";
        if (!id || !name) {
          throw new Error("Anthropic server_tool_use blocks require non-empty id and name.");
        }
        if (chunk.input !== undefined && !isRecordObject(chunk.input)) {
          throw new Error("Anthropic server_tool_use input must be a JSON object in local compatibility mode.");
        }
        normalized.push({
          type: "server_tool_use",
          id,
          name,
          input: isRecordObject(chunk.input) ? chunk.input : {}
        });
        continue;
      }

      if (type === "web_search_tool_result") {
        if (role !== "assistant") {
          throw new Error("Anthropic web_search_tool_result blocks are only supported in assistant messages.");
        }
        const toolUseId = typeof chunk.tool_use_id === "string" ? chunk.tool_use_id.trim() : "";
        if (!toolUseId) {
          throw new Error("Anthropic web_search_tool_result blocks require a non-empty tool_use_id.");
        }
        normalized.push({
          type: "web_search_tool_result",
          tool_use_id: toolUseId,
          content: normalizeAnthropicWebSearchToolResultContent(chunk.content)
        });
        continue;
      }

      throw new Error(`Unsupported Anthropic content block type "${type}" in local compatibility mode.`);
    }

    return normalized;
  }

  function normalizeAnthropicThinkingConfig(thinking) {
    if (thinking === undefined) return undefined;
    if (!isRecordObject(thinking)) {
      throw new Error("Anthropic thinking must be a JSON object.");
    }

    const type = typeof thinking.type === "string" ? thinking.type.trim().toLowerCase() : "";
    if (type && type !== "enabled" && type !== "disabled" && type !== "adaptive") {
      throw new Error(`Unsupported Anthropic thinking.type value "${thinking.type}".`);
    }

    const normalized = {};
    if (type) {
      normalized.type = type;
    }

    if (thinking.budget_tokens !== undefined) {
      const budgetTokens = Number(thinking.budget_tokens);
      if (!Number.isFinite(budgetTokens) || budgetTokens < 0) {
        throw new Error("Anthropic thinking.budget_tokens must be a non-negative number.");
      }
      normalized.budget_tokens = Math.floor(budgetTokens);
      if (!normalized.type && normalized.budget_tokens > 0) {
        normalized.type = "enabled";
      }
    }

    return normalized;
  }

  function parseAnthropicNativeBody(rawBody, parsedBody = undefined) {
    const parsed = parseAnthropicJsonBody(rawBody, parsedBody);

    const messages = [];
    const sourceMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (const item of sourceMessages) {
      if (!isRecordObject(item)) {
        throw new Error("Anthropic messages entries must be JSON objects.");
      }
      const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "";
      if (!role) {
        throw new Error("Anthropic messages only support user and assistant roles.");
      }
      const content = parseAnthropicMessageContentBlocks(item.content, role);
      if (content.length === 0) continue;
      messages.push({ role, content });
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: [{ type: "text", text: " " }] });
    }

    const systemText = parseAnthropicSystemTextContent(parsed.system);
    return {
      model:
        typeof parsed.model === "string" && parsed.model.trim().length > 0
          ? parsed.model
          : config.anthropic.defaultModel,
      systemText,
      messages,
      tools: parsed.tools,
      tool_choice: parsed.tool_choice,
      metadata: isRecordObject(parsed.metadata) ? parsed.metadata : undefined,
      documents: Array.isArray(parsed.documents) ? parsed.documents : undefined,
      thinking: normalizeAnthropicThinkingConfig(parsed.thinking),
      stream: parsed.stream === true,
      max_tokens: parsed.max_tokens,
      temperature: parsed.temperature,
      top_p: parsed.top_p,
      stop: Array.isArray(parsed.stop_sequences)
        ? parsed.stop_sequences
        : typeof parsed.stop_sequence === "string"
          ? [parsed.stop_sequence]
          : undefined
    };
  }

  function normalizeAnthropicNativeTools(tools) {
    if (tools === undefined) return undefined;
    if (!Array.isArray(tools)) {
      throw new Error("Anthropic tools must be an array.");
    }

    const normalized = [];
    let nativeWebSearchTool = null;
    for (const tool of tools) {
      if (!isRecordObject(tool)) {
        throw new Error("Anthropic tool definitions must be JSON objects.");
      }

      const toolType = typeof tool.type === "string" ? tool.type.trim() : "";
      const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
      const isBuiltInWebSearch = /^web_search_\d{8}$/.test(toolType);
      const isCustomWebBrowseTool = toolName === "WebSearch" || toolName === "WebFetch";

      if (isBuiltInWebSearch || isCustomWebBrowseTool) {
        const normalizedToolName = typeof tool.name === "string" ? tool.name.trim() : "web_search";
        if (isBuiltInWebSearch && normalizedToolName && normalizedToolName !== "web_search") {
          throw new Error(`Unsupported Anthropic built-in web search tool name "${normalizedToolName}".`);
        }

        if (!nativeWebSearchTool) {
          nativeWebSearchTool = { type: "web_search" };
        }

        if (isBuiltInWebSearch) {
          const allowedDomains = Array.isArray(tool.allowed_domains)
            ? tool.allowed_domains.filter((value) => typeof value === "string" && value.trim().length > 0)
            : [];
          const blockedDomains = Array.isArray(tool.blocked_domains)
            ? tool.blocked_domains.filter((value) => typeof value === "string" && value.trim().length > 0)
            : [];
          if (allowedDomains.length > 0 || blockedDomains.length > 0) {
            nativeWebSearchTool.filters = {};
            if (allowedDomains.length > 0) nativeWebSearchTool.filters.allowed_domains = allowedDomains;
            if (blockedDomains.length > 0) nativeWebSearchTool.filters.blocked_domains = blockedDomains;
          }
          if (isRecordObject(tool.user_location)) {
            nativeWebSearchTool.user_location = tool.user_location;
          }
        }
        continue;
      }

      if (!toolName) {
        throw new Error("Anthropic tools require a non-empty name.");
      }

      const inputSchema =
        tool.input_schema === undefined
          ? { type: "object", properties: {} }
          : isRecordObject(tool.input_schema)
            ? tool.input_schema
            : null;
      if (!inputSchema) {
        throw new Error(`Anthropic tool "${toolName}" must provide an object input_schema.`);
      }

      normalized.push({
        type: "function",
        name: toolName,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: inputSchema
      });
    }

    if (nativeWebSearchTool) {
      normalized.unshift(nativeWebSearchTool);
    }
    return normalized;
  }

  function normalizeAnthropicNativeToolChoice(toolChoice, tools = []) {
    if (toolChoice === undefined) return undefined;
    const hasBuiltInWebSearch = Array.isArray(tools) && tools.some((tool) => tool?.type === "web_search");

    if (typeof toolChoice === "string") {
      if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
      if (toolChoice === "any") return "required";
      throw new Error(`Unsupported Anthropic tool_choice value "${toolChoice}".`);
    }

    if (!isRecordObject(toolChoice)) {
      throw new Error("Anthropic tool_choice must be a string or JSON object.");
    }

    const type = typeof toolChoice.type === "string" ? toolChoice.type : "";
    if (type === "auto" || type === "none") return type;
    if (type === "any") return "required";
    if (type === "tool" || type === "function") {
      const name = typeof toolChoice.name === "string" ? toolChoice.name.trim() : "";
      if (!name) {
        throw new Error("Anthropic tool_choice tool entries require a non-empty name.");
      }
      if (hasBuiltInWebSearch && (name === "web_search" || name === "WebSearch" || name === "WebFetch")) {
        return "required";
      }
      return { type: "function", name };
    }

    throw new Error(`Unsupported Anthropic tool_choice type "${type || "<empty>"}".`);
  }

  function normalizeAnthropicNativeExecutionConfig(parsed) {
    const normalized = {
      metadata: isRecordObject(parsed?.metadata) ? parsed.metadata : undefined
    };

    if (parsed?.temperature !== undefined) {
      const temperature = Number(parsed.temperature);
      if (!Number.isFinite(temperature)) {
        throw new Error("Anthropic temperature must be a finite number in local compatibility mode.");
      }
      if (Math.abs(temperature - 1) > 1e-9) {
        throw new Error(
          "Anthropic temperature is not supported in local compatibility mode with the configured Codex upstream."
        );
      }
    }

    if (parsed?.top_p !== undefined) {
      const topP = Number(parsed.top_p);
      if (!Number.isFinite(topP)) {
        throw new Error("Anthropic top_p must be a finite number in local compatibility mode.");
      }
      if (Math.abs(topP - 1) > 1e-9) {
        throw new Error(
          "Anthropic top_p is not supported in local compatibility mode with the configured Codex upstream."
        );
      }
    }

    if (Array.isArray(parsed?.documents) && parsed.documents.length > 0) {
      throw new Error("Anthropic documents are not yet supported in local compatibility mode.");
    }

    return normalized;
  }

  function getAnthropicNativeResponsesInclude(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    if (!tools.some((tool) => tool?.type === "web_search")) return undefined;
    return ["web_search_call.action.sources"];
  }

  function resolveAnthropicNativeReasoningSummary(thinkingConfig, modelId = null, contextValue = null) {
    if (!isRecordObject(thinkingConfig)) {
      return "detailed";
    }

    if (thinkingConfig.type === "disabled") {
      return undefined;
    }

    if (thinkingConfig.type === "adaptive") {
      const adaptiveEffort = resolveReasoningEffort("adaptive", contextValue, modelId);
      if (adaptiveEffort === "none") {
        return undefined;
      }
    }

    return "detailed";
  }

  function flushAnthropicTextBlocksToResponsesInput(target, role, textBlocks) {
    if (!Array.isArray(textBlocks) || textBlocks.length === 0) return;
    target.push({
      role,
      content: textBlocks.map((text) => ({
        type: role === "assistant" ? "output_text" : "input_text",
        text
      }))
    });
    textBlocks.length = 0;
  }

  function toResponsesInputFromAnthropicMessages(messages) {
    const converted = [];

    for (const message of Array.isArray(messages) ? messages : []) {
      if (!isRecordObject(message)) continue;
      const role = message.role === "assistant" ? "assistant" : "user";
      const textBlocks = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecordObject(block)) continue;
        if (block.type === "thinking") {
          continue;
        }
        if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : "";
          if (text.length > 0) textBlocks.push(text);
          continue;
        }

        if (block.type === "image") {
          flushAnthropicTextBlocksToResponsesInput(converted, role, textBlocks);
          converted.push({
            role,
            content: [buildResponsesInputImagePart(block)]
          });
          continue;
        }

        if (block.type === "server_tool_use") {
          const query = typeof block.input?.query === "string" ? block.input.query.trim() : "";
          const name =
            typeof block.name === "string" && block.name.trim().length > 0 ? block.name.trim() : "server_tool";
          textBlocks.push(query ? `[${name}] ${query}` : `[${name}]`);
          continue;
        }

        if (block.type === "web_search_tool_result") {
          const summary = summarizeAnthropicWebSearchToolResultContent(block.content);
          if (summary) textBlocks.push(summary);
          continue;
        }

        flushAnthropicTextBlocksToResponsesInput(converted, role, textBlocks);

        if (block.type === "tool_use") {
          converted.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(isRecordObject(block.input) ? block.input : {})
          });
          continue;
        }

        if (block.type === "tool_result") {
          converted.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: parseAnthropicToolResultOutput(block.content)
          });
        }
      }

      flushAnthropicTextBlocksToResponsesInput(converted, role, textBlocks);
    }

    if (converted.length > 0) return converted;
    return [{ role: "user", content: [{ type: "input_text", text: "" }] }];
  }

  function estimateTokenCountFromText(text) {
    const source = typeof text === "string" ? text : String(text || "");
    if (!source) return 0;
    return Math.max(1, Math.ceil(Buffer.byteLength(source, "utf8") / 4));
  }

  function estimateAnthropicCountTokens(rawBody, parsedBody = undefined) {
    const parsed = parseAnthropicJsonBody(rawBody, parsedBody);
    const segments = [];
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

    const systemText = parseAnthropicMessageText(parsed.system);
    if (systemText.trim().length > 0) {
      segments.push(systemText);
    }

    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      const role = item.role === "assistant" ? "assistant" : "user";
      const text = parseAnthropicMessageText(item.content);
      segments.push(`${role}\n${text}`);
    }

    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      segments.push(JSON.stringify(parsed.tools));
    }
    if (parsed.tool_choice && typeof parsed.tool_choice === "object") {
      segments.push(JSON.stringify(parsed.tool_choice));
    }
    if (parsed.metadata && typeof parsed.metadata === "object") {
      segments.push(JSON.stringify(parsed.metadata));
    }
    if (Array.isArray(parsed.documents) && parsed.documents.length > 0) {
      segments.push(JSON.stringify(parsed.documents));
    }

    const fallbackSerialized = JSON.stringify(parsed);
    const combined = segments.filter((part) => typeof part === "string" && part.length > 0).join("\n\n");
    let inputTokens = estimateTokenCountFromText(combined || fallbackSerialized);

    if (messages.length > 0) inputTokens += messages.length * 6;
    if (systemText.trim().length > 0) inputTokens += 4;
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) inputTokens += parsed.tools.length * 20;

    return Math.max(1, Number(inputTokens || 0));
  }

  function parseAnthropicToolUseInput(argumentsText) {
    const parsed = parseJsonLoose(typeof argumentsText === "string" ? argumentsText : "");
    return isRecordObject(parsed) ? parsed : {};
  }

  function removeEmptyAnthropicToolUseFields(input, preserveEmptyStringKeys = null) {
    if (!isRecordObject(input)) return {};
    const allowedEmptyStringKeys =
      preserveEmptyStringKeys instanceof Set ? preserveEmptyStringKeys : new Set(preserveEmptyStringKeys || []);
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") {
        if (value.length === 0 && allowedEmptyStringKeys.has(key)) {
          normalized[key] = value;
          continue;
        }
        if (value.trim().length === 0) continue;
        normalized[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        const compact = value.filter((entry) => {
          if (typeof entry === "string") return entry.trim().length > 0;
          return entry !== undefined && entry !== null;
        });
        if (compact.length === 0) continue;
        normalized[key] = compact;
        continue;
      }
      if (value !== undefined) {
        normalized[key] = value;
      }
    }
    return normalized;
  }

  function escapeRegExpLiteral(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function hasGlobMagic(value) {
    return /[*?[\]{}]/.test(String(value || ""));
  }

  function narrowLiteralGlobSuffix(basePath, pattern) {
    const resolvedBasePath = resolveLocalToolPath(basePath);
    const normalizedPattern = normalizePathSeparators(pattern);
    if (!resolvedBasePath || !normalizedPattern.startsWith("**/")) return null;

    const literalSuffixSegments = splitPortablePathSegments(normalizedPattern.slice(3));
    if (literalSuffixSegments.length === 0 || literalSuffixSegments.some((segment) => hasGlobMagic(segment))) {
      return null;
    }

    const directCandidate = path.win32.join(resolvedBasePath, ...literalSuffixSegments);
    try {
      if (fsSync.existsSync(directCandidate) && fsSync.statSync(directCandidate).isFile()) {
        return {
          path: path.win32.dirname(directCandidate),
          pattern: path.win32.basename(directCandidate)
        };
      }
    } catch {
      return null;
    }

    if (literalSuffixSegments.length < 2) return null;
    const directDirCandidate = path.win32.join(resolvedBasePath, ...literalSuffixSegments.slice(0, -1));
    try {
      if (fsSync.existsSync(directDirCandidate) && fsSync.statSync(directDirCandidate).isDirectory()) {
        return {
          path: directDirCandidate,
          pattern: literalSuffixSegments.at(-1)
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  function normalizeGlobToolUseInput(input) {
    const normalized = { ...input };
    const pattern = typeof normalized.pattern === "string" ? normalized.pattern.trim() : "";
    const pathValue = typeof normalized.path === "string" ? normalized.path.trim() : "";
    const userHome = typeof process.env.USERPROFILE === "string" ? process.env.USERPROFILE.trim() : "";
    if (!pattern || !pathValue || !userHome) return normalized;

    const narrowedLiteralTarget = narrowLiteralGlobSuffix(pathValue, pattern);
    if (narrowedLiteralTarget) {
      normalized.path = narrowedLiteralTarget.path;
      normalized.pattern = narrowedLiteralTarget.pattern;
      return normalized;
    }

    const isWindowsHomeSearch =
      normalizePathSeparators(resolveLocalToolPath(pathValue)).toLowerCase() === normalizePathSeparators(userHome).toLowerCase();
    const isPosixHomeAlias = ["/home", "/users", "/root"].includes(normalizePathSeparators(pathValue).toLowerCase());

    if (/^(?:\*\*\/)?\.codex\/\*\*$/i.test(normalizePathSeparators(pattern)) && (isWindowsHomeSearch || isPosixHomeAlias)) {
      normalized.path = path.win32.join(userHome, ".codex");
      normalized.pattern = "**/*";
      return normalized;
    }

    const appDataPrefixMatch = normalizePathSeparators(pattern).match(
      /^(AppData\/(?:Roaming|Local)(?:\/[^*?[\]{}]+)*)\/\*\*\/(.+)$/i
    );
    if (appDataPrefixMatch && (isWindowsHomeSearch || isPosixHomeAlias)) {
      normalized.path = path.win32.join(userHome, ...splitPortablePathSegments(appDataPrefixMatch[1]));
      normalized.pattern = `**/${appDataPrefixMatch[2]}`;
      return normalized;
    }

    if (isPosixHomeAlias && (/auth\.json$/i.test(pattern) || /\.codex/i.test(pattern))) {
      normalized.path = userHome;
    }

    return normalized;
  }

  function findWhitespaceNormalizedEditMatch(fileText, oldString) {
    const sourceText = typeof fileText === "string" ? fileText : "";
    const needle = typeof oldString === "string" ? oldString : "";
    if (!sourceText || !needle || sourceText.includes(needle)) return null;

    const trimmedNeedle = needle.trim();
    if (!trimmedNeedle) return null;
    const tokens = trimmedNeedle.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;

    const pattern = tokens.map((token) => escapeRegExpLiteral(token)).join("\\s+");
    const matcher = new RegExp(pattern, "g");
    let match;
    let matchedText = null;
    while ((match = matcher.exec(sourceText)) !== null) {
      if (matchedText !== null) {
        return null;
      }
      matchedText = match[0];
    }
    return matchedText;
  }

  function normalizeEditToolUseInput(input) {
    const normalized = { ...input };
    const filePath = typeof normalized.file_path === "string" ? resolveLocalToolPath(normalized.file_path) : "";
    const oldString = typeof normalized.old_string === "string" ? normalized.old_string : null;
    if (!filePath || oldString === null || oldString.length === 0) {
      return normalized;
    }

    let fileText;
    try {
      fileText = fsSync.readFileSync(filePath, "utf8");
    } catch {
      return normalized;
    }

    const alignedOldString = findWhitespaceNormalizedEditMatch(fileText, oldString);
    if (alignedOldString) {
      normalized.old_string = alignedOldString;
    }
    return normalized;
  }

  function normalizeAnthropicToolUseInput(name, input) {
    if (!isRecordObject(input)) return {};
    const normalized = removeEmptyAnthropicToolUseFields(input, ANTHROPIC_TOOL_USE_EMPTY_STRING_KEYS[name]);

    if (name === "Agent") {
      if (normalized.isolation === "worktree") {
        delete normalized.isolation;
      }
      return normalized;
    }

    if (name === "Glob") {
      return normalizeGlobToolUseInput(normalized);
    }

    if (name === "Edit") {
      return normalizeEditToolUseInput(normalized);
    }

    if (name !== "WebSearch") return normalized;

    const allowedDomains = Array.isArray(normalized.allowed_domains)
      ? normalized.allowed_domains.filter((value) => typeof value === "string" && value.trim().length > 0)
      : null;
    const blockedDomains = Array.isArray(normalized.blocked_domains)
      ? normalized.blocked_domains.filter((value) => typeof value === "string" && value.trim().length > 0)
      : null;

    if (allowedDomains) {
      if (allowedDomains.length > 0) normalized.allowed_domains = allowedDomains;
      else delete normalized.allowed_domains;
    }
    if (blockedDomains) {
      if (blockedDomains.length > 0) normalized.blocked_domains = blockedDomains;
      else delete normalized.blocked_domains;
    }

    if (Array.isArray(normalized.allowed_domains) && normalized.allowed_domains.length > 0) {
      delete normalized.blocked_domains;
    }

    return normalized;
  }

  function mapResponsesStatusToAnthropicStopReason(response) {
    const hasToolUse = Array.isArray(response?.output)
      ? response.output.some((item) => item?.type === "function_call")
      : false;
    if (hasToolUse) return "tool_use";
    const finishReason = mapResponsesStatusToChatFinishReason(response?.status);
    return mapOpenAIFinishReasonToAnthropic(finishReason);
  }

  function buildAnthropicOpaqueWebSearchToken(seed) {
    return Buffer.from(String(seed || crypto.randomUUID()), "utf8").toString("base64url");
  }

  function getAnthropicWebSearchResultTitle(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "");
      const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
      return `${host}${pathname}`;
    } catch {
      return String(url || "");
    }
  }

  function normalizeOpenAIWebSearchSourceUrl(source) {
    if (!isRecordObject(source)) return "";
    if (typeof source.url === "string" && source.url.trim().length > 0) return source.url.trim();
    if (typeof source.href === "string" && source.href.trim().length > 0) return source.href.trim();
    return "";
  }

  function buildAnthropicWebSearchResultLocation(url, title, citedText = "") {
    return {
      type: "web_search_result_location",
      url,
      title,
      encrypted_index: buildAnthropicOpaqueWebSearchToken(`${url}::${title}`),
      cited_text: truncate(String(citedText || url), 150)
    };
  }

  function buildAnthropicWebSearchResultsFromOpenAIAction(action) {
    const results = [];
    const seenUrls = new Set();
    for (const source of Array.isArray(action?.sources) ? action.sources : []) {
      const url = normalizeOpenAIWebSearchSourceUrl(source);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title =
        typeof source?.title === "string" && source.title.trim().length > 0
          ? source.title.trim()
          : getAnthropicWebSearchResultTitle(url);
      const result = {
        type: "web_search_result",
        url,
        title,
        encrypted_content: buildAnthropicOpaqueWebSearchToken(`${url}::content`)
      };
      if (typeof source?.page_age === "string" && source.page_age.trim().length > 0) {
        result.page_age = source.page_age.trim();
      }
      results.push(result);
    }
    return results;
  }

  function buildAnthropicTextBlockFromResponsesChunk(chunk, webSearchResults) {
    const text =
      typeof chunk?.text === "string"
        ? chunk.text
        : typeof chunk?.output_text === "string"
          ? chunk.output_text
          : "";
    if (!text) return null;

    const citations = [];
    const seenUrls = new Set();
    for (const result of Array.isArray(webSearchResults) ? webSearchResults : []) {
      const url = typeof result?.url === "string" ? result.url : "";
      if (!url || seenUrls.has(url) || !text.includes(url)) continue;
      seenUrls.add(url);
      citations.push(buildAnthropicWebSearchResultLocation(url, result.title || url, url));
    }

    if (citations.length === 0) {
      for (const result of Array.isArray(webSearchResults) ? webSearchResults : []) {
        const url = typeof result?.url === "string" ? result.url : "";
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        citations.push(buildAnthropicWebSearchResultLocation(url, result.title || url, url));
        if (citations.length >= 5) break;
      }
    }

    if (citations.length > 0) {
      return {
        type: "text",
        text,
        citations
      };
    }
    return {
      type: "text",
      text
    };
  }

  function buildAnthropicThinkingBlocksFromResponsesReasoningItem(item) {
    const blocks = [];
    for (const part of Array.isArray(item?.summary) ? item.summary : []) {
      if (!isRecordObject(part) || part.type !== "summary_text") continue;
      const thinking = typeof part.text === "string" ? part.text : "";
      if (!thinking) continue;
      blocks.push({
        type: "thinking",
        thinking
      });
    }
    return blocks;
  }

  function isResponsesFunctionCallItem(item) {
    return isRecordObject(item) && item.type === "function_call" && typeof item.name === "string" && item.name.length > 0;
  }

  function ensureAnthropicQueuedFunctionCallId(item) {
    return {
      ...item,
      call_id:
        typeof item.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : `call_${crypto.randomUUID().replace(/-/g, "")}`
    };
  }

  function planAnthropicFunctionCallEmission(output) {
    const items = Array.isArray(output) ? output : [];
    const functionCalls = items.filter(isResponsesFunctionCallItem).map((item) => ensureAnthropicQueuedFunctionCallId(item));
    if (functionCalls.length <= 1) {
      return {
        immediateOutput:
          functionCalls.length === 1
            ? items.map((item) => (isResponsesFunctionCallItem(item) ? functionCalls[0] : item))
            : items,
        emittedFunctionCallId: functionCalls[0]?.call_id || "",
        pendingFunctionCalls: []
      };
    }

    const immediateOutput = [];
    let emittedFunctionCall = null;
    for (const item of items) {
      if (isResponsesFunctionCallItem(item)) {
        if (!emittedFunctionCall) {
          emittedFunctionCall = functionCalls[0];
          immediateOutput.push(emittedFunctionCall);
        }
        continue;
      }
      if (!emittedFunctionCall) {
        immediateOutput.push(item);
      }
    }

    return {
      immediateOutput,
      emittedFunctionCallId: emittedFunctionCall?.call_id || "",
      pendingFunctionCalls: functionCalls.slice(1)
    };
  }

  function pruneAnthropicPendingToolBatches(now = Date.now()) {
    for (const [callId, entry] of anthropicPendingToolBatches.entries()) {
      if (!isRecordObject(entry)) {
        anthropicPendingToolBatches.delete(callId);
        continue;
      }
      const createdAt = Number(entry.createdAt || 0);
      if (!Number.isFinite(createdAt) || now - createdAt > ANTHROPIC_PENDING_TOOL_BATCH_TTL_MS) {
        anthropicPendingToolBatches.delete(callId);
      }
    }
  }

  function rememberAnthropicPendingToolBatch(triggerCallId, pendingFunctionCalls, model = "") {
    pruneAnthropicPendingToolBatches();
    const callId = typeof triggerCallId === "string" ? triggerCallId.trim() : "";
    const remaining = Array.isArray(pendingFunctionCalls)
      ? pendingFunctionCalls
          .filter((item) => isResponsesFunctionCallItem(item))
          .map((item) => ensureAnthropicQueuedFunctionCallId(item))
      : [];
    if (!callId || remaining.length === 0) return;
    anthropicPendingToolBatches.set(callId, {
      createdAt: Date.now(),
      model: typeof model === "string" ? model.trim() : "",
      pendingFunctionCalls: remaining
    });
  }

  function extractLatestAnthropicToolResultIds(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (!isRecordObject(message) || message.role !== "user") continue;
      const ids = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecordObject(block) || block.type !== "tool_result") continue;
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
        if (toolUseId) ids.push(toolUseId);
      }
      return ids;
    }
    return [];
  }

  function maybeBuildQueuedAnthropicToolMessage(messages, modelOverride = "") {
    pruneAnthropicPendingToolBatches();
    const toolResultIds = extractLatestAnthropicToolResultIds(messages);
    for (let index = toolResultIds.length - 1; index >= 0; index -= 1) {
      const triggerCallId = toolResultIds[index];
      const entry = anthropicPendingToolBatches.get(triggerCallId);
      if (!isRecordObject(entry)) continue;
      anthropicPendingToolBatches.delete(triggerCallId);
      const pendingCalls = Array.isArray(entry.pendingFunctionCalls) ? entry.pendingFunctionCalls : [];
      if (pendingCalls.length === 0) continue;
      const [nextCall, ...remainingCalls] = pendingCalls;
      if (!isResponsesFunctionCallItem(nextCall)) continue;
      if (remainingCalls.length > 0) {
        rememberAnthropicPendingToolBatch(nextCall.call_id, remainingCalls, entry.model || modelOverride);
      }
      return buildAnthropicMessageFromResponsesResponse(
        {
          id: `resp_local_${crypto.randomUUID().replace(/-/g, "")}`,
          model: entry.model || modelOverride,
          status: "completed",
          usage: {
            input_tokens: 0,
            output_tokens: 0
          },
          output: [ensureAnthropicQueuedFunctionCallId(nextCall)]
        },
        entry.model || modelOverride
      );
    }
    return null;
  }

  function buildAnthropicMessageFromResponsesResponse(response, modelOverride = "") {
    const output = Array.isArray(response?.output) ? response.output : [];
    const webSearchBlocksByItemId = new Map();
    const allWebSearchResults = [];
    let webSearchRequestCount = 0;
    for (const item of output) {
      if (!isRecordObject(item) || item.type !== "web_search_call") continue;
      if (!isRecordObject(item.action) || item.action.type !== "search") continue;
      const itemId =
        typeof item.id === "string" && item.id.length > 0
          ? item.id
          : `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`;
      const query =
        typeof item.action.query === "string" && item.action.query.trim().length > 0
          ? item.action.query.trim()
          : Array.isArray(item.action.queries) && typeof item.action.queries[0] === "string"
            ? item.action.queries[0]
            : "";
      const results = buildAnthropicWebSearchResultsFromOpenAIAction(item.action);
      webSearchBlocksByItemId.set(itemId, {
        toolUse: {
          type: "server_tool_use",
          id: itemId,
          name: "web_search",
          input: query ? { query } : {}
        },
        result: {
          type: "web_search_tool_result",
          tool_use_id: itemId,
          content:
            results.length > 0
              ? results
              : {
                  type: "web_search_tool_result_error",
                  error_code: "unavailable"
                }
        },
        results
      });
      if (results.length > 0) {
        allWebSearchResults.push(...results);
      }
      webSearchRequestCount += 1;
    }

    const content = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "reasoning") {
        content.push(...buildAnthropicThinkingBlocksFromResponsesReasoningItem(item));
        continue;
      }
      if (item.type === "message" && item.role === "assistant") {
        for (const chunk of Array.isArray(item.content) ? item.content : []) {
          if (chunk?.type === "output_text") {
            const textBlock = buildAnthropicTextBlockFromResponsesChunk(chunk, allWebSearchResults);
            if (textBlock) content.push(textBlock);
          }
        }
        continue;
      }

      if (item.type === "web_search_call") {
        const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : "";
        const mapped = itemId ? webSearchBlocksByItemId.get(itemId) : null;
        if (!mapped) continue;
        content.push(mapped.toolUse, mapped.result);
        continue;
      }

      if (item.type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "";
        if (!name) continue;
        const rawInput = parseAnthropicToolUseInput(item.arguments);
        content.push({
          type: "tool_use",
          id:
            typeof item.call_id === "string" && item.call_id.length > 0
              ? item.call_id
              : `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
          name,
          input: normalizeAnthropicToolUseInput(name, rawInput)
        });
      }
    }

    const usage = response?.usage || {};
    return {
      id:
        typeof response?.id === "string" && response.id.length > 0
          ? response.id
          : `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model:
        typeof modelOverride === "string" && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : response?.model || config.anthropic.defaultModel,
      content,
      stop_reason: mapResponsesStatusToAnthropicStopReason(response),
      stop_sequence: null,
      usage: {
        input_tokens: Number(usage.input_tokens || 0),
        output_tokens: Number(usage.output_tokens || 0),
        ...(webSearchRequestCount > 0
          ? {
              server_tool_use: {
                web_search_requests: webSearchRequestCount
              }
            }
          : {})
      }
    };
  }

  function renderAnthropicMessageSseEvents(message) {
    const events = [];
    events.push({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: message.id,
          type: "message",
          role: "assistant",
          model: message.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: Number(message?.usage?.input_tokens || 0),
            output_tokens: 0
          }
        }
      }
    });

    const contentBlocks = Array.isArray(message?.content) ? message.content : [];
    for (let index = 0; index < contentBlocks.length; index += 1) {
      const block = contentBlocks[index];
      if (!isRecordObject(block)) continue;

      if (block.type === "thinking") {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: {
              type: "thinking",
              thinking: ""
            }
          }
        });
        const thinking = typeof block.thinking === "string" ? block.thinking : "";
        if (thinking.length > 0) {
          events.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "thinking_delta",
                thinking
              }
            }
          });
        }
        if (typeof block.signature === "string" && block.signature.length > 0) {
          events.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "signature_delta",
                signature: block.signature
              }
            }
          });
        }
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index }
        });
        continue;
      }

      if (block.type === "tool_use") {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {}
            }
          }
        });
        const partialJson = JSON.stringify(isRecordObject(block.input) ? block.input : {});
        if (partialJson.length > 0) {
          events.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: partialJson
              }
            }
          });
        }
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index }
        });
        continue;
      }

      if (block.type === "server_tool_use") {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: {
              type: "server_tool_use",
              id: block.id,
              name: block.name
            }
          }
        });
        const partialJson = JSON.stringify(isRecordObject(block.input) ? block.input : {});
        if (partialJson.length > 0) {
          events.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: partialJson
              }
            }
          });
        }
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index }
        });
        continue;
      }

      if (block.type === "web_search_tool_result") {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content
            }
          }
        });
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index }
        });
        continue;
      }

      const text = typeof block.text === "string" ? block.text : "";
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: {
            type: "text",
            text: "",
            ...(Array.isArray(block.citations) && block.citations.length > 0 ? { citations: block.citations } : {})
          }
        }
      });
      if (text.length > 0) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: {
              type: "text_delta",
              text
            }
          }
        });
      }
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index }
      });
    }

    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: message.stop_reason,
          stop_sequence: message.stop_sequence
        },
        usage: {
          output_tokens: Number(message?.usage?.output_tokens || 0),
          ...(message?.usage?.server_tool_use ? { server_tool_use: message.usage.server_tool_use } : {})
        }
      }
    });
    events.push({
      event: "message_stop",
      data: { type: "message_stop" }
    });
    return events;
  }

  function sendAnthropicMessageAsSse(res, message) {
    const session = createAnthropicPendingSseSession(res, {
      messageId: typeof message?.id === "string" && message.id.trim().length > 0 ? message.id : undefined,
      model:
        typeof message?.model === "string" && message.model.trim().length > 0
          ? message.model
          : config.anthropic.defaultModel,
      heartbeatMs: 0
    });

    try {
      session.finalize(message);
    } finally {
      session.cleanup();
    }
  }

  function createAnthropicPendingSseSession(
    res,
    {
      messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      model = config.anthropic.defaultModel,
      heartbeatMs = 15000
    } = {}
  ) {
    let started = false;
    const messageStartPayload = {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      }
    };
    const session = createSseSession(res, {
      heartbeatMs,
      heartbeatChunk: `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`,
      prepareResponse() {
        res.status(200);
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
      }
    });
    session.startHeartbeat();

    const rawWriteEvent = (eventName, data) => {
      return session.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ensureStarted = () => {
      if (started) return true;
      const wrote = rawWriteEvent("message_start", messageStartPayload);
      if (wrote) started = true;
      return wrote;
    };

    const writeEvent = (eventName, data, { skipStart = false } = {}) => {
      if (!skipStart && !ensureStarted()) return false;
      return rawWriteEvent(eventName, data);
    };

    return {
      attachStream(nextReader, nextUpstream) {
        session.attachReader(nextReader);
        session.setUpstream(nextUpstream);
      },
      hasStarted() {
        return started;
      },
      isClosed() {
        return session.isClosed();
      },
      writeEvent,
      closeBlock(index) {
        return writeEvent("content_block_stop", {
          type: "content_block_stop",
          index
        });
      },
      finish({ stopReason = "end_turn", stopSequence = null, usage = null } = {}) {
        writeEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: stopSequence
          },
          usage: {
            output_tokens: Number(usage?.output_tokens || 0),
            ...(usage?.server_tool_use ? { server_tool_use: usage.server_tool_use } : {})
          }
        });
        writeEvent("message_stop", { type: "message_stop" });
        session.end();
      },
      finalize(message) {
        const finalMessage =
          message && typeof message === "object"
            ? {
                ...message,
                id:
                  typeof message.id === "string" && message.id.trim().length > 0
                    ? message.id
                    : messageId,
                model:
                  typeof message.model === "string" && message.model.trim().length > 0
                    ? message.model
                    : model
              }
            : {
                id: messageId,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0
                }
              };

        for (const frame of renderAnthropicMessageSseEvents(finalMessage)) {
          if (frame.event === "message_start") continue;
          if (!writeEvent(frame.event, frame.data)) break;
        }
        session.end();
      },
      sendError(errorType, message) {
        if (!ensureStarted()) {
          session.end();
          return;
        }
        rawWriteEvent("error", {
          type: "error",
          error: {
            type:
              typeof errorType === "string" && errorType.trim().length > 0
                ? errorType.trim()
                : "api_error",
            message: String(message || "Anthropic stream failed.")
          }
        });
        session.end();
      },
      cleanup() {
        session.cleanup();
      }
    };
  }

  async function pipeCodexSseAsAnthropicMessages(upstream, res, { model = config.anthropic.defaultModel } = {}) {
    if (!upstream?.body) throw new Error("No upstream SSE body.");

    const reader = upstream.body.getReader();
    const session = createAnthropicPendingSseSession(res, { model });
    session.attachStream(reader, upstream);
    const idleTimeoutMs = Math.max(0, Number(config?.upstreamStreamIdleTimeoutMs || 0));
    let nextIndex = 0;
    let finalResponse = null;
    let webSearchRequestCount = 0;

    const textBlocksByItemId = new Map();
    const reasoningBlocksByKey = new Map();
    const toolCallBlocksByItemId = new Map();
    const openBlockIndices = new Set();

    const allocateIndex = () => {
      const index = nextIndex;
      nextIndex += 1;
      return index;
    };

    const startBlock = (index, contentBlock) => {
      const wrote = session.writeEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: contentBlock
      });
      if (wrote) openBlockIndices.add(index);
      return wrote;
    };

    const closeBlock = (index) => {
      if (!openBlockIndices.has(index)) return;
      openBlockIndices.delete(index);
      session.closeBlock(index);
    };

    const closeAllOpenBlocks = () => {
      for (const index of [...openBlockIndices].sort((a, b) => a - b)) {
        closeBlock(index);
      }
    };

    const ensureTextBlock = (itemId = "") => {
      const key = itemId || `text_${textBlocksByItemId.size}`;
      if (textBlocksByItemId.has(key)) return textBlocksByItemId.get(key);
      const state = {
        index: allocateIndex(),
        emittedLength: 0
      };
      if (!startBlock(state.index, { type: "text", text: "" })) return null;
      textBlocksByItemId.set(key, state);
      return state;
    };

    const ensureReasoningBlock = (itemId = "", summaryIndex = 0) => {
      const key = `${itemId}:${summaryIndex}`;
      if (reasoningBlocksByKey.has(key)) return reasoningBlocksByKey.get(key);
      const state = {
        index: allocateIndex(),
        emittedLength: 0
      };
      if (!startBlock(state.index, { type: "thinking", thinking: "" })) return null;
      reasoningBlocksByKey.set(key, state);
      return state;
    };

    const appendDeltaToBlock = (state, deltaType, nextText) => {
      if (!state || typeof nextText !== "string" || nextText.length === 0) return;
      const wrote = session.writeEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.index,
        delta: {
          type: deltaType,
          [deltaType === "text_delta" ? "text" : "thinking"]: nextText
        }
      });
      if (wrote) {
        state.emittedLength += nextText.length;
      }
    };

    const appendTextDelta = (itemId, deltaText) => {
      const state = ensureTextBlock(itemId);
      appendDeltaToBlock(state, "text_delta", deltaText);
    };

    const finalizeTextBlock = (itemId, doneText) => {
      const key = itemId || `text_${textBlocksByItemId.size}`;
      const state = textBlocksByItemId.get(key) || ensureTextBlock(itemId);
      if (!state) return;
      if (typeof doneText === "string" && doneText.length > state.emittedLength) {
        appendDeltaToBlock(state, "text_delta", doneText.slice(state.emittedLength));
      }
      closeBlock(state.index);
    };

    const appendReasoningDelta = (itemId, summaryIndex, deltaText) => {
      const state = ensureReasoningBlock(itemId, summaryIndex);
      appendDeltaToBlock(state, "thinking_delta", deltaText);
    };

    const finalizeReasoningBlock = (itemId, summaryIndex, doneText) => {
      const key = `${itemId}:${summaryIndex}`;
      const state = reasoningBlocksByKey.get(key) || ensureReasoningBlock(itemId, summaryIndex);
      if (!state) return;
      if (typeof doneText === "string" && doneText.length > state.emittedLength) {
        appendDeltaToBlock(state, "thinking_delta", doneText.slice(state.emittedLength));
      }
      closeBlock(state.index);
    };

    const startToolUseBlock = (item) => {
      const itemId = typeof item?.id === "string" && item.id.length > 0 ? item.id : `tool_${allocateIndex()}`;
      if (toolCallBlocksByItemId.has(itemId)) return toolCallBlocksByItemId.get(itemId);

      const callId =
        typeof item?.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
      const name = typeof item?.name === "string" ? item.name : "tool";
      const state = {
        itemId,
        callId,
        name,
        index: allocateIndex(),
        emittedLength: 0
      };
      if (
        !startBlock(state.index, {
          type: "tool_use",
          id: state.callId,
          name: state.name,
          input: {}
        })
      ) {
        return null;
      }
      toolCallBlocksByItemId.set(itemId, state);
      return state;
    };

    const appendToolInputDelta = (itemId, deltaText) => {
      const state = toolCallBlocksByItemId.get(itemId);
      if (!state || typeof deltaText !== "string" || deltaText.length === 0) return;
      const wrote = session.writeEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.index,
        delta: {
          type: "input_json_delta",
          partial_json: deltaText
        }
      });
      if (wrote) {
        state.emittedLength += deltaText.length;
      }
    };

    const finalizeToolInput = (itemId, fullArguments) => {
      const state = toolCallBlocksByItemId.get(itemId);
      if (!state) return;
      if (typeof fullArguments === "string" && fullArguments.length > state.emittedLength) {
        appendToolInputDelta(itemId, fullArguments.slice(state.emittedLength));
      }
      closeBlock(state.index);
    };

    const emitWebSearchCall = (item) => {
      const action = item?.action;
      const query =
        typeof action?.query === "string" && action.query.trim().length > 0
          ? action.query.trim()
          : Array.isArray(action?.queries) && typeof action.queries[0] === "string"
            ? action.queries[0]
            : "";
      const blockId =
        typeof item?.id === "string" && item.id.length > 0
          ? item.id
          : `srvtoolu_${crypto.randomUUID().replace(/-/g, "")}`;
      const index = allocateIndex();
      if (
        !startBlock(index, {
          type: "server_tool_use",
          id: blockId,
          name: "web_search"
        })
      ) {
        return;
      }
      if (query) {
        session.writeEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ query })
          }
        });
      }
      closeBlock(index);
      webSearchRequestCount += 1;
    };

    const handleSseBlock = (block) => {
      const event = parseSseJsonEventBlock(block);
      if (!event) return;

      if (event.type === "response.output_text.delta") {
        appendTextDelta(typeof event.item_id === "string" ? event.item_id : "", typeof event.delta === "string" ? event.delta : "");
        return;
      }

      if (event.type === "response.output_text.done") {
        finalizeTextBlock(
          typeof event.item_id === "string" ? event.item_id : "",
          typeof event.text === "string" ? event.text : ""
        );
        return;
      }

      if (event.type === "response.reasoning_summary_text.delta") {
        appendReasoningDelta(
          typeof event.item_id === "string" ? event.item_id : "",
          Number.isInteger(event.summary_index) ? event.summary_index : 0,
          typeof event.delta === "string" ? event.delta : ""
        );
        return;
      }

      if (event.type === "response.reasoning_summary_part.added") {
        appendReasoningDelta(
          typeof event.item_id === "string" ? event.item_id : "",
          Number.isInteger(event.summary_index) ? event.summary_index : 0,
          typeof event.part?.text === "string" ? event.part.text : ""
        );
        return;
      }

      if (
        event.type === "response.reasoning_summary_text.done" ||
        event.type === "response.reasoning_summary_part.done"
      ) {
        finalizeReasoningBlock(
          typeof event.item_id === "string" ? event.item_id : "",
          Number.isInteger(event.summary_index) ? event.summary_index : 0,
          typeof event.text === "string"
            ? event.text
            : typeof event.part?.text === "string"
              ? event.part.text
              : ""
        );
        return;
      }

      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        startToolUseBlock(event.item);
        return;
      }

      if (event.type === "response.function_call_arguments.delta") {
        appendToolInputDelta(
          typeof event.item_id === "string" ? event.item_id : "",
          typeof event.delta === "string" ? event.delta : ""
        );
        return;
      }

      if (event.type === "response.function_call_arguments.done") {
        finalizeToolInput(
          typeof event.item_id === "string" ? event.item_id : "",
          typeof event.arguments === "string" ? event.arguments : ""
        );
        return;
      }

      if (event.type === "response.output_item.added" && event.item?.type === "web_search_call") {
        emitWebSearchCall(event.item);
        return;
      }

      if (event.type === "response.failed") {
        const err = new Error(event.response?.error?.message || "Codex response failed.");
        err.statusCode = Number(event.response?.status_code || event.status_code || 502) || 502;
        throw err;
      }

      if (event.type === "response.completed" || event.type === "response.done") {
        finalResponse = event.response && typeof event.response === "object" ? event.response : finalResponse;
      }
    };

    try {
      await consumeSseBlocks(upstream, {
        reader,
        timeoutMs: idleTimeoutMs,
        isClosed: () => session.isClosed(),
        onBlock: handleSseBlock
      });

      if (!session.isClosed() && !finalResponse) {
        throw new Error("Upstream SSE ended before response.completed event.");
      }

      const allFunctionCalls = Array.isArray(finalResponse?.output)
        ? finalResponse.output.filter(isResponsesFunctionCallItem).map((item) => ensureAnthropicQueuedFunctionCallId(item))
        : [];
      const emittedFunctionCallId = allFunctionCalls[0]?.call_id || "";
      const pendingFunctionCalls = allFunctionCalls.slice(1);
      const usage = finalResponse?.usage || {};
      closeAllOpenBlocks();
      session.finish({
        stopReason: mapResponsesStatusToAnthropicStopReason(finalResponse),
        usage: {
          output_tokens: Number(usage.output_tokens || 0),
          ...(webSearchRequestCount > 0
            ? {
                server_tool_use: {
                  web_search_requests: webSearchRequestCount
                }
              }
            : {})
        }
      });

      return {
        usage: {
          prompt_tokens: Number(usage.input_tokens || 0),
          completion_tokens: Number(usage.output_tokens || 0),
          total_tokens: Number(usage.total_tokens || 0)
        },
        emittedFunctionCallId,
        pendingFunctionCalls
      };
    } catch (err) {
      if (session.hasStarted() && !session.isClosed()) {
        session.sendError(mapHttpStatusToAnthropicErrorType(Number(err?.statusCode || 502) || 502), err.message);
      }
      throw err;
    } finally {
      session.cleanup();
      reader.releaseLock?.();
    }
  }

  async function handleAnthropicNativeCompat(req, res) {
    res.locals.protocolType = "anthropic-v1-native";
    const incoming = new URL(req.originalUrl, "http://localhost");
    if (!isAnthropicNativeMessagesPath(incoming.pathname)) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "In local Anthropic compatibility mode, only POST /v1/messages and POST /v1/messages/count_tokens are supported."
        }
      });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Use POST ${incoming.pathname}.`
        }
      });
      return;
    }

    if (incoming.pathname === "/v1/messages/count_tokens") {
      let inputTokens;
      try {
        const rawBody = await readRawBody(req);
        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch {
          parsedBody = undefined;
        }
        inputTokens = estimateAnthropicCountTokens(rawBody, parsedBody);
      } catch (err) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: err.message
          }
        });
        return;
      }

      const usage = {
        prompt_tokens: Number(inputTokens || 0),
        completion_tokens: 0,
        total_tokens: Number(inputTokens || 0)
      };
      res.locals.tokenUsage = usage;
      res.status(200).json({
        input_tokens: Number(inputTokens || 0)
      });
      return;
    }

    let parsedReq;
    try {
      const rawBody = await readRawBody(req);
      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
      parsedReq = parseAnthropicNativeBody(rawBody, parsedBody);
    } catch (err) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: err.message
        }
      });
      return;
    }

    const codexRoute = resolveCodexCompatibleRoute(parsedReq.model || config.anthropic.defaultModel);
    res.locals.modelRoute = codexRoute;

    const queuedToolMessage = maybeBuildQueuedAnthropicToolMessage(parsedReq.messages, parsedReq.model || config.anthropic.defaultModel);
    if (queuedToolMessage) {
      res.locals.tokenUsage = {
        prompt_tokens: Number(queuedToolMessage?.usage?.input_tokens || 0),
        completion_tokens: Number(queuedToolMessage?.usage?.output_tokens || 0),
        total_tokens:
          Number(queuedToolMessage?.usage?.input_tokens || 0) +
          Number(queuedToolMessage?.usage?.output_tokens || 0)
      };
      if (parsedReq.stream === true) {
        sendAnthropicMessageAsSse(res, queuedToolMessage);
        return;
      }
      res.status(200).json(queuedToolMessage);
      return;
    }

    if (parsedReq.stream === true) {
      let streamSession;
      try {
        const input = toResponsesInputFromAnthropicMessages(parsedReq.messages);
        const tools = normalizeAnthropicNativeTools(parsedReq.tools);
        const toolChoice = normalizeAnthropicNativeToolChoice(parsedReq.tool_choice, tools);
        const include = getAnthropicNativeResponsesInclude(tools);
        const hasBuiltInWebSearch = Array.isArray(tools) && tools.some((tool) => tool?.type === "web_search");
        const resolvedToolChoice = toolChoice === undefined && hasBuiltInWebSearch ? "auto" : toolChoice;
        const resolvedInstructions =
          typeof parsedReq.systemText === "string" && parsedReq.systemText.trim().length > 0
            ? parsedReq.systemText
            : config.codex.defaultInstructions;
        const reasoningSummary = resolveAnthropicNativeReasoningSummary(parsedReq.thinking, codexRoute.mappedModel, {
          input,
          tools,
          tool_choice: resolvedToolChoice,
          instructions: resolvedInstructions
        });

        streamSession = await openCodexResponsesStreamViaOAuth({
          model: parsedReq.model,
          requestedModel: codexRoute.requestedModel,
          upstreamModel: codexRoute.mappedModel,
          instructions: resolvedInstructions,
          input,
          stop: parsedReq.stop,
          tools,
          toolChoice: resolvedToolChoice,
          include,
          reasoningSummary
        });
        res.locals.authAccountId = streamSession.authAccountId || null;

        if (streamSession.upstream?.body) {
          const streamResult = await pipeCodexSseAsAnthropicMessages(streamSession.upstream, res, {
            model: codexRoute.requestedModel || parsedReq.model || config.anthropic.defaultModel
          });
          if (streamResult?.pendingFunctionCalls?.length > 0) {
            rememberAnthropicPendingToolBatch(
              streamResult.emittedFunctionCallId,
              streamResult.pendingFunctionCalls,
              codexRoute.requestedModel || parsedReq.model || config.anthropic.defaultModel
            );
          }
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
            type: "error",
            error: {
              type: mapHttpStatusToAnthropicErrorType(statusCode),
              message: err.message
            }
          });
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      } finally {
        streamSession?.release?.();
      }
    }

    let result;
    try {
      const input = toResponsesInputFromAnthropicMessages(parsedReq.messages);
      const tools = normalizeAnthropicNativeTools(parsedReq.tools);
      const toolChoice = normalizeAnthropicNativeToolChoice(parsedReq.tool_choice, tools);
      const include = getAnthropicNativeResponsesInclude(tools);
      const hasBuiltInWebSearch = Array.isArray(tools) && tools.some((tool) => tool?.type === "web_search");
      const resolvedToolChoice = toolChoice === undefined && hasBuiltInWebSearch ? "auto" : toolChoice;
      const resolvedInstructions =
        typeof parsedReq.systemText === "string" && parsedReq.systemText.trim().length > 0
          ? parsedReq.systemText
          : config.codex.defaultInstructions;
      const reasoningSummary = resolveAnthropicNativeReasoningSummary(parsedReq.thinking, codexRoute.mappedModel, {
        input,
        tools,
        tool_choice: resolvedToolChoice,
        instructions: resolvedInstructions
      });
      result = await executeCodexResponsesViaOAuth({
        model: parsedReq.model,
        requestedModel: codexRoute.requestedModel,
        upstreamModel: codexRoute.mappedModel,
        instructions: resolvedInstructions,
        input,
        stop: parsedReq.stop,
        tools,
        toolChoice: resolvedToolChoice,
        include,
        reasoningSummary
      });
    } catch (err) {
      const statusCode = resolveCompatErrorStatusCode(err, 502);
      res.status(statusCode).json({
        type: "error",
        error: {
          type: mapHttpStatusToAnthropicErrorType(statusCode),
          message: err.message
        }
      });
      return;
    }

    const emissionPlan = planAnthropicFunctionCallEmission(result.completed?.output);
    const message = buildAnthropicMessageFromResponsesResponse(
      {
        ...result.completed,
        output: emissionPlan.immediateOutput
      },
      result.model
    );
    if (emissionPlan.pendingFunctionCalls.length > 0) {
      rememberAnthropicPendingToolBatch(emissionPlan.emittedFunctionCallId, emissionPlan.pendingFunctionCalls, message.model);
    }
    res.locals.authAccountId = result.authAccountId || null;
    res.locals.tokenUsage = {
      prompt_tokens: Number(message?.usage?.input_tokens || 0),
      completion_tokens: Number(message?.usage?.output_tokens || 0),
      total_tokens: Number(message?.usage?.input_tokens || 0) + Number(message?.usage?.output_tokens || 0)
    };
    res.status(200).json(message);
  }

  function clearAnthropicPendingToolBatches() {
    anthropicPendingToolBatches.clear();
  }

  return {
    isAnthropicNativeMessagesPath,
    normalizeCherryAnthropicAgentOriginalUrl,
    parseAnthropicNativeBody,
    normalizeAnthropicNativeTools,
    normalizeAnthropicNativeToolChoice,
    normalizeAnthropicNativeExecutionConfig,
    resolveAnthropicNativeReasoningSummary,
    normalizeAnthropicToolUseInput,
    toResponsesInputFromAnthropicMessages,
    planAnthropicFunctionCallEmission,
    rememberAnthropicPendingToolBatch,
    maybeBuildQueuedAnthropicToolMessage,
    clearAnthropicPendingToolBatches,
    buildAnthropicMessageFromResponsesResponse,
    renderAnthropicMessageSseEvents,
    estimateAnthropicCountTokens,
    handleAnthropicNativeCompat
  };
}
