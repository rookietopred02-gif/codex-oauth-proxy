import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import test from "node:test";

import { createProxyRouteHandlers } from "../src/routes/proxy-handlers.js";
import {
  mergeNormalizedTokenUsage,
  normalizeTokenUsage
} from "../src/http/token-usage.js";
import { createOpenAIRequestNormalizationHelpers } from "../src/protocols/openai/request-normalization.js";
import { createOpenAIResponsesCompatHelpers } from "../src/protocols/openai/responses-compat.js";
import {
  OFFICIAL_RESPONSES_METHOD_CONTRACT,
  RESPONSES_METHOD_CONTRACT
} from "../src/protocols/openai/responses-contract.js";
import {
  buildResponsesChainEntry,
  expandResponsesRequestBodyFromChain
} from "../src/responses-chain-store.js";

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
      requestAudit: {
        capturePackets: false,
        maxPacketChars: 65536
      },
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
      if (req.rawBody.length === 0) return undefined;
      try {
        return JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        const error = new Error("Body must be valid JSON.");
        error.code = "invalid_json";
        error.statusCode = 400;
        throw error;
      }
    },
    async readRawBody(req) {
      return req.rawBody || Buffer.alloc(0);
    },
    getCachedJsonBody(req) {
      if (req.rawBody.length === 0) return undefined;
      try {
        return JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        return undefined;
      }
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
    async bridgeCodexResponsesCollaborationMode(body) {
      return body;
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
    async getExecutableModelCandidateIds() {
      return null;
    },
    async getOfficialModelCandidateIds() {
      return [];
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

function createRealResponsesNormalizer() {
  return createOpenAIRequestNormalizationHelpers({
    config: {
      upstreamMode: "codex-chatgpt",
      codex: {
        defaultModel: "gpt-5.4",
        defaultInstructions: "Default instructions",
        defaultServiceTier: "priority",
        planModeReasoningEffort: "high"
      }
    },
    resolveCodexCompatibleRoute(model) {
      return {
        requestedModel: model || "gpt-5.4",
        mappedModel: model || "gpt-5.4"
      };
    },
    resolveReasoningEffort(value) {
      return value || "medium";
    },
    applyReasoningEffortDefaults(target, reasoningEffort) {
      if (!target.reasoning || typeof target.reasoning !== "object") {
        target.reasoning = {};
      }
      if (!target.reasoning.effort) {
        target.reasoning.effort = reasoningEffort || "medium";
      }
    }
  });
}

test("Responses method contract fixture matches the runtime method contract", () => {
  assert.deepEqual(
    responsesOpenApiContract.methods.map(({ id, method, path }) => ({ id, method, path })),
    OFFICIAL_RESPONSES_METHOD_CONTRACT
  );
});

test("Responses local extension fixture remains separate from the official method contract", () => {
  assert.deepEqual(
    responsesOpenApiContract.local_extension_methods.map(({ id, method, path }) => ({ id, method, path })),
    RESPONSES_METHOD_CONTRACT.filter(({ id }) => id === "compact" || id === "input_tokens")
  );
});

test("GET /v1/models prefers scoped executable model candidates", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in models list test.");
    },
    async fetchImpl() {
      throw new Error("Not used in models list test.");
    },
    contextOverrides: {
      async getExecutableModelCandidateIds() {
        return ["gpt-5.4"];
      },
      async getOfficialModelCandidateIds() {
        throw new Error("global catalog should not be used when scoped candidates are available");
      },
      getOpenAICompatibleModelIds() {
        return ["gpt-5.4", "gpt-5.5"];
      }
    }
  });
  const req = createMockRequest({ method: "GET", originalUrl: "/v1/models" });
  const res = createMockResponse();

  await handlers.modelsList(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonPayload?.data?.map((item) => item.id), ["gpt-5.4"]);
});

test("GET /v1/models prefers dynamic official model candidates so newly exposed models are listed", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in models list test.");
    },
    async fetchImpl() {
      throw new Error("Not used in models list test.");
    },
    contextOverrides: {
      async getOfficialModelCandidateIds() {
        return ["gpt-5.4", "gpt-5.5", "gpt-5.5-codex"];
      },
      getOpenAICompatibleModelIds() {
        return ["gpt-5.4", "gpt-5.3-codex"];
      }
    }
  });
  const req = createMockRequest({ method: "GET", originalUrl: "/v1/models" });
  const res = createMockResponse();

  await handlers.modelsList(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.jsonPayload?.data?.map((item) => item.id),
    ["gpt-5.4", "gpt-5.5", "gpt-5.5-codex"]
  );
});

test("GET /v1/models falls back to local compatible model ids when the dynamic catalog is unavailable", async () => {
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in models list test.");
    },
    async fetchImpl() {
      throw new Error("Not used in models list test.");
    },
    contextOverrides: {
      async getOfficialModelCandidateIds() {
        throw new Error("catalog unavailable");
      },
      getOpenAICompatibleModelIds() {
        return ["gpt-5.4", "gpt-5.3-codex"];
      }
    }
  });
  const req = createMockRequest({ method: "GET", originalUrl: "/v1/models" });
  const res = createMockResponse();

  await handlers.modelsList(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.jsonPayload?.data?.map((item) => item.id), ["gpt-5.4", "gpt-5.3-codex"]);
});

test("recent proxy audit rows mark normal requests as HTTP transport", () => {
  const appendedRows = [];
  const runtimeStats = {
    totalRequests: 0,
    okRequests: 0,
    errorRequests: 0,
    recentRequests: []
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in audit transport test.");
    },
    async fetchImpl() {
      throw new Error("Not used in audit transport test.");
    },
    contextOverrides: {
      runtimeStats,
      recentRequestsStore: {
        append(row) {
          appendedRows.push(row);
          return { recentRequests: appendedRows };
        }
      }
    }
  });

  const row = handlers.recordRecentProxyRequest({
    method: "POST",
    rawPath: "/v1/responses",
    statusCode: 200,
    proxyApiKeyId: "key_alpha",
    proxyApiKeyLabel: "alpha-client"
  });

  assert.equal(row.transportType, "http");
  assert.equal(row.method, "POST");
  assert.equal(row.proxyApiKeyId, "key_alpha");
  assert.equal(row.proxyApiKeyLabel, "alpha-client");
  assert.equal(appendedRows[0]?.transportType, "http");
});

