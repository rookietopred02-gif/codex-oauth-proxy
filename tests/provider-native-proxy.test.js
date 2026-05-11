import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "../src/http/request-body.js";

function createMockRequest({ originalUrl, rawBody, headers = {} }) {
  return {
    method: "POST",
    originalUrl,
    url: originalUrl,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    rawBody: Buffer.from(rawBody, "utf8")
  };
}

function createOversizedMockRequest({ originalUrl, headers = {} }) {
  return {
    method: "POST",
    originalUrl,
    url: originalUrl,
    headers: {
      "content-type": "application/json",
      "content-length": String(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      ...headers
    },
    async *[Symbol.asyncIterator]() {}
  };
}

function createMockResponse() {
  return {
    locals: {},
    statusCode: 200,
    jsonPayload: null,
    headers: new Map(),
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    write(chunk) {
      this.body += Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      return this;
    }
  };
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

function createStalledResponse(status = 400) {
  let cancelReason = null;
  const body = new ReadableStream({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  return {
    response: new Response(body, {
      status,
      headers: { "content-type": "application/json" }
    }),
    get cancelReason() {
      return cancelReason;
    }
  };
}

async function importServerTesting(label, envOverrides = {}) {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";
  const previousEnv = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const serverModule = await import(`../src/server.js?provider-native-proxy=${label}-${Date.now()}`);
    return serverModule.__testing;
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Gemini direct native proxy rejects malformed JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("gemini-invalid-json");
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createMockRequest({
        originalUrl: "/v1beta/models/gemini-2.5-flash:generateContent",
        rawBody: '{"contents":['
      });
      const res = createMockResponse();

      await testing.handleGeminiNativeProxy(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.jsonPayload, {
        error: {
          code: 400,
          message: "Invalid JSON body for Gemini endpoint.",
          status: "INVALID_ARGUMENT"
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini direct native proxy rejects oversized JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("gemini-oversized-json");
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createOversizedMockRequest({
        originalUrl: "/v1beta/models/gemini-2.5-flash:generateContent"
      });
      const res = createMockResponse();

      await testing.handleGeminiNativeProxy(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.jsonPayload, {
        error: {
          code: 413,
          message: `Request body exceeds the ${DEFAULT_MAX_REQUEST_BODY_BYTES} byte limit.`,
          status: "INVALID_ARGUMENT"
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini direct native proxy bounds stalled upstream error bodies", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let upstream = null;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    upstream = createStalledResponse(400);
    return upstream.response;
  };

  try {
    const testing = await importServerTesting("gemini-stalled-error-body", {
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "7"
    });
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createMockRequest({
        originalUrl: "/v1beta/models/gemini-2.5-flash:generateContent",
        rawBody: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }]
        })
      });
      const res = createMockResponse();

      await withTimeout(
        testing.handleGeminiNativeProxy(req, res),
        "Gemini native proxy stalled on upstream error body"
      );

      assert.equal(fetchCalls, 1);
      assert.equal(res.statusCode, 400);
      assert.equal(
        res.jsonPayload?.error?.message,
        "Gemini upstream request failed with HTTP 400."
      );
      assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini direct OpenAI-compat proxy preserves oversized JSON status before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("gemini-openai-compat-oversized-json");
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createOversizedMockRequest({
        originalUrl: "/v1/chat/completions"
      });
      const res = createMockResponse();

      await testing.handleGeminiProtocol(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.jsonPayload, {
        error: {
          code: 413,
          message: `Request body exceeds the ${DEFAULT_MAX_REQUEST_BODY_BYTES} byte limit.`,
          status: "INVALID_ARGUMENT"
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini direct OpenAI-compat proxy rejects malformed JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("gemini-openai-compat-invalid-json");
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: '{"messages":['
      });
      const res = createMockResponse();

      await testing.handleGeminiProtocol(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.jsonPayload, {
        error: {
          code: 400,
          message: "Invalid JSON body for /v1/chat/completions.",
          status: "INVALID_ARGUMENT"
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini direct OpenAI-compat proxy normalizes malformed usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "hello" }]
            },
            finishReason: "STOP"
          }
        ],
        usageMetadata: {
          promptTokenCount: "not-a-number",
          candidatesTokenCount: {},
          totalTokenCount: Number.NaN
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const testing = await importServerTesting("gemini-openai-compat-malformed-usage");
    const previousAuthMode = testing.config.authMode;
    const previousGemini = { ...testing.config.gemini };

    try {
      testing.config.authMode = "profile-store";
      testing.config.gemini = {
        ...testing.config.gemini,
        apiKey: `AIza${"A".repeat(24)}`,
        baseUrl: "https://example.invalid/v1beta"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: JSON.stringify({
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      const res = createMockResponse();

      await testing.handleGeminiProtocol(req, res);

      assert.equal(fetchCalls, 1);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload.usage, {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });
    } finally {
      testing.config.authMode = previousAuthMode;
      testing.config.gemini = previousGemini;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct native proxy rejects malformed JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("anthropic-invalid-json");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/messages",
        rawBody: '{"messages":['
      });
      const res = createMockResponse();

      await testing.handleAnthropicNativeProxy(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.jsonPayload, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON body for Anthropic endpoint."
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct native proxy rejects oversized JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("anthropic-oversized-json");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createOversizedMockRequest({
        originalUrl: "/v1/messages"
      });
      const res = createMockResponse();

      await testing.handleAnthropicNativeProxy(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.jsonPayload, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Request body exceeds the ${DEFAULT_MAX_REQUEST_BODY_BYTES} byte limit.`
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct native proxy bounds stalled upstream error bodies", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let upstream = null;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    upstream = createStalledResponse(400);
    return upstream.response;
  };

  try {
    const testing = await importServerTesting("anthropic-stalled-error-body", {
      UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "7"
    });
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/messages",
        rawBody: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }]
        })
      });
      const res = createMockResponse();

      await withTimeout(
        testing.handleAnthropicNativeProxy(req, res),
        "Anthropic native proxy stalled on upstream error body"
      );

      assert.equal(fetchCalls, 1);
      assert.equal(res.statusCode, 400);
      assert.equal(
        res.jsonPayload?.error?.message,
        "Anthropic upstream request failed with HTTP 400."
      );
      assert.equal(upstream.cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy rejects malformed JSON before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-invalid-json");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: '{"messages":['
      });
      const res = createMockResponse();

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.jsonPayload, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON body for /v1/chat/completions."
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy preserves oversized JSON status before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-oversized-json");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createOversizedMockRequest({
        originalUrl: "/v1/chat/completions"
      });
      const res = createMockResponse();

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(fetchCalls, 0);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.jsonPayload, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Request body exceeds the ${DEFAULT_MAX_REQUEST_BODY_BYTES} byte limit.`
        }
      });
      assert.equal(res.locals.upstreamRequestBody, undefined);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy normalizes malformed usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: "not-a-number",
          output_tokens: {}
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-malformed-usage");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      const res = createMockResponse();

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(fetchCalls, 1);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload.usage, {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy defaults malformed max_tokens before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamPayload = null;
  globalThis.fetch = async (_url, init) => {
    upstreamPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-malformed-max-tokens");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: "not-a-number"
        })
      });
      const res = createMockResponse();

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(upstreamPayload.max_tokens, 4096);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy defaults decimal-form max_tokens before upstream fetch", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamPayload = null;
  globalThis.fetch = async (_url, init) => {
    upstreamPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 2
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-decimal-max-tokens");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: "2.9"
        })
      });
      const res = createMockResponse();

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(upstreamPayload.max_tokens, 4096);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic direct OpenAI-compat proxy normalizes malformed retry metadata on transport failures", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("permanent upstream failure");
  };

  try {
    const testing = await importServerTesting("anthropic-openai-compat-malformed-retry-count");
    const previousAnthropic = { ...testing.config.anthropic };

    try {
      testing.config.anthropic = {
        ...testing.config.anthropic,
        apiKey: `sk-ant-${"A".repeat(20)}`,
        baseUrl: "https://example.invalid/v1"
      };

      const req = createMockRequest({
        originalUrl: "/v1/chat/completions",
        rawBody: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      const res = createMockResponse();
      Object.defineProperty(res.locals, "upstreamRetryCount", {
        configurable: true,
        get() {
          return Symbol("retry-count");
        },
        set() {}
      });

      await testing.handleAnthropicProtocol(req, res);

      assert.equal(fetchCalls, 1);
      assert.equal(res.statusCode, 502);
      assert.equal(res.jsonPayload?.error, "upstream_unreachable");
      assert.equal(res.jsonPayload?.retry_count, 0);
    } finally {
      testing.config.anthropic = previousAnthropic;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
