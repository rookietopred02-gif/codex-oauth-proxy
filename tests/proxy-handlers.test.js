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
        this.write(chunk);
      }
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.closed = true;
      events.emit("close");
      return this;
    },
    send(payload) {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.body = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
      return this;
    },
    json(payload) {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      this.jsonPayload = payload;
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

function createHandlers({ normalizeResponsesImpl, fetchImpl }) {
  return createProxyRouteHandlers({
    config: {
      upstreamMode: "codex-chatgpt",
      upstreamBaseUrl: "https://example.test",
      authMode: "codex-oauth",
      codex: {
        defaultModel: "gpt-5.4"
      }
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
    }
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