test("recent proxy audit rows tolerate malformed numeric metadata", () => {
  const appendedRows = [];
  const packetLimits = [];
  const runtimeStats = {
    totalRequests: 0,
    okRequests: 0,
    errorRequests: 0,
    auditErrors: Symbol("audit-errors"),
    recentRequests: []
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in malformed audit metadata test.");
    },
    async fetchImpl() {
      throw new Error("Not used in malformed audit metadata test.");
    },
    configOverrides: {
      requestAudit: {
        capturePackets: true,
        maxPacketChars: Symbol("packet-limit")
      }
    },
    contextOverrides: {
      runtimeStats,
      recentRequestsStore: {
        append(row) {
          appendedRows.push(row);
          return { recentRequests: appendedRows };
        }
      },
      formatPayloadForAudit(raw, _contentType, maxChars) {
        packetLimits.push(maxChars);
        return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
      }
    }
  });

  const row = handlers.recordRecentProxyRequest({
    method: "GET",
    rawPath: "/v1/responses",
    statusCode: Symbol("status"),
    startedAt: Symbol("started-at"),
    upstreamRetryCount: Symbol("retry-count"),
    requestBody: Buffer.from("request", "utf8"),
    upstreamRequestBody: Buffer.from("upstream", "utf8"),
    responseBody: Buffer.from("response", "utf8")
  });

  assert.equal(row.status, 0);
  assert.equal(row.upstreamRetryCount, 0);
  assert.ok(row.durationMs >= 0);
  assert.equal(row.requestPacket, "request");
  assert.equal(row.upstreamRequestPacket, "upstream");
  assert.equal(row.responsePacket, "response");
  assert.deepEqual(packetLimits, [0, 0, 0, 0]);
  assert.equal(runtimeStats.totalRequests, 1);
  assert.equal(runtimeStats.okRequests, 0);
  assert.equal(runtimeStats.errorRequests, 1);
  assert.equal(appendedRows.length, 1);

  const outOfRangeRow = handlers.recordRecentProxyRequest({
    method: "GET",
    rawPath: "/v1/responses",
    statusCode: 700
  });

  assert.equal(outOfRangeRow.status, 0);
  assert.equal(runtimeStats.totalRequests, 2);
  assert.equal(runtimeStats.okRequests, 0);
  assert.equal(runtimeStats.errorRequests, 2);
  assert.equal(appendedRows.length, 2);

  const decimalStatusRow = handlers.recordRecentProxyRequest({
    method: "GET",
    rawPath: "/v1/responses",
    statusCode: "500.0",
    upstreamRetryCount: "1.9"
  });

  assert.equal(decimalStatusRow.status, 0);
  assert.equal(decimalStatusRow.upstreamRetryCount, 0);
  assert.equal(runtimeStats.totalRequests, 3);
  assert.equal(runtimeStats.okRequests, 0);
  assert.equal(runtimeStats.errorRequests, 3);
  assert.equal(appendedRows.length, 3);
});

test("recent proxy audit backfills cached input tokens from response packets", () => {
  const appendedRows = [];
  const runtimeStats = {
    totalRequests: 0,
    okRequests: 0,
    errorRequests: 0,
    recentRequests: []
  };
  const compat = createOpenAIResponsesCompatHelpers({
    config: { codex: { defaultModel: "gpt-5.4" } },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Not used in cached input audit test.");
    },
    async fetchImpl() {
      throw new Error("Not used in cached input audit test.");
    },
    contextOverrides: {
      runtimeStats,
      recentRequestsStore: {
        append(row) {
          appendedRows.push(row);
          return { recentRequests: appendedRows };
        }
      },
      formatPayloadForAudit(raw) {
        return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
      },
      normalizeTokenUsage,
      mergeNormalizedTokenUsage,
      extractTokenUsageFromAuditResponse: compat.extractTokenUsageFromAuditResponse
    }
  });
  const sse =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80},"output_tokens":5,"total_tokens":125}}}\n\n';

  const row = handlers.recordRecentProxyRequest({
    method: "WS",
    rawPath: "/v1/responses",
    statusCode: 200,
    tokenUsage: {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125
    },
    responseBody: Buffer.from(sse, "utf8"),
    responseContentType: "text/event-stream",
    transportType: "websocket"
  });

  assert.equal(row.cachedInputTokens, 80);
  assert.equal(appendedRows[0]?.cachedInputTokens, 80);
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

