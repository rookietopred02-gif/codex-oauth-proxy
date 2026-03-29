import assert from "node:assert/strict";
import test from "node:test";

import { createAuthService } from "../src/services/auth-service.js";

function createService() {
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
    loadJsonStore: async () => ({ version: 1, keys: [] }),
    saveJsonStore: async () => {},
    extractBearerToken: () => "",
    readHeaderValue: () => ""
  });
}

test("createProxyApiKey emits lowercase unambiguous local keys", () => {
  const service = createService();
  const key = service.createProxyApiKey();

  assert.match(key, /^sk-[a-z2-9]+$/);
  assert.doesNotMatch(key, /[01lo]/);
});

test("findManagedProxyApiKeyByValue accepts a unique case-insensitive match", async () => {
  const service = createService();
  const store = service.getProxyApiKeyStore();
  store.keys.push({
    id: "key_1",
    label: "generated-key",
    prefix: "sk-ZnuNesP",
    value: "sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3",
    hash: service.hashProxyApiKey("sk-ZnuNesPaDbhOXJkEyagnYidxM4BzLYo3"),
    created_at: 1,
    last_used_at: 0,
    use_count: 0,
    revoked_at: 0,
    expires_at: 0
  });

  const matched = service.findManagedProxyApiKeyByValue("sk-ZnuNesPaDbHOXJkEyagnYidxM4BzLYo3");
  assert.equal(matched?.id, "key_1");
});
