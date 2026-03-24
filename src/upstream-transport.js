const DEFAULT_UPSTREAM_TRANSPORT_RETRY_DELAYS_MS = [400, 1200, 2400];

const RETRYABLE_TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED"
]);

const RETRYABLE_TRANSPORT_MESSAGE_PATTERNS = [
  /fetch failed/i,
  /timed out/i,
  /timeout/i,
  /socket hang up/i,
  /connection reset/i,
  /network/i,
  /econnreset/i,
  /econnrefused/i,
  /und_err_/i,
  /terminated/i,
  /other side closed/i,
  /headers timeout/i,
  /body timeout/i
];

const RETRYABLE_UPSTREAM_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function clip(text, maxLen = 400) {
  const value = typeof text === "string" ? text.trim() : String(text || "").trim();
  if (!value) return "";
  return value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
}

function normalizeMessage(err) {
  return clip(
    err?.message || err?.cause?.message || err?.stack || err?.cause?.stack || "Unknown upstream transport error."
  );
}

function createUpstreamRequestTimeoutError(timeoutMs) {
  const err = new Error(`Upstream request timed out after ${timeoutMs}ms.`);
  err.code = "ETIMEDOUT";
  err.upstreamTransport = {
    code: "UPSTREAM_REQUEST_TIMEOUT",
    name: "TimeoutError",
    message: err.message,
    detail: err.message,
    retryable: true
  };
  return err;
}

function combineAbortSignals(...signals) {
  const activeSignals = signals.filter((signal) => signal && typeof signal.aborted === "boolean");
  if (activeSignals.length === 0) return null;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal?.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  let detached = false;
  const cleanupCallbacks = [];
  const cleanup = () => {
    if (detached) return;
    detached = true;
    for (const fn of cleanupCallbacks) {
      try {
        fn();
      } catch {}
    }
  };

  const forwardAbort = (signal) => {
    if (controller.signal.aborted) return;
    controller.abort(signal.reason);
    cleanup();
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      forwardAbort(signal);
      break;
    }
    const onAbort = () => forwardAbort(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanupCallbacks.push(() => signal.removeEventListener("abort", onAbort));
  }

  return controller.signal;
}

