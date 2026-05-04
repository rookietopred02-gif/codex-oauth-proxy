import assert from "node:assert/strict";
import test from "node:test";

import { createProviderRoutingHelpers } from "../src/server/provider-routing.js";

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
