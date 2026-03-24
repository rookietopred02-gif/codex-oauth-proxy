import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../upstream-timeouts.js";

export function isResponseClosed(res) {
  return Boolean(
    !res ||
    res.destroyed ||
    res.closed ||
    res.writableEnded ||
    res.writableFinished
  );
}

export function isStreamAbortError(err) {
  const code = String(err?.code || err?.cause?.code || "").trim();
  if (
    code === "ABORT_ERR" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ERR_INVALID_STATE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "UND_ERR_ABORTED"
  ) {
    return true;
  }
  const message = String(err?.message || err?.cause?.message || "").toLowerCase();
  return (
    message.includes("closed or destroyed stream") ||
    message.includes("invalid state") ||
    message.includes("operation was aborted") ||
    message.includes("premature close") ||
    message.includes("socket hang up")
  );
}

export async function cancelUpstreamStream(upstream, reader = null) {
  if (reader && typeof reader.cancel === "function") {
    try {
      await reader.cancel();
      return;
    } catch {}
  }

  const cancel = upstream?.body?.cancel;
  if (typeof cancel !== "function") return;
  try {
    await cancel.call(upstream.body);
  } catch {}
}

export function takeNextSseBlock(buffer) {
  if (typeof buffer !== "string" || buffer.length === 0) return null;
  const separatorMatch = /\r?\n\r?\n/.exec(buffer);
  if (!separatorMatch) return null;
  return {
    block: buffer.slice(0, separatorMatch.index),
    rest: buffer.slice(separatorMatch.index + separatorMatch[0].length)
  };
}

export function parseSseEventBlock(block) {
  if (!block || typeof block !== "string") return null;
  let event = "";
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  return {
    event,
    data: dataLines.join("\n").trim()
  };
}

export function parseSseJsonEventBlock(block) {
  const parsedBlock = parseSseEventBlock(block);
  if (!parsedBlock?.data || parsedBlock.data === "[DONE]") return null;
  try {
    return JSON.parse(parsedBlock.data);
  } catch {
    return null;
  }
}

export function createUpstreamIdleTimeoutError(
  timeoutMs = DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
) {
  const err = new Error(`Upstream SSE stalled for ${timeoutMs}ms without data.`);
  err.code = "UPSTREAM_STREAM_IDLE_TIMEOUT";
  return err;
}

export async function readUpstreamChunkWithIdleTimeout(
  reader,
  upstream,
  timeoutMs = DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS
) {
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
          const cancelReader =
            typeof reader?.cancel === "function" ? reader.cancel.bind(reader) : null;
          if (cancelReader) {
            cancelReader(timeoutError).catch(() => {});
          } else {
            cancelUpstreamStream(upstream, reader).catch(() => {});
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

export async function consumeSseBlocks(
  upstream,
  {
    reader = null,
    timeoutMs = DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
    isClosed = () => false,
    onBlock
  } = {}
) {
  if (typeof onBlock !== "function") {
    throw new TypeError("consumeSseBlocks requires an onBlock handler.");
  }

  const activeReader = reader || upstream?.body?.getReader?.();
  if (!activeReader) {
    throw new Error("No upstream SSE body.");
  }

  const ownReader = !reader;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!isClosed()) {
      let chunkResult;
      try {
        chunkResult = await readUpstreamChunkWithIdleTimeout(activeReader, upstream, timeoutMs);
      } catch (err) {
        if (isClosed()) break;
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
        await onBlock(nextBlock.block);
        if (isClosed()) break;
      }
    }

    buffer += decoder.decode();
    if (!isClosed() && buffer.trim().length > 0) {
      await onBlock(buffer);
    }
  } finally {
    if (ownReader) {
      activeReader.releaseLock?.();
    }
  }
}

export function createSseSession(
  res,
  {
    upstream = null,
    heartbeatMs = 15000,
    heartbeatChunk = ": keep-alive\n\n",
    prepareResponse = null
  } = {}
) {
  let reader = null;
  let currentUpstream = upstream;
  let responseClosed = isResponseClosed(res);
  let heartbeatRequested = false;
  let heartbeatTimer = null;
  let prepared = false;
  let wroteChunk = false;

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const ensurePrepared = () => {
    if (prepared) return true;
    if (responseClosed || isResponseClosed(res)) {
      markClosed();
      return false;
    }
    prepareResponse?.();
    prepared = true;
    return true;
  };

  const ensureHeartbeatStarted = () => {
    if (
      !heartbeatRequested ||
      heartbeatTimer ||
      !wroteChunk ||
      responseClosed ||
      isResponseClosed(res)
    ) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      if (responseClosed || isResponseClosed(res)) {
        markClosed();
        return;
      }
      try {
        res.write(heartbeatChunk);
      } catch {
        markClosed();
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  const markClosed = () => {
    if (responseClosed) return;
    responseClosed = true;
    stopHeartbeat();
    cancelUpstreamStream(currentUpstream, reader).catch(() => {});
  };

  const write = (chunk) => {
    if (!ensurePrepared()) return false;
    if (responseClosed || isResponseClosed(res)) {
      markClosed();
      return false;
    }
    try {
      res.write(chunk);
      wroteChunk = true;
      ensureHeartbeatStarted();
      return true;
    } catch (err) {
      if (isStreamAbortError(err)) {
        markClosed();
        return false;
      }
      throw err;
    }
  };

  const startHeartbeat = () => {
    if (!(heartbeatMs > 0)) return;
    heartbeatRequested = true;
    ensureHeartbeatStarted();
  };

  const handleResponseClose = () => {
    markClosed();
  };

  res.once("close", handleResponseClose);
  res.once("error", handleResponseClose);

  return {
    attachReader(nextReader) {
      reader = nextReader;
    },
    setUpstream(nextUpstream) {
      currentUpstream = nextUpstream;
    },
    hasWritten() {
      return wroteChunk;
    },
    isClosed() {
      return responseClosed || isResponseClosed(res);
    },
    write,
    startHeartbeat,
    end() {
      stopHeartbeat();
      if (responseClosed || isResponseClosed(res)) return;
      try {
        res.end();
      } catch (err) {
        if (!isStreamAbortError(err)) throw err;
      }
    },
    cleanup() {
      stopHeartbeat();
      res.off("close", handleResponseClose);
      res.off("error", handleResponseClose);
    }
  };
}
