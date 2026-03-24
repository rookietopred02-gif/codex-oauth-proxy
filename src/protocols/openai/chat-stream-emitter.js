import { createOpenAIChatCompletionStream } from "../../http/openai-chat-stream.js";
import { isResponsesSuccessTerminalEventType } from "./responses-contract.js";

export function createOpenAIChatCompletionStreamEmitter({
  upstream = null,
  res,
  model,
  mapResponsesStatusToChatFinishReason,
  extractAssistantTextFromResponse,
  extractAssistantToolCallsFromResponse,
  usageMapper = null,
  heartbeatMs = 15000
}) {
  const stream = createOpenAIChatCompletionStream(res, {
    model,
    upstream,
    heartbeatMs
  });

  let emittedText = "";
  let emittedToolCalls = false;
  let toolCallCounter = 0;
  let finalUsage = null;
  let finalized = false;
  const functionCallsByItemId = new Map();
  const outputTextByKey = new Map();
  const refusalTextByKey = new Map();
  const reasoningByKey = new Map();

  const emitToolCallChunk = (toolCallIndex, callId, name, argumentsDelta) => {
    emittedToolCalls = true;
    return stream.emitToolCallChunk(toolCallIndex, callId, name, argumentsDelta);
  };

  const emitTextDelta = (text) => {
    const deltaText = typeof text === "string" ? text : "";
    if (!deltaText) return;
    emittedText += deltaText;
    stream.emitTextDelta(deltaText);
  };

  const emitReasoningDelta = (text) => {
    const deltaText = typeof text === "string" ? text : "";
    if (!deltaText) return;
    stream.emitReasoningDelta(deltaText);
  };

  const emitTrackedStringDelta = (stateMap, key, text, emitDelta, { final = false } = {}) => {
    const normalizedText = typeof text === "string" ? text : "";
    if (!normalizedText) return;

    const state = stateMap.get(key) || { emittedText: "" };
    let deltaText = normalizedText;
    if (final) {
      if (normalizedText === state.emittedText) return;
      if (state.emittedText.length > 0 && !normalizedText.startsWith(state.emittedText)) {
        state.emittedText = normalizedText;
        stateMap.set(key, state);
        return;
      }
      deltaText = normalizedText.slice(state.emittedText.length);
      state.emittedText = normalizedText;
    } else {
      state.emittedText += deltaText;
    }
    if (!deltaText) {
      stateMap.set(key, state);
      return;
    }
    stateMap.set(key, state);
    emitDelta(deltaText);
  };

  const emitTrackedToolArgumentsDone = (tracked, finalArguments) => {
    const normalizedArguments = typeof finalArguments === "string" ? finalArguments : "";
    if (!tracked || !normalizedArguments) return;
    if (tracked.arguments.length > 0 && !normalizedArguments.startsWith(tracked.arguments)) {
      tracked.arguments = normalizedArguments;
      return;
    }
    const deltaText = normalizedArguments.slice(tracked.arguments.length);
    tracked.arguments = normalizedArguments;
    if (!deltaText) return;
    emitToolCallChunk(tracked.toolCallIndex, tracked.callId, undefined, deltaText);
  };

  const mapUsage = (usage) => {
    if (typeof usageMapper === "function") {
      return usageMapper(usage);
    }
    if (!usage || typeof usage !== "object") return null;
    return {
      prompt_tokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
      completion_tokens: Number(usage.output_tokens || usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    };
  };

  const finalizeFromCompleted = (completedResponse) => {
    if (!completedResponse || finalized) return;
    finalized = true;

    const finalText = extractAssistantTextFromResponse(completedResponse);
    if (finalText) {
      if (emittedText.length === 0) {
        emitTextDelta(finalText);
      } else if (finalText.startsWith(emittedText)) {
        emitTextDelta(finalText.slice(emittedText.length));
      }
    }

    const toolCalls = extractAssistantToolCallsFromResponse(completedResponse);
    for (const toolCall of toolCalls) {
      const tracked = [...functionCallsByItemId.values()].find((item) => item.callId === toolCall.id) || null;
      if (tracked) {
        emitTrackedToolArgumentsDone(tracked, toolCall.function?.arguments || "");
        continue;
      }
      emitToolCallChunk(
        toolCallCounter++,
        toolCall.id,
        toolCall.function?.name,
        toolCall.function?.arguments || ""
      );
    }

    const usage = mapUsage(completedResponse?.usage);
    if (usage) {
      finalUsage = usage;
    }
    stream.finish({
      finishReason: emittedToolCalls
        ? "tool_calls"
        : mapResponsesStatusToChatFinishReason(completedResponse?.status),
      usage,
      ensureAssistantRole: !emittedToolCalls
    });
  };

  return {
    session: stream.session,
    emitEvent(event) {
      if (!event || typeof event !== "object") return;

      const reasoningKey =
        `${typeof event?.item_id === "string" ? event.item_id : ""}:` +
        `${Number.isInteger(event?.summary_index) ? event.summary_index : 0}`;

      if (
        event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_summary_part.added"
      ) {
        emitTrackedStringDelta(
          reasoningByKey,
          reasoningKey,
          event.type === "response.reasoning_summary_text.delta" ? event.delta : event.part?.text,
          emitReasoningDelta
        );
        return;
      }

      if (
        event.type === "response.reasoning_summary_text.done" ||
        event.type === "response.reasoning_summary_part.done"
      ) {
        emitTrackedStringDelta(
          reasoningByKey,
          reasoningKey,
          event.type === "response.reasoning_summary_text.done" ? event.text : event.part?.text,
          emitReasoningDelta,
          { final: true }
        );
        return;
      }

      if (event.type === "response.reasoning_text.delta" || event.type === "response.reasoning_text.done") {
        const reasoningTextKey =
          `${typeof event?.item_id === "string" ? event.item_id : ""}:` +
          `${Number.isInteger(event?.content_index) ? event.content_index : 0}`;
        emitTrackedStringDelta(
          reasoningByKey,
          reasoningTextKey,
          event.type.endsWith(".done") ? event.text : event.delta,
          emitReasoningDelta,
          { final: event.type.endsWith(".done") }
        );
        return;
      }

      if (event.type === "response.output_text.delta" || event.type === "response.output_text.done") {
        const outputTextKey =
          `${typeof event?.item_id === "string" ? event.item_id : ""}:` +
          `${Number.isInteger(event?.content_index) ? event.content_index : 0}`;
        emitTrackedStringDelta(
          outputTextByKey,
          outputTextKey,
          event.type.endsWith(".done") ? event.text : event.delta,
          emitTextDelta,
          { final: event.type.endsWith(".done") }
        );
        return;
      }

      if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") {
        const refusalKey =
          `${typeof event?.item_id === "string" ? event.item_id : ""}:` +
          `${Number.isInteger(event?.content_index) ? event.content_index : 0}`;
        emitTrackedStringDelta(
          refusalTextByKey,
          refusalKey,
          event.type.endsWith(".done") ? event.refusal : event.delta,
          emitTextDelta,
          { final: event.type.endsWith(".done") }
        );
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
        emitTrackedToolArgumentsDone(tracked, event.arguments);
        return;
      }

      if (isResponsesSuccessTerminalEventType(event.type)) {
        finalizeFromCompleted(event.response);
      }
    },
    finalizeFromCompleted,
    isFinalized() {
      return finalized;
    },
    getUsage() {
      return finalUsage;
    }
  };
}
