import crypto from "node:crypto";

function isRecordObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createOpenAIResponsesCompatHelpers(context) {
  const { config, parseJsonLoose } = context;

  function normalizeTokenUsage(usage) {
    if (!usage || typeof usage !== "object") return null;

    const inputTokens = Number(
      usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens
    );
    const outputTokens = Number(
      usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens
    );
    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);

    const hasInput = Number.isFinite(inputTokens);
    const hasOutput = Number.isFinite(outputTokens);
    const hasTotal = Number.isFinite(totalTokens);

    if (!hasInput && !hasOutput && !hasTotal) return null;
    const resolvedTotalTokens =
      hasTotal ? totalTokens : (hasInput ? inputTokens : 0) + (hasOutput ? outputTokens : 0);

    return {
      inputTokens: hasInput ? inputTokens : null,
      outputTokens: hasOutput ? outputTokens : null,
      totalTokens: Number.isFinite(resolvedTotalTokens) ? resolvedTotalTokens : null
    };
  }

  function mergeNormalizedTokenUsage(current, next) {
    const currentUsage = normalizeTokenUsage(current);
    const nextUsage = normalizeTokenUsage(next);
    if (!currentUsage) return nextUsage;
    if (!nextUsage) return currentUsage;

    return normalizeTokenUsage({
      inputTokens: nextUsage.inputTokens ?? currentUsage.inputTokens,
      outputTokens: nextUsage.outputTokens ?? currentUsage.outputTokens,
      totalTokens: nextUsage.totalTokens ?? currentUsage.totalTokens
    });
  }

  function toChatUsageFromNormalizedTokenUsage(usage) {
    const normalized = normalizeTokenUsage(usage);
    if (!normalized) return null;
    return {
      prompt_tokens: Number(normalized.inputTokens || 0),
      completion_tokens: Number(normalized.outputTokens || 0),
      total_tokens: Number(normalized.totalTokens || 0)
    };
  }

  function mapCodexUsageToChatUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    return {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    };
  }

  function normalizeResponsesUsageObject(usage) {
    const normalized = normalizeTokenUsage(usage);
    if (!normalized) return undefined;
    return {
      input_tokens: Number(normalized.inputTokens || 0),
      output_tokens: Number(normalized.outputTokens || 0),
      total_tokens: Number(normalized.totalTokens || 0)
    };
  }

  function normalizeResponsesReasoningItem(item) {
    if (!isRecordObject(item) || item.type !== "reasoning") return null;
    const summary = [];
    for (const part of Array.isArray(item.summary) ? item.summary : []) {
      if (!isRecordObject(part) || part.type !== "summary_text") continue;
      summary.push({
        type: "summary_text",
        text: typeof part.text === "string" ? part.text : ""
      });
    }
    return {
      ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
      type: "reasoning",
      summary
    };
  }

  function normalizeResponsesOutputMessageItem(item) {
    if (!isRecordObject(item) || item.type !== "message" || item.role !== "assistant") return null;
    const content = [];
    for (const chunk of Array.isArray(item.content) ? item.content : []) {
      if (!isRecordObject(chunk)) continue;
      const text =
        typeof chunk.text === "string"
          ? chunk.text
          : typeof chunk.output_text === "string"
            ? chunk.output_text
            : "";
      if (!text) continue;
      const normalizedChunk = {
        type: "output_text",
        text
      };
      if (Array.isArray(chunk.annotations) && chunk.annotations.length > 0) {
        normalizedChunk.annotations = chunk.annotations;
      }
      content.push(normalizedChunk);
    }
    return {
      ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
      type: "message",
      role: "assistant",
      content
    };
  }

  function normalizeResponsesFunctionCallItem(item) {
    if (!isRecordObject(item) || item.type !== "function_call") return null;
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) return null;
    const rawArguments =
      typeof item.arguments === "string"
        ? item.arguments
        : isRecordObject(item.arguments) || Array.isArray(item.arguments)
          ? JSON.stringify(item.arguments)
          : "";
    return {
      ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
      ...(typeof item.call_id === "string" && item.call_id.length > 0 ? { call_id: item.call_id } : {}),
      type: "function_call",
      name,
      arguments: rawArguments
    };
  }

  function normalizeResponsesWebSearchCallItem(item) {
    if (!isRecordObject(item) || item.type !== "web_search_call") return null;
    return {
      ...(typeof item.id === "string" && item.id.length > 0 ? { id: item.id } : {}),
      type: "web_search_call",
      ...(typeof item.status === "string" && item.status.length > 0 ? { status: item.status } : {}),
      ...(isRecordObject(item.action) ? { action: item.action } : {})
    };
  }

  function buildSyntheticCompletedResponseFromSseState(state) {
    const output = Array.isArray(state.output) ? state.output.filter(Boolean) : [];
    if (output.length === 0) return null;
    return {
      id:
        typeof state.responseId === "string" && state.responseId.length > 0
          ? state.responseId
          : `resp_${crypto.randomUUID().replace(/-/g, "")}`,
      model:
        typeof state.responseModel === "string" && state.responseModel.length > 0
          ? state.responseModel
          : config.codex.defaultModel,
      status:
        typeof state.responseStatus === "string" && state.responseStatus.length > 0
          ? state.responseStatus
          : "completed",
      output,
      ...(state.usage ? { usage: normalizeResponsesUsageObject(state.usage) } : {})
    };
  }

  function parseResponsesResultFromSse(rawText) {
    if (typeof rawText !== "string" || rawText.length === 0) {
      return { completed: null, failed: null };
    }

    const state = {
      completed: null,
      failed: null,
      usage: null,
      responseId: "",
      responseModel: "",
      responseStatus: "",
      output: [],
      outputIndexById: new Map(),
      functionCallByItemId: new Map(),
      reasoningByItemId: new Map()
    };

    const upsertOutputItem = (item) => {
      if (!item) return null;
      const itemId = typeof item.id === "string" ? item.id : "";
      if (itemId && state.outputIndexById.has(itemId)) {
        state.output[state.outputIndexById.get(itemId)] = item;
        return item;
      }
      state.output.push(item);
      if (itemId) state.outputIndexById.set(itemId, state.output.length - 1);
      return item;
    };

    const ensureAssistantMessage = (itemId = "") => {
      if (itemId && state.outputIndexById.has(itemId)) {
        const existing = state.output[state.outputIndexById.get(itemId)];
        if (existing?.type === "message" && existing.role === "assistant") return existing;
      }
      return upsertOutputItem({ ...(itemId ? { id: itemId } : {}), type: "message", role: "assistant", content: [] });
    };

    const ensureReasoningItem = (itemId = "") => {
      if (itemId && state.outputIndexById.has(itemId)) {
        const existing = state.output[state.outputIndexById.get(itemId)];
        if (existing?.type === "reasoning") {
          if (!Array.isArray(existing.summary)) existing.summary = [];
          return existing;
        }
      }
      const item = upsertOutputItem({ ...(itemId ? { id: itemId } : {}), type: "reasoning", summary: [] });
      if (itemId) state.reasoningByItemId.set(itemId, item);
      return item;
    };

    const ensureReasoningSummaryPart = (itemId, summaryIndex = 0) => {
      const item = ensureReasoningItem(itemId);
      while (item.summary.length <= summaryIndex) {
        item.summary.push({ type: "summary_text", text: "" });
      }
      const existing = item.summary[summaryIndex];
      if (!isRecordObject(existing) || existing.type !== "summary_text") {
        item.summary[summaryIndex] = { type: "summary_text", text: "" };
      }
      return item.summary[summaryIndex];
    };

    const appendAssistantText = (itemId, text) => {
      if (typeof text !== "string" || text.length === 0) return;
      const message = ensureAssistantMessage(itemId);
      if (!Array.isArray(message.content)) message.content = [];
      const lastChunk = message.content[message.content.length - 1];
      if (lastChunk?.type === "output_text" && typeof lastChunk.text === "string") {
        lastChunk.text += text;
        return;
      }
      message.content.push({ type: "output_text", text });
    };

    for (const line of rawText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      state.usage = mergeNormalizedTokenUsage(
        state.usage,
        parsed?.usage || parsed?.response?.usage || parsed?.message?.usage || null
      );
      if (typeof parsed?.response?.id === "string" && parsed.response.id.length > 0) state.responseId = parsed.response.id;
      if (typeof parsed?.response?.model === "string" && parsed.response.model.length > 0) state.responseModel = parsed.response.model;
      if (typeof parsed?.response?.status === "string" && parsed.response.status.length > 0) state.responseStatus = parsed.response.status;

      if ((parsed.type === "response.completed" || parsed.type === "response.done") && parsed.response && typeof parsed.response === "object") {
        state.completed = parsed.response;
        continue;
      }

      if (parsed.type === "response.failed") {
        const message =
          parsed?.response?.error?.message ||
          parsed?.error?.message ||
          parsed?.message ||
          "Upstream response failed.";
        state.failed = {
          message: String(message || "Upstream response failed."),
          statusCode: Number(parsed?.response?.status_code || parsed?.status_code || 502) || 502
        };
        continue;
      }

      if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
        const reasoningItem = normalizeResponsesReasoningItem(parsed.item);
        if (reasoningItem) {
          upsertOutputItem(reasoningItem);
          if (typeof parsed?.item?.id === "string" && parsed.item.id.length > 0) {
            state.reasoningByItemId.set(parsed.item.id, reasoningItem);
          }
          continue;
        }
        const messageItem = normalizeResponsesOutputMessageItem(parsed.item);
        if (messageItem) {
          upsertOutputItem(messageItem);
          continue;
        }
        const webSearchItem = normalizeResponsesWebSearchCallItem(parsed.item);
        if (webSearchItem) {
          upsertOutputItem(webSearchItem);
          continue;
        }
        const functionCallItem = normalizeResponsesFunctionCallItem(parsed.item);
        if (functionCallItem) {
          upsertOutputItem(functionCallItem);
          if (typeof parsed?.item?.id === "string" && parsed.item.id.length > 0) {
            state.functionCallByItemId.set(parsed.item.id, functionCallItem);
          }
        }
        continue;
      }

      if (parsed.type === "response.output_text.delta") {
        appendAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          typeof parsed.delta === "string" ? parsed.delta : ""
        );
        continue;
      }

      if (parsed.type === "response.output_text.done") {
        appendAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          typeof parsed.text === "string" ? parsed.text : ""
        );
        continue;
      }

      if (parsed.type === "response.reasoning_summary_part.added" || parsed.type === "response.reasoning_summary_part.done") {
        if (typeof parsed.item_id !== "string" || parsed.item_id.length === 0) continue;
        const summaryIndex = Number.isInteger(parsed.summary_index) ? parsed.summary_index : 0;
        const part = ensureReasoningSummaryPart(parsed.item_id, summaryIndex);
        const nextText =
          isRecordObject(parsed.part) && parsed.part.type === "summary_text" && typeof parsed.part.text === "string"
            ? parsed.part.text
            : "";
        if (parsed.type.endsWith(".added")) {
          if (nextText) part.text = nextText;
        } else if (nextText && nextText.length >= part.text.length) {
          part.text = nextText;
        }
        continue;
      }

      if (parsed.type === "response.reasoning_summary_text.delta") {
        if (typeof parsed.item_id !== "string" || parsed.item_id.length === 0) continue;
        const summaryIndex = Number.isInteger(parsed.summary_index) ? parsed.summary_index : 0;
        const part = ensureReasoningSummaryPart(parsed.item_id, summaryIndex);
        const deltaText = typeof parsed.delta === "string" ? parsed.delta : "";
        if (deltaText) part.text += deltaText;
        continue;
      }

      if (parsed.type === "response.reasoning_summary_text.done") {
        if (typeof parsed.item_id !== "string" || parsed.item_id.length === 0) continue;
        const summaryIndex = Number.isInteger(parsed.summary_index) ? parsed.summary_index : 0;
        const part = ensureReasoningSummaryPart(parsed.item_id, summaryIndex);
        const doneText = typeof parsed.text === "string" ? parsed.text : "";
        if (doneText && doneText.length >= part.text.length) part.text = doneText;
        continue;
      }

      if (parsed.type === "response.function_call_arguments.delta") {
        const tracked =
          typeof parsed.item_id === "string" ? state.functionCallByItemId.get(parsed.item_id) : null;
        if (!tracked) continue;
        const deltaText = typeof parsed.delta === "string" ? parsed.delta : "";
        if (deltaText) tracked.arguments = `${typeof tracked.arguments === "string" ? tracked.arguments : ""}${deltaText}`;
        continue;
      }

      if (parsed.type === "response.function_call_arguments.done") {
        const tracked =
          typeof parsed.item_id === "string" ? state.functionCallByItemId.get(parsed.item_id) : null;
        if (!tracked) continue;
        if (typeof tracked.arguments === "string" && tracked.arguments.length > 0) continue;
        tracked.arguments = typeof parsed.arguments === "string" ? parsed.arguments : "";
      }
    }

    return {
      completed: state.completed || buildSyntheticCompletedResponseFromSseState(state),
      failed: state.failed || null
    };
  }

  function extractCompletedResponseFromSse(rawText) {
    return parseResponsesResultFromSse(rawText).completed;
  }

  function extractCompletedResponseFromJson(rawText) {
    if (typeof rawText !== "string" || rawText.trim().length === 0) return null;
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.response && typeof parsed.response === "object") return parsed.response;
    return parsed;
  }

  async function pipeSseAndCaptureTokenUsage(upstream, res) {
    if (!upstream.body) throw new Error("No upstream SSE body.");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;

    const handleSseBlock = (block) => {
      if (!block || typeof block !== "string") return;
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        usage = mergeNormalizedTokenUsage(
          usage,
          parsed?.response?.usage || parsed?.message?.usage || parsed?.usage || parsed?.usageMetadata || null
        );
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        buffer += decoder.decode(value, { stream: true });
      }

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        handleSseBlock(block);
        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleSseBlock(buffer);
    res.end();
    return { usage: toChatUsageFromNormalizedTokenUsage(usage) };
  }

  async function pipeCodexSseAsChatCompletions(upstream, res, model) {
    if (!upstream.body) throw new Error("No upstream SSE body.");

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");

    const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    let emittedAssistantRole = false;
    let emittedDone = false;
    let emittedToolCalls = false;
    let toolCallCounter = 0;
    let finalUsage = null;
    const functionCallsByItemId = new Map();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";

    const emit = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const emitAssistantRole = () => {
      if (emittedAssistantRole) return;
      emittedAssistantRole = true;
      emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });
    };

    const emitToolCallChunk = (toolCallIndex, callId, name, argumentsDelta) => {
      emitAssistantRole();
      emittedToolCalls = true;
      const functionPayload = {};
      if (typeof name === "string" && name.length > 0) functionPayload.name = name;
      if (typeof argumentsDelta === "string") functionPayload.arguments = argumentsDelta;
      emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIndex,
              ...(callId ? { id: callId } : {}),
              type: "function",
              function: functionPayload
            }]
          },
          finish_reason: null
        }]
      });
    };

    const handleSseBlock = (block) => {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n").trim();
      if (!payload || payload === "[DONE]") return;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }

      if (event.type === "response.output_text.delta") {
        const deltaText = typeof event.delta === "string" ? event.delta : "";
        if (!deltaText) return;
        emitAssistantRole();
        emit({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
        });
        return;
      }

      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const itemId = event.item.id;
        const callId = typeof event.item.call_id === "string" ? event.item.call_id : "";
        const name = typeof event.item.name === "string" ? event.item.name : "";
        const toolCallIndex = toolCallCounter++;
        if (itemId) {
          functionCallsByItemId.set(itemId, { toolCallIndex, callId, name, arguments: "" });
        }
        emitToolCallChunk(toolCallIndex, callId, name, "");
        return;
      }

      if (event.type === "response.function_call_arguments.delta") {
        const tracked = event.item_id ? functionCallsByItemId.get(event.item_id) : null;
        if (!tracked) return;
        const deltaText = typeof event.delta === "string" ? event.delta : "";
        if (!deltaText) return;
        tracked.arguments += deltaText;
        emitToolCallChunk(tracked.toolCallIndex, tracked.callId, undefined, deltaText);
        return;
      }

      if (event.type === "response.function_call_arguments.done") {
        const tracked = event.item_id ? functionCallsByItemId.get(event.item_id) : null;
        if (!tracked) return;
        if (!tracked.arguments && typeof event.arguments === "string") {
          tracked.arguments = event.arguments;
          emitToolCallChunk(tracked.toolCallIndex, tracked.callId, tracked.name, tracked.arguments);
        }
        return;
      }

      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message || "Codex response failed.");
      }

      if (event.type === "response.completed" || event.type === "response.done") {
        if (!emittedToolCalls) emitAssistantRole();
        const finishReason = emittedToolCalls ? "tool_calls" : "stop";
        const chunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
        };
        const usage = mapCodexUsageToChatUsage(event.response?.usage);
        if (usage) {
          finalUsage = usage;
          chunk.usage = usage;
        }
        emit(chunk);
        res.write("data: [DONE]\n\n");
        emittedDone = true;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        handleSseBlock(block);
        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim().length > 0) handleSseBlock(buffer);

    if (!emittedDone) {
      if (!emittedToolCalls) emitAssistantRole();
      emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: emittedToolCalls ? "tool_calls" : "stop" }]
      });
      res.write("data: [DONE]\n\n");
    }

    res.end();
    return { usage: finalUsage };
  }

  function parseSseUsageFromAuditPayload(packetText, options = {}) {
    if (!packetText || typeof packetText !== "string") return null;
    const usageRootPath = typeof options.usageRootPath === "string" ? options.usageRootPath.trim() : "";
    let usage = null;

    const readUsageObject = (event) => {
      if (!event || typeof event !== "object") return null;
      if (!usageRootPath) {
        return event?.usage || event?.usageMetadata || event?.message?.usage || event?.response?.usage || null;
      }
      let cursor = event;
      for (const key of usageRootPath.split(".").filter(Boolean)) {
        if (!cursor || typeof cursor !== "object") return null;
        cursor = cursor[key];
      }
      return cursor || null;
    };

    for (const line of packetText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      usage = mergeNormalizedTokenUsage(usage, readUsageObject(parsed));
    }

    return usage;
  }

  function extractTokenUsageFromAuditResponse({ protocolType, responseContentType, responsePacket }) {
    if (!responsePacket || typeof responsePacket !== "string") return null;
    const contentType = String(responseContentType || "").toLowerCase();
    const protocol = String(protocolType || "").toLowerCase();
    const trimmedPacket = responsePacket.trim();

    if (contentType.includes("json") || trimmedPacket.startsWith("{") || trimmedPacket.startsWith("[")) {
      const parsed = parseJsonLoose(responsePacket);
      if (parsed && typeof parsed === "object") {
        const jsonUsage =
          parsed?.usage ||
          parsed?.response?.usage ||
          parsed?.usageMetadata ||
          parsed?.message?.usage ||
          parsed?.error?.usage ||
          null;
        const normalizedJsonUsage = normalizeTokenUsage(jsonUsage);
        if (normalizedJsonUsage) return normalizedJsonUsage;
      }
    }

    const looksLikeSse =
      contentType.includes("event-stream") || /(^|\n)\s*(event:|data:)/.test(responsePacket);
    if (!looksLikeSse) return null;

    const completed = extractCompletedResponseFromSse(responsePacket);
    const completedUsage = normalizeTokenUsage(completed?.usage);
    if (completedUsage) return completedUsage;

    if (protocol.includes("anthropic")) {
      return (
        parseSseUsageFromAuditPayload(responsePacket) ||
        parseSseUsageFromAuditPayload(responsePacket, { usageRootPath: "message.usage" })
      );
    }
    if (protocol.includes("gemini")) {
      return parseSseUsageFromAuditPayload(responsePacket);
    }
    return parseSseUsageFromAuditPayload(responsePacket);
  }

  function convertResponsesToChatCompletion(response) {
    const content = extractAssistantTextFromResponse(response);
    const toolCalls = extractAssistantToolCallsFromResponse(response);
    const nowSec = Math.floor(Date.now() / 1000);
    const usage = response?.usage || {};

    return {
      id: response?.id || `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
      object: "chat.completion",
      created: Number.isFinite(response?.created_at) ? response.created_at : nowSec,
      model: response?.model || config.codex.defaultModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : mapResponsesStatusToChatFinishReason(response?.status)
      }],
      usage: {
        prompt_tokens: Number(usage.input_tokens || 0),
        completion_tokens: Number(usage.output_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0)
      }
    };
  }

  function extractAssistantTextFromResponse(response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    const parts = [];
    for (const item of output) {
      if (!item || item.type !== "message" || item.role !== "assistant") continue;
      for (const chunk of Array.isArray(item.content) ? item.content : []) {
        if (chunk?.type === "output_text" && typeof chunk.text === "string") parts.push(chunk.text);
      }
    }
    return parts.join("");
  }

  function extractAssistantToolCallsFromResponse(response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    const calls = [];
    for (const item of output) {
      if (!item || item.type !== "function_call") continue;
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) continue;
      calls.push({
        id:
          typeof item.call_id === "string" && item.call_id.length > 0
            ? item.call_id
            : `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: {
          name,
          arguments: typeof item.arguments === "string" ? item.arguments : "{}"
        }
      });
    }
    return calls;
  }

  function mapResponsesStatusToChatFinishReason(status) {
    if (status === "incomplete") return "length";
    if (status === "failed" || status === "cancelled") return "stop";
    return "stop";
  }

  return {
    parseResponsesResultFromSse,
    extractCompletedResponseFromSse,
    extractCompletedResponseFromJson,
    pipeSseAndCaptureTokenUsage,
    pipeCodexSseAsChatCompletions,
    normalizeTokenUsage,
    mergeNormalizedTokenUsage,
    extractTokenUsageFromAuditResponse,
    convertResponsesToChatCompletion,
    extractAssistantTextFromResponse,
    extractAssistantToolCallsFromResponse,
    mapResponsesStatusToChatFinishReason
  };
}
