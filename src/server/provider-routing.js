export function readHeaderValue(req, name) {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || "";
  return typeof raw === "string" ? raw : "";
}

export function extractBearerToken(req) {
  const auth = readHeaderValue(req, "authorization");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return "";
  return (match[1] || "").trim();
}

export async function withTimeout(promise, timeoutMs, errorMessage) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createProviderRoutingHelpers({
  config,
  DEFAULT_CODEX_CLIENT_VERSION,
  OFFICIAL_OPENAI_MODELS,
  OFFICIAL_GEMINI_MODELS,
  OFFICIAL_ANTHROPIC_MODELS,
  OFFICIAL_CODEX_MODELS,
  getValidAuthContext,
  getCodexOriginator,
  getCachedJsonBody
}) {
  function getModeDefaultModel(mode) {
    if (mode === "gemini-v1beta") return config.gemini.defaultModel;
    if (mode === "anthropic-v1") return config.anthropic.defaultModel;
    return config.codex.defaultModel;
  }

  function wildcardMatch(pattern, text) {
    const parts = String(pattern || "").split("*");
    if (parts.length === 1) return pattern === text;
    let textPos = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part) continue;
      if (i === 0) {
        if (!text.slice(textPos).startsWith(part)) return false;
        textPos += part.length;
        continue;
      }
      if (i === parts.length - 1) {
        return text.slice(textPos).endsWith(part);
      }
      const nextPos = text.slice(textPos).indexOf(part);
      if (nextPos < 0) return false;
      textPos += nextPos + part.length;
    }
    return true;
  }

  function resolveSystemModelRoute(originalModel, targetMode) {
    const model =
      typeof originalModel === "string" && originalModel.trim().length > 0
        ? originalModel.trim()
        : getModeDefaultModel(targetMode);
    const lower = model.toLowerCase();

    if (targetMode === "gemini-v1beta") {
      if (lower.startsWith("gemini-")) return model;
      if (lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("claude-")) {
        return config.gemini.defaultModel;
      }
      return model;
    }

    if (targetMode === "anthropic-v1") {
      if (lower.startsWith("claude-")) return model;
      if (lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("gemini-")) {
        return config.anthropic.defaultModel;
      }
      return model;
    }

    if (lower.startsWith("gpt-") || lower.includes("codex")) return model;
    return config.codex.defaultModel;
  }

  function resolveModelRoute(originalModel, targetMode = config.upstreamMode) {
    const requestedModel =
      typeof originalModel === "string" && originalModel.trim().length > 0
        ? originalModel.trim()
        : getModeDefaultModel(targetMode);

    if (!config.modelRouter.enabled) {
      return {
        requestedModel,
        mappedModel: requestedModel,
        routeType: "disabled",
        routeRule: null
      };
    }

    const customMappings = config.modelRouter.customMappings || {};
    if (customMappings[requestedModel]) {
      return {
        requestedModel,
        mappedModel: customMappings[requestedModel],
        routeType: "exact",
        routeRule: requestedModel
      };
    }

    let bestWildcard = null;
    for (const [pattern, target] of Object.entries(customMappings)) {
      if (!pattern.includes("*")) continue;
      if (!wildcardMatch(pattern, requestedModel)) continue;
      const specificity = pattern.length - (pattern.match(/\*/g)?.length || 0);
      if (!bestWildcard || specificity > bestWildcard.specificity) {
        bestWildcard = {
          pattern,
          target,
          specificity
        };
      }
    }

    if (bestWildcard) {
      return {
        requestedModel,
        mappedModel: bestWildcard.target,
        routeType: "wildcard",
        routeRule: bestWildcard.pattern
      };
    }

    const fallbackModel = resolveSystemModelRoute(requestedModel, targetMode);
    return {
      requestedModel,
      mappedModel: fallbackModel,
      routeType: fallbackModel === requestedModel ? "passthrough" : "system",
      routeRule: fallbackModel === requestedModel ? null : targetMode
    };
  }

  function detectModelFamily(modelId) {
    const value = String(modelId || "").trim().toLowerCase();
    if (!value) return "";
    if (value.startsWith("gemini-")) return "gemini-v1beta";
    if (
      value.startsWith("claude-") ||
      value.includes("claude") ||
      value.includes("opus") ||
      value.includes("sonnet") ||
      value.includes("haiku")
    ) {
      return "anthropic-v1";
    }
    if (value.startsWith("gpt-") || value.includes("codex") || /^o\d/.test(value)) {
      return "codex-chatgpt";
    }
    return "";
  }

  function resolveCustomModelRouteOnly(originalModel) {
    const requestedModel =
      typeof originalModel === "string" && originalModel.trim().length > 0
        ? originalModel.trim()
        : "";
    if (!requestedModel || !config.modelRouter.enabled) return null;

    const customMappings = config.modelRouter.customMappings || {};
    if (customMappings[requestedModel]) {
      return {
        requestedModel,
        mappedModel: customMappings[requestedModel],
        routeType: "exact",
        routeRule: requestedModel
      };
    }

    let bestWildcard = null;
    for (const [pattern, target] of Object.entries(customMappings)) {
      if (!pattern.includes("*")) continue;
      if (!wildcardMatch(pattern, requestedModel)) continue;
      const specificity = pattern.length - (pattern.match(/\*/g)?.length || 0);
      if (!bestWildcard || specificity > bestWildcard.specificity) {
        bestWildcard = {
          pattern,
          target,
          specificity
        };
      }
    }

    if (!bestWildcard) return null;
    return {
      requestedModel,
      mappedModel: bestWildcard.target,
      routeType: "wildcard",
      routeRule: bestWildcard.pattern
    };
  }

  function resolveCodexCompatibleRoute(originalModel) {
    const route = resolveModelRoute(originalModel, "codex-chatgpt");
    const family = detectModelFamily(route.mappedModel);
    if (!family || family === "codex-chatgpt") return route;

    const fallbackModel = resolveSystemModelRoute(route.requestedModel, "codex-chatgpt");
    return {
      requestedModel: route.requestedModel,
      mappedModel: fallbackModel,
      routeType: "system",
      routeRule: "codex-chatgpt"
    };
  }

  function extractRequestedModelFromOpenAICompatBody(
    rawBody,
    fallbackModel = config.codex.defaultModel,
    parsedBody = undefined
  ) {
    if ((!rawBody || rawBody.length === 0) && parsedBody === undefined) return fallbackModel;

    let parsed = parsedBody;
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return fallbackModel;
      }
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
      if (model.length > 0) return model;
    }
    return fallbackModel;
  }

  function chooseProtocolForV1ChatCompletions(req) {
    const requestedModel = extractRequestedModelFromOpenAICompatBody(
      req.rawBody,
      getModeDefaultModel(config.upstreamMode),
      getCachedJsonBody(req)
    );
    const customRoute = resolveCustomModelRouteOnly(requestedModel);
    if (customRoute) {
      const customFamily = detectModelFamily(customRoute.mappedModel);
      if (customFamily) {
        return customFamily;
      }
    }

    if (config.upstreamMode === "codex-chatgpt") {
      const requestFamily = detectModelFamily(requestedModel);
      if (requestFamily === "gemini-v1beta" || requestFamily === "anthropic-v1") {
        return requestFamily;
      }
    }

    return config.upstreamMode;
  }

  function isGeminiNativeAliasPath(pathname) {
    return /^\/v1\/models\/[^/:]+:(generateContent|streamGenerateContent|countTokens)$/.test(
      String(pathname || "")
    );
  }

  function uniqueNonEmptyModelIds(values) {
    return [...new Set((values || []).filter((x) => typeof x === "string" && x.trim().length > 0))];
  }

  function getOpenAICompatibleModelIds() {
    const ids = [
      config.codex.defaultModel,
      config.gemini.defaultModel,
      config.anthropic.defaultModel,
      ...OFFICIAL_OPENAI_MODELS,
      ...OFFICIAL_GEMINI_MODELS,
      ...OFFICIAL_ANTHROPIC_MODELS
    ];
    for (const [sourceModel, targetModel] of Object.entries(config.modelRouter.customMappings || {})) {
      ids.push(sourceModel, targetModel);
    }
    return uniqueNonEmptyModelIds(ids);
  }

  function getModelCandidateIds() {
    const ids = [
      config.codex.defaultModel,
      config.gemini.defaultModel,
      config.anthropic.defaultModel,
      ...OFFICIAL_OPENAI_MODELS,
      ...OFFICIAL_GEMINI_MODELS,
      ...OFFICIAL_ANTHROPIC_MODELS
    ];
    ids.push(...getOpenAICompatibleModelIds());
    for (const [sourceModel, targetModel] of Object.entries(config.modelRouter.customMappings || {})) {
      ids.push(sourceModel, targetModel);
    }
    return uniqueNonEmptyModelIds(ids).sort();
  }

  function buildOfficialCodexModelCandidateIds(dynamicIds = [], defaultModel = config.codex.defaultModel) {
    return uniqueNonEmptyModelIds([
      defaultModel,
      ...OFFICIAL_CODEX_MODELS,
      ...(Array.isArray(dynamicIds) ? dynamicIds : [])
    ]).sort();
  }

  const officialModelCache = {
    expiresAt: 0,
    ids: [],
    codexIds: []
  };

  async function fetchCodexOfficialModels() {
    let auth = null;
    try {
      auth = await getValidAuthContext();
    } catch {
      return [];
    }
    if (!auth?.accessToken || !auth?.accountId) return [];

    const url = new URL(`${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/models`);
    url.searchParams.set("client_version", DEFAULT_CODEX_CLIENT_VERSION);

    const resp = await withTimeout(
      fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          "openai-beta": "responses=experimental",
          originator: getCodexOriginator(),
          accept: "application/json",
          "user-agent": "codex-pro-max-model-catalog"
        }
      }),
      5000,
      "Codex model catalog request timed out."
    );
    if (!resp.ok) return [];
    const json = await resp.json().catch(() => null);
    const models = Array.isArray(json?.models) ? json.models : [];
    return uniqueNonEmptyModelIds(models.map((m) => (typeof m?.slug === "string" ? m.slug : "")));
  }

  async function fetchGeminiOfficialModels() {
    const apiKey = String(config.gemini.apiKey || "").trim();
    if (!apiKey) return [];

    const url = new URL(`${config.gemini.baseUrl.replace(/\/+$/, "")}/models`);
    url.searchParams.set("key", apiKey);
    const resp = await withTimeout(
      fetch(url.toString(), { method: "GET" }),
      5000,
      "Gemini model catalog request timed out."
    );
    if (!resp.ok) return [];
    const json = await resp.json().catch(() => null);
    const models = Array.isArray(json?.models) ? json.models : [];
    return uniqueNonEmptyModelIds(
      models.map((m) => {
        const raw = typeof m?.name === "string" ? m.name : "";
        return raw.startsWith("models/") ? raw.slice(7) : raw;
      })
    );
  }

  async function fetchAnthropicOfficialModels() {
    const apiKey = String(config.anthropic.apiKey || "").trim();
    if (!apiKey) return [];

    const url = `${config.anthropic.baseUrl.replace(/\/+$/, "")}/models`;
    const resp = await withTimeout(
      fetch(url, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": config.anthropic.version
        }
      }),
      5000,
      "Anthropic model catalog request timed out."
    );
    if (!resp.ok) return [];
    const json = await resp.json().catch(() => null);
    const models = Array.isArray(json?.data) ? json.data : [];
    return uniqueNonEmptyModelIds(models.map((m) => (typeof m?.id === "string" ? m.id : "")));
  }

  async function getOfficialModelCandidateIds({ forceRefresh = false } = {}) {
    if (!forceRefresh && officialModelCache.expiresAt > Date.now() && officialModelCache.ids.length > 0) {
      return officialModelCache.ids;
    }

    const [codexIds, geminiIds, anthropicIds] = await Promise.all([
      fetchCodexOfficialModels().catch(() => []),
      fetchGeminiOfficialModels().catch(() => []),
      fetchAnthropicOfficialModels().catch(() => [])
    ]);

    const merged = uniqueNonEmptyModelIds([
      ...OFFICIAL_OPENAI_MODELS,
      ...OFFICIAL_GEMINI_MODELS,
      ...OFFICIAL_ANTHROPIC_MODELS,
      ...codexIds,
      ...geminiIds,
      ...anthropicIds,
      ...getModelCandidateIds()
    ]).sort();
    const codexMerged = buildOfficialCodexModelCandidateIds(codexIds, config.codex.defaultModel);

    officialModelCache.ids = merged;
    officialModelCache.codexIds = codexMerged;
    officialModelCache.expiresAt = Date.now() + 5 * 60 * 1000;
    return merged;
  }

  async function getOfficialCodexModelCandidateIds({ forceRefresh = false } = {}) {
    if (!forceRefresh && officialModelCache.expiresAt > Date.now() && officialModelCache.codexIds.length > 0) {
      return officialModelCache.codexIds;
    }
    await getOfficialModelCandidateIds({ forceRefresh });
    return officialModelCache.codexIds;
  }

  function sanitizeUpstreamApiKeyCandidate(value) {
    const key = String(value || "").trim();
    if (!key) return "";
    const shared = String(config.codexOAuth.sharedApiKey || "").trim();
    if (shared && key === shared) return "";
    return key;
  }

  function isLikelyGeminiApiKey(value) {
    const key = String(value || "").trim();
    return /^AIza[0-9A-Za-z_-]{20,}$/.test(key);
  }

  function isLikelyAnthropicApiKey(value) {
    const key = String(value || "").trim();
    return /^sk-ant-[0-9A-Za-z_-]{16,}$/i.test(key);
  }

  function extractGeminiRequestApiKeys(req) {
    if (!config.providerUpstream.allowRequestApiKeys) {
      return {
        headerKey: "",
        queryKey: ""
      };
    }
    const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
    return {
      headerKey: sanitizeUpstreamApiKeyCandidate(readHeaderValue(req, "x-goog-api-key")),
      queryKey: sanitizeUpstreamApiKeyCandidate(incoming.searchParams.get("key") || "")
    };
  }

  function shouldForceGeminiUpstream(req) {
    const forceHeader = String(readHeaderValue(req, "x-proxy-gemini-upstream") || "")
      .trim()
      .toLowerCase();
    if (["1", "true", "yes", "on", "force"].includes(forceHeader)) return true;
    const incoming = new URL(req.originalUrl || req.url || "", "http://localhost");
    const forceQuery = String(incoming.searchParams.get("proxy_gemini_upstream") || "")
      .trim()
      .toLowerCase();
    return ["1", "true", "yes", "on", "force"].includes(forceQuery);
  }

  function shouldPreferGeminiCompat(req) {
    if (config.authMode !== "codex-oauth") return false;
    if (shouldForceGeminiUpstream(req)) return false;
    return true;
  }

  function shouldFallbackGeminiUpstreamToCompat(req, httpStatus) {
    return shouldPreferGeminiCompat(req) && [401, 403, 429].includes(Number(httpStatus || 0));
  }

  function resolveGeminiApiKey(req) {
    if (shouldPreferGeminiCompat(req)) return "";
    const configuredKey = sanitizeUpstreamApiKeyCandidate(config.gemini.apiKey || "");
    if (configuredKey && isLikelyGeminiApiKey(configuredKey)) return configuredKey;
    const { headerKey, queryKey } = extractGeminiRequestApiKeys(req);
    if (headerKey && isLikelyGeminiApiKey(headerKey)) return headerKey;
    if (queryKey && isLikelyGeminiApiKey(queryKey)) return queryKey;
    return "";
  }

  function resolveAnthropicApiKey(req) {
    const configuredKey = sanitizeUpstreamApiKeyCandidate(config.anthropic.apiKey || "");
    if (configuredKey && isLikelyAnthropicApiKey(configuredKey)) return configuredKey;
    if (!config.providerUpstream.allowRequestApiKeys) return "";
    const headerKey = sanitizeUpstreamApiKeyCandidate(readHeaderValue(req, "x-api-key"));
    if (headerKey && isLikelyAnthropicApiKey(headerKey)) return headerKey;
    return "";
  }

  function isAnthropicNativeRequest(req) {
    return (
      config.upstreamMode === "anthropic-v1" ||
      Boolean(readHeaderValue(req, "anthropic-version")) ||
      Boolean(readHeaderValue(req, "anthropic-beta")) ||
      (config.providerUpstream.allowRequestApiKeys && Boolean(readHeaderValue(req, "x-api-key")))
    );
  }

  async function handleAnthropicModelsList(req, res) {
    const nowIso = new Date().toISOString();
    const modelIds = getOpenAICompatibleModelIds();
    res.json({
      data: modelIds.map((id) => ({
        type: "model",
        id,
        display_name: id,
        created_at: nowIso
      })),
      first_id: modelIds[0] || config.anthropic.defaultModel,
      last_id: modelIds[modelIds.length - 1] || config.anthropic.defaultModel,
      has_more: false
    });
  }

  return {
    buildOfficialCodexModelCandidateIds,
    chooseProtocolForV1ChatCompletions,
    getOfficialCodexModelCandidateIds,
    getOfficialModelCandidateIds,
    getOpenAICompatibleModelIds,
    handleAnthropicModelsList,
    isAnthropicNativeRequest,
    isGeminiNativeAliasPath,
    resolveAnthropicApiKey,
    resolveCodexCompatibleRoute,
    resolveGeminiApiKey,
    resolveModelRoute,
    shouldFallbackGeminiUpstreamToCompat
  };
}
