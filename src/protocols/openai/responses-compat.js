import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../../upstream-timeouts.js";
import {
  consumeSseBlocks,
  createSseSession,
  parseSseJsonEventBlock,
  readUpstreamChunkWithIdleTimeout,
  takeNextSseBlock
} from "../../http/sse-runtime.js";
import {
  mapResponsesUsageToChatUsage,
  mergeNormalizedTokenUsage,
  normalizeTokenUsage,
  toChatUsageFromNormalizedTokenUsage
} from "../../http/token-usage.js";
import { createOpenAIChatCompletionStreamEmitter } from "./chat-stream-emitter.js";

function isRecordObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createOpenAIResponsesCompatHelpers(context) {
  const {
    config,
    parseJsonLoose,
    upstreamStreamIdleTimeoutMs:
      upstreamStreamIdleTimeoutMsInput =
        config?.upstreamStreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
  } = context;

  function getResolvedUpstreamStreamIdleTimeoutMs() {
    const raw =
      typeof upstreamStreamIdleTimeoutMsInput === "function"
        ? upstreamStreamIdleTimeoutMsInput()
        : upstreamStreamIdleTimeoutMsInput;
    return Math.max(0, Number(raw || 0));
  }

  function mapCodexUsageToChatUsage(usage) {
    return mapResponsesUsageToChatUsage(usage);
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
      sawTerminalEvent: false,
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

      if (parsed.type === "response.completed" || parsed.type === "response.done") {
        state.sawTerminalEvent = true;
        if (parsed.response && typeof parsed.response === "object") {
          state.completed = parsed.response;
        }
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
      completed:
        state.completed || (state.sawTerminalEvent ? buildSyntheticCompletedResponseFromSseState(state) : null),
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

  async function pipeCodexSse(upstream, res, options = {}) {
    if (!upstream.body) throw new Error("No upstream SSE body.");

    const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    const onCompleted = typeof options.onCompleted === "function" ? options.onCompleted : null;
    const requireCompletion = options.requireCompletion !== false;
    const reader = upstream.body.getReader();
    const session = createSseSession(res, { upstream });
    session.attachReader(reader);
    session.startHeartbeat();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawSse = "";
    let usage = null;
    let sawTerminalEvent = false;
    let completed = null;

    const context = {
      session,
      write(chunk) {
        return session.write(chunk);
      }
    };

    const handleBlock = (block) => {
      const event = parseSseJsonEventBlock(block);
      if (!event) return;
      rawSse += `${block}\n\n`;
      usage = mergeNormalizedTokenUsage(
        usage,
        event?.response?.usage || event?.message?.usage || event?.usage || event?.usageMetadata || null
      );
      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message || event.error?.message || event.message || "Codex response failed.");
      }
      if (event.type === "response.completed" || event.type === "response.done") {
        sawTerminalEvent = true;
        if (event.response && typeof event.response === "object") {
          completed = event.response;
        }
      }
      onEvent?.(event, context);
    };

    try {
      while (!session.isClosed()) {
        let chunkResult;
        try {
          chunkResult = await readUpstreamChunkWithIdleTimeout(reader, upstream);
        } catch (err) {
          if (session.isClosed()) break;
          throw err;
        }
        const { done, value } = chunkResult;
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const nextBlock = takeNextSseBlock(buffer);
          if (!nextBlock) break;
          buffer = nextBlock.rest;
          handleBlock(nextBlock.block);
        }
      }

      buffer += decoder.decode();
      if (!session.isClosed() && buffer.trim().length > 0) handleBlock(buffer);

      if (!session.isClosed() && requireCompletion && !sawTerminalEvent) {
        throw new Error("Upstream SSE ended before response.completed event.");
      }

      if (!completed && sawTerminalEvent && rawSse) {
        completed = parseResponsesResultFromSse(rawSse).completed;
      }
      if (!session.isClosed() && completed) {
        onCompleted?.(completed, context);
      }

      session.end();
      return {
        completed,
        usage: toChatUsageFromNormalizedTokenUsage(usage || completed?.usage || null)
      };
    } finally {
      session.cleanup();
    }
  }

  async function pipeSseAndCaptureTokenUsage(upstream, res) {
    if (!upstream.body) throw new Error("No upstream SSE body.");

    const reader = upstream.body.getReader();
    const session = createSseSession(res, { upstream });
    session.attachReader(reader);
    session.startHeartbeat();
    const decoder = new TextDecoder();
    let buffer = "";
    let rawSse = "";
    let usage = null;
    let completed = null;
    let sawTerminalEvent = false;

    const handleSseBlock = (block) => {
      if (!block || typeof block !== "string") return;
      rawSse += `${block}\n\n`;
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
        if (parsed.type === "response.completed" || parsed.type === "response.done") {
          sawTerminalEvent = true;
          if (parsed.response && typeof parsed.response === "object") {
            completed = parsed.response;
          }
        }
      }
    };

    try {
      while (!session.isClosed()) {
        let chunkResult;
        try {
          chunkResult = await readUpstreamChunkWithIdleTimeout(reader, upstream);
        } catch (err) {
          if (session.isClosed()) break;
          throw err;
        }
        const { done, value } = chunkResult;
        if (done) break;
        if (!value) continue;
        if (!session.write(value)) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const nextBlock = takeNextSseBlock(buffer);
          if (!nextBlock) break;
          buffer = nextBlock.rest;
          handleSseBlock(nextBlock.block);
        }
      }

      buffer += decoder.decode();
      if (!session.isClosed() && buffer.trim().length > 0) handleSseBlock(buffer);
      if (!completed && sawTerminalEvent && rawSse) {
        completed = parseResponsesResultFromSse(rawSse).completed;
      }
      session.end();
      return {
        completed,
        usage: toChatUsageFromNormalizedTokenUsage(usage || completed?.usage || null)
      };
    } finally {
      session.cleanup();
    }
  }

  async function pipeCodexSseAsChatCompletions(upstream, res, model) {
    if (!upstream.body) throw new Error("No upstream SSE body.");
    const reader = upstream.body.getReader();
    const emitter = createOpenAIChatCompletionStreamEmitter({
      upstream,
      res,
      model,
      mapResponsesStatusToChatFinishReason,
      extractAssistantTextFromResponse,
      extractAssistantToolCallsFromResponse,
      usageMapper: mapCodexUsageToChatUsage
    });
    emitter.session.attachReader(reader);

    try {
      await consumeSseBlocks(upstream, {
        reader,
        timeoutMs: getResolvedUpstreamStreamIdleTimeoutMs(),
        isClosed: () => emitter.session.isClosed(),
        onBlock(block) {
          const event = parseSseJsonEventBlock(block);
          if (!event) return;
          if (event.type === "response.failed") {
            throw new Error(
              event.response?.error?.message ||
                event.error?.message ||
                event.message ||
                "Codex response failed."
            );
          }
          emitter.emitEvent(event);
        }
      });
      if (!emitter.session.isClosed() && !emitter.getUsage() && !res.writableEnded) {
        throw new Error("Upstream SSE ended before response.completed event.");
      }
      if (!emitter.session.isClosed()) {
        emitter.session.end();
      }
      return { usage: emitter.getUsage() || null };
    } finally {
      emitter.session.cleanup();
      reader.releaseLock?.();
    }
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
    pipeCodexSse,
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
