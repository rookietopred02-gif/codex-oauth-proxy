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
});