test("Responses create proxy session forwards the mapped model to auth selection and retry", async () => {
  const authOptions = [];
  let authCounter = 0;
  let fetchCalls = 0;
  const normalizedJson = {
    model: "gpt-5.5",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      return {
        body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
        json: normalizedJson,
        collectCompletedResponseAsJson: false,
        model: "gpt-alias",
        modelRoute: {
          requestedModel: "gpt-alias",
          mappedModel: "gpt-5.5"
        }
      };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response("", {
        status: fetchCalls === 1 ? 429 : 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    contextOverrides: {
      isCodexPoolRetryEnabled() {
        return true;
      },
      shouldRotateCodexAccountForStatus(status) {
        return Number(status || 0) === 429;
      },
      async getValidAuthContext(options = {}) {
        authOptions.push(options);
        authCounter += 1;
        return {
          accessToken: `token_${authCounter}`,
          accountId: `acct_${authCounter}`,
          poolEntryId: `pool_${authCounter}`,
          poolAccountId: `pool_${authCounter}`,
          releaseLease() {}
        };
      }
    }
  });
  const payload = {
    model: "gpt-alias",
    input: "hello"
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

  assert.equal(fetchCalls, 2);
  assert.deepEqual(
    authOptions.map((options) => options.requestedModel),
    ["gpt-5.5", "gpt-5.5"]
  );
  session.release();
});

test("Responses create proxy reports model-specific pool selection failures", async () => {
  let fetchCalls = 0;
  const normalizedJson = {
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      return {
        body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
        json: normalizedJson,
        collectCompletedResponseAsJson: false,
        model: "gpt-alias",
        modelRoute: {
          requestedModel: "gpt-alias",
          mappedModel: "gpt-5.5"
        }
      };
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("request should not reach upstream without a capable account");
    },
    contextOverrides: {
      async getValidAuthContext(options = {}) {
        assert.equal(options.requestedModel, "gpt-5.5");
        const err = new Error('No selectable OAuth account is known to support the requested model "gpt-5.5".');
        err.statusCode = 409;
        err.error = "model_account_unavailable";
        err.requestedModel = "gpt-5.5";
        throw err;
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-alias", input: "hello" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonPayload?.error, "model_account_unavailable");
  assert.match(res.jsonPayload?.message || "", /gpt-5\.5/);
});

test("Chat completions proxy forwards the mapped model to auth selection and retry", async () => {
  const authOptions = [];
  let authCounter = 0;
  let fetchCalls = 0;
  const normalizedJson = {
    model: "gpt-5.5",
    stream: true,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Responses normalizer should not run for chat completions");
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp_chat","status":"completed","usage":{},"output":[]}}\n\n',
        {
          status: fetchCalls === 1 ? 429 : 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    },
    contextOverrides: {
      normalizeChatCompletionsRequestBody() {
        return {
          body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
          json: normalizedJson,
          wantsStream: false,
          model: "gpt-alias",
          modelRoute: {
            requestedModel: "gpt-alias",
            mappedModel: "gpt-5.5"
          }
        };
      },
      isCodexPoolRetryEnabled() {
        return true;
      },
      shouldRotateCodexAccountForStatus(status) {
        return Number(status || 0) === 429;
      },
      async getValidAuthContext(options = {}) {
        authOptions.push(options);
        authCounter += 1;
        return {
          accessToken: `token_${authCounter}`,
          accountId: `acct_${authCounter}`,
          poolEntryId: `pool_${authCounter}`,
          poolAccountId: `pool_${authCounter}`,
          releaseLease() {}
        };
      },
      parseResponsesResultFromSse() {
        return {
          completed: {
            id: "resp_chat",
            status: "completed",
            usage: {},
            output: []
          },
          failed: null
        };
      },
      convertResponsesToChatCompletion(completed) {
        return {
          id: "chatcmpl_test",
          object: "chat.completion",
          model: completed?.model || "",
          choices: [],
          usage: {}
        };
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/chat/completions",
    body: { model: "gpt-alias", messages: [{ role: "user", content: "hello" }] }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 2);
  assert.deepEqual(
    authOptions.map((options) => options.requestedModel),
    ["gpt-5.5", "gpt-5.5"]
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonPayload?.model, "gpt-alias");
});

test("Chat completions proxy reports model-specific pool selection failures", async () => {
  let fetchCalls = 0;
  const normalizedJson = {
    model: "gpt-5.5",
    stream: true,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Responses normalizer should not run for chat completions");
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("request should not reach upstream without a capable account");
    },
    contextOverrides: {
      normalizeChatCompletionsRequestBody() {
        return {
          body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
          json: normalizedJson,
          wantsStream: false,
          model: "gpt-alias",
          modelRoute: {
            requestedModel: "gpt-alias",
            mappedModel: "gpt-5.5"
          }
        };
      },
      async getValidAuthContext(options = {}) {
        assert.equal(options.requestedModel, "gpt-5.5");
        const err = new Error('No selectable OAuth account is known to support the requested model "gpt-5.5".');
        err.statusCode = 409;
        err.error = "model_account_unavailable";
        err.requestedModel = "gpt-5.5";
        throw err;
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/chat/completions",
    body: { model: "gpt-alias", messages: [{ role: "user", content: "hello" }] }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonPayload?.error, "model_account_unavailable");
  assert.match(res.jsonPayload?.message || "", /gpt-5\.5/);
});

test("Chat completions proxy treats malformed auth failure statuses as unauthorized", async () => {
  let fetchCalls = 0;
  const normalizedJson = {
    model: "gpt-5.4",
    stream: false,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Responses normalizer should not run for chat completions");
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("Upstream should not be reached after auth failure.");
    },
    contextOverrides: {
      normalizeChatCompletionsRequestBody() {
        return {
          body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
          json: normalizedJson,
          wantsStream: false,
          model: "gpt-5.4"
        };
      },
      async getValidAuthContext() {
        const err = new Error("Auth failed with malformed status metadata.");
        err.statusCode = Symbol("bad-status");
        throw err;
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/chat/completions",
    body: { model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 401);
  assert.equal(res.jsonPayload?.error, "unauthorized");
  assert.match(res.jsonPayload?.message || "", /malformed status/i);
});

test("Chat completions proxy normalizes malformed retry metadata on transport failures", async () => {
  let upstreamCalls = 0;
  const normalizedJson = {
    model: "gpt-5.4",
    stream: false,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Responses normalizer should not run for chat completions");
    },
    async fetchImpl() {
      throw new Error("Default fetch should not run when fetchUpstreamWithRetry is overridden.");
    },
    contextOverrides: {
      normalizeChatCompletionsRequestBody() {
        return {
          body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
          json: normalizedJson,
          wantsStream: false,
          model: "gpt-5.4"
        };
      },
      async fetchUpstreamWithRetry(_url, _init, retryState) {
        upstreamCalls += 1;
        retryState.locals.upstreamRetryCount = "1.9";
        const err = new Error("network down");
        err.code = "ECONNRESET";
        throw err;
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/chat/completions",
    body: { model: "gpt-5.4", messages: [{ role: "user", content: "hello" }] }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(upstreamCalls, 1);
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonPayload?.error, "upstream_unreachable");
  assert.equal(res.jsonPayload?.code, "ECONNRESET");
  assert.equal(res.jsonPayload?.retry_count, 0);
});

test("OpenAI proxy returns a bounded JSON error when the request body is too large", async () => {
  let fetchCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Normalizer should not run after a body-size failure.");
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("Upstream should not be reached after a body-size failure.");
    },
    contextOverrides: {
      async readRawBody() {
        const err = new Error("Request body exceeds the 16 byte limit.");
        err.code = "request_body_too_large";
        err.statusCode = 413;
        throw err;
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { input: "x".repeat(32) }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.jsonPayload, {
    error: "request_body_too_large",
    message: "Request body exceeds the 16 byte limit."
  });
});

test("POST /v1/responses rejects malformed JSON before auth or upstream", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("Responses create normalization must not run after malformed JSON.");
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("malformed Responses create bodies must not reach upstream");
    },
    contextOverrides: {
      async getValidAuthContext() {
        authCalls += 1;
        return {
          accessToken: "token",
          accountId: "acct_123",
          releaseLease() {}
        };
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: "{\"input\":"
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonPayload?.error, "invalid_json");
  assert.equal(res.jsonPayload?.message, "Body must be valid JSON.");
});

test("POST /v1/responses forwards explicit client create fields after normalization", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_client_first",
          status: "completed",
          output: [],
          usage: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    store: true,
    include: ["message.output_text.logprobs"],
    instructions: "",
    input: "hello",
    max_output_tokens: 7,
    service_tier: "flex",
    temperature: 0.2,
    top_p: 0.9,
    reasoning: {
      effort: "low",
      summary: "concise"
    }
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(upstreamPayload.stream, false);
  assert.equal(upstreamPayload.store, true);
  assert.deepEqual(upstreamPayload.include, ["message.output_text.logprobs"]);
  assert.equal(upstreamPayload.instructions, "");
  assert.equal(upstreamPayload.max_output_tokens, 7);
  assert.equal(upstreamPayload.service_tier, "flex");
  assert.equal(upstreamPayload.temperature, 0.2);
  assert.equal(upstreamPayload.top_p, 0.9);
  assert.deepEqual(upstreamPayload.reasoning, {
    effort: "low",
    summary: "concise"
  });
  assert.equal(session.collectCompletedResponseAsJson, true);
  session.release();
});

test("POST /v1/responses forwards web search sources include when omitted", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_web_search_sources",
          status: "completed",
          output: [],
          usage: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    input: "Search for current docs.",
    tools: [
      {
        type: "web_search",
        search_context_size: "low"
      }
    ]
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.deepEqual(upstreamPayload.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources"
  ]);
  assert.deepEqual(upstreamPayload.tools, payload.tools);
  assert.equal(session.collectCompletedResponseAsJson, true);
  session.release();
});

test("POST /v1/responses forwards web search sources include for dated web search tools", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_dated_web_search_sources",
          status: "completed",
          output: [],
          usage: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    input: "Search for current docs.",
    tools: [
      {
        type: "web_search_2025_08_26",
        search_context_size: "low"
      }
    ]
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.deepEqual(upstreamPayload.include, [
    "reasoning.encrypted_content",
    "web_search_call.action.sources"
  ]);
  assert.deepEqual(upstreamPayload.tools, payload.tools);
  assert.equal(session.collectCompletedResponseAsJson, true);
  session.release();
});

test("POST /v1/responses strips local generate before forwarding upstream", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_generate_stripped",
          status: "completed",
          output: [],
          usage: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    input: "hello",
    generate: true
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(Object.hasOwn(upstreamPayload, "generate"), false);
  assert.equal(upstreamPayload.stream, false);
  assert.deepEqual(upstreamPayload.input, [
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    }
  ]);
  session.release();
});

test("POST /v1/responses injects configured service tier when the client omits it", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_no_service_tier",
          status: "completed",
          output: [],
          usage: {}
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    input: "hello"
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(upstreamPayload.service_tier, "priority");
  assert.equal(Object.hasOwn(upstreamPayload, "reasoning"), false);
  session.release();
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

test("Responses create proxy session rejects unresolved previous_response_id before Codex upstream", async () => {
  let fetchCalls = 0;
  let compatibilityHint = "";
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
      fetchCalls += 1;
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    contextOverrides: {
      noteCompatibilityHint(_res, hint) {
        compatibilityHint = hint;
      },
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      }
    }
  });

  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_prev_123",
    input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
  };

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
          requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
          parsedRequestBody: payload
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.error, "previous_response_id_chain_missing");
      return true;
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(compatibilityHint, "");
});

