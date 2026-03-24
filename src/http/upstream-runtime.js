import { Readable, pipeline } from "node:stream";
import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../upstream-timeouts.js";

export function createUpstreamRuntimeHelpers(context) {
  const {
    extractUpstreamTransportError,
    fetchWithUpstreamRetry: fetchWithUpstreamRetryImpl,
    parseContentType,
    upstreamStreamIdleTimeoutMs:
      upstreamStreamIdleTimeoutMsInput = DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
  } = context;

  function getResolvedUpstreamStreamIdleTimeoutMs() {
    const raw =
      typeof upstreamStreamIdleTimeoutMsInput === "function"
        ? upstreamStreamIdleTimeoutMsInput()
        : upstreamStreamIdleTimeoutMsInput;
    return Math.max(0, Number(raw || 0));
  }

  function isClientDisconnectError(err) {
    const code = String(err?.code || err?.cause?.code || "").trim();
    if (code === "ERR_STREAM_UNABLE_TO_PIPE" || code === "ERR_STREAM_DESTROYED") return true;
    if (code === "EPIPE") return true;
    const message = String(err?.message || err?.cause?.message || "").toLowerCase();
    return message.includes("response has been destroyed");
  }

  function isResponseClosed(res) {
    return Boolean(
      !res ||
      res.destroyed ||
      res.closed ||
      res.writableEnded ||
      res.writableFinished
    );
  }

  async function cancelUpstreamBody(upstream) {
    const cancel = upstream?.body?.cancel;
    if (typeof cancel !== "function") return;
    try {
      await cancel.call(upstream.body);
    } catch {}
  }

  function noteUpstreamRetry(res, retryCount = 0, err = null) {
    if (!res?.locals) return;
    const normalizedRetryCount = Math.max(
      Number(res.locals.upstreamRetryCount || 0),
      Math.max(0, Number(retryCount || 0))
    );
    res.locals.upstreamRetryCount = normalizedRetryCount;
    if (!err) return;
    const details = extractUpstreamTransportError(err);
    res.locals.upstreamErrorCode = details.code || details.name || "";
    res.locals.upstreamErrorDetail = details.detail || details.message || "";
  }

  function noteCompatibilityHint(res, hint = "") {
    if (!res?.locals) return;
    const normalizedHint = String(hint || "").trim();
    if (!normalizedHint) return;
    res.locals.compatibilityHint = normalizedHint;
  }

  function noteUpstreamRequestAudit(res, body, contentType = "") {
    if (!res?.locals) return;
    res.locals.upstreamRequestContentType = parseContentType(contentType) || null;
    res.locals.upstreamRequestBody = body;
  }

  function createUpstreamIdleTimeoutError(timeoutMs = getResolvedUpstreamStreamIdleTimeoutMs()) {
    const err = new Error(`Upstream stream stalled for ${timeoutMs}ms without data.`);
    err.code = "UPSTREAM_STREAM_IDLE_TIMEOUT";
    return err;
  }

  function createIdleTimer(timeoutMs, onTimeout) {
    if (!(timeoutMs > 0) || typeof onTimeout !== "function") {
      return {
        start() {},
        refresh() {},
        stop() {}
      };
    }

    let timer = null;

    const stop = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    };

    const start = () => {
      stop();
      timer = setTimeout(() => {
        timer = null;
        onTimeout();
      }, timeoutMs);
      timer.unref?.();
    };

    return {
      start,
      refresh: start,
      stop
    };
  }

  async function readUpstreamChunkWithIdleTimeout(reader, upstream, timeoutMs = getResolvedUpstreamStreamIdleTimeoutMs()) {
    if (!(timeoutMs > 0)) {
      return await reader.read();
    }

    let timer = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const timeoutError = createUpstreamIdleTimeoutError(timeoutMs);
            const cancelReader = typeof reader?.cancel === "function" ? reader.cancel.bind(reader) : null;
            if (cancelReader) {
              cancelReader(timeoutError).catch(() => {});
            } else {
              cancelUpstreamBody(upstream).catch(() => {});
            }
            reject(timeoutError);
          }, timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchUpstreamWithRetry(targetUrl, init, res) {
    try {
      const result = await fetchWithUpstreamRetryImpl(targetUrl, init, {
        requestTimeoutMs: getResolvedUpstreamStreamIdleTimeoutMs(),
        onRetry: ({ retryCount, code, name, detail }) => {
          noteUpstreamRetry(res, retryCount + 1, {
            code: code || name || "",
            message: detail || code || name || "fetch failed"
          });
        }
      });
      noteUpstreamRetry(res, result.retryCount, result.lastTransportError);
      return result.response;
    } catch (err) {
      noteUpstreamRetry(res, err?.retryCount || 0, err);
      throw err;
    }
  }

  async function pipeUpstreamBodyToResponse(upstream, res) {
    if (!upstream?.body) {
      res.end();
      return;
    }

    if (isResponseClosed(res)) {
      await cancelUpstreamBody(upstream);
      return;
    }

    const bodyStream = Readable.fromWeb(upstream.body);
    bodyStream.on("error", () => {});
    const idleTimer = createIdleTimer(getResolvedUpstreamStreamIdleTimeoutMs(), () => {
      const timeoutError = createUpstreamIdleTimeoutError();
      cancelUpstreamBody(upstream).catch(() => {});
      bodyStream.destroy(timeoutError);
    });
    bodyStream.on("data", () => {
      idleTimer.refresh();
    });
    bodyStream.on("end", () => {
      idleTimer.stop();
    });
    bodyStream.on("close", () => {
      idleTimer.stop();
    });
    bodyStream.on("error", () => {
      idleTimer.stop();
    });
    idleTimer.start();

    try {
      await new Promise((resolve) => {
        try {
          pipeline(bodyStream, res, (err) => {
            if (err && !isClientDisconnectError(err) && !isResponseClosed(res)) {
              noteUpstreamRetry(res, res?.locals?.upstreamRetryCount || 0, err);
              if (!res.headersSent) {
                res.status(502).json({
                  error: "upstream_stream_failed",
                  message: err?.message || "stream failed",
                  code: err?.code || err?.cause?.code || null,
                  detail: extractUpstreamTransportError(err).detail || null,
                  retry_count: Number(res?.locals?.upstreamRetryCount || 0)
                });
              } else if (!res.writableEnded) {
                res.end();
              }
            }
            resolve();
          });
        } catch (err) {
          if (!isClientDisconnectError(err) && !isResponseClosed(res)) {
            noteUpstreamRetry(res, res?.locals?.upstreamRetryCount || 0, err);
            if (!res.headersSent) {
              res.status(502).json({
                error: "upstream_stream_failed",
                message: err?.message || "stream failed",
                code: err?.code || err?.cause?.code || null,
                detail: extractUpstreamTransportError(err).detail || null,
                retry_count: Number(res?.locals?.upstreamRetryCount || 0)
              });
            } else if (!res.writableEnded) {
              res.end();
            }
          }
          resolve();
        }
      });
    } finally {
      idleTimer.stop();
      bodyStream.destroy();
    }
  }

  async function readUpstreamTextOrThrow(upstream) {
    try {
      if (!upstream?.body) {
        return await upstream.text();
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      try {
        while (true) {
          const { done, value } = await readUpstreamChunkWithIdleTimeout(reader, upstream);
          if (done) break;
          if (!value) continue;
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
        return raw;
      } finally {
        reader.releaseLock?.();
      }
    } catch (err) {
      const details = extractUpstreamTransportError(err);
      throw new Error(`Upstream body read failed: ${details.message || "stream failed"}`, { cause: err });
    }
  }

  return {
    noteUpstreamRetry,
    noteCompatibilityHint,
    noteUpstreamRequestAudit,
    fetchUpstreamWithRetry,
    pipeUpstreamBodyToResponse,
    readUpstreamTextOrThrow
  };
}
