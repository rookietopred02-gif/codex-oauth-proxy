import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createProxyRouteHandlers } from "../src/routes/proxy-handlers.js";
import {
  RESPONSES_METHOD_CONTRACT
} from "../src/protocols/openai/responses-contract.js";

const responsesOpenApiContract = JSON.parse(
  readFileSync(new URL("./fixtures/openai-responses-openapi.json", import.meta.url), "utf8")
);

function createMockRequest({ method, originalUrl, body }) {
  const rawBody =
    body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return {
    method,
    originalUrl,
    url: originalUrl,
    path: originalUrl,
    headers: {},
    rawBody
  };
}

function createMockResponse() {
  const events = new EventEmitter();
  const emitCompleted = () => {
    events.emit("finish");
    events.emit("close");
  };
  return {
    locals: {},
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    closed: false,
    headers: new Map(),
    body: "",
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return this.headers.get(String(name).toLowerCase());
    },
    write(chunk) {
      this.headersSent = true;
      this.body += Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) {
        this.headersSent = true;
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.closed = true;
      emitCompleted();
      return this;
    },
    send(payload) {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
      emitCompleted();
      return this;
    },
    json(payload) {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.jsonPayload = payload;
      emitCompleted();
      return this;
    },
    on(eventName, handler) {
      events.on(eventName, handler);
      return this;
    },
    once(eventName, handler) {
      events.once(eventName, handler);
      return this;
    },
    off(eventName, handler) {
      events.off(eventName, handler);
      return this;
    }
  };
}

function createHandlers({ normalizeResponsesImpl, fetchImpl, configOverrides = {}, contextOverrides = {} }) {
  return createProxyRouteHandlers({
    config: {
      upstreamMode: "codex-chatgpt",
      upstreamBaseUrl: "https://example.test",
      authMode: "codex-oauth",
      codex: {
        defaultModel: "gpt-5.4"
      },
      ...configOverrides
    },
    runtimeStats: {},
    recentRequestsStore: { append() {} },
    hopByHop: new Set(),
    runtimeAuditMaxBodyBytes: 1024,
    runtimeAuditMaxTextChars: 1024,
    async readJsonBody(req) {
      return req.rawBody.length > 0 ? JSON.parse(req.rawBody.toString("utf8")) : undefined;
    },
    async readRawBody(req) {
      return req.rawBody || Buffer.alloc(0);
    },
    getCachedJsonBody(req) {
      return req.rawBody.length > 0 ? JSON.parse(req.rawBody.toString("utf8")) : undefined;
    },
    extractPreviousResponseId() {
      return "";
    },
    extractUpstreamTransportError(err) {
      return { message: err.message, code: err.code || null, detail: null, name: err.name || null };
    },
    isPreviousResponseIdUnsupportedError() {
      return false;
    },
    formatPayloadForAudit() {
      return "";
    },
    inferProtocolType() {
      return "openai-v1";
    },
    isProxyApiPath() {
      return true;
    },
    parseContentType(value) {
      return String(value || "");
    },
    sanitizeAuditPath(value) {
      return value;
    },
    toChunkBuffer(chunk) {
      return Buffer.from(chunk);
    },
    normalizeCherryAnthropicAgentOriginalUrl() {
      return "";
    },
    isGeminiNativeAliasPath() {
      return false;
    },
    chooseProtocolForV1ChatCompletions() {
      return "codex-chatgpt";
    },
    async handleGeminiProtocol() {
      throw new Error("Not used in proxy route tests.");
    },
    async handleAnthropicProtocol() {
      throw new Error("Not used in proxy route tests.");
    },
    async getValidAuthContext() {
      return {
        accessToken: "token",
        accountId: "acct_123",
        releaseLease() {}
      };
    },
    getCodexOriginator() {
      return "codex-pro-max";
    },
    noteUpstreamRetry() {},
    noteCompatibilityHint() {},
    noteUpstreamRequestAudit() {},
    async fetchUpstreamWithRetry(url, init) {
      return await fetchImpl(url, init);
    },
    async pipeUpstreamBodyToResponse(upstream, res) {
      const text = await upstream.text();
      res.status(upstream.status);
      res.send(text);
    },
    async readUpstreamTextOrThrow(upstream) {
      return await upstream.text();
    },
    normalizeCodexResponsesRequestBody: normalizeResponsesImpl,
    normalizeChatCompletionsRequestBody() {
      throw new Error("Not used in proxy route tests.");
    },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    buildResponsesChainEntry() {
      return null;
    },
    codexResponsesChain: {
      lookup() {
        return null;
      },
      remember() {}
    },
    expandResponsesRequestBodyFromChain(body) {
      return body;
    },
    isCodexMultiAccountEnabled() {
      return false;
    },
    isCodexPoolRetryEnabled() {
      return false;
    },
    shouldRotateCodexAccountForStatus() {
      return false;
    },
    async maybeMarkCodexPoolFailure() {},
    async maybeCaptureCodexUsageFromHeaders() {},
    async maybeMarkCodexPoolSuccess() {},
    truncate(value) {
      return String(value || "");
    },
    parseResponsesResultFromSse() {
      return { completed: null, failed: null };
    },
    extractCompletedResponseFromJson() {
      return null;
    },
    convertResponsesToChatCompletion(value) {
      return value;
    },
    async pipeCodexSseAsChatCompletions() {
      throw new Error("Not used in proxy route tests.");
    },
    async pipeSseAndCaptureTokenUsage() {
      throw new Error("Not used in proxy route tests.");
    },
    async handleGeminiNativeProxy() {
      throw new Error("Not used in proxy route tests.");
    },
    async handleAnthropicNativeProxy() {
      throw new Error("Not used in proxy route tests.");
    },
    normalizeTokenUsage() {
      return null;
    },
    extractTokenUsageFromAuditResponse() {
      return null;
    },
    estimateOpenAIChatCompletionTokens() {
      return 0;
    },
    mergeNormalizedTokenUsage() {
      return null;
    },
    resolveAuditAccountLabel() {
      return "";
    },
    async handleAnthropicModelsList() {
      throw new Error("Not used in proxy route tests.");
    },
    isAnthropicNativeRequest() {
      return false;
    },
    getOpenAICompatibleModelIds() {
      return [];
    },
    isCodexTokenInvalidatedError() {
      return false;
    },
    codexResponseAffinity: {
      lookup() {
        return null;
      },
      remember() {},
      forget() {}
    },
    getAuthModeHint() {
      return "";
    },
    nextRuntimeRequestSeq() {
      return 1;
    },
    ...contextOverrides
  });
}