test("Responses create proxy session emulates previous_response_id from the local chain", async () => {
  let capturedInit = null;
  let compatibilityHint = "";
  let compatibilityHintCalls = 0;
  let rememberedEntry = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options = {}) {
      const json = JSON.parse(rawBody.toString("utf8"));
      if (options.previousResponseContinuation && !json.instructions) {
        assert.equal(Object.hasOwn(json, "previous_response_id"), false);
      }
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
      noteCompatibilityHint(_res, hint) {
        compatibilityHintCalls += 1;
        compatibilityHint = hint;
      },
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponsesChain: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev_123");
          return {
            responseId,
            inputHistory: [
              { role: "user", content: [{ type: "input_text", text: "first turn" }] },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] }
            ],
            updatedAt: Date.now()
          };
        },
        remember(entry) {
          rememberedEntry = entry;
        }
      },
      expandResponsesRequestBodyFromChain(body, previousEntry) {
        const next = structuredClone(body);
        next.input = [
          ...previousEntry.inputHistory,
          ...next.input
        ];
        delete next.previous_response_id;
        return next;
      },
      buildResponsesChainEntry(requestBody, completed) {
        return {
          responseId: completed.id,
          inputHistory: requestBody.input,
          updatedAt: Date.now()
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

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(Object.hasOwn(upstreamPayload, "previous_response_id"), false);
  assert.deepEqual(upstreamPayload.input.map((item) => item.content?.[0]?.text || item.content?.[0]?.text), [
    "first turn",
    "first answer",
    "next turn"
  ]);
  assert.equal(session.compatibilityHint, "");
  assert.equal(compatibilityHint, "");
  assert.equal(compatibilityHintCalls, 0);
  session.rememberCompletion({ id: "resp_next", output: [] });
  assert.equal(rememberedEntry.responseId, "resp_next");
  session.release();
});

