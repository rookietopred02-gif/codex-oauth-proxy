import {
  consumeSseBlocks,
  parseSseEventBlock,
  parseSseJsonEventBlock
} from "./sse-runtime.js";
import { createOpenAIChatCompletionStream } from "./openai-chat-stream.js";

function toGeminiChatUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return null;
  return {
    prompt_tokens: Number(usageMetadata.promptTokenCount || 0),
    completion_tokens: Number(usageMetadata.candidatesTokenCount || 0),
    total_tokens: Number(usageMetadata.totalTokenCount || 0)
  };
}

function extractGeminiChunkText(payload) {
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

export async function pipeGeminiSseAsOpenAIChatCompletions(
  upstream,
  res,
  {
    model,
    mapGeminiFinishReasonToOpenAI,
    upstreamStreamIdleTimeoutMs = 0
  } = {}
) {
  if (!upstream?.body) throw new Error("No upstream SSE body.");

  const reader = upstream.body.getReader();
  const stream = createOpenAIChatCompletionStream(res, { model, upstream });
  stream.attachReader(reader);

  let emittedText = "";
  let finalFinishReason = "stop";
  let finalUsage = null;
  let sawTerminalEvent = false;

  try {
    await consumeSseBlocks(upstream, {
      reader,
      timeoutMs: upstreamStreamIdleTimeoutMs,
      isClosed: () => stream.isClosed(),
      onBlock(block) {
        const event = parseSseJsonEventBlock(block);
        if (!event) return;

        const chunkText = extractGeminiChunkText(event);
        if (chunkText) {
          const deltaText =
            emittedText.length > 0 && chunkText.startsWith(emittedText)
              ? chunkText.slice(emittedText.length)
              : chunkText;
          if (deltaText) {
            emittedText += deltaText;
            stream.emitTextDelta(deltaText);
          }
        }

        const usage = toGeminiChatUsage(event?.usageMetadata);
        if (usage) {
          finalUsage = usage;
        }

        const candidate = Array.isArray(event?.candidates) ? event.candidates[0] : null;
        const finishReason = candidate?.finishReason;
        if (typeof finishReason === "string" && finishReason.length > 0) {
          finalFinishReason =
            typeof mapGeminiFinishReasonToOpenAI === "function"
              ? mapGeminiFinishReasonToOpenAI(finishReason)
              : "stop";
          sawTerminalEvent = true;
        }
      }
    });

    if (!stream.isClosed() && !sawTerminalEvent) {
      throw new Error("Upstream SSE ended before Gemini finish reason was emitted.");
    }

    if (!stream.isClosed()) {
      stream.finish({
        finishReason: finalFinishReason,
        usage: finalUsage,
        ensureAssistantRole: true
      });
    }

    return { usage: finalUsage };
  } finally {
    stream.cleanup();
    reader.releaseLock?.();
  }
}

function getAnthropicBlockText(block) {
  if (block?.type === "text") return typeof block.text === "string" ? block.text : "";
  if (block?.type === "thinking") return typeof block.thinking === "string" ? block.thinking : "";
  return "";
}

function normalizeAnthropicToolInput(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") return JSON.stringify(input);
  return "";
}

export async function pipeAnthropicSseAsOpenAIChatCompletions(
  upstream,
  res,
  {
    model,
    mapAnthropicStopReasonToOpenAI,
    upstreamStreamIdleTimeoutMs = 0
  } = {}
) {
  if (!upstream?.body) throw new Error("No upstream SSE body.");

  const reader = upstream.body.getReader();
  const stream = createOpenAIChatCompletionStream(res, { model, upstream });
  stream.attachReader(reader);

  const blocksByIndex = new Map();
  let toolCallCounter = 0;
  let emittedToolCalls = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalFinishReason = "stop";
  let sawTerminalEvent = false;

  const emitTextLikeDelta = (index, text, type) => {
    const state = blocksByIndex.get(index);
    if (!state || typeof text !== "string" || text.length === 0) return;
    const deltaText =
      text.length > state.emittedLength && text.startsWith(state.buffer)
        ? text.slice(state.emittedLength)
        : text;
    if (!deltaText) return;
    state.buffer += deltaText;
    state.emittedLength += deltaText.length;
    if (type === "thinking") {
      stream.emitReasoningDelta(deltaText);
      return;
    }
    stream.emitTextDelta(deltaText);
  };

  try {
    await consumeSseBlocks(upstream, {
      reader,
      timeoutMs: upstreamStreamIdleTimeoutMs,
      isClosed: () => stream.isClosed(),
      onBlock(block) {
        const parsedBlock = parseSseEventBlock(block);
        if (!parsedBlock?.data || parsedBlock.data === "[DONE]") return;

        let event;
        try {
          event = JSON.parse(parsedBlock.data);
        } catch {
          return;
        }

        const eventName = parsedBlock.event || event?.type || "";

        if (eventName === "error" || event?.type === "error") {
          throw new Error(
            event?.error?.message ||
              event?.message ||
              "Anthropic upstream stream failed."
          );
        }

        if (eventName === "message_start") {
          promptTokens = Number(event?.message?.usage?.input_tokens || promptTokens || 0);
          return;
        }

        if (eventName === "content_block_start") {
          const index = Number(event?.index);
          if (!Number.isInteger(index)) return;
          const contentBlock = event?.content_block || {};
          if (contentBlock?.type === "tool_use") {
            emittedToolCalls = true;
            const toolCallIndex = toolCallCounter++;
            const callId =
              typeof contentBlock.id === "string" && contentBlock.id.length > 0
                ? contentBlock.id
                : `call_${toolCallIndex}`;
            const name =
              typeof contentBlock.name === "string" && contentBlock.name.length > 0
                ? contentBlock.name
                : "tool";
            const initialArgs = normalizeAnthropicToolInput(contentBlock.input);
            blocksByIndex.set(index, {
              type: "tool_use",
              toolCallIndex,
              callId,
              name,
              emittedLength: initialArgs.length,
              buffer: initialArgs
            });
            stream.emitToolCallChunk(toolCallIndex, callId, name, initialArgs || "");
            return;
          }

          const type =
            contentBlock?.type === "thinking"
              ? "thinking"
              : contentBlock?.type === "text"
                ? "text"
                : "";
          if (!type) return;
          blocksByIndex.set(index, {
            type,
            emittedLength: 0,
            buffer: getAnthropicBlockText(contentBlock)
          });
          if (type === "text" && blocksByIndex.get(index).buffer) {
            emitTextLikeDelta(index, blocksByIndex.get(index).buffer, type);
          }
          if (type === "thinking" && blocksByIndex.get(index).buffer) {
            emitTextLikeDelta(index, blocksByIndex.get(index).buffer, type);
          }
          return;
        }

        if (eventName === "content_block_delta") {
          const index = Number(event?.index);
          const state = blocksByIndex.get(index);
          if (!state) return;
          const delta = event?.delta || {};
          if (state.type === "tool_use" && delta?.type === "input_json_delta") {
            const deltaText = typeof delta.partial_json === "string" ? delta.partial_json : "";
            if (!deltaText) return;
            state.buffer += deltaText;
            state.emittedLength += deltaText.length;
            stream.emitToolCallChunk(state.toolCallIndex, state.callId, undefined, deltaText);
            return;
          }
          if (state.type === "text" && delta?.type === "text_delta") {
            const deltaText = typeof delta.text === "string" ? delta.text : "";
            if (!deltaText) return;
            state.buffer += deltaText;
            state.emittedLength += deltaText.length;
            stream.emitTextDelta(deltaText);
            return;
          }
          if (state.type === "thinking" && delta?.type === "thinking_delta") {
            const deltaText = typeof delta.thinking === "string" ? delta.thinking : "";
            if (!deltaText) return;
            state.buffer += deltaText;
            state.emittedLength += deltaText.length;
            stream.emitReasoningDelta(deltaText);
          }
          return;
        }

        if (eventName === "message_delta") {
          completionTokens = Number(event?.usage?.output_tokens || completionTokens || 0);
          const stopReason = event?.delta?.stop_reason;
          if (typeof stopReason === "string" && stopReason.length > 0) {
            finalFinishReason =
              stopReason === "tool_use" && emittedToolCalls
                ? "tool_calls"
                : typeof mapAnthropicStopReasonToOpenAI === "function"
                  ? mapAnthropicStopReasonToOpenAI(stopReason)
                  : "stop";
          }
          return;
        }

        if (eventName === "message_stop") {
          sawTerminalEvent = true;
        }
      }
    });

    if (!stream.isClosed() && !sawTerminalEvent) {
      throw new Error("Upstream SSE ended before Anthropic message_stop event.");
    }

    const usage = {
      prompt_tokens: Number(promptTokens || 0),
      completion_tokens: Number(completionTokens || 0),
      total_tokens: Number(promptTokens || 0) + Number(completionTokens || 0)
    };

    if (!stream.isClosed()) {
      stream.finish({
        finishReason: emittedToolCalls ? "tool_calls" : finalFinishReason,
        usage,
        ensureAssistantRole: !emittedToolCalls
      });
    }

    return { usage };
  } finally {
    stream.cleanup();
    reader.releaseLock?.();
  }
}