test("Responses method contract fixture matches the runtime method contract", () => {
  assert.deepEqual(
    responsesOpenApiContract.methods.map(({ id, method, path }) => ({ id, method, path })),
    RESPONSES_METHOD_CONTRACT
  );
});

test("POST /v1/responses applies create normalization before forwarding upstream", async () => {
  let normalizeCalls = 0;
  let normalizeRawBody = null;
  let capturedUrl = "";
  let capturedInit = null;
  const normalizedJson = {
    model: "gpt-5.4",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      normalizeCalls += 1;
      normalizeRawBody = rawBody.toString("utf8");
      return {
        body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
        json: normalizedJson,
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4",
        modelRoute: {
          requestedModel: "gpt-5.4",
          mappedModel: "gpt-5.4"
        }
      };
    },
    async fetchImpl(url, init) {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const requestBody = responsesOpenApiContract.create.sample_create_request;
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: requestBody
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(normalizeCalls, 1);
  assert.equal(normalizeRawBody, JSON.stringify(requestBody));
  assert.equal(capturedUrl, "https://example.test/codex/responses");
  assert.equal(Buffer.from(capturedInit.body).toString("utf8"), JSON.stringify(normalizedJson));
});

test("Responses WebSocket session helper rejects non-codex upstream modes", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      throw new Error("should not reach upstream fetch");
    },
    configOverrides: {
      upstreamMode: "gemini-v1beta"
    }
  });

  await assert.rejects(
    () =>
      handlers.openResponsesCreateProxySession(
        {
          method: "POST",
          originalUrl: "/v1/responses",
          url: "/v1/responses",
          headers: {}
        },
        null,
        {
          originalUrl: "/v1/responses",
          requestBody: Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "hi" }), "utf8"),
          parsedRequestBody: { model: "gpt-5.4", input: "hi" }
        }
      ),
    /UPSTREAM_MODE=codex-chatgpt/
  );
});