test("Responses create proxy session fails locally instead of falling back from the pinned account", async () => {
  let capturedPreferredPoolEntryId = "";
  let fetchCalls = 0;
  let releaseCalls = 0;
  const sourceEntry = {
    responseId: "resp_prev",
    inputHistory: [
      {
        role: "user",
        content: [{ type: "input_text", text: "previous turn" }]
      }
    ],
    updatedAt: Date.now()
  };
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: rawBody,
        json,
        collectCompletedResponseAsJson: false,
        model: json.model || "gpt-5.4"
      };
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    contextOverrides: {
      isCodexMultiAccountEnabled() {
        return true;
      },
      isCodexPoolRetryEnabled() {
        return true;
      },
      async getValidAuthContext(options = {}) {
        capturedPreferredPoolEntryId = options.preferredPoolEntryId || "";
        return {
          accessToken: "token",
          accountId: "acct_free",
          poolEntryId: "pool_free",
          poolAccountId: "pool_free",
          releaseLease() {
            releaseCalls += 1;
          }
        };
      },
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponseAffinity: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return { poolEntryId: "pool_team", accountId: "acct_team" };
        },
        remember() {},
        forget() {}
      },
      codexResponsesChain: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return sourceEntry;
        },
        remember() {}
      },
      expandResponsesRequestBodyFromChain
    }
  });
  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_prev",
    input: "next"
  };
  const requestBody = Buffer.from(JSON.stringify(payload), "utf8");
  let session = null;
  let thrown = null;

  try {
    session = await handlers.openResponsesCreateProxySession(
      {
        method: "POST",
        originalUrl: "/v1/responses",
        url: "/v1/responses",
        headers: {}
      },
      createMockResponse(),
      {
        originalUrl: "/v1/responses",
        requestBody,
        parsedRequestBody: payload
      }
    );
  } catch (err) {
    thrown = err;
  } finally {
    session?.release();
  }

  assert.equal(capturedPreferredPoolEntryId, "pool_team");
  assert.equal(fetchCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.equal(thrown?.statusCode, 409);
  assert.equal(thrown?.error, "response_id_account_unavailable");
});

test("Responses create proxy session keeps WebSocket callers on the stream-first bridge path", async () => {
  let capturedInit = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      const normalizedJson = {
        ...json,
        stream: true
      };
      return {
        body: Buffer.from(JSON.stringify(normalizedJson), "utf8"),
        json: normalizedJson,
        collectCompletedResponseAsJson: true,
        model: "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
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
      headers: {}
    },
    null,
    {
      originalUrl: "/v1/responses",
      requestBody: Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "hello" }), "utf8"),
      parsedRequestBody: { model: "gpt-5.4", input: "hello" }
    }
  );

  assert.equal(session.collectCompletedResponseAsJson, false);
  assert.equal(capturedInit.headers.get("accept"), "text/event-stream");
  assert.equal(capturedInit.headers.get("accept-encoding"), "identity");
  assert.equal(JSON.parse(Buffer.from(capturedInit.body).toString("utf8")).stream, true);
  session.release();
});

test("Responses WebSocket session helper forces upstream stream when client sends stream false", async () => {
  let capturedInit = null;
  const realNormalizer = createRealResponsesNormalizer();
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody, options) {
      return realNormalizer.normalizeCodexResponsesRequestBody(rawBody, options);
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });
  const payload = {
    model: "gpt-5.4",
    stream: false,
    input: "hello"
  };

  const session = await handlers.openResponsesCreateProxySession(
    {
      method: "POST",
      originalUrl: "/v1/responses",
      url: "/v1/responses",
      headers: {}
    },
    null,
    {
      originalUrl: "/v1/responses",
      requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
      parsedRequestBody: payload
    }
  );

  const upstreamPayload = JSON.parse(Buffer.from(capturedInit.body).toString("utf8"));
  assert.equal(upstreamPayload.stream, true);
  assert.equal(session.collectCompletedResponseAsJson, false);
  assert.equal(session.normalizedResponsesRequest.stream, true);
  assert.equal(capturedInit.headers.get("accept"), "text/event-stream");
  assert.equal(capturedInit.headers.get("accept-encoding"), "identity");
  session.release();
});

test("Responses create proxy session bridges explicit plan mode from local Codex session state before normalization", async () => {
  let normalizedPayload = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      normalizedPayload = JSON.parse(rawBody.toString("utf8"));
      return {
        body: rawBody,
        json: normalizedPayload,
        collectCompletedResponseAsJson: false,
        model: normalizedPayload.model || "gpt-5.4",
        modelRoute: {
          requestedModel: normalizedPayload.model || "gpt-5.4",
          mappedModel: normalizedPayload.model || "gpt-5.4"
        }
      };
    },
    async fetchImpl() {
      return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    contextOverrides: {
      async bridgeCodexResponsesCollaborationMode(body) {
        return {
          ...body,
          collaborationMode: "plan",
          settings: {
            developer_instructions: null
          }
        };
      }
    }
  });

  const requestBody = Buffer.from(
    JSON.stringify({
      model: "gpt-5.4",
      instructions: "Base instructions",
      client_metadata: {
        "x-codex-turn-metadata": "{\"session_id\":\"sess_1\",\"turn_id\":\"turn_1\"}"
      },
      input: "hello"
    }),
    "utf8"
  );

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
      requestBody,
      parsedRequestBody: JSON.parse(requestBody.toString("utf8"))
    }
  );

  assert.equal(normalizedPayload?.collaborationMode, "plan");
  assert.equal(normalizedPayload?.settings?.developer_instructions, null);
  session.release();
});

test("Responses create proxy session keeps the current bridged mode when previous_response_id is present", async () => {
  let normalizedPayload = null;
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      normalizedPayload = JSON.parse(rawBody.toString("utf8"));
      return {
        body: rawBody,
        json: normalizedPayload,
        collectCompletedResponseAsJson: false,
        model: normalizedPayload.model || "gpt-5.4"
      };
    },
    async fetchImpl() {
      return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    contextOverrides: {
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponsesChain: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev_plan");
          return {
            responseId,
            inputHistory: [],
            updatedAt: Date.now()
          };
        },
        remember() {}
      },
      expandResponsesRequestBodyFromChain(body) {
        const next = structuredClone(body);
        delete next.previous_response_id;
        return next;
      },
      async bridgeCodexResponsesCollaborationMode(body) {
        if (body.collaborationMode) return body;
        return {
          ...body,
          collaborationMode: "default"
        };
      }
    }
  });

  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_prev_plan",
    input: [{ role: "user", content: [{ type: "input_text", text: "Continue in normal mode." }] }]
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

  assert.equal(normalizedPayload?.collaborationMode, "default");
  assert.equal(Object.hasOwn(normalizedPayload || {}, "previous_response_id"), false);
  session.release();
});

