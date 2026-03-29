import { WebSocketServer } from "ws";

import {
  consumeSseBlocks,
  parseSseJsonEventBlock
} from "./sse-runtime.js";
import { authorizeProxyApiRequest } from "./proxy-api-key-auth.js";
import { isResponsesCreatePath } from "../protocols/openai/responses-contract.js";

const WEBSOCKET_CONNECTION_LIMIT_MS = 60 * 60 * 1000;
const WEBSOCKET_OPEN_STATE = 1;

function safeTruncate(value, limit = 400) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function buildResponseFailedEvent({ message, code = "", statusCode = 400, responseId = "" } = {}) {
  return {
    type: "response.failed",
    response: {
      ...(responseId ? { id: responseId } : {}),
      status: "failed",
      status_code: Number(statusCode || 400) || 400,
      error: {
        ...(code ? { code } : {}),
        message: String(message || "Response request failed.")
      }
    }
  };
}

function writeUpgradeJson(socket, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const lines = [
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : statusCode === 404 ? "Not Found" : "Bad Request"}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${body.length}`,
    "",
    ""
  ];
  socket.write(lines.join("\r\n"));
  socket.write(body);
  socket.destroy();
}

function extractUpstreamError(rawText, parseJsonLoose) {
  const parsed = typeof parseJsonLoose === "function" ? parseJsonLoose(rawText) : null;
  const message =
    parsed?.error?.message ||
    parsed?.message ||
    String(rawText || "") ||
    "Upstream request failed.";
  const code = parsed?.error?.code || parsed?.code || "";
  return {
    code: typeof code === "string" ? code : "",
    message: String(message || "Upstream request failed.")
  };
}

function extractCompletedResponse(rawText, parseJsonLoose) {
  const parsed = typeof parseJsonLoose === "function" ? parseJsonLoose(rawText) : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)) {
    return parsed.response;
  }
  return parsed;
}

function looksLikeSsePayload(rawText) {
  return typeof rawText === "string" && /(^|\n)\s*(event:|data:)/.test(rawText);
}

function replayBufferedSseEvents(ws, rawSse) {
  const blocks = String(rawSse || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  for (const block of blocks) {
    const parsedEvent = parseSseJsonEventBlock(block);
    if (!parsedEvent) continue;
    if (!safeSendJson(ws, parsedEvent)) {
      throw new Error("WebSocket closed while replaying buffered response events.");
    }
  }
}

function normalizeResponseCreatePayload(event) {
  const payload = { ...event };
  delete payload.type;
  delete payload.stream;
  delete payload.background;
  return payload;
}

function safeSendJson(ws, payload) {
  if (!ws || ws.readyState !== WEBSOCKET_OPEN_STATE) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function cancelActiveReader(reader) {
  if (!reader || typeof reader.cancel !== "function") return;
  try {
    await reader.cancel();
  } catch {}
}

async function cancelActiveUpstream(upstream) {
  const cancel = upstream?.body?.cancel;
  if (typeof cancel !== "function") return;
  try {
    await cancel.call(upstream.body);
  } catch {}
}

export function attachResponsesWebSocketServer(server, context) {
  const {
    config,
    hasActiveManagedProxyApiKeys,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    recordManagedProxyApiKeyUsage,
    recordRecentProxyRequest,
    openResponsesCreateProxySession,
    parseResponsesResultFromSse,
    readUpstreamTextOrThrow,
    parseJsonLoose
  } = context;

  const wss = new WebSocketServer({
    noServer: true
  });
  const sockets = new Set();

  const handleUpgrade = (req, socket, head) => {
    const incoming = new URL(req.url || "/", "http://localhost");
    if (!isResponsesCreatePath(incoming.pathname)) {
      writeUpgradeJson(socket, 404, {
        error: "unsupported_endpoint",
        message: "WebSocket mode is only available on /v1/responses."
      });
      return;
    }

    const authorization = authorizeProxyApiRequest(req, {
      config,
      hasActiveManagedProxyApiKeys,
      extractProxyApiKeyFromRequest,
      findManagedProxyApiKeyByValue,
      recordManagedProxyApiKeyUsage
    });
    if (!authorization.ok) {
      writeUpgradeJson(socket, authorization.statusCode, authorization.payload);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, {
        pathname: incoming.pathname
      });
    });
  };

  wss.on("connection", (ws, req, meta = {}) => {
    sockets.add(ws);

    const state = {
      activeReader: null,
      activeSession: null,
      closed: false,
      inFlight: false
    };

    const cleanupActiveRequest = async () => {
      const reader = state.activeReader;
      const session = state.activeSession;
      state.activeReader = null;
      state.activeSession = null;
      await cancelActiveReader(reader);
      await cancelActiveUpstream(session?.upstream);
      session?.release?.();
    };

    const connectionLimitTimer = setTimeout(() => {
      if (ws.readyState !== WEBSOCKET_OPEN_STATE) return;
      safeSendJson(
        ws,
        buildResponseFailedEvent({
          code: "websocket_connection_limit_reached",
          message: "The WebSocket connection hit the 60-minute limit. Open a new connection and continue.",
          statusCode: 409
        })
      );
      ws.close(1000, "connection limit reached");
    }, WEBSOCKET_CONNECTION_LIMIT_MS);
    connectionLimitTimer.unref?.();

    ws.on("close", () => {
      state.closed = true;
      clearTimeout(connectionLimitTimer);
      sockets.delete(ws);
      cleanupActiveRequest().catch(() => {});
    });
    ws.on("error", () => {});

    ws.on("message", async (data, isBinary) => {
      if (state.closed || ws.readyState !== WEBSOCKET_OPEN_STATE) return;
      if (isBinary) {
        safeSendJson(
          ws,
          buildResponseFailedEvent({
            code: "invalid_request_error",
            message: "WebSocket mode expects JSON text frames.",
            statusCode: 400
          })
        );
        return;
      }
      if (state.inFlight) {
        safeSendJson(
          ws,
          buildResponseFailedEvent({
            code: "invalid_request_error",
            message: "Only one in-flight response.create is allowed per WebSocket connection.",
            statusCode: 409
          })
        );
        return;
      }

      let event;
      try {
        event = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        safeSendJson(
          ws,
          buildResponseFailedEvent({
            code: "invalid_request_error",
            message: "Invalid JSON payload for WebSocket mode.",
            statusCode: 400
          })
        );
        return;
      }

      if (!event || typeof event !== "object" || Array.isArray(event) || event.type !== "response.create") {
        safeSendJson(
          ws,
          buildResponseFailedEvent({
            code: "invalid_request_error",
            message: "WebSocket mode requires a response.create event.",
            statusCode: 400
          })
        );
        return;
      }

      state.inFlight = true;
      const startedAt = Date.now();
      const rawPath = meta.pathname || req.url || "/v1/responses";
      let session = null;
      let terminalSent = false;
      let requestBody = Buffer.alloc(0);
      let latestResponseBody = "";
      let latestResponseContentType = "application/json";
      let latestStatusCode = 502;
      let latestTokenUsage = null;
      let latestUpstreamErrorCode = "";
      let latestUpstreamErrorDetail = "";

      const finalizeRecentRequest = () => {
        if (typeof recordRecentProxyRequest !== "function") return;
        recordRecentProxyRequest({
          startedAt,
          method: "POST",
          rawPath,
          statusCode: latestStatusCode,
          requestBody,
          requestContentType: "application/json",
          upstreamRequestBody: session?.upstreamRequestBody,
          upstreamRequestContentType: session?.upstreamRequestContentType,
          responseBody: latestResponseBody,
          responseContentType: latestResponseContentType,
          protocolType: "openai-v1",
          tokenUsage: latestTokenUsage,
          modelRoute: session?.modelRoute || null,
          authAccountId: session?.authAccountId || null,
          upstreamRetryCount: session?.retryCount || 0,
          upstreamErrorCode: latestUpstreamErrorCode,
          upstreamErrorDetail: latestUpstreamErrorDetail,
          compatibilityHint: session?.compatibilityHint || ""
        });
      };

      try {
        const payload = normalizeResponseCreatePayload(event);
        requestBody = Buffer.from(JSON.stringify(payload), "utf8");
        session = await openResponsesCreateProxySession(
          {
            method: "POST",
            originalUrl: rawPath,
            url: rawPath,
            headers: req.headers
          },
          null,
          {
            originalUrl: rawPath,
            requestBody,
            parsedRequestBody: payload
          }
        );
        state.activeSession = session;

        if (!session.upstream.ok) {
          const raw = await readUpstreamTextOrThrow(session.upstream);
          const errorInfo = extractUpstreamError(raw, parseJsonLoose);
          latestStatusCode = session.upstream.status;
          latestResponseBody = raw;
          latestResponseContentType = String(session.upstream.headers.get("content-type") || "application/json");
          latestUpstreamErrorCode = errorInfo.code || "";
          latestUpstreamErrorDetail = errorInfo.message || "";
          session.forgetPinnedAffinity(session.upstream.status, raw);
          await session.markFailure(
            `Upstream HTTP ${session.upstream.status} on POST ${rawPath}: ${safeTruncate(errorInfo.message, 200)}`,
            session.upstream.status
          );
          safeSendJson(
            ws,
            buildResponseFailedEvent({
              code: errorInfo.code,
              message: errorInfo.message,
              statusCode: session.upstream.status
            })
          );
          terminalSent = true;
          finalizeRecentRequest();
          return;
        }

        const upstreamContentType = String(session.upstream.headers.get("content-type") || "").toLowerCase();
        if (!upstreamContentType.includes("text/event-stream")) {
          const raw = await readUpstreamTextOrThrow(session.upstream);
          if (looksLikeSsePayload(raw)) {
            const parsedResult = parseResponsesResultFromSse(raw);
            if (!parsedResult.failed && !parsedResult.completed) {
              const failure = buildResponseFailedEvent({
                code: "invalid_upstream_sse",
                message: "Upstream SSE ended before a terminal response event.",
                statusCode: 502
              });
              latestStatusCode = 502;
              latestResponseBody = raw || JSON.stringify(failure);
              latestResponseContentType = raw ? "text/event-stream" : "application/json";
              latestUpstreamErrorCode = "invalid_upstream_sse";
              latestUpstreamErrorDetail = "Upstream SSE ended before a terminal response event.";
              await session.markFailure("Invalid upstream SSE on WebSocket bridge.", 502);
              safeSendJson(ws, failure);
              terminalSent = true;
              finalizeRecentRequest();
              return;
            }

            replayBufferedSseEvents(ws, raw);
            latestStatusCode = parsedResult.failed ? Number(parsedResult.failed.statusCode || 502) || 502 : 200;
            latestResponseBody = raw;
            latestResponseContentType = "text/event-stream";
            latestTokenUsage = parsedResult.completed?.usage || null;
            latestUpstreamErrorCode = String(parsedResult.failed?.code || "");
            latestUpstreamErrorDetail = String(parsedResult.failed?.message || "");
            if (parsedResult.failed) {
              await session.markFailure(
                `Upstream SSE response failed on POST ${rawPath}: ${safeTruncate(parsedResult.failed.message, 200)}`,
                parsedResult.failed.statusCode
              );
            } else if (parsedResult.completed) {
              session.rememberCompletion(parsedResult.completed);
              await session.markSuccess();
            }
            terminalSent = true;
            finalizeRecentRequest();
            return;
          }

          const completed = extractCompletedResponse(raw, parseJsonLoose);
          if (!completed) {
            latestStatusCode = 502;
            latestResponseBody = JSON.stringify(
              buildResponseFailedEvent({
                code: "invalid_upstream_sse",
                message: "Stream request returned a non-SSE body without a completed response payload.",
                statusCode: 502
              })
            );
            latestResponseContentType = "application/json";
            latestUpstreamErrorCode = "invalid_upstream_sse";
            latestUpstreamErrorDetail = "Stream request returned a non-SSE body without a completed response payload.";
            await session.markFailure("Invalid upstream SSE on WebSocket bridge.", 502);
            safeSendJson(
              ws,
              buildResponseFailedEvent({
                code: "invalid_upstream_sse",
                message: "Stream request returned a non-SSE body without a completed response payload.",
                statusCode: 502
              })
            );
            terminalSent = true;
            finalizeRecentRequest();
            return;
          }

          latestStatusCode = 200;
          latestResponseBody = JSON.stringify({
            type: "response.completed",
            response: completed
          });
          latestResponseContentType = "application/json";
          latestTokenUsage = completed?.usage || null;
          session.rememberCompletion(completed);
          await session.markSuccess();
          safeSendJson(ws, {
            type: "response.completed",
            response: completed
          });
          terminalSent = true;
          finalizeRecentRequest();
          return;
        }

        if (!session.upstream.body) {
          latestStatusCode = 502;
          latestResponseBody = JSON.stringify(
            buildResponseFailedEvent({
              code: "invalid_upstream_sse",
              message: "No upstream SSE body.",
              statusCode: 502
            })
          );
          await session.markFailure("No upstream SSE body.", 502);
          safeSendJson(
            ws,
            buildResponseFailedEvent({
              code: "invalid_upstream_sse",
              message: "No upstream SSE body.",
              statusCode: 502
            })
          );
          terminalSent = true;
          finalizeRecentRequest();
          return;
        }

        const reader = session.upstream.body.getReader();
        state.activeReader = reader;
        let rawSse = "";

        await consumeSseBlocks(session.upstream, {
          reader,
          isClosed: () => state.closed || ws.readyState !== ws.OPEN,
          onBlock(block) {
            const parsedEvent = parseSseJsonEventBlock(block);
            if (!parsedEvent) return;
            rawSse += `${block}\n\n`;
            if (!safeSendJson(ws, parsedEvent)) {
              throw new Error("WebSocket closed while streaming response events.");
            }
          }
        });

        const parsedResult = parseResponsesResultFromSse(rawSse);
        if (parsedResult.failed) {
          latestStatusCode = Number(parsedResult.failed.statusCode || 502) || 502;
          latestResponseBody = rawSse;
          latestResponseContentType = String(session.upstream.headers.get("content-type") || "text/event-stream");
          latestUpstreamErrorCode = String(parsedResult.failed.code || "");
          latestUpstreamErrorDetail = String(parsedResult.failed.message || "");
          await session.markFailure(
            `Upstream SSE response failed on POST ${rawPath}: ${safeTruncate(parsedResult.failed.message, 200)}`,
            parsedResult.failed.statusCode
          );
          terminalSent = true;
          finalizeRecentRequest();
          return;
        }
        if (!parsedResult.completed) {
          const failure = buildResponseFailedEvent({
            code: "invalid_upstream_sse",
            message: "Upstream SSE ended before a terminal response event.",
            statusCode: 502
          });
          latestStatusCode = 502;
          latestResponseBody = rawSse || JSON.stringify(failure);
          latestResponseContentType = rawSse ? String(session.upstream.headers.get("content-type") || "text/event-stream") : "application/json";
          latestUpstreamErrorCode = "invalid_upstream_sse";
          latestUpstreamErrorDetail = "Upstream SSE ended before a terminal response event.";
          safeSendJson(ws, failure);
          await session.markFailure("Invalid upstream SSE on WebSocket bridge.", 502);
          terminalSent = true;
          finalizeRecentRequest();
          return;
        }

        latestStatusCode = 200;
        latestResponseBody = rawSse;
        latestResponseContentType = String(session.upstream.headers.get("content-type") || "text/event-stream");
        latestTokenUsage = parsedResult.completed?.usage || null;
        session.rememberCompletion(parsedResult.completed);
        await session.markSuccess();
        terminalSent = true;
        finalizeRecentRequest();
      } catch (err) {
        if (!state.closed && ws.readyState === WEBSOCKET_OPEN_STATE && !terminalSent) {
          const statusCode = Number(err?.statusCode || 502) || 502;
          const failureCode =
            typeof err?.failureCode === "string" && err.failureCode.length > 0
              ? err.failureCode
              : err?.error || "invalid_upstream_sse";
          safeSendJson(
            ws,
            buildResponseFailedEvent({
              code: failureCode,
              message: err?.message || "WebSocket response request failed.",
              statusCode
            })
          );
        }
        latestStatusCode = Number(err?.statusCode || 502) || 502;
        latestResponseBody = JSON.stringify(
          buildResponseFailedEvent({
            code:
              typeof err?.failureCode === "string" && err.failureCode.length > 0
                ? err.failureCode
                : err?.error || "invalid_upstream_sse",
            message: err?.message || "WebSocket response request failed.",
            statusCode: latestStatusCode
          })
        );
        latestResponseContentType = "application/json";
        latestUpstreamErrorCode = String(err?.code || err?.failureCode || err?.error || "");
        latestUpstreamErrorDetail = String(err?.message || "");
        if (session) {
          session.forgetPinnedAffinity(Number(err?.statusCode || 0), err?.message || "");
          await session.markFailure(err?.message || "WebSocket response request failed.", Number(err?.statusCode || 502) || 502);
        }
        finalizeRecentRequest();
      } finally {
        state.activeReader?.releaseLock?.();
        state.activeReader = null;
        state.activeSession?.release?.();
        state.activeSession = null;
        state.inFlight = false;
      }
    });
  });

  server.on("upgrade", handleUpgrade);

  return {
    async close() {
      server.off("upgrade", handleUpgrade);
      for (const ws of sockets) {
        try {
          ws.close(1001, "server shutting down");
        } catch {}
      }
      sockets.clear();
      await new Promise((resolve) => {
        wss.close(() => resolve());
      });
    }
  };
}