test("Responses create proxy session replays local chain and strips previous_response_id before forwarding", async () => {
  let capturedInit = null;
  let chainLookupCalls = 0;
  let expandCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        json,
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    contextOverrides: {
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponsesChain: {
        lookup() {
          chainLookupCalls += 1;
          return {
            responseId: "resp_prev_123",
            inputHistory: [
              { role: "user", content: [{ type: "input_text", text: "first turn" }] },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
            ]
          };
        },
        remember() {}
      },
      expandResponsesRequestBodyFromChain(body, entry) {
        expandCalls += 1;
        assert.equal(body.previous_response_id, "resp_prev_123");
        assert.equal(entry.responseId, "resp_prev_123");
        return {
          model: body.model,
          input: [
            ...entry.inputHistory,
            ...body.input
          ]
        };
      }
    }
  });

  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_prev_123",
    input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
  };

  const session = await handlers.openResponsesCreateProxySession(
    {
      method: "POST",
      originalUrl: "/v1/responses",
      url: "/v1/responses",
      headers: {}
    },
    createMockResponse(),
    {
      originalUrl: "/v1/responses",
      requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
      parsedRequestBody: payload
    }
  );

  assert.equal(chainLookupCalls, 1);
  assert.equal(expandCalls, 1);
  assert.deepEqual(session.normalizedResponsesRequest, {
    model: "gpt-5.4",
    input: [
      { role: "user", content: [{ type: "input_text", text: "first turn" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { role: "user", content: [{ type: "input_text", text: "next turn" }] }
    ]
  });
  assert.equal(
    Buffer.from(capturedInit.body).toString("utf8"),
    JSON.stringify({
      model: "gpt-5.4",
      input: [
        { role: "user", content: [{ type: "input_text", text: "first turn" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { role: "user", content: [{ type: "input_text", text: "next turn" }] }
      ]
    })
  );
  assert.equal(capturedInit.headers.get("accept-encoding"), "identity");
  assert.equal(session.compatibilityHint, "");
  session.release();
});

test("Responses create proxy session strips Cloudflare and forwarded headers before upstream fetch", async () => {
  let capturedHeaders = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        json,
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedHeaders = init.headers;
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });

  const session = await handlers.openResponsesCreateProxySession(
    {
      method: "POST",
      originalUrl: "/v1/responses",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer caller",
        "x-api-key": "proxy-key",
        "x-goog-api-key": "proxy-key",
        "cf-ray": "test-ray",
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
        host: "example.trycloudflare.com",
        cookie: "a=b",
        origin: "https://example.trycloudflare.com",
        referer: "https://example.trycloudflare.com/"
      }
    },
    createMockResponse(),
    {
      originalUrl: "/v1/responses",
      requestBody: Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "hello" }), "utf8"),
      parsedRequestBody: { model: "gpt-5.4", input: "hello" }
    }
  );

  assert.equal(capturedHeaders.get("cf-ray"), null);
  assert.equal(capturedHeaders.get("cf-connecting-ip"), null);
  assert.equal(capturedHeaders.get("x-forwarded-for"), null);
  assert.equal(capturedHeaders.get("x-forwarded-proto"), null);
  assert.equal(capturedHeaders.get("host"), null);
  assert.equal(capturedHeaders.get("cookie"), null);
  assert.equal(capturedHeaders.get("origin"), null);
  assert.equal(capturedHeaders.get("referer"), null);
  assert.equal(capturedHeaders.get("x-api-key"), null);
  assert.equal(capturedHeaders.get("x-goog-api-key"), null);
  assert.match(String(capturedHeaders.get("authorization") || ""), /^Bearer token$/);
  session.release();
});