test("Responses create proxy session preserves current explicit developer instructions while stripping previous_response_id", async () => {
  let normalizedPayload = null;
  let capturedInit = null;

  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      normalizedPayload = JSON.parse(rawBody.toString("utf8"));
      return {
        body: rawBody,
        json: normalizedPayload,
        collectCompletedResponseAsJson: false,
        model: normalizedPayload.model || "gpt-5.4"
      };
    },
    async fetchImpl(_url, init) {
      capturedInit = init;
      return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    contextOverrides: {
      extractPreviousResponseId(rawBody) {
        return JSON.parse(rawBody.toString("utf8")).previous_response_id || "";
      },
      codexResponsesChain: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev_chain");
          return {
            responseId,
            inputHistory: [],
            updatedAt: Date.now()
          };
        },
        remember() {}
      },
      expandResponsesRequestBodyFromChain(body) {
        const next = structuredClone(body);
        delete next.previous_response_id;
        return next;
      }
    }
  });

  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_prev_chain",
    settings: {
      developer_instructions: "Use the explicit developer instructions for this turn."
    },
    messages: [
      {
        role: "developer",
        content: "Keep the current developer guidance."
      },
      {
        role: "system",
        content: "Keep the current system guidance."
      },
      {
        role: "user",
        content: "Second turn."
      }
    ]
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

  assert.equal(Object.hasOwn(normalizedPayload || {}, "previous_response_id"), false);
  assert.equal(normalizedPayload?.settings?.developer_instructions, "Use the explicit developer instructions for this turn.");
  assert.equal(Array.isArray(normalizedPayload?.messages), true);
  assert.equal(Buffer.from(capturedInit.body).toString("utf8"), JSON.stringify(normalizedPayload));
  session.release();
});

test("Responses create proxy session streams when the client accepts SSE without an explicit stream flag", async () => {
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
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
  });

  const payload = {
    model: "gpt-5.4",
    input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
  };

  const session = await handlers.openResponsesCreateProxySession(
    {
      method: "POST",
      originalUrl: "/v1/responses",
      url: "/v1/responses",
      headers: {
        accept: "text/event-stream"
      }
    },
    createMockResponse(),
    {
      originalUrl: "/v1/responses",
      requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
      parsedRequestBody: payload
    }
  );

  assert.equal(session.collectCompletedResponseAsJson, false);
  assert.equal(capturedInit.headers.get("accept"), "text/event-stream");
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

test("Responses create proxy session fails previous_response_id without a local chain", async () => {
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
      }
    }
  });

  const payload = {
    model: "gpt-5.4",
    previous_response_id: "resp_missing",
    input: [{ role: "user", content: [{ type: "input_text", text: "next turn" }] }]
  };

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
          requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
          parsedRequestBody: payload
        }
      ),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.error, "previous_response_id_chain_missing");
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test("POST /v1/responses/compact pins source account and preserves the local response chain", async () => {
  let capturedUrl = "";
  let capturedInit = null;
  let capturedPreferredPoolEntryId = "";
  let rememberedEntry = null;
  let rememberedAffinity = null;
  const sourceEntry = {
    responseId: "resp_prev",
    inputHistory: [
      { role: "user", content: [{ type: "input_text", text: "上一輪使用者 prompt" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "上一輪回答" }]
      }
    ],
    updatedAt: Date.now()
  };
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("compact must not run create normalization");
    },
    async fetchImpl(url, init) {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: "resp_compact",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "compact summary" }]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    },
    contextOverrides: {
      isCodexMultiAccountEnabled() {
        return true;
      },
      isCodexPoolRetryEnabled() {
        return true;
      },
      async getValidAuthContext(options = {}) {
        capturedPreferredPoolEntryId = options.preferredPoolEntryId || "";
        return {
          accessToken: "token",
          accountId: "acct_team",
          poolEntryId: capturedPreferredPoolEntryId,
          poolAccountId: capturedPreferredPoolEntryId,
          releaseLease() {}
        };
      },
      extractCompletedResponseFromJson(raw) {
        return JSON.parse(raw);
      },
      codexResponseAffinity: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return { poolEntryId: "pool_team", accountId: "acct_team" };
        },
        remember(responseId, affinity) {
          rememberedAffinity = { responseId, affinity };
        },
        forget() {}
      },
      codexResponsesChain: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return sourceEntry;
        },
        remember(entry) {
          rememberedEntry = entry;
        }
      },
      buildResponsesChainEntry,
      expandResponsesRequestBodyFromChain
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses/compact",
    body: { response_id: "resp_prev", summary: "short" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(capturedUrl, "https://example.test/codex/responses/compact");
  assert.equal(Buffer.from(capturedInit.body).toString("utf8"), JSON.stringify({ response_id: "resp_prev", summary: "short" }));
  assert.equal(capturedPreferredPoolEntryId, "pool_team");
  assert.equal(rememberedAffinity.responseId, "resp_compact");
  assert.equal(rememberedEntry.responseId, "resp_compact");

  const expanded = expandResponsesRequestBodyFromChain(
    {
      previous_response_id: "resp_compact",
      input: [{ role: "user", content: [{ type: "input_text", text: "compact 後的新問題" }] }]
    },
    rememberedEntry
  );
  const replayTexts = expanded.input
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part) => part.text)
    .filter(Boolean);
  assert.deepEqual(replayTexts, ["上一輪使用者 prompt", "上一輪回答", "compact summary", "compact 後的新問題"]);
});

test("POST /v1/responses/compact fails locally instead of falling back from the pinned account", async () => {
  let fetchCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("compact must not run create normalization");
    },
    async fetchImpl() {
      fetchCalls += 1;
      throw new Error("compact should not be sent to an unpinned fallback account");
    },
    contextOverrides: {
      isCodexMultiAccountEnabled() {
        return true;
      },
      isCodexPoolRetryEnabled() {
        return true;
      },
      async getValidAuthContext() {
        return {
          accessToken: "token",
          accountId: "acct_free",
          poolEntryId: "pool_free",
          poolAccountId: "pool_free",
          releaseLease() {}
        };
      },
      codexResponseAffinity: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return { poolEntryId: "pool_team", accountId: "acct_team" };
        },
        remember() {},
        forget() {}
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses/compact",
    body: { response_id: "resp_prev", summary: "short" }
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(fetchCalls, 0);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonPayload?.error, "response_id_account_unavailable");
});

