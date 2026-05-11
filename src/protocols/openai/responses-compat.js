import crypto from "node:crypto";

import {
  DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
  normalizeUpstreamStreamIdleTimeoutMs
} from "../../upstream-timeouts.js";
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
import {
  extractAssistantAnnotationsFromResponse,
  extractAssistantTextFromResponse,
  extractAssistantToolCallsFromResponse,
  chooseResponsesWebSearchCallStatus,
  isRecordObject,
  mergeResponsesWebSearchCallOutputItems,
  normalizeResponsesOutputItem
} from "./responses-output-items.js";
import {
  buildResponsesFailureResult,
  mergeCompletedResponseWithSseState
} from "./responses-sse-state.js";
import {
  isResponsesFailureEventType,
  isResponsesSuccessTerminalEventType
} from "./responses-contract.js";

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
    return normalizeUpstreamStreamIdleTimeoutMs(raw, 0);
  }

  function mapCodexUsageToChatUsage(usage) {
    return mapResponsesUsageToChatUsage(usage);
  }

  function parseResponsesResultFromSse(rawText) {
    if (typeof rawText !== "string" || rawText.length === 0) {
      return { completed: null, failed: null };
    }

    const state = {
      completed: null,
      failed: null,
      sawSuccessTerminalEvent: false,
      usage: null,
      responseId: "",
      responseModel: "",
      responseStatus: "",
      output: [],
      outputIndexById: new Map(),
      functionCallByItemId: new Map()
    };

    const upsertOutputItem = (item, outputIndex = null) => {
      if (!item) return null;
      const itemId = typeof item.id === "string" ? item.id : "";
      if (itemId && state.outputIndexById.has(itemId)) {
        const existingIndex = state.outputIndexById.get(itemId);
        state.output[existingIndex] = mergeResponsesWebSearchCallOutputItems(state.output[existingIndex], item);
        return state.output[existingIndex];
      }
      if (Number.isInteger(outputIndex) && outputIndex >= 0) {
        const existing = state.output[outputIndex];
        const existingId = typeof existing?.id === "string" ? existing.id : "";
        if (existing === undefined) {
          state.output[outputIndex] = item;
          if (itemId) state.outputIndexById.set(itemId, outputIndex);
          return state.output[outputIndex];
        }
        if (existing?.type === item.type && (!existingId || !itemId || existingId === itemId)) {
          state.output[outputIndex] = mergeResponsesWebSearchCallOutputItems(existing, item);
          if (itemId) state.outputIndexById.set(itemId, outputIndex);
          return state.output[outputIndex];
        }
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
          if (!Array.isArray(existing.content)) existing.content = [];
          return existing;
        }
      }
      return upsertOutputItem({ ...(itemId ? { id: itemId } : {}), type: "reasoning", summary: [], content: [] });
    };

    const ensureWebSearchCallItem = (itemId = "", outputIndex = null) => {
      if (itemId && state.outputIndexById.has(itemId)) {
        const existing = state.output[state.outputIndexById.get(itemId)];
        if (existing?.type === "web_search_call") return existing;
      }
      if (Number.isInteger(outputIndex) && outputIndex >= 0) {
        const existing = state.output[outputIndex];
        if (existing?.type === "web_search_call") {
          if (itemId && (typeof existing.id !== "string" || existing.id.length === 0)) {
            existing.id = itemId;
            state.outputIndexById.set(itemId, outputIndex);
          }
          return existing;
        }
      }
      return upsertOutputItem({ ...(itemId ? { id: itemId } : {}), type: "web_search_call" }, outputIndex);
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

    const ensureAssistantTextPart = (itemId = "", contentIndex = 0) => {
      const message = ensureAssistantMessage(itemId);
      if (!Array.isArray(message.content)) message.content = [];
      while (message.content.length <= contentIndex) {
        message.content.push({ type: "output_text", text: "", annotations: [] });
      }
      const existing = message.content[contentIndex];
      if (!isRecordObject(existing) || existing.type !== "output_text") {
        message.content[contentIndex] = { type: "output_text", text: "", annotations: [] };
      } else if (!Array.isArray(existing.annotations)) {
        existing.annotations = [];
      }
      return message.content[contentIndex];
    };

    const ensureReasoningTextPart = (itemId = "", contentIndex = 0) => {
      const reasoning = ensureReasoningItem(itemId);
      if (!Array.isArray(reasoning.content)) reasoning.content = [];
      while (reasoning.content.length <= contentIndex) {
        reasoning.content.push({ type: "reasoning_text", text: "" });
      }
      const existing = reasoning.content[contentIndex];
      if (!isRecordObject(existing) || existing.type !== "reasoning_text") {
        reasoning.content[contentIndex] = { type: "reasoning_text", text: "" };
      }
      return reasoning.content[contentIndex];
    };

    const appendAssistantText = (itemId, contentIndex, text) => {
      if (typeof text !== "string" || text.length === 0) return;
      const part = ensureAssistantTextPart(itemId, contentIndex);
      part.text += text;
    };

    const finalizeAssistantText = (itemId, contentIndex, text) => {
      if (typeof text !== "string" || text.length === 0) return;
      const part = ensureAssistantTextPart(itemId, contentIndex);
      part.text = text;
    };

    const appendReasoningText = (itemId, contentIndex, text) => {
      if (typeof text !== "string" || text.length === 0) return;
      const part = ensureReasoningTextPart(itemId, contentIndex);
      part.text += text;
    };

    const finalizeReasoningText = (itemId, contentIndex, text) => {
      if (typeof text !== "string" || text.length === 0) return;
      const part = ensureReasoningTextPart(itemId, contentIndex);
      part.text = text;
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

      if (isResponsesSuccessTerminalEventType(parsed.type)) {
        state.sawSuccessTerminalEvent = true;
        if (parsed.response && typeof parsed.response === "object") {
          state.completed = parsed.response;
        }
        continue;
      }

      if (isResponsesFailureEventType(parsed.type)) {
        state.failed = buildResponsesFailureResult(parsed);
        continue;
      }

      if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
        const outputItem = normalizeResponsesOutputItem(parsed.item);
        if (outputItem) {
          const outputIndex = Number.isInteger(parsed.output_index) ? parsed.output_index : null;
          upsertOutputItem(outputItem, outputIndex);
          if (outputItem.type === "function_call" && typeof parsed?.item?.id === "string" && parsed.item.id.length > 0) {
            state.functionCallByItemId.set(parsed.item.id, outputItem);
          }
        }
        continue;
      }

      if (parsed.type === "response.content_part.added" || parsed.type === "response.content_part.done") {
        if (typeof parsed.item_id !== "string" || parsed.item_id.length === 0) continue;
        if (!isRecordObject(parsed.part)) continue;
        const contentIndex = Number.isInteger(parsed.content_index) ? parsed.content_index : 0;

        if (parsed.part.type === "output_text") {
          const part = ensureAssistantTextPart(parsed.item_id, contentIndex);
          if (typeof parsed.part.text === "string") {
            part.text = parsed.part.text;
          }
          if (Array.isArray(parsed.part.annotations)) {
            part.annotations = parsed.part.annotations;
          }
          continue;
        }

        if (parsed.part.type === "refusal") {
          const part = ensureAssistantTextPart(parsed.item_id, contentIndex);
          if (typeof parsed.part.refusal === "string") {
            part.text = parsed.part.refusal;
          }
          continue;
        }

        if (parsed.part.type === "reasoning_text") {
          const part = ensureReasoningTextPart(parsed.item_id, contentIndex);
          if (typeof parsed.part.text === "string") {
            part.text = parsed.part.text;
          }
        }
        continue;
      }

      if (parsed.type === "response.output_text.delta") {
        appendAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.delta === "string" ? parsed.delta : ""
        );
        continue;
      }

      if (parsed.type === "response.output_text.done") {
        finalizeAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.text === "string" ? parsed.text : ""
        );
        continue;
      }

      if (parsed.type === "response.output_text.annotation.added") {
        if (typeof parsed.item_id !== "string" || parsed.item_id.length === 0) continue;
        if (!isRecordObject(parsed.annotation)) continue;
        const contentIndex = Number.isInteger(parsed.content_index) ? parsed.content_index : 0;
        const annotationIndex =
          Number.isInteger(parsed.annotation_index) && parsed.annotation_index >= 0
            ? parsed.annotation_index
            : null;
        const part = ensureAssistantTextPart(parsed.item_id, contentIndex);
        if (!Array.isArray(part.annotations)) part.annotations = [];
        if (annotationIndex === null) {
          part.annotations.push(parsed.annotation);
        } else {
          part.annotations[annotationIndex] = parsed.annotation;
        }
        continue;
      }

      if (
        parsed.type === "response.web_search_call.in_progress" ||
        parsed.type === "response.web_search_call.searching" ||
        parsed.type === "response.web_search_call.completed"
      ) {
        const itemId = typeof parsed.item_id === "string" ? parsed.item_id : "";
        const outputIndex = Number.isInteger(parsed.output_index) ? parsed.output_index : null;
        if (!itemId && outputIndex === null) continue;
        const item = ensureWebSearchCallItem(itemId, outputIndex);
        item.status = chooseResponsesWebSearchCallStatus(
          item.status,
          parsed.type.slice("response.web_search_call.".length)
        );
        continue;
      }

      if (parsed.type === "response.refusal.delta") {
        appendAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.delta === "string" ? parsed.delta : ""
        );
        continue;
      }

      if (parsed.type === "response.refusal.done") {
        finalizeAssistantText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.refusal === "string" ? parsed.refusal : ""
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
        if (nextText) {
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
        if (doneText) part.text = doneText;
        continue;
      }

      if (parsed.type === "response.reasoning_text.delta") {
        appendReasoningText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.delta === "string" ? parsed.delta : ""
        );
        continue;
      }

      if (parsed.type === "response.reasoning_text.done") {
        finalizeReasoningText(
          typeof parsed.item_id === "string" ? parsed.item_id : "",
          Number.isInteger(parsed.content_index) ? parsed.content_index : 0,
          typeof parsed.text === "string" ? parsed.text : ""
        );
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
        if (typeof parsed.arguments === "string") {
          tracked.arguments = parsed.arguments;
        }
      }
    }

    return {
      completed:
        mergeCompletedResponseWithSseState(state.completed, state, {
          config,
          normalizeTokenUsage
        }) || null,
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
      if (isResponsesFailureEventType(event.type)) {
        throw new Error(event.response?.error?.message || event.error?.message || event.message || "Codex response failed.");
      }
      if (isResponsesSuccessTerminalEventType(event.type)) {
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
          chunkResult = await readUpstreamChunkWithIdleTimeout(
            reader,
            upstream,
            getResolvedUpstreamStreamIdleTimeoutMs()
          );
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
        throw new Error("Upstream SSE ended before a terminal response event.");
      }

      if (rawSse) {
        const parsedResult = parseResponsesResultFromSse(rawSse);
        completed = parsedResult.completed || completed;
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
    let failed = null;
    let sawTerminalEvent = false;
    let responseId = "";
    const seenTerminalEventKeys = new Set();

    const buildTerminalEventKey = (parsed) => {
      if (!parsed || typeof parsed !== "object") return "";
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (!type) return "";
      const responseId =
        typeof parsed?.response?.id === "string" && parsed.response.id.length > 0
          ? parsed.response.id
          : "";
      const status =
        typeof parsed?.response?.status === "string" && parsed.response.status.length > 0
          ? parsed.response.status
          : "";
        const message = isResponsesFailureEventType(type)
          ? String(parsed?.response?.error?.message || parsed?.error?.message || parsed?.message || "")
          : "";
      return `${type}:${responseId}:${status}:${message}`;
    };

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
        if (typeof parsed?.response?.id === "string" && parsed.response.id.length > 0) {
          responseId = parsed.response.id;
        }
        if (isResponsesFailureEventType(parsed.type)) {
          const terminalEventKey = buildTerminalEventKey(parsed);
          if (terminalEventKey) {
            if (seenTerminalEventKeys.has(terminalEventKey)) {
              continue;
            }
            seenTerminalEventKeys.add(terminalEventKey);
          }
          sawTerminalEvent = true;
          failed = buildResponsesFailureResult(parsed);
          continue;
        }
        if (isResponsesSuccessTerminalEventType(parsed.type)) {
          const terminalEventKey = buildTerminalEventKey(parsed);
          if (terminalEventKey) {
            if (seenTerminalEventKeys.has(terminalEventKey)) {
              continue;
            }
            seenTerminalEventKeys.add(terminalEventKey);
          }
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
          chunkResult = await readUpstreamChunkWithIdleTimeout(
            reader,
            upstream,
            getResolvedUpstreamStreamIdleTimeoutMs()
          );
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
      if (!session.isClosed() && !sawTerminalEvent) {
        const err = new Error("Upstream SSE ended before a terminal response event.");
        if (session.hasWritten()) {
          session.write(
            `event: response.failed\ndata: ${JSON.stringify({
              type: "response.failed",
              response: {
                ...(responseId ? { id: responseId } : {}),
                status: "failed",
                error: {
                  message: err.message
                }
              }
            })}\n\n`
          );
          session.end();
        }
        throw err;
      }
      if (rawSse) {
        const parsedResult = parseResponsesResultFromSse(rawSse);
        completed = parsedResult.completed || completed;
        failed = parsedResult.failed || failed;
      }
      session.end();
      return {
        failed,
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
          if (isResponsesFailureEventType(event.type)) {
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
      if (!emitter.session.isClosed() && !emitter.isFinalized() && !res.writableEnded) {
        throw new Error("Upstream SSE ended before a terminal response event.");
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
    const annotations = extractAssistantAnnotationsFromResponse(response);
    const toolCalls = extractAssistantToolCallsFromResponse(response);
    const nowSec = Math.floor(Date.now() / 1000);
    const usage = toChatUsageFromNormalizedTokenUsage(response?.usage || null) || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    };

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
          ...(annotations.length > 0 ? { annotations } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : mapResponsesStatusToChatFinishReason(response?.status)
      }],
      usage
    };
  }

  function extractAssistantRefusalFromResponse(response) {
    void response;
    return "";
  }

  function extractAssistantDisplayTextFromResponse(response) {
    return extractAssistantTextFromResponse(response);
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
    extractAssistantAnnotationsFromResponse,
    extractAssistantDisplayTextFromResponse,
    extractAssistantRefusalFromResponse,
    extractAssistantTextFromResponse,
    extractAssistantToolCallsFromResponse,
    mapResponsesStatusToChatFinishReason
  };
}
