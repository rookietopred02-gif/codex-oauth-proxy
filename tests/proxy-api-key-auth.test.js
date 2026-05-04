import assert from "node:assert/strict";
import test from "node:test";

import { authorizeProxyApiRequest } from "../src/http/proxy-api-key-auth.js";

function createContext(overrides = {}) {
  return {
    config: {
      codexOAuth: {
        sharedApiKey: ""
      }
    },
    hasActiveManagedProxyApiKeys: () => false,
    extractProxyApiKeyFromRequest: () => "",
    findManagedProxyApiKeyByValue: () => null,
    recordManagedProxyApiKeyUsage: () => {},
    ...overrides
  };
}

test("proxy API authorization fails closed when no API key is configured", () => {
  const result = authorizeProxyApiRequest({}, createContext());

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.payload.error, "proxy_api_key_not_configured");
});

test("proxy API authorization still accepts the legacy shared key when configured", () => {
  const result = authorizeProxyApiRequest(
    {},
    createContext({
      config: {
        codexOAuth: {
          sharedApiKey: "sk-local"
        }
      },
      extractProxyApiKeyFromRequest: () => "sk-local"
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.proxyApiKeyId, "legacy-local-api-key");
  assert.equal(result.proxyApiKeyLabel, "legacy env LOCAL_API_KEY");
});

test("proxy API authorization returns managed key identity for request grouping", () => {
  const result = authorizeProxyApiRequest(
    {},
    createContext({
      hasActiveManagedProxyApiKeys: () => true,
      extractProxyApiKeyFromRequest: () => "sk-managed",
      findManagedProxyApiKeyByValue: () => ({
        id: "key_alpha",
        label: "alpha-client",
        prefix: "sk-alpha"
      })
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.proxyApiKeyId, "key_alpha");
  assert.equal(result.proxyApiKeyLabel, "alpha-client");
});

test("proxy API authorization does not advertise URL query credentials", () => {
  const result = authorizeProxyApiRequest(
    {},
    createContext({
      hasActiveManagedProxyApiKeys: () => true,
      extractProxyApiKeyFromRequest: () => "sk-wrong"
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.doesNotMatch(result.payload.message, /\?key=|query/i);
});