for (const extensionPath of ["/v1/responses/compact", "/v1/responses/input_tokens"]) {
  test(`POST ${extensionPath} rejects malformed JSON before auth or upstream`, async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const handlers = createHandlers({
      normalizeResponsesImpl() {
        throw new Error("extension routes must not run create normalization");
      },
      async fetchImpl() {
        fetchCalls += 1;
        throw new Error("malformed extension bodies must not reach upstream");
      },
      contextOverrides: {
        async getValidAuthContext() {
          authCalls += 1;
          return {
            accessToken: "token",
            accountId: "acct_123",
            releaseLease() {}
          };
        }
      }
    });
    const req = createMockRequest({
      method: "POST",
      originalUrl: extensionPath,
      body: "{\"response_id\":"
    });
    const res = createMockResponse();

    await handlers.openAIProxy(req, res);

    assert.equal(authCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(res.statusCode, 400);
    assert.equal(res.jsonPayload?.error, "invalid_json");
    assert.equal(res.jsonPayload?.message, "Body must be valid JSON.");
  });
}

test("GET /v1/responses/{response_id} fails locally instead of falling back from the pinned account", async () => {
  let capturedPreferredPoolEntryId = "";
  let fetchCalls = 0;
  let releaseCalls = 0;
  const handlers = createHandlers({
    normalizeResponsesImpl() {
      throw new Error("create normalization should not run for read methods");
    },
    async fetchImpl() {
      fetchCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    contextOverrides: {
      isCodexMultiAccountEnabled() {
        return true;
      },
      isCodexPoolRetryEnabled() {
        return true;
      },
      async getValidAuthContext(options = {}) {
        capturedPreferredPoolEntryId = options.preferredPoolEntryId || "";
        return {
          accessToken: "token",
          accountId: "acct_free",
          poolEntryId: "pool_free",
          poolAccountId: "pool_free",
          releaseLease() {
            releaseCalls += 1;
          }
        };
      },
      codexResponseAffinity: {
        lookup(responseId) {
          assert.equal(responseId, "resp_prev");
          return { poolEntryId: "pool_team", accountId: "acct_team" };
        },
        remember() {},
        forget() {}
      }
    }
  });
  const req = createMockRequest({
    method: "GET",
    originalUrl: "/v1/responses/resp_prev"
  });
  const res = createMockResponse();

  await handlers.openAIProxy(req, res);

  assert.equal(capturedPreferredPoolEntryId, "pool_team");
  assert.equal(fetchCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonPayload?.error, "response_id_account_unavailable");
});

test("audit middleware omits persisted packets when capture is disabled", () => {
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
    configOverrides: {
      requestAudit: {
        capturePackets: false,
        maxPacketChars: 65536
      }
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

  assert.equal(capturedRow?.requestPacket, "");
  assert.equal(capturedRow?.upstreamRequestPacket, "");
  assert.equal(capturedRow?.responsePacket, "");
});

test("audit middleware captures bounded packets when enabled", () => {
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
    configOverrides: {
      requestAudit: {
        capturePackets: true,
        maxPacketChars: 4
      }
    },
    contextOverrides: {
      runtimeStats: { totalRequests: 0, okRequests: 0, errorRequests: 0 },
      recentRequestsStore: {
        append(row) {
          capturedRow = row;
          return { recentRequests: [row] };
        }
      },
      formatPayloadForAudit(raw, _contentType, maxChars = 0) {
        let text = "";
        if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
        else if (raw && typeof raw === "object") text = JSON.stringify(raw);
        else text = String(raw || "");
        return maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) : text;
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

  assert.equal(capturedRow?.requestPacket, '{"pr');
  assert.equal(capturedRow?.responsePacket, "ABCD");
});

test("audit middleware records audit_error instead of throwing from finish hooks", () => {
  const runtimeStats = { totalRequests: 0, okRequests: 0, errorRequests: 0 };
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
      runtimeStats,
      estimateOpenAIChatCompletionTokens() {
        throw new ReferenceError("soak estimator missing");
      }
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/chat/completions",
    body: { messages: [{ role: "user", content: "trigger failed request audit estimator" }] }
  });
  const res = createMockResponse();

  handlers.auditMiddleware(req, res, () => {});
  res.status(400);

  assert.doesNotThrow(() => res.end(JSON.stringify({ error: "bad_request" })));
  assert.equal(runtimeStats.auditErrors, 1);
  assert.equal(runtimeStats.lastAuditError?.type, "audit_error");
  assert.equal(runtimeStats.lastAuditError?.phase, "response_finish");
  assert.match(runtimeStats.lastAuditError?.message || "", /soak estimator missing/);
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

test("Responses create JSON fallback coerces out-of-range failed SSE statuses", async () => {
  let failureStatusCode = null;
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
        'event: response.failed\n' +
          'data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    },
    contextOverrides: {
      async maybeMarkCodexPoolFailure(_auth, _message, statusCode) {
        failureStatusCode = statusCode;
      },
      parseResponsesResultFromSse() {
        return {
          completed: null,
          failed: {
            message: "upstream failed",
            statusCode: 700
          }
        };
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

  assert.equal(res.statusCode, 502);
  assert.equal(failureStatusCode, 502);
  assert.deepEqual(res.jsonPayload, {
    error: "upstream_response_failed",
    message: "upstream failed",
    retry_count: 0
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
  const encoder = new TextEncoder();
  let completedEnqueued = false;
  let streamedBeforeCompletion = false;
  const responseHelpers = createOpenAIResponsesCompatHelpers({
    config: { codex: { defaultModel: "gpt-5.4" } },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });
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
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.output_text.delta\n' +
                'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}\n\n'
            )
          );
          setTimeout(() => {
            completedEnqueued = true;
            controller.enqueue(
              encoder.encode(
                'event: response.completed\n' +
                  'data: {"type":"response.completed","response":{"id":"resp_sse_no_header","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n'
              )
            );
            controller.close();
          }, 10);
        }
      }), {
        status: 202,
        headers: {}
      });
    },
    contextOverrides: {
      parseResponsesResultFromSse: responseHelpers.parseResponsesResultFromSse,
      pipeSseAndCaptureTokenUsage: responseHelpers.pipeSseAndCaptureTokenUsage
    }
  });
  const req = createMockRequest({
    method: "POST",
    originalUrl: "/v1/responses",
    body: { model: "gpt-5.4", stream: true, store: false, input: "hello" }
  });
  const res = createMockResponse();
  const originalWrite = res.write.bind(res);
  res.write = (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    const result = originalWrite(chunk);
    if (text.includes("response.output_text.delta") && !completedEnqueued) {
      streamedBeforeCompletion = true;
    }
    return result;
  };

  await handlers.openAIProxy(req, res);

  assert.equal(res.statusCode, 202);
  assert.match(String(res.getHeader("content-type") || ""), /text\/event-stream/i);
  assert.equal(res.getHeader("cache-control"), "no-cache");
  assert.equal(res.getHeader("connection"), "keep-alive");
  assert.equal(res.getHeader("x-accel-buffering"), "no");
  assert.equal(streamedBeforeCompletion, true);
  assert.match(res.body, /response\.output_text\.delta/);
  assert.match(res.body, /response\.completed/);
  assert.match(res.body, /resp_sse_no_header/);
  assert.deepEqual(res.locals.tokenUsage, {
    prompt_tokens: 4,
    completion_tokens: 5,
    total_tokens: 9
  });
});

