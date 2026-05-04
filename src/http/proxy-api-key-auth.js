const INVALID_PROXY_API_KEY_MESSAGE =
  "Invalid API key. Use one of: Authorization: Bearer <your_proxy_api_key>, x-api-key, x-goog-api-key, or ?key=<your_proxy_api_key>.";
const MISSING_PROXY_API_KEY_CONFIGURATION_MESSAGE =
  "Proxy API access is locked until a proxy API key is generated or LOCAL_API_KEY/CODEX_OAUTH_SHARED_API_KEY is configured.";

export function authorizeProxyApiRequest(req, context) {
  const {
    config,
    hasActiveManagedProxyApiKeys,
    extractProxyApiKeyFromRequest,
    findManagedProxyApiKeyByValue,
    recordManagedProxyApiKeyUsage
  } = context;

  const managedEnabled = hasActiveManagedProxyApiKeys();
  const legacyKey = String(config?.codexOAuth?.sharedApiKey || "").trim();
  if (!managedEnabled && !legacyKey) {
    return {
      ok: false,
      statusCode: 401,
      payload: {
        error: "proxy_api_key_not_configured",
        message: MISSING_PROXY_API_KEY_CONFIGURATION_MESSAGE
      }
    };
  }

  const provided = extractProxyApiKeyFromRequest(req);
  const managedMatch = findManagedProxyApiKeyByValue(provided);
  if (managedMatch) {
    recordManagedProxyApiKeyUsage(managedMatch);
    return {
      ok: true,
      proxyApiKeyId: managedMatch.id || null
    };
  }

  if (legacyKey && provided === legacyKey) {
    return {
      ok: true,
      proxyApiKeyId: null
    };
  }

  return {
    ok: false,
    statusCode: 401,
    payload: {
      error: "invalid_api_key",
      message: INVALID_PROXY_API_KEY_MESSAGE
    }
  };
}