async function fetchWithRequestTimeout(fetchImpl, targetUrl, init, timeoutMs) {
  if (!(timeoutMs > 0)) {
    return await fetchImpl(targetUrl, init);
  }

  const timeoutController = new AbortController();
  const mergedSignal = combineAbortSignals(init?.signal || null, timeoutController.signal);
  const nextInit = mergedSignal ? { ...init, signal: mergedSignal } : init;
  const timeoutError = createUpstreamRequestTimeoutError(timeoutMs);
  let timedOut = false;
  let timer = null;

  try {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(timeoutError);
    }, timeoutMs);
    timer.unref?.();
    return await fetchImpl(targetUrl, nextInit);
  } catch (err) {
    if (timedOut) {
      throw timeoutError;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function discardResponseBody(response) {
  if (!response) return;
  try {
    if (typeof response.arrayBuffer === "function") {
      await response.arrayBuffer();
      return;
    }
  } catch {}

  try {
    const cancel = response?.body?.cancel;
    if (typeof cancel === "function") {
      await cancel.call(response.body);
    }
  } catch {}
}

async function summarizeRetryableResponse(response) {
  const status = Number(response?.status || 0);
  const statusText = clip(response?.statusText || "");
  let bodyPreview = "";
  try {
    if (typeof response?.clone === "function") {
      bodyPreview = clip(await response.clone().text(), 240);
    }
  } catch {}

  const message = clip(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`.trim());
  const detail = bodyPreview ? clip(`${message} | ${bodyPreview}`) : message;
  return {
    code: status ? `HTTP_${status}` : "",
    name: status ? `HTTP ${status}` : "",
    message,
    detail,
    retryable: RETRYABLE_UPSTREAM_STATUS_CODES.has(status)
  };
}

export function extractUpstreamTransportError(err) {
  if (err?.upstreamTransport && typeof err.upstreamTransport === "object") {
    return {
      code: typeof err.upstreamTransport.code === "string" ? err.upstreamTransport.code : "",
      name: typeof err.upstreamTransport.name === "string" ? err.upstreamTransport.name : "",
      message: clip(err.upstreamTransport.message || normalizeMessage(err)),
      detail: clip(err.upstreamTransport.detail || normalizeMessage(err)),
      retryable: Boolean(err.upstreamTransport.retryable)
    };
  }

  const code = String(err?.code || err?.cause?.code || "").trim();
  const name = String(err?.name || err?.cause?.name || "").trim();
  const message = normalizeMessage(err);
  const detailParts = [];
  if (code) detailParts.push(`code=${code}`);
  if (name && name !== code) detailParts.push(`name=${name}`);
  if (message) detailParts.push(message);
  const detail = clip(detailParts.join(" | ") || message);
  const haystack = `${code} ${name} ${message}`;
  const retryable =
    (code && RETRYABLE_TRANSPORT_ERROR_CODES.has(code)) ||
    RETRYABLE_TRANSPORT_MESSAGE_PATTERNS.some((pattern) => pattern.test(haystack));

  return {
    code,
    name,
    message,
    detail,
    retryable
  };
}

export function isPreviousResponseIdUnsupportedError(statusCode, reason) {
  if (Number(statusCode || 0) !== 400) return false;
  const text = String(reason || "").toLowerCase();
  return text.includes("previous_response_id") && (text.includes("unsupported") || text.includes("unknown parameter"));
}

export async function fetchWithUpstreamRetry(targetUrl, init, options = {}) {
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const sleepImpl =
    typeof options.sleepImpl === "function"
      ? options.sleepImpl
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : null;
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs
        .filter((value) => Number.isFinite(Number(value)) && Number(value) >= 0)
        .map((value) => Number(value))
    : DEFAULT_UPSTREAM_TRANSPORT_RETRY_DELAYS_MS;
  const requestTimeoutMs = Math.max(0, Number(options.requestTimeoutMs || 0));

  let attempts = 0;
  let lastError = null;

  while (attempts < retryDelaysMs.length + 1) {
    attempts += 1;
    try {
      const response = await fetchWithRequestTimeout(fetchImpl, targetUrl, init, requestTimeoutMs);
      const retryCount = Math.max(0, attempts - 1);
      const nextDelayMs = retryDelaysMs[retryCount];
      if (RETRYABLE_UPSTREAM_STATUS_CODES.has(Number(response?.status || 0))) {
        const details = await summarizeRetryableResponse(response);
        lastError = details;
        if (!Number.isFinite(nextDelayMs)) {
          const wrapped = new Error(details.message || "upstream request failed");
          wrapped.upstreamTransport = details;
          wrapped.attempts = attempts;
          wrapped.retryCount = retryCount;
          throw wrapped;
        }
        if (onRetry) {
          await onRetry({
            ...details,
            attempts,
            retryCount,
            nextDelayMs,
            targetUrl: String(targetUrl || "")
          });
        }
        await discardResponseBody(response);
        await sleepImpl(nextDelayMs);
        continue;
      }
      return {
        response,
        attempts,
        retryCount,
        lastTransportError: lastError
      };
    } catch (err) {
      const details = extractUpstreamTransportError(err);
      lastError = details;
      const retryCount = Math.max(0, attempts - 1);
      const nextDelayMs = retryDelaysMs[retryCount];
      const canRetry = details.retryable && Number.isFinite(nextDelayMs);
      if (!canRetry) {
        const wrapped = new Error(details.message || "fetch failed", { cause: err });
        wrapped.upstreamTransport = details;
        wrapped.attempts = attempts;
        wrapped.retryCount = retryCount;
        throw wrapped;
      }
      if (onRetry) {
        await onRetry({
          ...details,
          attempts,
          retryCount,
          nextDelayMs,
          targetUrl: String(targetUrl || "")
        });
      }
      await sleepImpl(nextDelayMs);
    }
  }

  const details = lastError || extractUpstreamTransportError(new Error("fetch failed"));
  const wrapped = new Error(details.message || "fetch failed");
  wrapped.upstreamTransport = details;
  wrapped.attempts = attempts;
  wrapped.retryCount = Math.max(0, attempts - 1);
  throw wrapped;
}