test("Responses create HTTP stream flushes official SSE events before upstream completion", async () => {
  const encoder = new TextEncoder();
  let completedEnqueued = false;
  const responseHelpers = createOpenAIResponsesCompatHelpers({
    config: { codex: { defaultModel: "gpt-5.4" } },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });
  const handlers = createHandlers({
    normalizeResponsesImpl(rawBody) {
      const json = JSON.parse(rawBody.toString("utf8"));
      return {
        body: Buffer.from(JSON.stringify({ ...json, stream: true }), "utf8"),
        json: { ...json, stream: true },
        collectCompletedResponseAsJson: false,
        model: "gpt-5.4"
      };
    },
    async fetchImpl() {
      let upstreamClosed = false;
      let completionTimer = null;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.mcp_call_arguments.delta\n' +
                'data: {"type":"response.mcp_call_arguments.delta","item_id":"mcp_1","output_index":0,"sequence_number":1,"delta":"{\\"city\\""}\n\n'
            )
          );
          completionTimer = setTimeout(() => {
            if (upstreamClosed) return;
            completedEnqueued = true;
            try {
              controller.enqueue(
                encoder.encode(
                  'event: response.completed\n' +
                    'data: {"type":"response.completed","response":{"id":"resp_http_stream","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
                )
              );
              controller.close();
            } catch {}
          }, 50);
          completionTimer.unref?.();
        },
        cancel() {
          upstreamClosed = true;
          if (completionTimer) clearTimeout(completionTimer);
        }
      }), {
        status: 200,
        headers: {}
      });
    },
    contextOverrides: {
      parseResponsesResultFromSse: responseHelpers.parseResponsesResultFromSse,
      pipeSseAndCaptureTokenUsage: responseHelpers.pipeSseAndCaptureTokenUsage
    }
  });

  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      req.rawBody = Buffer.concat(chunks);
      req.originalUrl = req.url;
      req.path = req.url;
      res.locals = {};
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (payload) => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
        return res;
      };
      res.send = (payload) => {
        res.end(payload);
        return res;
      };
      try {
        await handlers.openAIProxy(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(err.message);
        } else {
          res.end();
        }
      }
    });
  });

  server.keepAliveTimeout = 1;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/v1/responses`;

  try {
    let firstChunkSeen = false;
    const firstChunk = new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };
      timeout = setTimeout(() => fail(new Error("Timed out waiting for first stream chunk.")), 1000);
      const clientReq = request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream"
          }
        },
        (clientRes) => {
          clientRes.setEncoding("utf8");
          clientRes.on("data", (chunk) => {
            if (firstChunkSeen) return;
            firstChunkSeen = true;
            const first = {
              chunk,
              completedEnqueued,
              statusCode: clientRes.statusCode,
              contentType: clientRes.headers["content-type"]
            };
            clientRes.destroy();
            finish(first);
          });
          clientRes.on("error", fail);
          clientRes.on("end", () => {
            if (!firstChunkSeen) fail(new Error("Stream ended before emitting a data chunk."));
          });
        }
      );
      clientReq.on("error", fail);
      clientReq.end(JSON.stringify({ model: "gpt-5.4", stream: true, store: false, input: "hello" }));
    });

    const first = await firstChunk;
    assert.equal(first.statusCode, 200);
    assert.match(String(first.contentType || ""), /text\/event-stream/i);
    assert.equal(first.completedEnqueued, false);
    assert.match(first.chunk, /response\.mcp_call_arguments\.delta/);
    assert.doesNotMatch(first.chunk, /response\.completed/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Responses create stream rejects truncated upstream SSE without content-type header", async () => {
  const responseHelpers = createOpenAIResponsesCompatHelpers({
    config: { codex: { defaultModel: "gpt-5.4" } },
    parseJsonLoose(value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  });
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
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.output_text.delta\n' +
                'data: {"type":"response.output_text.delta","delta":"hel"}\n\n'
            )
          );
          controller.close();
        }
      }), {
        status: 200,
        headers: {}
      });
    },
    contextOverrides: {
      parseResponsesResultFromSse: responseHelpers.parseResponsesResultFromSse,
      pipeSseAndCaptureTokenUsage: responseHelpers.pipeSseAndCaptureTokenUsage
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
  assert.equal(res.jsonPayload, null);
  assert.match(String(res.getHeader("content-type") || ""), /text\/event-stream/i);
  assert.match(res.body, /response\.output_text\.delta/);
  assert.match(res.body, /response\.failed/);
  assert.match(res.body, /Upstream SSE ended before a terminal response event/);
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

for (const route of [...responsesOpenApiContract.methods, ...responsesOpenApiContract.local_extension_methods].filter(
  (entry) => entry.expects_create_normalization === false
)) {
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
