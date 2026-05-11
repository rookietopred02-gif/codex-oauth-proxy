import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createUpstreamRuntimeHelpers } from "../src/http/upstream-runtime.js";
import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../src/upstream-timeouts.js";

function createMockResponse() {
  const state = {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    closed: false
  };
  const res = new Writable({
    write(_chunk, _encoding, callback) {
      state.headersSent = true;
      callback();
    }
  });

  Object.defineProperties(res, {
    headersSent: { get: () => state.headersSent },
    writableEnded: { get: () => state.writableEnded },
    writableFinished: { get: () => state.writableFinished },
    destroyed: {
      get: () => state.destroyed,
      set(value) {
        state.destroyed = Boolean(value);
      }
    },
    closed: {
      get: () => state.closed,
      set(value) {
        state.closed = Boolean(value);
      }
    }
  });

  Object.assign(res, {
    locals: {},
    statusCode: 200,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      state.headersSent = true;
      this.jsonPayload = payload;
      state.writableEnded = true;
      state.writableFinished = true;
      return this;
    },
    end() {
      state.headersSent = true;
      state.writableEnded = true;
      state.writableFinished = true;
      state.closed = true;
      return this;
    }
  });

  return res;
}

function createErroredStream(error) {
  const stream = new Readable({
    read() {
      this.destroy(error);
    }
  });
  return Readable.toWeb(stream);
}

async function withTimeout(promise, message, ms = 200) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("pipeUpstreamBodyToResponse surfaces upstream ECONNRESET as 502", async () => {
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    fetchWithUpstreamRetry: async () => {
      throw new Error("not used");
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    }
  });

  const err = new Error("socket hang up");
  err.code = "ECONNRESET";
  const upstream = {
    body: createErroredStream(err)
  };
  const res = createMockResponse();
  res.locals.upstreamRetryCount = Symbol("retry");

  await helpers.pipeUpstreamBodyToResponse(upstream, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonPayload?.error, "upstream_stream_failed");
  assert.equal(res.jsonPayload?.code, "ECONNRESET");
  assert.equal(res.jsonPayload?.retry_count, 0);
});

test("readUpstreamTextOrThrow rejects configured idle timeout when cancellation resolves pending reads", async () => {
  let cancelReason = null;
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    fetchWithUpstreamRetry: async () => {
      throw new Error("not used");
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    },
    upstreamStreamIdleTimeoutMs: 7
  });

  await assert.rejects(
    () =>
      helpers.readUpstreamTextOrThrow({
        body: new ReadableStream({
          cancel(reason) {
            cancelReason = reason;
          }
        }),
        async text() {
          throw new Error("fallback text reader should not run");
        }
      }),
    (err) => {
      assert.match(err.message, /Upstream body read failed/);
      assert.equal(err.cause?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
      assert.match(err.cause?.message || "", /7ms/);
      return true;
    }
  );

  assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
});

test("readUpstreamTextOrThrow bounds stalled non-stream text fallbacks", async () => {
  let textCallCount = 0;
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    fetchWithUpstreamRetry: async () => {
      throw new Error("not used");
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    },
    upstreamStreamIdleTimeoutMs: 7
  });

  await assert.rejects(
    withTimeout(
      helpers.readUpstreamTextOrThrow({
        body: null,
        async text() {
          textCallCount += 1;
          return await new Promise(() => {});
        }
      }),
      "readUpstreamTextOrThrow stalled on fallback text body"
    ),
    /Upstream body read failed/
  );

  assert.equal(textCallCount, 1);
});

test("fetchUpstreamWithRetry forwards request timeout from upstreamStreamIdleTimeoutMs", async () => {
  let capturedOptions = null;
  const upstreamResponse = { ok: true };
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    fetchWithUpstreamRetry: async (_targetUrl, _init, options) => {
      capturedOptions = options;
      return {
        response: upstreamResponse,
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    },
    upstreamStreamIdleTimeoutMs: 43210
  });

  const res = createMockResponse();
  const response = await helpers.fetchUpstreamWithRetry("https://example.test", { method: "POST" }, res);

  assert.equal(response, upstreamResponse);
  assert.equal(capturedOptions?.requestTimeoutMs, 43210);
  assert.equal(typeof capturedOptions?.onRetry, "function");
});

test("fetchUpstreamWithRetry uses extended default timeout when config omits it", async () => {
  let capturedOptions = null;
  const upstreamResponse = { ok: true };
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    fetchWithUpstreamRetry: async (_targetUrl, _init, options) => {
      capturedOptions = options;
      return {
        response: upstreamResponse,
        attempts: 1,
        retryCount: 0,
        lastTransportError: null
      };
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    }
  });

  const res = createMockResponse();
  const response = await helpers.fetchUpstreamWithRetry("https://example.test", { method: "POST" }, res);

  assert.equal(response, upstreamResponse);
  assert.equal(capturedOptions?.requestTimeoutMs, DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
});

test("fetchUpstreamWithRetry ignores malformed runtime timeout and retry counts", async () => {
  let capturedOptions = null;
  const upstreamResponse = { ok: true };
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    async fetchWithUpstreamRetry(_targetUrl, _init, options) {
      capturedOptions = options;
      await options.onRetry({
        retryCount: Symbol("retry"),
        code: "ECONNRESET",
        detail: "socket hang up"
      });
      return {
        response: upstreamResponse,
        attempts: 2,
        retryCount: Symbol("retry"),
        lastTransportError: null
      };
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    },
    upstreamStreamIdleTimeoutMs: Symbol("timeout")
  });

  const res = createMockResponse();
  res.locals.upstreamRetryCount = Symbol("retry");

  const response = await helpers.fetchUpstreamWithRetry("https://example.test", { method: "POST" }, res);

  assert.equal(response, upstreamResponse);
  assert.equal(capturedOptions?.requestTimeoutMs, 0);
  assert.equal(res.locals.upstreamRetryCount, 1);
  assert.equal(res.locals.upstreamErrorCode, "ECONNRESET");
});

test("fetchUpstreamWithRetry rejects decimal-form timeout and retry counts", async () => {
  let capturedOptions = null;
  const upstreamResponse = { ok: true };
  const helpers = createUpstreamRuntimeHelpers({
    parseContentType(value) {
      return String(value || "");
    },
    async fetchWithUpstreamRetry(_targetUrl, _init, options) {
      capturedOptions = options;
      await options.onRetry({
        retryCount: "1.9",
        code: "ECONNRESET",
        detail: "socket hang up"
      });
      return {
        response: upstreamResponse,
        attempts: 3,
        retryCount: "3.0",
        lastTransportError: null
      };
    },
    extractUpstreamTransportError(err) {
      return {
        code: err?.code || err?.cause?.code || "",
        detail: err?.message || err?.cause?.message || "",
        message: err?.message || err?.cause?.message || ""
      };
    },
    upstreamStreamIdleTimeoutMs: "43210.5"
  });

  const res = createMockResponse();
  res.locals.upstreamRetryCount = "2.5";

  const response = await helpers.fetchUpstreamWithRetry("https://example.test", { method: "POST" }, res);

  assert.equal(response, upstreamResponse);
  assert.equal(capturedOptions?.requestTimeoutMs, 0);
  assert.equal(res.locals.upstreamRetryCount, 1);
  assert.equal(res.locals.upstreamErrorCode, "ECONNRESET");
});
