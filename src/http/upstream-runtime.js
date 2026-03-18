import { Readable, pipeline } from "node:stream";

export function createUpstreamRuntimeHelpers(context) {
  const {
    maxAuditTextChars,
    extractUpstreamTransportError,
    fetchWithUpstreamRetry,
    formatPayloadForAudit,
    parseContentType
  } = context;

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
    res.locals.upstreamRequestPacket =
      formatPayloadForAudit(body, contentType, maxAuditTextChars) || "";
  }

  async function fetchUpstreamWithRetry(targetUrl, init, res) {
    try {
      const result = await fetchWithUpstreamRetry(targetUrl, init, {
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
    const bodyStream = Readable.fromWeb(upstream.body);
    bodyStream.on("error", () => {});
    await new Promise((resolve) => {
      pipeline(bodyStream, res, (err) => {
        if (err) {
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
    });
  }

  async function readUpstreamTextOrThrow(upstream) {
    try {
      return await upstream.text();
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
