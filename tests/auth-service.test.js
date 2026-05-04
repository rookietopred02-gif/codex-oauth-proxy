import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createAuthService } from "../src/services/auth-service.js";

function createService(overrides = {}) {
  return createAuthService({
    config: {
      authMode: "codex-oauth",
      codexOAuth: {
        sharedApiKey: ""
      },
      apiKeys: {
        storePath: "memory"
      }
    },
    loadJsonStore: overrides.loadJsonStore || (async () => ({ version: 1, keys: [] })),
    saveJsonStore: overrides.saveJsonStore || (async () => {}),
    extractBearerToken: overrides.extractBearerToken || (() => ""),
    readHeaderValue: overrides.readHeaderValue || (() => "")
  });
}

test("createProxyApiKey emits lowercase unambiguous local keys", () => {
  const service = createService();
  const key = service.createProxyApiKey();

  assert.match(key, /^sk-[a-z2-9]+$/);
  assert.doesNotMatch(key, /[01lo]/);
});

test("findManagedProxyApiKeyByValue requires an exact key hash match", async () => {
  const service = createService();
  const store = service.getProxyApiKeyStore();
  store.keys.push({
    id: "key_1",
    label: "generated-key",
    prefix: "sk-ZnuNesP",
    hash: service.hashProxyApiKey("sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3"),
    created_at: 1,
    last_used_at: 0,
    use_count: 0,
    revoked_at: 0,
    expires_at: 0
  });

  const matched = service.findManagedProxyApiKeyByValue("sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3");
  assert.equal(matched?.id, "key_1");
  const folded = service.findManagedProxyApiKeyByValue("sk-ZnuNesPaDbHOXJkEyagnYidxM4BzLYo3");
  assert.equal(folded, null);
});

test("buildApiKeySummary never exposes reusable API key values", async () => {
  const service = createService();
  const store = service.getProxyApiKeyStore();
  store.keys.push({
    id: "key_1",
    label: "generated-key",
    prefix: "sk-ZnuNesP",
    hash: service.hashProxyApiKey("sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3"),
    created_at: 1,
    last_used_at: 0,
    use_count: 0,
    revoked_at: 0,
    expires_at: 0
  });

  const summary = service.buildApiKeySummary();
  assert.equal(summary.keys.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.keys[0], "value"), false);
  assert.equal(JSON.stringify(summary).includes("sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3"), false);
});

test("loadProxyApiKeyStore strips legacy plaintext API key values", async () => {
  const legacyKey = "sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3";
  const legacyHash = crypto.createHash("sha256").update(legacyKey, "utf8").digest("hex");
  let savedStore = null;
  const service = createService({
    loadJsonStore: async () => ({
      version: 1,
      keys: [
        {
          id: "key_legacy",
          label: "legacy",
          prefix: "sk-ZnuNesP",
          value: legacyKey,
          apiKey: legacyKey,
          hash: legacyHash,
          created_at: 1,
          last_used_at: 0,
          use_count: 0,
          revoked_at: 0,
          expires_at: 0
        }
      ]
    }),
    saveJsonStore: async (_path, nextStore) => {
      savedStore = nextStore;
    }
  });

  const store = await service.loadProxyApiKeyStore();

  assert.equal(store.keys.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(store.keys[0], "value"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store.keys[0], "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(savedStore.keys[0], "value"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(savedStore.keys[0], "apiKey"), false);
  assert.equal(JSON.stringify(savedStore).includes(legacyKey), false);
});

test("extractProxyApiKeyFromRequest ignores URL query parameters", () => {
  const service = createService({
    readHeaderValue(req, name) {
      return String(req.headers?.[String(name).toLowerCase()] || "");
    }
  });

  const fromQuery = service.extractProxyApiKeyFromRequest({
    url: "/v1/responses?key=sk-query-secret",
    headers: {}
  });
  const fromHeader = service.extractProxyApiKeyFromRequest({
    url: "/v1/responses?key=sk-query-secret",
    headers: {
      "x-api-key": "sk-header-secret"
    }
  });

  assert.equal(fromQuery, "");
  assert.equal(fromHeader, "sk-header-secret");
});