test("Responses create proxy session fails locally when previous_response_id chain is missing", async () => {
  let fetchCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        json,
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    contextOverrides: {
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponsesChain: {
        lookup() {
          return null;
        },
        remember() {}
      }
    }
  });

  await assert.rejects(
    () =>
      handlers.openResponsesCreateProxySession(
        {
          method: "POST",
          originalUrl: "/v1/responses",
          url: "/v1/responses",
          headers: {}
        },
        createMockResponse(),
        {
          originalUrl: "/v1/responses",
          requestBody: Buffer.from(JSON.stringify({
            model: "gpt-5.4",
            previous_response_id: "resp_missing",
            input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
          }), "utf8"),
          parsedRequestBody: {
            model: "gpt-5.4",
            previous_response_id: "resp_missing",
            input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
          }
        }
      ),
    (err) => {
      assert.equal(err?.statusCode, 409);
      assert.equal(err?.error, "previous_response_id_chain_missing");
      assert.match(err?.message || "", /full input/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("audit middleware preserves full packets without truncation even if limits are small", () => {
  let capturedRow = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      throw new Error("not used");
    },
    contextOverrides: {
      runtimeStats: { totalRequests: 0, okRequests: 0, errorRequests: 0 },
      recentRequestsStore: {
        append(row) {
          capturedRow = row;
          return { recentRequests: [row] };
        }
      },
      runtimeAuditMaxBodyBytes: 4,
      runtimeAuditMaxTextChars: 4,
      formatPayloadForAudit(raw) {
        if (Buffer.isBuffer(raw)) return raw.toString("utf8");
        if (raw && typeof raw === "object") return JSON.stringify(raw);
        return String(raw || "");
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { prompt: "abcdefghijklmnopqrstuvwxyz" }
  });
  const res = createMockResponse();

  handlers.auditMiddleware(req, res, () => {});
  res.setHeader("content-type", "text/plain");
  res.write("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  res.end();

  assert.equal(capturedRow?.requestPacket, JSON.stringify({ prompt: "abcdefghijklmnopqrstuvwxyz" }));
  assert.equal(capturedRow?.responsePacket, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
});

test("Responses create JSON fallback accepts completed non-SSE upstream payloads", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: true,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      return new Response(
        JSON.stringify({
          status: "completed",
          usage: {
            input_tokens: 4,
            output_tokens: 5,
            total_tokens: 9
          },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    },
    contextOverrides: {
      parseResponsesResultFromSse() {
        return { completed: null, failed: null };
      },
      extractCompletedResponseFromJson(raw) {
        return JSON.parse(raw);
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", input: "hello" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonPayload, {
    status: "completed",
    usage: {
      input_tokens: 4,
      output_tokens: 5,
      total_tokens: 9
    },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "done" }]
      }
    ],
    model: "gpt-5.4"
  });
});

test("Responses create stream fallback converts completed JSON payloads into SSE", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      return new Response(
        JSON.stringify({
          id: "resp_stream_fallback",
          status: "completed",
          usage: {
            input_tokens: 4,
            output_tokens: 5,
            total_tokens: 9
          },
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    },
    contextOverrides: {
      extractCompletedResponseFromJson(raw) {
        return JSON.parse(raw);
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", stream: true, input: "hello" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(String(res.getHeader("content-type") || ""), /text\/event-stream/i);
  assert.match(res.body, /"type":"response.completed"/);
  assert.match(res.body, /"id":"resp_stream_fallback"/);
  assert.deepEqual(res.locals.tokenUsage, {
    input_tokens: 4,
    output_tokens: 5,
    total_tokens: 9
  });
});

test("Responses create stream accepts upstream SSE without content-type header", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      return new Response(
        'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"id":"resp_sse_no_header","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n',
        {
          status: 200,
          headers: {}
        }
      );
    },
    contextOverrides: {
      parseResponsesResultFromSse() {
        return {
          completed: {
            id: "resp_sse_no_header",
            status: "completed",
            usage: {
              input_tokens: 4,
              output_tokens: 5,
              total_tokens: 9
            },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }]
              }
            ]
          },
          failed: null
        };
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", stream: true, store: false, input: "hello" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(String(res.getHeader("content-type") || ""), /text\/event-stream/i);
  assert.match(res.body, /response\.completed/);
  assert.match(res.body, /resp_sse_no_header/);
  assert.deepEqual(res.locals.tokenUsage, {
    input_tokens: 4,
    output_tokens: 5,
    total_tokens: 9
  });
});

test("Responses create stream rejects truncated upstream SSE without content-type header", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      return {
        body: rawBody,
        json: JSON.parse(rawBody.toString("utf8")),
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      return new Response(
        'event: response.output_text.delta\n' +
          'data: {"type":"response.output_text.delta","delta":"hel"}\n\n',
        {
          status: 200,
          headers: {}
        }
      );
    },
    contextOverrides: {
      parseResponsesResultFromSse() {
        return {
          completed: null,
          failed: null
        };
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", stream: true, store: false, input: "hello" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "invalid_upstream_sse",
    message: "Upstream SSE ended before a terminal response event."
  });
});

test("Responses create normalization preserves temperature on non-stream requests", async () => {
  let capturedInit = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        json,
        collectCompletedResponseAsJson: true,
        model: "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    },
    contextOverrides: {
      extractCompletedResponseFromJson(raw) {
        return JSON.parse(raw);
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", input: "hello", temperature: 0.25 }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  const forwarded = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(forwarded.temperature, 0.25);
});

test("Responses create normalization preserves temperature on stream requests", async () => {
  let capturedInit = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify(json), "utf8"),
        json,
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"id":"resp_temp_stream","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" }
        }
      );
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", stream: true, input: "hello", temperature: 0.25 }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  const forwarded = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(forwarded.temperature, 0.25);
});

for (const route of responsesOpenApiContract.methods.filter((entry) => entry.expects_create_normalization === false)) {
  test(`${route.method} ${route.path} bypasses create normalization and preserves request shape`, async () => {
    let normalizeCalls = 0;
    let capturedUrl = "";
    let capturedInit = null;
    const handlers = createHandlers({
      normalizeResponsesImpl() {
        normalizeCalls += 1;
        throw new Error("create normalization should not run");
      },
      async fetchImpl(url, init) {
        capturedUrl = url;
        capturedInit = init;
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const req = createMockRequest({
      method: route.method,
      originalUrl: route.sample_original_url,
      body: route.sample_body == null ? undefined : route.sample_body
    });
    const res = createMockResponse();

    await handlers.openAIProxy(req, res);

    assert.equal(normalizeCalls, 0);
    assert.equal(capturedUrl, route.expected_upstream_url);
    assert.equal(capturedInit.method, route.method);
    if (route.sample_body === undefined || route.sample_body === null) {
      assert.equal(capturedInit.body, undefined);
    } else {
      assert.equal(Buffer.from(capturedInit.body).toString("utf8"), JSON.stringify(route.sample_body));
    }
  });
}
