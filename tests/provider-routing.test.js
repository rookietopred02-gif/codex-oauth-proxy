import assert from "node:assert/strict";
import test from "node:test";

import { createProviderRoutingHelpers } from "../src/server/provider-routing.js";

function createRoutingHelpers(overrides = {}) {
  return createProviderRoutingHelpers({
    config: {
      upstreamMode: "codex-chatgpt",
      upstreamBaseUrl: "https://chatgpt.com/backend-api",
      codex: { defaultModel: "gpt-5.4" },
      gemini: {
        defaultModel: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: ""
      },
      anthropic: {
        defaultModel: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        version: "2023-06-01"
      },
      modelRouter: {
        enabled: false,
        customMappings: {}
      },
      providerUpstream: {
        allowRequestApiKeys: false
      },
      authMode: "codex-oauth",
      codexOAuth: {
        sharedApiKey: ""
      },
      ...overrides.config
    },
    DEFAULT_CODEX_CLIENT_VERSION: "2026.2.26",
    OFFICIAL_OPENAI_MODELS: [],
    OFFICIAL_GEMINI_MODELS: [],
    OFFICIAL_ANTHROPIC_MODELS: [],
    OFFICIAL_CODEX_MODELS: [],
    getValidAuthContext: async () => ({
      accessToken: "token",
      accountId: "acct_123"
    }),
    getCodexOriginator: () => "codex-pro-max",
    getCachedJsonBody: () => undefined,
    ...overrides
  });
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

function createStalledResponse(status = 200) {
  return new Response(
    new ReadableStream({
      cancel() {}
    }),
    {
      status,
      headers: { "content-type": "application/json" }
    }
  );
}

test("Gemini upstream fallback ignores malformed status values", () => {
  const helpers = createRoutingHelpers();
  const req = {
    headers: {},
    originalUrl: "/v1beta/models/gemini-2.5-flash:generateContent"
  };

  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, 429), true);
  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, "403"), true);
  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, "403.0"), false);
  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, 429.5), false);
  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, 600), false);
  assert.equal(helpers.shouldFallbackGeminiUpstreamToCompat(req, Symbol("status")), false);
});

test("official model catalog parsing accepts codex string, id, and slug entries and warms the sync cache", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url || "");
    if (href.includes("/codex/models")) {
      return new Response(
        JSON.stringify({
          models: ["gpt-5.5", { id: "gpt-5.5-codex" }, { slug: "gpt-5.5-pro" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    if (href.includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("api.anthropic.com")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    const helpers = createProviderRoutingHelpers({
      config: {
        upstreamMode: "codex-chatgpt",
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
        codex: { defaultModel: "gpt-5.4" },
        gemini: {
          defaultModel: "gemini-2.5-pro",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: ""
        },
        anthropic: {
          defaultModel: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "",
          version: "2023-06-01"
        },
        modelRouter: {
          enabled: false,
          customMappings: {}
        },
        providerUpstream: {
          allowRequestApiKeys: false
        },
        authMode: "codex-oauth",
        codexOAuth: {
          sharedApiKey: ""
        }
      },
      DEFAULT_CODEX_CLIENT_VERSION: "2026.2.26",
      OFFICIAL_OPENAI_MODELS: [],
      OFFICIAL_GEMINI_MODELS: [],
      OFFICIAL_ANTHROPIC_MODELS: [],
      OFFICIAL_CODEX_MODELS: [],
      getValidAuthContext: async () => ({
        accessToken: "token",
        accountId: "acct_123"
      }),
      getCodexOriginator: () => "codex-pro-max",
      getCachedJsonBody: () => undefined
    });

    const officialIds = await helpers.getOfficialModelCandidateIds({ forceRefresh: true });

    assert.match(officialIds.join(","), /gpt-5\.5/);
    assert.match(officialIds.join(","), /gpt-5\.5-codex/);
    assert.match(officialIds.join(","), /gpt-5\.5-pro/);

    const syncIds = helpers.getOpenAICompatibleModelIds();
    assert.match(syncIds.join(","), /gpt-5\.5/);
    assert.match(syncIds.join(","), /gpt-5\.5-codex/);
    assert.match(syncIds.join(","), /gpt-5\.5-pro/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("official model catalog parsing bounds stalled response bodies", async () => {
  const originalFetch = globalThis.fetch;
  const fetchUrls = [];
  globalThis.fetch = async (url) => {
    fetchUrls.push(String(url || ""));
    return createStalledResponse(200);
  };

  try {
    const helpers = createRoutingHelpers({
      config: {
        upstreamMode: "codex-chatgpt",
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
        codex: { defaultModel: "gpt-5.4" },
        gemini: {
          defaultModel: "gemini-2.5-pro",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini_key"
        },
        anthropic: {
          defaultModel: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "anthropic_key",
          version: "2023-06-01"
        },
        modelRouter: {
          enabled: false,
          customMappings: {}
        },
        providerUpstream: {
          allowRequestApiKeys: false
        },
        authMode: "codex-oauth",
        codexOAuth: {
          sharedApiKey: ""
        }
      },
      modelCatalogBodyTimeoutMs: 7
    });

    const officialIds = await withTimeout(
      helpers.getOfficialModelCandidateIds({ forceRefresh: true }),
      "official model catalog response bodies stalled"
    );

    assert.ok(officialIds.includes("gpt-5.4"));
    assert.ok(officialIds.includes("gemini-2.5-pro"));
    assert.ok(officialIds.includes("claude-sonnet-4-5"));
    assert.equal(fetchUrls.length, 3);
    assert.ok(fetchUrls.some((url) => url.includes("/codex/models")));
    assert.ok(fetchUrls.some((url) => url.includes("generativelanguage.googleapis.com")));
    assert.ok(fetchUrls.some((url) => url.includes("api.anthropic.com")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
