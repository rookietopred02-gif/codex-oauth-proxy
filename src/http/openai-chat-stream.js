import crypto from "node:crypto";

import { createSseSession } from "./sse-runtime.js";

export function commitOpenAISseHeaders(res) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
}

export function createOpenAIChatCompletionStream(
  res,
  {
    model,
    heartbeatMs = 15000,
    completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    created = Math.floor(Date.now() / 1000),
    upstream = null,
    prepareResponse = null
  } = {}
) {
  const session = createSseSession(res, {
    upstream,
    heartbeatMs,
    prepareResponse:
      typeof prepareResponse === "function"
        ? prepareResponse
        : () => commitOpenAISseHeaders(res)
  });
  session.startHeartbeat();

  let emittedAssistantRole = false;
  let emittedDone = false;

  const emit = (payload) => {
    return session.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitAssistantRole = () => {
    if (emittedAssistantRole) return true;
    emittedAssistantRole = true;
    return emit({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    });
  };

  return {
    session,
    completionId,
    created,
    attachReader(reader) {
      session.attachReader(reader);
    },
    setUpstream(nextUpstream) {
      session.setUpstream(nextUpstream);
    },
    isClosed() {
      return session.isClosed();
    },
    emit,
    emitAssistantRole,
    emitTextDelta(text) {
      const deltaText = typeof text === "string" ? text : "";
      if (!deltaText) return true;
      if (!emitAssistantRole()) return false;
      return emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
      });
    },
    emitReasoningDelta(text) {
      const deltaText = typeof text === "string" ? text : "";
      if (!deltaText) return true;
      if (!emitAssistantRole()) return false;
      return emit({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            reasoning: deltaText,
            reasoning_content: deltaText
          },
          finish_reason: null
        }]
      });
    },
    emitToolCallChunk(toolCallIndex, callId, name, argumentsDelta) {
      if (!emitAssistantRole()) return false;
      const functionPayload = {};
      if (typeof name === "string" && name.length > 0) functionPayload.name = name;
      if (typeof argumentsDelta === "string") functionPayload.arguments = argumentsDelta;
      return emit({
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
    },
    finish({ finishReason = "stop", usage = null, ensureAssistantRole = true } = {}) {
      if (emittedDone) return false;
      if (ensureAssistantRole && !emitAssistantRole()) {
        return false;
      }

      const payload = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }]
      };
      if (usage) payload.usage = usage;
      if (!emit(payload)) return false;
      if (!session.write("data: [DONE]\n\n")) return false;
      emittedDone = true;
      session.end();
      return true;
    },
    end() {
      session.end();
    },
    cleanup() {
      session.cleanup();
    }
  };
}

export function sendOpenAICompletionAsSse(
  res,
  completion,
  {
    heartbeatMs = 15000,
    upstream = null,
    prepareResponse = null
  } = {}
) {
  const stream = createOpenAIChatCompletionStream(res, {
    model: completion?.model || "",
    completionId: completion?.id,
    created: completion?.created,
    heartbeatMs,
    upstream,
    prepareResponse
  });

  try {
    stream.emitAssistantRole();
    stream.emitTextDelta(completion?.choices?.[0]?.message?.content || "");
    stream.finish({
      finishReason: completion?.choices?.[0]?.finish_reason || "stop",
      usage: completion?.usage || null
    });
  } finally {
    stream.cleanup();
  }
}
