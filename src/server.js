import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { createDashboardAuthController } from "./dashboard-auth.js";
import { persistProxyConfigEnv } from "./env-config-store.js";

import { extractCodexOAuthImportItems, importCodexOAuthTokens } from "./codex-auth-pool-import.js";
import { createCodexAccountLeaseRegistry } from "./codex-account-leases.js";
import { isCodexTokenInvalidatedError } from "./codex-token-invalidated.js";
import { createExpiredAccountCleanupController } from "./expired-account-cleanup.js";
import { createResponseAffinityStore, extractPreviousResponseId } from "./response-affinity.js";
import {
  buildResponsesChainEntry,
  expandResponsesRequestBodyFromChain,
  createResponsesChainStore
} from "./responses-chain-store.js";
import { createTempMailController } from "./temp-mail-controller.js";
import { createCodexPoolSelectionHelpers } from "./runtime/codex-pool-selection.js";
import { createCodexAuthPoolCoreHelpers } from "./runtime/codex-auth-pool-core.js";
import { createCodexAccountIdentityHelpers } from "./runtime/codex-account-identity.js";
import {
  extractUpstreamTransportError,
  fetchWithUpstreamRetry,
  isPreviousResponseIdUnsupportedError
} from "./upstream-transport.js";
import {
  formatPayloadForAudit,
  inferProtocolType,
  isProxyApiPath,
  parseContentType,
  sanitizeAuditPath,
  toChunkBuffer
} from "./http/audit.js";
import {
  pipeAnthropicSseAsOpenAIChatCompletions,
  pipeGeminiSseAsOpenAIChatCompletions
} from "./http/provider-stream-adapters.js";
import { sendOpenAICompletionAsSse } from "./http/openai-chat-stream.js";
import { getCachedJsonBody, readJsonBody, readRawBody } from "./http/request-body.js";
import { createUpstreamRuntimeHelpers } from "./http/upstream-runtime.js";
import { createAnthropicLocalCompatHelpers } from "./protocols/anthropic/local-compat.js";
import { createAnthropicOpenAICompatHelpers } from "./protocols/anthropic/openai-compat.js";
import { createCodexOAuthResponsesHelpers } from "./protocols/codex/oauth-responses.js";
import { createGeminiLocalCompatHelpers } from "./protocols/gemini/local-compat.js";
import { applyAdditionalResponsesCreateFields } from "./protocols/openai/responses-create-compat.js";
import { assertResponsesCreateFieldSupported } from "./protocols/openai/responses-create-compat.js";
import { createOpenAIRequestNormalizationHelpers } from "./protocols/openai/request-normalization.js";
import { createOpenAIResponsesCompatHelpers } from "./protocols/openai/responses-compat.js";
import { createServerLifecycleRuntime, registerServerApp } from "./server/app-runtime.js";
import { createAuthContextRuntime } from "./server/auth-context-runtime.js";
import { createAuthService } from "./services/auth-service.js";
import { createAuditService } from "./services/audit-service.js";
import { createCloudflaredService } from "./services/cloudflared-service.js";
import { createCodexOAuthCallbackRuntime } from "./server/oauth-callback-runtime.js";
import {
  createProviderRoutingHelpers,
  extractBearerToken,
  readHeaderValue,
  withTimeout
} from "./server/provider-routing.js";
import {
  loadJsonStore,
  loadTokenStore,
  normalizeToken,
  saveJsonStore,
  saveTokenStore
} from "./server/store-utils.js";
import { createServerTestingExports } from "./server/testing-exports.js";
import {
  DEFAULT_CLOUDFLARED_BIN,
  DEFAULT_CODEX_UPSTREAM_BASE_URL,
  LOW_QUOTA_THRESHOLD_DUAL_WINDOW,
  LOW_QUOTA_THRESHOLD_SINGLE_WINDOW,
  MULTI_ACCOUNT_STRATEGY_LIST,
  OAUTH_CALLBACK_SUCCESS_HTML,
  OFFICIAL_ANTHROPIC_MODELS,
  OFFICIAL_CODEX_MODELS,
  OFFICIAL_GEMINI_MODELS,
  OFFICIAL_OPENAI_MODELS,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_JWT_CLAIM_PATH,
  OPENAI_CODEX_TOKEN_URL,
  VALID_CLOUDFLARED_MODES,
  VALID_MULTI_ACCOUNT_STRATEGIES,
  clampReasoningEffortForModel,
  createServerConfig,
  getDefaultCodexClientVersion,
  normalizeCodexServiceTier,
  normalizeUpstreamMode,
  parseBooleanEnv,
  parseNumberEnv,
  parseReasoningEffortOrFallback,
  parseSlotValue,
  resolveBundledCloudflaredBinaryName,
  resolveBundledCloudflaredTargetNames,
  resolveServerRuntimePaths,
  sanitizeModelMappings
} from "./services/config-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runtimePaths = resolveServerRuntimePaths({ rootDir, env: process.env });
const { runtimeBinDir, bundledCloudflaredResourcesDir, publicDir, envFilePath } = runtimePaths;
const DEFAULT_CODEX_CLIENT_VERSION = getDefaultCodexClientVersion(process.env);
const codexAccountIdentity = createCodexAccountIdentityHelpers({
  jwtClaimPath: OPENAI_CODEX_JWT_CLAIM_PATH
});
const {
  extractOpenAICodexAccountId,
  extractOpenAICodexPrincipalId,
  normalizeOpenAICodexPlanType,
  extractOpenAICodexPlanType,
  extractOpenAICodexEmail
} = codexAccountIdentity;
let config;
let hasExplicitCustomOAuthRedirectUri = false;
let hasExplicitCloudflaredLocalPort = false;
try {
  const runtimeConfig = createServerConfig({
    env: process.env,
    runtimePaths,
    logger: console
  });
  config = runtimeConfig.config;
  hasExplicitCustomOAuthRedirectUri = runtimeConfig.flags.hasExplicitCustomOAuthRedirectUri;
  hasExplicitCloudflaredLocalPort = runtimeConfig.flags.hasExplicitCloudflaredLocalPort;
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}

const codexAuthPoolCore = createCodexAuthPoolCoreHelpers({
  normalizeToken,
  parseSlotValue,
  normalizePlanType: normalizeOpenAICodexPlanType,
  extractAccountId: extractOpenAICodexAccountId,
  extractPrincipalId: extractOpenAICodexPrincipalId,
  extractPlanType: extractOpenAICodexPlanType,
  extractEmail: extractOpenAICodexEmail,
  getStrategy: () => config.codexOAuth.multiAccountStrategy,
  isAccountLeased: (ref, account) => isCodexAccountLeased(ref, account)
});

const {
  deriveCodexAccountIdFromToken,
  buildCodexPoolEntryId,
  deriveCodexPoolEntryIdFromToken,
  getCodexPoolEntryId,
  createDefaultCodexAccountPoolStore,
  sanitizeCodexAccountEntry,
  normalizeCodexAccountSlots,
  ensureCodexOAuthStoreShape,
  upsertCodexOAuthAccount,
  findCodexPoolAccountByRef,
  selectCodexAccountForLogout,
  removeCodexPoolAccountFromStore
} = codexAuthPoolCore;

const app = express();

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization"
]);

let customOAuthStore = { token: null };
let codexOAuthStore = { token: null };
if (config.authMode === "custom-oauth" || config.authMode === "codex-oauth") {
  customOAuthStore = await loadTokenStore(config.customOAuth.tokenStorePath);
  codexOAuthStore = await loadTokenStore(config.codexOAuth.tokenStorePath);
}
if (config.authMode === "codex-oauth") {
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  if (normalized.changed) {
    await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  }
}

const authService = createAuthService({
  config,
  loadJsonStore,
  saveJsonStore,
  extractBearerToken,
  readHeaderValue,
  logger: console
});
const {
  bootstrapLegacySharedApiKey,
  buildApiKeySummary,
  cacheAuthContext,
  clearAuthContextCache,
  createProxyApiKey,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  flushProxyApiKeyStore,
  getCachedAuthContext,
  getProxyApiKeyStore,
  hasActiveManagedProxyApiKeys,
  hashProxyApiKey,
  loadProxyApiKeyStore,
  persistProxyApiKeyStore,
  recordManagedProxyApiKeyUsage,
  sanitizeProxyApiKeyLabel
} = authService;
await loadProxyApiKeyStore();
if (bootstrapLegacySharedApiKey(config.codexOAuth.sharedApiKey, config.apiKeys.bootstrapLegacySharedKey)) {
  await persistProxyApiKeyStore();
}
const dashboardAuth = await createDashboardAuthController({
  storePath: config.dashboardAuth.storePath,
  sessionTtlSeconds: config.dashboardAuth.sessionTtlSeconds,
  loginWindowMs: config.dashboardAuth.loginWindowSeconds * 1000,
  loginMaxAttempts: config.dashboardAuth.loginMaxAttempts,
  minimumPasswordLength: config.dashboardAuth.minimumPasswordLength
});
const providerRoutingHelpers = createProviderRoutingHelpers({
  config,
  DEFAULT_CODEX_CLIENT_VERSION,
  OFFICIAL_OPENAI_MODELS,
  OFFICIAL_GEMINI_MODELS,
  OFFICIAL_ANTHROPIC_MODELS,
  OFFICIAL_CODEX_MODELS,
  getValidAuthContext,
  getCodexOriginator,
  getCachedJsonBody
});
const {
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
} = providerRoutingHelpers;
const codexOAuthCallbackRuntime = createCodexOAuthCallbackRuntime({
  config,
  OAUTH_CALLBACK_SUCCESS_HTML,
  logger: console,
  getActiveOAuthRuntime,
  normalizeToken,
  extractOpenAICodexAccountId,
  extractOpenAICodexPrincipalId,
  extractOpenAICodexEmail,
  parseSlotValue,
  ensureCodexOAuthStoreShape,
  normalizeOpenAICodexPlanType,
  extractOpenAICodexPlanType,
  withTimeout,
  fetchCodexUsageSnapshotForAccount,
  upsertCodexOAuthAccount,
  saveTokenStore,
  clearAuthContextCache,
  exchangeCodeForToken
});
const {
  buildOAuthCallbackMessage,
  cleanupPendingStates,
  completeOAuthCallback,
  ensureCodexOAuthCallbackServer,
  pendingAuth,
  randomBase64Url,
  sha256base64url,
  stopCodexOAuthCallbackServer,
  truncate,
  getCodexOAuthCallbackServer
} = codexOAuthCallbackRuntime;

const cloudflaredService = createCloudflaredService({
  config,
  rootDir,
  runtimeBinDir,
  bundledCloudflaredResourcesDir,
  defaultCloudflaredBin: DEFAULT_CLOUDFLARED_BIN,
  resolveBundledCloudflaredBinaryName,
  resolveBundledCloudflaredTargetNames,
  validCloudflaredModes: VALID_CLOUDFLARED_MODES,
  parseNumberEnv
});
const cloudflaredRuntime = cloudflaredService.runtime;
const resolveCloudflaredBin = (...args) => cloudflaredService.resolveBin(...args);
const checkCloudflaredInstalled = (...args) => cloudflaredService.checkInstalled(...args);
const getCloudflaredStatus = (...args) => cloudflaredService.getStatus(...args);
const installCloudflaredBinary = (...args) => cloudflaredService.installBinary(...args);
const startCloudflaredTunnel = (...args) => cloudflaredService.startTunnel(...args);
const stopCloudflaredTunnel = (...args) => cloudflaredService.stopTunnel(...args);

async function importIntoCodexAuthPool(items, options = {}) {
  const result = await importCodexOAuthTokens({
    store: codexOAuthStore,
    items,
    replace: options.replace === true,
    probeUsage: options.probeUsage !== false,
    ensureStoreShape: ensureCodexOAuthStoreShape,
    normalizeToken,
    upsertAccount: upsertCodexOAuthAccount,
    findAccountByRef: findCodexPoolAccountByRef,
    refreshUsageSnapshot: async (store, ref) =>
      await withTimeout(
        refreshCodexUsageSnapshotInStore(store, ref, config.codexOAuth, {
          includeDisabled: false
        }),
        12000,
        "Usage probe timed out."
      ),
    normalizePlanType: normalizeOpenAICodexPlanType,
    parseSlotValue
  });
  codexOAuthStore = result.store;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  return result;
}

const tempMailController = createTempMailController({
  rootDir,
  importTokens: async (items, options = {}) => await importIntoCodexAuthPool(items, options),
  isSupported: () => config.authMode === "codex-oauth",
  runnerBinaryPath: process.env.CODEX_PRO_MAX_TEMP_MAIL_RUNNER_BIN || "",
  runnerResourcesDir: process.env.CODEX_PRO_MAX_TEMP_MAIL_RESOURCES_DIR || "",
  allowGoRun: !parseBooleanEnv(process.env.CODEX_PRO_MAX_DISABLE_TEMP_MAIL_GO_RUN, false)
});

const expiredAccountCleanupController = createExpiredAccountCleanupController({
  initialConfig: config.expiredAccountCleanup,
  isSupported: () => config.authMode === "codex-oauth",
  getStore: () => codexOAuthStore,
  getAccounts: (store) => store?.accounts || [],
  probeAccount: async (store, ref) =>
    await refreshCodexUsageSnapshotInStore(store, ref, config.codexOAuth, { includeDisabled: true }),
  isAccountLeased: (ref, account) => isCodexAccountLeased(ref, account),
  removeAccount: (store, ref, options = {}) => removeCodexPoolAccountFromStore(store, ref, options),
  saveStore: async (store) => {
    codexOAuthStore = store;
    await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
    clearAuthContextCache();
  },
  onRemoved: async ({ reason, removedRefs }) => {
    if (!Array.isArray(removedRefs) || removedRefs.length === 0) return;
    console.log(
      `[auth-pool] ${reason}: removed ${removedRefs.length} auto-rm account(s): ${removedRefs.join(", ")}`
    );
  }
});

const RUNTIME_AUDIT_MAX_BODY_BYTES = 96 * 1024;
const RUNTIME_AUDIT_MAX_TEXT_CHARS = 12000;
const auditService = await createAuditService({
  historyPath: config.requestAudit.historyPath,
  maxEntries: config.requestAudit.maxEntries,
  getCodexOAuthStore: () => codexOAuthStore,
  ensureCodexOAuthStoreShape,
  findCodexPoolAccountByRef
});
const { runtimeStats, recentRequestsStore, resolveAuditAccountLabel, nextRuntimeRequestSeq } = auditService;

async function runBoundedShutdownStep(label, task, timeoutMs = 2500) {
  try {
    await withTimeout(Promise.resolve().then(task), timeoutMs, `${label} timed out`);
  } catch (err) {
    console.warn(`[shutdown] ${label}: ${err?.message || err}`);
  }
}

let codexPreheatHistory = { accounts: {} };
try {
  codexPreheatHistory = await loadJsonStore(config.codexPreheat.historyPath, { accounts: {} });
} catch {
  codexPreheatHistory = { accounts: {} };
}
if (!codexPreheatHistory || typeof codexPreheatHistory !== "object") {
  codexPreheatHistory = { accounts: {} };
}
if (!codexPreheatHistory.accounts || typeof codexPreheatHistory.accounts !== "object") {
  codexPreheatHistory.accounts = {};
}

const codexPreheatRuntime = {
  running: false,
  lastRunAt: 0,
  lastCompletedAt: 0,
  lastReason: "",
  lastStatus: "idle",
  lastError: "",
  lastDurationMs: 0,
  lastSummary: null
};

const codexResponseAffinity = createResponseAffinityStore();
const codexResponsesChain = createResponsesChainStore();
const codexAccountLeaseRegistry = createCodexAccountLeaseRegistry();

let expiredAccountCleanupTimer = null;

function normalizeCodexAccountLeaseRefs(...refs) {
  const unique = new Set();
  for (const value of refs.flat()) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function acquireCodexAccountLease(authContext = null) {
  const refs = normalizeCodexAccountLeaseRefs(
    authContext?.poolEntryId,
    authContext?.poolAccountId,
    authContext?.accountId
  );
  if (refs.length === 0) {
    return () => {};
  }
  const leases = refs.map((ref) => codexAccountLeaseRegistry.acquire(ref));

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const lease of leases) {
      lease?.release?.();
    }
  };
}

function isCodexAccountLeased(ref = "", account = null) {
  const refs = normalizeCodexAccountLeaseRefs(
    ref,
    account?.identity_id,
    account?.entry_id,
    account?.entryId,
    account?.account_id,
    account?.accountId
  );
  return refs.some((candidate) => codexAccountLeaseRegistry.isLeased(candidate));
}

const codexPoolSelection = createCodexPoolSelectionHelpers({
  lowQuotaThresholdDualWindow: LOW_QUOTA_THRESHOLD_DUAL_WINDOW,
  lowQuotaThresholdSingleWindow: LOW_QUOTA_THRESHOLD_SINGLE_WINDOW,
  getCodexPoolEntryId,
  isCodexAccountLeased: (ref, account) => isCodexAccountLeased(ref, account),
  getStrategy: () => config.codexOAuth.multiAccountStrategy,
  randomInt: crypto.randomInt
});

const {
  hasCodexUsageWindow,
  readUsageRemainingPercent,
  readUsageUsedPercent,
  getCodexUsageWindowStats,
  classifyCodexPoolHealth,
  buildCodexPoolMetrics,
  getCodexEnabledAccounts,
  pickCodexAccountCandidates
} = codexPoolSelection;

function startExpiredAccountCleanupTimer() {
  if (expiredAccountCleanupTimer) return expiredAccountCleanupTimer;
  expiredAccountCleanupTimer = setInterval(() => {
    expiredAccountCleanupController.run("interval").catch((err) => {
      console.warn(`[auth-pool] account auto-rm failed: ${err?.message || err}`);
    });
  }, Math.max(10, Number(config.expiredAccountCleanup.intervalSeconds || 30)) * 1000);
  expiredAccountCleanupTimer.unref?.();
  return expiredAccountCleanupTimer;
}

function stopExpiredAccountCleanupTimer() {
  if (!expiredAccountCleanupTimer) return;
  clearInterval(expiredAccountCleanupTimer);
  expiredAccountCleanupTimer = null;
}

function getActiveUpstreamBaseUrl() {
  if (config.upstreamMode === "gemini-v1beta") return config.gemini.baseUrl;
  if (config.upstreamMode === "anthropic-v1") return config.anthropic.baseUrl;
  return config.upstreamBaseUrl;
}

function setActiveUpstreamBaseUrl(nextBaseUrl) {
  if (config.upstreamMode === "gemini-v1beta") {
    config.gemini.baseUrl = nextBaseUrl;
    return;
  }
  if (config.upstreamMode === "anthropic-v1") {
    config.anthropic.baseUrl = nextBaseUrl;
    return;
  }
  config.upstreamBaseUrl = nextBaseUrl;
}

function isSelfProxyBaseUrl(urlValue) {
  try {
    const parsed = new URL(String(urlValue || ""));
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return false;

    const parsedPort = Number(parsed.port || (protocol === "https:" ? 443 : 80));
    if (parsedPort !== Number(config.port)) return false;

    const host = String(parsed.hostname || "").toLowerCase();
    const selfHosts = new Set([
      String(config.host || "").toLowerCase(),
      "127.0.0.1",
      "localhost",
      "::1",
      "0.0.0.0"
    ]);
    return selfHosts.has(host);
  } catch {
    return false;
  }
}

function getCodexUsageProbeBaseUrl() {
  const configured = String(config.codexOAuth.usageBaseUrl || "").trim();
  const selected = configured || DEFAULT_CODEX_UPSTREAM_BASE_URL;
  if (isSelfProxyBaseUrl(selected)) {
    return DEFAULT_CODEX_UPSTREAM_BASE_URL;
  }
  return selected;
}

function isCodexMultiAccountEnabled() {
  return config.authMode === "codex-oauth" && config.codexOAuth.multiAccountEnabled === true;
}

function replaceActiveOAuthStore(nextStore) {
  if (config.authMode === "codex-oauth") {
    codexOAuthStore = nextStore;
    return;
  }
  if (config.authMode === "custom-oauth") {
    customOAuthStore = nextStore;
  }
}
function getCodexOAuthStore() {
  return codexOAuthStore;
}

function setCodexOAuthStore(nextStore) {
  codexOAuthStore = nextStore;
}

const authContextRuntime = createAuthContextRuntime({
  config,
  logger: console,
  ensureCodexOAuthStoreShape,
  saveTokenStore,
  normalizeToken,
  extractOpenAICodexAccountId,
  extractOpenAICodexPrincipalId,
  deriveCodexPoolEntryIdFromToken,
  upsertCodexOAuthAccount,
  pickCodexAccountCandidates,
  getCodexEnabledAccounts,
  getCodexPoolEntryId,
  clearAuthContextCache,
  expiredAccountCleanupController,
  isCodexTokenInvalidatedError,
  applyCodexInvalidatedAccountState
});
const { getValidAuthContextFromCodexOAuthStore, getValidAuthContextFromOAuthStore } = authContextRuntime;

const upstreamRuntimeHelpers = createUpstreamRuntimeHelpers({
  maxAuditTextChars: RUNTIME_AUDIT_MAX_TEXT_CHARS,
  extractUpstreamTransportError,
  fetchWithUpstreamRetry,
  formatPayloadForAudit,
  parseContentType,
  upstreamStreamIdleTimeoutMs: config.upstreamStreamIdleTimeoutMs
});
const {
  noteUpstreamRetry,
  noteCompatibilityHint,
  noteUpstreamRequestAudit,
  fetchUpstreamWithRetry,
  pipeUpstreamBodyToResponse,
  readUpstreamTextOrThrow
} = upstreamRuntimeHelpers;
const openAIRequestNormalizationHelpers = createOpenAIRequestNormalizationHelpers({
  config,
  resolveCodexCompatibleRoute,
  resolveReasoningEffort,
  applyReasoningEffortDefaults
});
const {
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  toResponsesInputFromChatMessages
} = openAIRequestNormalizationHelpers;
const openAIResponsesCompatHelpers = createOpenAIResponsesCompatHelpers({
  config,
  parseJsonLoose,
  upstreamStreamIdleTimeoutMs: () => config.upstreamStreamIdleTimeoutMs
});
const {
  parseResponsesResultFromSse,
  extractCompletedResponseFromSse,
  extractCompletedResponseFromJson,
  pipeCodexSse,
  pipeSseAndCaptureTokenUsage,
  pipeCodexSseAsChatCompletions,
  normalizeTokenUsage,
  mergeNormalizedTokenUsage,
  extractTokenUsageFromAuditResponse,
  convertResponsesToChatCompletion,
  extractAssistantDisplayTextFromResponse,
  extractAssistantTextFromResponse,
  extractAssistantToolCallsFromResponse,
  mapResponsesStatusToChatFinishReason
} = openAIResponsesCompatHelpers;
const codexOAuthResponsesHelpers = createCodexOAuthResponsesHelpers({
  config,
  truncate,
  getValidAuthContext,
  getCodexOriginator,
  fetchWithUpstreamRetry,
  readUpstreamTextOrThrow,
  parseResponsesResultFromSse,
  extractCompletedResponseFromJson,
  normalizeTokenUsage,
  extractAssistantDisplayTextFromResponse,
  extractAssistantTextFromResponse,
  mapResponsesStatusToChatFinishReason,
  resolveReasoningEffort,
  resolveCodexCompatibleRoute,
  isUnsupportedMaxOutputTokensError,
  isCodexPoolRetryEnabled,
  shouldRotateCodexAccountForStatus,
  maybeMarkCodexPoolFailure,
  maybeMarkCodexPoolSuccess,
  maybeCaptureCodexUsageFromHeaders,
  toResponsesInputFromChatMessages,
  applyAdditionalResponsesCreateFields,
  assertResponsesCreateFieldSupported
});
const {
  buildCodexResponsesRequestBody,
  executeCodexResponsesViaOAuth,
  openCodexResponsesStreamViaOAuth,
  openCodexConversationStreamViaOAuth,
  runCodexConversationViaOAuth
} = codexOAuthResponsesHelpers;
const anthropicLocalCompatHelpers = createAnthropicLocalCompatHelpers({
  config,
  readJsonBody,
  readRawBody,
  parseJsonLoose,
  truncate,
  resolveReasoningEffort,
  resolveCodexCompatibleRoute,
  executeCodexResponsesViaOAuth,
  openCodexResponsesStreamViaOAuth,
  pipeCodexSse,
  resolveCompatErrorStatusCode,
  mapHttpStatusToAnthropicErrorType,
  mapResponsesStatusToChatFinishReason,
  mapOpenAIFinishReasonToAnthropic
});
const geminiLocalCompatHelpers = createGeminiLocalCompatHelpers({
  config,
  readJsonBody,
  resolveCodexCompatibleRoute,
  resolveCompatErrorStatusCode,
  parseOpenAIChatCompletionsLikeRequest,
  splitSystemAndConversation,
  buildOpenAIChatCompletion,
  sendOpenAICompletionAsSse,
  pipeCodexSse,
  pipeCodexSseAsChatCompletions,
  openCodexConversationStreamViaOAuth,
  mapResponsesStatusToChatFinishReason,
  mapOpenAIFinishReasonToGemini,
  runCodexConversationViaOAuth,
  getOpenAICompatibleModelIds
});
const anthropicOpenAICompatHelpers = createAnthropicOpenAICompatHelpers({
  config,
  readJsonBody,
  resolveCodexCompatibleRoute,
  resolveCompatErrorStatusCode,
  parseOpenAIChatCompletionsLikeRequest,
  splitSystemAndConversation,
  buildOpenAIChatCompletion,
  sendOpenAICompletionAsSse,
  pipeCodexSseAsChatCompletions,
  openCodexConversationStreamViaOAuth,
  runCodexConversationViaOAuth
});
const proxyRouteHandlerDeps = {
  config,
  runtimeStats,
  recentRequestsStore,
  hopByHop,
  runtimeAuditMaxBodyBytes: RUNTIME_AUDIT_MAX_BODY_BYTES,
  runtimeAuditMaxTextChars: RUNTIME_AUDIT_MAX_TEXT_CHARS,
  readJsonBody,
  readRawBody,
  getCachedJsonBody,
  extractPreviousResponseId,
  extractUpstreamTransportError,
  isPreviousResponseIdUnsupportedError,
  formatPayloadForAudit,
  inferProtocolType,
  isProxyApiPath,
  parseContentType,
  sanitizeAuditPath,
  toChunkBuffer,
  normalizeCherryAnthropicAgentOriginalUrl: anthropicLocalCompatHelpers.normalizeCherryAnthropicAgentOriginalUrl,
  isGeminiNativeAliasPath,
  chooseProtocolForV1ChatCompletions,
  handleGeminiProtocol,
  handleAnthropicProtocol,
  getValidAuthContext,
  getCodexOriginator,
  noteUpstreamRetry,
  noteCompatibilityHint,
  noteUpstreamRequestAudit,
  fetchUpstreamWithRetry,
  pipeUpstreamBodyToResponse,
  readUpstreamTextOrThrow,
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  parseJsonLoose,
  buildResponsesChainEntry,
  expandResponsesRequestBodyFromChain,
  codexResponsesChain,
  isCodexMultiAccountEnabled,
  isCodexPoolRetryEnabled,
  shouldRotateCodexAccountForStatus,
  maybeMarkCodexPoolFailure,
  maybeCaptureCodexUsageFromHeaders,
  maybeMarkCodexPoolSuccess,
  truncate,
  parseResponsesResultFromSse,
  extractCompletedResponseFromSse,
  extractCompletedResponseFromJson,
  convertResponsesToChatCompletion,
  pipeCodexSseAsChatCompletions,
  pipeSseAndCaptureTokenUsage,
  handleGeminiNativeProxy,
  handleAnthropicNativeProxy,
  normalizeTokenUsage,
  extractTokenUsageFromAuditResponse,
  estimateOpenAIChatCompletionTokens,
  mergeNormalizedTokenUsage,
  resolveAuditAccountLabel,
  handleAnthropicModelsList,
  isAnthropicNativeRequest,
  getOpenAICompatibleModelIds,
  isCodexTokenInvalidatedError,
  codexResponseAffinity,
  acquireCodexAccountLease,
  nextRuntimeRequestSeq,
  extractCodexOAuthImportItems,
  getAuthModeHint: () =>
    config.authMode === "profile-store"
      ? "Run `your external auth tool login flow` first."
      : "Open /auth/login first."
};

const { proxyRouteHandlers } = registerServerApp({
  app,
  config,
  publicDir,
  dashboardAuth,
  hasActiveManagedProxyApiKeys,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  recordManagedProxyApiKeyUsage,
  getAuthStatus,
  getActiveUpstreamBaseUrl,
  isCodexMultiAccountEnabled,
  getActiveOAuthRuntime,
  ensureCodexOAuthCallbackServer,
  randomBase64Url,
  sha256base64url,
  pendingAuth,
  cleanupPendingStates,
  parseSlotValue,
  completeOAuthCallback,
  buildOAuthCallbackMessage,
  oauthCallbackSuccessHtml: OAUTH_CALLBACK_SUCCESS_HTML,
  readJsonBody,
  removeCodexPoolAccountFromStore,
  isCodexAccountLeased,
  saveTokenStore,
  clearAuthContextCache,
  replaceActiveOAuthStore,
  runtimeStats,
  recentRequestsStore,
  cloudflaredRuntime,
  tempMailController,
  expiredAccountCleanupController,
  getProxyApiKeyStore,
  checkCloudflaredInstalled,
  buildApiKeySummary,
  getCloudflaredStatus,
  getCodexPreheatState,
  createProxyApiKey,
  hashProxyApiKey,
  sanitizeProxyApiKeyLabel,
  persistProxyApiKeyStore,
  startCloudflaredTunnel,
  stopCloudflaredTunnel,
  installCloudflaredBinary,
  validCloudflaredModes: VALID_CLOUDFLARED_MODES,
  parseNumberEnv,
  getOfficialModelCandidateIds,
  getOfficialCodexModelCandidateIds,
  getCodexOAuthStore,
  setCodexOAuthStore,
  ensureCodexOAuthStoreShape,
  buildCodexPoolMetrics,
  getCodexPoolEntryId,
  findCodexPoolAccountByRef,
  importIntoCodexAuthPool,
  normalizeOpenAICodexPlanType,
  refreshCodexUsageSnapshotInStore,
  refreshCodexTokensInStore,
  runCodexPreheat,
  persistProxyConfigEnv,
  envFilePath,
  normalizeUpstreamMode,
  setActiveUpstreamBaseUrl,
  normalizeCodexServiceTier,
  parseReasoningEffortOrFallback,
  validMultiAccountStrategies: VALID_MULTI_ACCOUNT_STRATEGIES,
  multiAccountStrategyList: MULTI_ACCOUNT_STRATEGY_LIST,
  sanitizeModelMappings,
  runDirectChatCompletionTest,
  proxyRouteHandlerDeps
});

const { serverLifecycle, shouldAutostartServer } = createServerLifecycleRuntime({
  app,
  config,
  parseBooleanEnv,
  processEnv: process.env,
  hasExplicitCustomOAuthRedirectUri,
  hasExplicitCloudflaredLocalPort,
  cloudflaredRuntime,
  getActiveUpstreamBaseUrl,
  startExpiredAccountCleanupTimer,
  stopExpiredAccountCleanupTimer,
  expiredAccountCleanupController,
  hasActiveManagedProxyApiKeys,
  extractProxyApiKeyFromRequest,
  findManagedProxyApiKeyByValue,
  recordManagedProxyApiKeyUsage,
  proxyRouteHandlers,
  parseResponsesResultFromSse,
  readUpstreamTextOrThrow,
  parseJsonLoose,
  tempMailController,
  recentRequestsStore,
  flushProxyApiKeyStore,
  stopCloudflaredTunnel,
  stopCodexOAuthCallbackServer,
  runBoundedShutdownStep
});
let mainServer = serverLifecycle.mainServer;

export async function startServer(options = {}) {
  const started = await serverLifecycle.start(options);
  mainServer = serverLifecycle.mainServer;
  return {
    app,
    mainServer,
    host: started?.host || config.host,
    port: started?.port || config.port,
    url: `http://${config.host}:${config.port}`
  };
}

export async function stopServer(signal = "SIGTERM") {
  await serverLifecycle.stop(signal);
  mainServer = serverLifecycle.mainServer;
  return {
    app,
    mainServer,
    stopped: true
  };
}

if (shouldAutostartServer) {
  try {
    await serverLifecycle.autostartPromise;
    mainServer = serverLifecycle.mainServer;
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `[startup] Port ${config.host}:${config.port} is already in use. Stop the existing process or run with a different PORT.`
      );
    } else {
      console.error(`[startup] Failed to start server: ${err?.message || err}`);
    }
    process.exit(1);
  }
}

async function getAuthStatus() {
  if (config.authMode === "profile-store") {
    const { store, profileId, profile } = await loadProfileStoreProfile();
    return {
      mode: "profile-store",
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      authenticated: Boolean(profile?.access),
      profileId,
      provider: profile?.provider ?? null,
      expiresAt: profile?.expires ?? null,
      hasRefreshToken: Boolean(profile?.refresh),
      accountId: profile?.accountId || extractOpenAICodexAccountId(profile?.access || "") || null,
      authStorePath: config.profileStore.authStorePath,
      hasStore: Boolean(store)
    };
  }

  const token = customOAuthStore.token || null;
  if (config.authMode === "codex-oauth") {
    const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
    codexOAuthStore = normalized.store;
    const codexToken = codexOAuthStore.token || null;
    const accounts = Array.isArray(codexOAuthStore.accounts) ? codexOAuthStore.accounts : [];
    const enabledCount = accounts.filter((x) => x.enabled !== false).length;
    const activeEntryId = codexOAuthStore.active_account_id || null;
    const metrics = buildCodexPoolMetrics(accounts, activeEntryId || "");
    return {
      mode: "codex-oauth",
      upstreamMode: config.upstreamMode,
      upstreamBaseUrl: getActiveUpstreamBaseUrl(),
      authenticated: Boolean(codexToken?.access_token),
      expiresAt: codexToken?.expires_at || null,
      hasRefreshToken: Boolean(codexToken?.refresh_token),
      accountId: extractOpenAICodexAccountId(codexToken?.access_token || "") || null,
      tokenStorePath: config.codexOAuth.tokenStorePath,
      sharedApiKeyEnabled: Boolean(config.codexOAuth.sharedApiKey),
      multiAccountEnabled: isCodexMultiAccountEnabled(),
      multiAccountStrategy: config.codexOAuth.multiAccountStrategy,
      accountPoolSize: accounts.length,
      enabledAccountCount: enabledCount,
      activeEntryId,
      activeAccountId:
        accounts.find((x) => getCodexPoolEntryId(x) === String(activeEntryId || ""))
          ?.account_id || null,
      poolMetrics: metrics.summary,
      accounts: (metrics.decorated || []).map((d, idx) => {
        const x = d.account;
        return {
          entryId: d.entryId,
          accountId: x.account_id,
          label: x.label || "",
          slot: Number(x.slot || 0) || idx + 1,
          enabled: x.enabled !== false,
          expiresAt: x.token?.expires_at || null,
          lastUsedAt: x.last_used_at || 0,
          failureCount: x.failure_count || 0,
          cooldownUntil: x.cooldown_until || 0,
          usageSnapshot: x.usage_snapshot || null,
          usageUpdatedAt: x.usage_updated_at || 0,
          healthScore: d.healthScore,
          healthStatus: d.healthStatus,
          primaryRemaining: d.primaryRemaining,
          secondaryRemaining: d.secondaryRemaining,
          lowQuota: d.lowQuota,
          hardLimited: d.hardLimited
        };
      })
    };
  }

  return {
    mode: "custom-oauth",
    upstreamMode: config.upstreamMode,
    upstreamBaseUrl: getActiveUpstreamBaseUrl(),
    authenticated: Boolean(token?.access_token),
    expiresAt: token?.expires_at || null,
    hasRefreshToken: Boolean(token?.refresh_token),
    accountId: extractOpenAICodexAccountId(token?.access_token || "") || null
  };
}

async function getValidAuthContext(options = {}) {
  const preferredPoolEntryId =
    typeof options.preferredPoolEntryId === "string" ? options.preferredPoolEntryId.trim() : "";
  const retainLease = options.retainLease === true;
  const allowCache = !(
    config.authMode === "codex-oauth" &&
    (isCodexMultiAccountEnabled() || preferredPoolEntryId.length > 0)
  );
  if (allowCache) {
    const cached = getCachedAuthContext();
    if (cached) {
      if (retainLease && config.authMode === "codex-oauth") {
        return {
          ...cached,
          releaseLease: acquireCodexAccountLease(cached)
        };
      }
      return cached;
    }
  }

  let context;
  if (config.authMode === "profile-store") {
    context = await getValidAuthContextFromProfileStore();
  } else if (config.authMode === "codex-oauth") {
    context = await getValidAuthContextFromCodexOAuthStore(codexOAuthStore, config.codexOAuth, {
      preferredPoolEntryId
    });
  } else {
    context = await getValidAuthContextFromOAuthStore(customOAuthStore, config.customOAuth);
  }

  if (allowCache) {
    cacheAuthContext(context);
  }
  if (retainLease && config.authMode === "codex-oauth") {
    return {
      ...context,
      releaseLease: acquireCodexAccountLease(context)
    };
  }
  return context;
}

async function loadProfileStoreProfile() {
  let raw;
  try {
    raw = await fs.readFile(config.profileStore.authStorePath, "utf8");
  } catch {
    throw new Error(`Profile Store auth store not found: ${config.profileStore.authStorePath}`);
  }

  const store = JSON.parse(raw);
  const resolved = resolveProfileStoreProfile(store, config.profileStore.profileId);
  if (!resolved.profile) {
    throw new Error(
      `No usable oauth profile found. Run: your external auth tool login flow`
    );
  }
  return { store, profileId: resolved.profileId, profile: resolved.profile };
}

function resolveProfileStoreProfile(store, preferredProfileId) {
  const profiles = store?.profiles ?? {};
  let profileId = preferredProfileId;
  let profile = profiles[profileId];

  if (!isProfileStoreCodexOauthProfile(profile)) {
    const fallbackEntry = Object.entries(profiles).find(([, value]) => isProfileStoreCodexOauthProfile(value));
    if (fallbackEntry) {
      profileId = fallbackEntry[0];
      profile = fallbackEntry[1];
    }
  }

  return { profileId, profile };
}

function isProfileStoreCodexOauthProfile(profile) {
  return (
    profile &&
    profile.type === "oauth" &&
    profile.provider === "openai-codex" &&
    typeof profile.access === "string"
  );
}

function isExpiredOrNearExpiryMs(expiresAtMs) {
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs - Date.now() < 60_000;
}

async function getValidAuthContextFromProfileStore() {
  const { store, profileId, profile } = await loadProfileStoreProfile();
  if (!profile.access) {
    throw new Error(`Profile ${profileId} has no access token.`);
  }

  const accountId = profile.accountId || extractOpenAICodexAccountId(profile.access) || null;
  if (!isExpiredOrNearExpiryMs(profile.expires)) {
    return {
      accessToken: profile.access,
      accountId
    };
  }

  if (!profile.refresh) {
    throw new Error(`Token expired and no refresh token found in profile ${profileId}.`);
  }

  const refreshed = await refreshOpenAICodexToken(profile.refresh);
  const nextProfile = {
    ...profile,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    ...(refreshed.accountId ? { accountId: refreshed.accountId } : {})
  };

  store.profiles = store.profiles || {};
  store.profiles[profileId] = nextProfile;
  store.lastGood = store.lastGood || {};
  store.lastGood["openai-codex"] = profileId;
  store.usageStats = store.usageStats || {};
  store.usageStats[profileId] = {
    ...(store.usageStats[profileId] || {}),
    lastUsed: Date.now(),
    errorCount: 0
  };

  await fs.writeFile(config.profileStore.authStorePath, JSON.stringify(store, null, 2), "utf8");
  return {
    accessToken: refreshed.access,
    accountId: refreshed.accountId || accountId
  };
}

async function refreshOpenAICodexToken(refreshToken) {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex refresh failed: HTTP ${response.status} ${response.statusText}: ${truncate(bodyText, 500)}`
    );
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("OpenAI Codex refresh failed: invalid JSON response.");
  }

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI Codex refresh failed: missing required token fields.");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractOpenAICodexAccountId(json.access_token)
  };
}

function getActiveOAuthRuntime() {
  if (config.authMode === "codex-oauth") {
    return { oauth: config.codexOAuth, store: codexOAuthStore };
  }
  if (config.authMode === "custom-oauth") {
    return { oauth: config.customOAuth, store: customOAuthStore };
  }
  return null;
}

function parsePercentOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function parseJsonLoose(rawText) {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function shouldRotateCodexAccountForStatus(statusCode) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function getCodexPoolCooldownSeconds(statusCode, failureCount) {
  if (statusCode === 401 || statusCode === 403) return Math.min(1800, 120 * Math.max(1, failureCount));
  if (statusCode === 429) return Math.min(600, 30 * Math.max(1, failureCount));
  return Math.min(180, 15 * Math.max(1, failureCount));
}

function applyCodexInvalidatedAccountState(store, target, nowSec = Math.floor(Date.now() / 1000)) {
  if (!store || !target) return;
  const targetEntryId = getCodexPoolEntryId(target);
  target.enabled = false;
  target.cooldown_until = 0;
  target.token_invalidated_at = nowSec;

  const currentTokenEntryId = deriveCodexPoolEntryIdFromToken(store.token || null);
  const currentTokenMatchesTarget =
    currentTokenEntryId === targetEntryId ||
    (typeof store?.token?.access_token === "string" &&
      typeof target?.token?.access_token === "string" &&
      store.token.access_token === target.token.access_token);
  if (currentTokenMatchesTarget) {
    const fallbackAccount =
      (store.accounts || []).find((account) => account && account.enabled !== false && getCodexPoolEntryId(account) !== targetEntryId) ||
      null;
    store.token = fallbackAccount?.token || null;
  }

  if (store.active_account_id === targetEntryId && config.codexOAuth.multiAccountStrategy !== "manual") {
    store.active_account_id = null;
  }
}

async function markCodexPoolAccountFailure(accountRef, reason, statusCode = 0) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) return;
  target.failure_count = Number(target.failure_count || 0) + 1;
  target.last_error = String(reason || "request_failed");
  target.last_status_code = Number(statusCode || 0) || 0;
  const cooldownSeconds = getCodexPoolCooldownSeconds(statusCode, target.failure_count);
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenInvalidated = isCodexTokenInvalidatedError(statusCode, target.last_error);
  if (tokenInvalidated) {
    // Hard-disable invalidated identities to stop poisoning account rotation.
    applyCodexInvalidatedAccountState(codexOAuthStore, target, nowSec);
  } else {
    target.cooldown_until = nowSec + cooldownSeconds;
    target.token_invalidated_at = 0;
  }
  if (Number(statusCode || 0) === 429) {
    const fallbackSnapshot = extractCodexUsageSnapshotFromLimitError(
      target.last_error,
      target.usage_snapshot || null,
      "request_error"
    );
    if (fallbackSnapshot) {
      target.usage_snapshot = fallbackSnapshot;
      target.usage_updated_at = Number(fallbackSnapshot.fetched_at || nowSec) || nowSec;
    }
  }
  const targetEntryId = getCodexPoolEntryId(target);
  if (
    codexOAuthStore.active_account_id === targetEntryId &&
    (tokenInvalidated ||
      (config.codexOAuth.multiAccountStrategy !== "sticky" &&
        config.codexOAuth.multiAccountStrategy !== "manual"))
  ) {
    codexOAuthStore.active_account_id = null;
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
  clearAuthContextCache();
  if (tokenInvalidated && config.expiredAccountCleanup.enabled) {
    await expiredAccountCleanupController.run("token_invalidated").catch((err) => {
      console.warn(`[auth-pool] account auto-rm failed after 401: ${err?.message || err}`);
    });
  }
}

async function markCodexPoolAccountSuccess(accountRef) {
  if (!isCodexMultiAccountEnabled()) return;
  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;
  const target = findCodexPoolAccountByRef(codexOAuthStore.accounts || [], accountRef);
  if (!target) return;
  target.last_used_at = Math.floor(Date.now() / 1000);
  target.failure_count = 0;
  target.cooldown_until = 0;
  target.last_error = "";
  target.last_status_code = 0;
  target.token_invalidated_at = 0;
  if (config.codexOAuth.multiAccountStrategy === "sticky") {
    codexOAuthStore.active_account_id = getCodexPoolEntryId(target);
  }
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

function isCodexPoolRetryEnabled() {
  return config.authMode === "codex-oauth" && isCodexMultiAccountEnabled();
}

async function maybeMarkCodexPoolFailure(authContext, reason, statusCode = 0) {
  if (!isCodexPoolRetryEnabled()) return false;
  const poolRef = authContext?.poolEntryId || authContext?.poolAccountId || null;
  if (!poolRef) return false;
  const code = Number(statusCode || 0);
  if (!shouldRotateCodexAccountForStatus(code)) return false;
  await markCodexPoolAccountFailure(poolRef, reason, code);
  return true;
}

async function maybeMarkCodexPoolSuccess(authContext) {
  if (!isCodexPoolRetryEnabled()) return;
  const poolRef = authContext?.poolEntryId || authContext?.poolAccountId || null;
  if (!poolRef) return;
  await markCodexPoolAccountSuccess(poolRef);
}

function parseCodexHeaderNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCodexHeaderBoolean(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function extractCodexUsageSnapshotFromHeaders(headers, source = "response") {
  if (!headers || typeof headers.get !== "function") return null;

  const planType = headers.get("x-codex-plan-type") || null;
  const activeLimit = headers.get("x-codex-active-limit") || null;
  const primaryUsedPercent = parseCodexHeaderNumber(headers.get("x-codex-primary-used-percent"));
  const secondaryUsedPercent = parseCodexHeaderNumber(headers.get("x-codex-secondary-used-percent"));
  const hasCodexUsageSignals =
    Boolean(planType || activeLimit) ||
    primaryUsedPercent !== null ||
    secondaryUsedPercent !== null;
  if (!hasCodexUsageSignals) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const rawHeaders = {};
  for (const [k, v] of headers.entries()) {
    if (k.startsWith("x-codex-")) rawHeaders[k] = v;
  }

  const primaryRemainingPercent =
    primaryUsedPercent === null ? null : Math.max(0, Math.min(100, 100 - primaryUsedPercent));
  const secondaryRemainingPercent =
    secondaryUsedPercent === null ? null : Math.max(0, Math.min(100, 100 - secondaryUsedPercent));

  return {
    fetched_at: nowSec,
    source,
    plan_type: planType,
    active_limit: activeLimit,
    credits: {
      has_credits: parseCodexHeaderBoolean(headers.get("x-codex-credits-has-credits")),
      unlimited: parseCodexHeaderBoolean(headers.get("x-codex-credits-unlimited")),
      balance: headers.get("x-codex-credits-balance") || null
    },
    primary: {
      used_percent: primaryUsedPercent,
      remaining_percent: primaryRemainingPercent,
      reset_after_seconds: parseCodexHeaderNumber(headers.get("x-codex-primary-reset-after-seconds")),
      reset_at: parseCodexHeaderNumber(headers.get("x-codex-primary-reset-at")),
      window_minutes: parseCodexHeaderNumber(headers.get("x-codex-primary-window-minutes")),
      over_secondary_limit_percent: parseCodexHeaderNumber(
        headers.get("x-codex-primary-over-secondary-limit-percent")
      )
    },
    secondary: {
      used_percent: secondaryUsedPercent,
      remaining_percent: secondaryRemainingPercent,
      reset_after_seconds: parseCodexHeaderNumber(headers.get("x-codex-secondary-reset-after-seconds")),
      reset_at: parseCodexHeaderNumber(headers.get("x-codex-secondary-reset-at")),
      window_minutes: parseCodexHeaderNumber(headers.get("x-codex-secondary-window-minutes"))
    },
    raw_headers: rawHeaders
  };
}

function applyCodexUsageSnapshotToStore(store, accountRef, snapshot) {
  if (!store || !Array.isArray(store.accounts) || !accountRef || !snapshot) return false;
  const target = findCodexPoolAccountByRef(store.accounts, accountRef);
  if (!target) return false;
  target.usage_snapshot = snapshot;
  target.usage_updated_at = Number(snapshot.fetched_at || Math.floor(Date.now() / 1000));
  return true;
}

function extractCodexUsageSnapshotFromLimitError(rawText, previousSnapshot = null, source = "error") {
  const parsed = parseJsonLoose(rawText);
  const err = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  if (!err) return null;
  const errType = String(err.type || err.code || "").trim().toLowerCase();
  if (errType !== "usage_limit_reached") return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const planTypeRaw = String(err.plan_type || previousSnapshot?.plan_type || "").trim().toLowerCase();
  const planType = planTypeRaw || null;
  const resetAt = parseCodexHeaderNumber(err.resets_at);
  const resetInSeconds = parseCodexHeaderNumber(err.resets_in_seconds);
  const effectiveResetAt =
    resetAt ?? (Number.isFinite(resetInSeconds) ? nowSec + Math.max(0, resetInSeconds) : null);

  const prevPrimary = previousSnapshot?.primary && hasCodexUsageWindow(previousSnapshot.primary)
    ? {
        used_percent: parsePercentOrNull(previousSnapshot.primary.used_percent),
        remaining_percent: readUsageRemainingPercent(previousSnapshot.primary),
        reset_after_seconds: parseCodexHeaderNumber(previousSnapshot.primary.reset_after_seconds),
        reset_at: parseCodexHeaderNumber(previousSnapshot.primary.reset_at),
        window_minutes: parseCodexHeaderNumber(previousSnapshot.primary.window_minutes),
        over_secondary_limit_percent: parseCodexHeaderNumber(previousSnapshot.primary.over_secondary_limit_percent)
      }
    : null;
  const weeklyMinutes =
    parseCodexHeaderNumber(previousSnapshot?.secondary?.window_minutes) ||
    parseCodexHeaderNumber(previousSnapshot?.primary?.window_minutes) ||
    10080;
  const weeklyWindow = {
    used_percent: 100,
    remaining_percent: 0,
    reset_after_seconds: resetInSeconds,
    reset_at: effectiveResetAt,
    window_minutes: weeklyMinutes
  };

  // free plan => single weekly window only.
  if (planType === "free") {
    return {
      fetched_at: nowSec,
      source,
      plan_type: "free",
      active_limit: "weekly",
      credits: previousSnapshot?.credits || {
        has_credits: null,
        unlimited: null,
        balance: null
      },
      primary: {
        ...weeklyWindow,
        over_secondary_limit_percent: null
      },
      secondary: null,
      raw_headers:
        previousSnapshot?.raw_headers && typeof previousSnapshot.raw_headers === "object"
          ? previousSnapshot.raw_headers
          : {}
    };
  }

  return {
    fetched_at: nowSec,
    source,
    plan_type: planType,
    active_limit: "secondary",
    credits: previousSnapshot?.credits || {
      has_credits: null,
      unlimited: null,
      balance: null
    },
    primary: prevPrimary,
    secondary: weeklyWindow,
    raw_headers:
      previousSnapshot?.raw_headers && typeof previousSnapshot.raw_headers === "object"
        ? previousSnapshot.raw_headers
        : {}
  };
}

async function refreshCodexUsageSnapshotInStore(store, accountRef, oauthConfig, options = {}) {
  if (!store || !Array.isArray(store.accounts)) {
    return {
      ok: false,
      skipped: "invalid_store",
      error: "Account store is unavailable."
    };
  }

  const includeDisabled = options.includeDisabled === true;
  const target = findCodexPoolAccountByRef(store.accounts, accountRef);
  if (!target) {
    return {
      ok: false,
      skipped: "not_found",
      error: `Account not found: ${accountRef}`
    };
  }

  const entryId = getCodexPoolEntryId(target);
  const accountId = target.account_id || null;
  if (!includeDisabled && target.enabled === false) {
    return {
      ok: false,
      skipped: "disabled",
      entryId,
      accountId,
      error: "Account is disabled."
    };
  }

  try {
    const hadFailureMarkers =
      Number(target.last_status_code || 0) !== 0 ||
      Number(target.token_invalidated_at || 0) !== 0 ||
      String(target.last_error || "").trim().length > 0;
    const probeModel = String(options.model || "").trim() || config.codex.defaultModel;
    const snapshot = await fetchCodexUsageSnapshotForAccount(target, oauthConfig, { model: probeModel });
    const applied = applyCodexUsageSnapshotToStore(store, entryId || accountId, snapshot);
    target.last_error = "";
    target.last_status_code = 0;
    target.token_invalidated_at = 0;
    return {
      ok: true,
      entryId,
      accountId,
      model: probeModel,
      snapshot,
      applied,
      changed: applied || hadFailureMarkers,
      planType: String(snapshot?.plan_type || "").trim().toLowerCase() || null,
      usageUpdatedAt: Number(snapshot?.fetched_at || 0) || Math.floor(Date.now() / 1000)
    };
  } catch (err) {
    const message = String(err?.message || err || "usage_probe_failed");
    const statusCode = Number(err?.statusCode || 0) || 0;
    const tokenInvalidated = isCodexTokenInvalidatedError(statusCode, message);
    target.last_error = message;
    target.last_status_code = statusCode;
    target.token_invalidated_at = tokenInvalidated ? Math.floor(Date.now() / 1000) : 0;
    return {
      ok: false,
      entryId,
      accountId,
      model: String(options.model || "").trim() || config.codex.defaultModel,
      error: message,
      statusCode,
      tokenInvalidated,
      changed: true
    };
  }
}

async function refreshCodexTokensInStore(store, oauthConfig, options = {}) {
  if (!store || !Array.isArray(store.accounts)) {
    return {
      ok: false,
      refreshed: 0,
      total: 0,
      results: [],
      error: "Account store is unavailable."
    };
  }

  const includeDisabled = options.includeDisabled === true;
  const accountRef = typeof options.accountRef === "string" ? options.accountRef.trim() : "";
  const normalized = ensureCodexOAuthStoreShape(store);
  Object.assign(store, normalized.store);

  let targets = Array.isArray(store.accounts) ? [...store.accounts] : [];
  if (!includeDisabled) {
    targets = targets.filter((account) => account?.enabled !== false);
  }
  if (accountRef) {
    targets = targets.filter((account) => {
      const entryId = getCodexPoolEntryId(account);
      return entryId === accountRef || String(account?.account_id || "").trim() === accountRef;
    });
  }

  if (targets.length === 0) {
    return {
      ok: false,
      refreshed: 0,
      total: 0,
      results: [],
      error: accountRef ? `No matching account to refresh: ${accountRef}` : "No eligible accounts to refresh tokens."
    };
  }

  const activeRefBefore = String(store.active_account_id || "").trim();
  const results = [];
  let refreshed = 0;
  let changed = false;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const entryIdBefore = getCodexPoolEntryId(target) || String(target?.account_id || "").trim();
    const accountIdBefore = String(target?.account_id || "").trim() || null;
    const previousAccessToken = String(target?.token?.access_token || "");
    const isActive = entryIdBefore === activeRefBefore;

    try {
      if (!target?.token?.refresh_token) {
        throw new Error("No refresh token available.");
      }

      const refreshedToken = await refreshAccessToken(target.token.refresh_token, oauthConfig);
      const nextToken = normalizeToken(refreshedToken, target.token);
      const nextAccountId =
        extractOpenAICodexAccountId(nextToken.access_token || "") || target.account_id || accountIdBefore;
      const nextEntryId =
        deriveCodexPoolEntryIdFromToken(nextToken, {
          planType:
            normalizeOpenAICodexPlanType(target?.usage_snapshot?.plan_type) ||
            normalizeOpenAICodexPlanType(target?.plan_type)
        }) ||
        entryIdBefore;

      target.token = nextToken;
      target.account_id = nextAccountId;
      target.identity_id = nextEntryId;
      target.last_error = "";
      target.last_status_code = 0;
      target.token_invalidated_at = 0;
      target.cooldown_until = 0;
      target.failure_count = 0;
      target.last_used_at = Math.floor(Date.now() / 1000);

      if (isActive) {
        store.active_account_id = nextEntryId;
      }
      if (String(store?.token?.access_token || "") === previousAccessToken) {
        store.token = nextToken;
      }

      refreshed += 1;
      changed = true;
      results.push({
        entryId: nextEntryId,
        accountId: nextAccountId,
        ok: true,
        expiresAt: Number(nextToken?.expires_at || 0) || 0
      });
    } catch (err) {
      const message = String(err?.message || err || "token_refresh_failed");
      const statusCode = Number(err?.statusCode || 0) || 0;
      target.last_error = message;
      target.last_status_code = statusCode;
      changed = true;
      results.push({
        entryId: entryIdBefore || null,
        accountId: accountIdBefore,
        ok: false,
        error: message,
        statusCode
      });
    }

    if (index < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  const renormalized = ensureCodexOAuthStoreShape(store);
  Object.assign(store, renormalized.store);
  changed = changed || renormalized.changed;

  return {
    ok: refreshed > 0,
    refreshed,
    total: targets.length,
    changed,
    results
  };
}

async function maybeCaptureCodexUsageFromHeaders(authContext, headers, source = "response") {
  if (config.authMode !== "codex-oauth") return;
  const tokenPrincipalId =
    typeof authContext?.principalId === "string" && authContext.principalId.trim().length > 0
      ? authContext.principalId.trim()
      : null;
  const tokenAccountId =
    typeof authContext?.accountId === "string" && authContext.accountId.trim().length > 0
      ? authContext.accountId.trim()
      : null;
  const poolEntryId =
    typeof authContext?.poolEntryId === "string" && authContext.poolEntryId.trim().length > 0
      ? authContext.poolEntryId.trim()
      : null;
  const poolAccountId =
    typeof authContext?.poolAccountId === "string" && authContext.poolAccountId.trim().length > 0
      ? authContext.poolAccountId.trim()
      : null;
  if (!tokenPrincipalId && !tokenAccountId && !poolEntryId && !poolAccountId) return;
  const snapshot = extractCodexUsageSnapshotFromHeaders(headers, source);
  if (!snapshot) return;

  const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
  codexOAuthStore = normalized.store;

  const candidateIds = [];
  if (poolEntryId) candidateIds.push(poolEntryId);
  if (tokenPrincipalId && !candidateIds.includes(tokenPrincipalId)) candidateIds.push(tokenPrincipalId);
  if (tokenAccountId) candidateIds.push(tokenAccountId);
  if (poolAccountId && poolAccountId !== tokenAccountId) candidateIds.push(poolAccountId);

  let changed = false;
  for (const candidate of candidateIds) {
    if (applyCodexUsageSnapshotToStore(codexOAuthStore, candidate, snapshot)) {
      changed = true;
      break;
    }
  }

  if (!changed) return;
  await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
}

async function fetchCodexUsageSnapshotForAccount(account, oauthConfig, options = {}) {
  if (!account || !account.token?.access_token) {
    throw new Error("Missing access token.");
  }

  let accountIdFromToken = extractOpenAICodexAccountId(account.token.access_token || "") || account.account_id;
  let entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token) || getCodexPoolEntryId(account);

  if (isExpiredOrNearExpirySec(account.token.expires_at)) {
    if (!account.token.refresh_token) {
      throw new Error("Access token expired and no refresh token available.");
    }
    const refreshed = await refreshAccessToken(account.token.refresh_token, oauthConfig);
    account.token = normalizeToken(refreshed, account.token);
    accountIdFromToken = extractOpenAICodexAccountId(account.token.access_token || "") || accountIdFromToken;
    entryIdFromToken = deriveCodexPoolEntryIdFromToken(account.token) || entryIdFromToken;
  }
  if (!accountIdFromToken) {
    throw new Error("Could not resolve chatgpt account id from OAuth token.");
  }
  if (!entryIdFromToken) {
    throw new Error("Could not resolve principal identity from OAuth token.");
  }
  account.identity_id = entryIdFromToken;
  account.account_id = accountIdFromToken;

  const url = `${getCodexUsageProbeBaseUrl().replace(/\/+$/, "")}/codex/responses`;
  const probeModel = String(options.model || "").trim() || config.codex.defaultModel;
  const body = {
    model: probeModel,
    stream: true,
    store: false,
    instructions: "Return one character.",
    reasoning: {
      effort: resolveReasoningEffort(
        undefined,
        {
          input: [{ role: "user", content: [{ type: "input_text", text: "." }] }],
          instructions: "Return one character."
        },
        probeModel
      )
    },
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "." }]
      }
    ]
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token.access_token}`,
      "chatgpt-account-id": accountIdFromToken,
      "openai-beta": "responses=experimental",
      originator: getCodexOriginator(),
      accept: "text/event-stream",
      "content-type": "application/json",
      "user-agent": "codex-pro-max-usage-probe"
    },
    body: JSON.stringify(body)
  });

  const snapshot = extractCodexUsageSnapshotFromHeaders(response.headers, "probe");
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const fallback = extractCodexUsageSnapshotFromLimitError(raw, account?.usage_snapshot || null, "probe_error");
    if (fallback) {
      return fallback;
    }
    const error = new Error(`HTTP ${response.status}: ${truncate(raw, 180)}`);
    error.statusCode = Number(response.status || 0) || 0;
    error.responseText = raw;
    error.tokenInvalidated = isCodexTokenInvalidatedError(response.status, raw);
    throw error;
  }
  if (response.body) {
    response.body.cancel().catch(() => {});
  }
  if (!snapshot) {
    throw new Error("Usage headers missing in upstream response.");
  }
  return snapshot;
}

function getCodexPreheatAccountHistory(entryId) {
  const key = String(entryId || "").trim();
  if (!key) return null;
  if (!codexPreheatHistory.accounts || typeof codexPreheatHistory.accounts !== "object") {
    codexPreheatHistory.accounts = {};
  }
  if (!codexPreheatHistory.accounts[key] || typeof codexPreheatHistory.accounts[key] !== "object") {
    codexPreheatHistory.accounts[key] = {
      run_count: 0,
      success_count: 0,
      failure_count: 0,
      last_run_at: 0,
      last_success_at: 0,
      last_failure_at: 0,
      last_error: ""
    };
  }
  return codexPreheatHistory.accounts[key];
}

function getCodexPreheatState() {
  return {
    running: codexPreheatRuntime.running,
    lastRunAt: codexPreheatRuntime.lastRunAt,
    lastCompletedAt: codexPreheatRuntime.lastCompletedAt,
    lastReason: codexPreheatRuntime.lastReason,
    lastStatus: codexPreheatRuntime.lastStatus,
    lastError: codexPreheatRuntime.lastError,
    lastDurationMs: codexPreheatRuntime.lastDurationMs,
    lastSummary: codexPreheatRuntime.lastSummary
  };
}

function getCodexPreheatTargets(store) {
  const accounts = Array.isArray(store?.accounts) ? store.accounts : [];
  const targets = [];
  const skipped = [];

  for (const account of accounts) {
    if (!account) continue;
    const entryId = getCodexPoolEntryId(account);
    const accountId = account.account_id || null;
    if (account.enabled === false) {
      skipped.push({ entryId, accountId, reason: "disabled" });
      continue;
    }
    if (!account.token?.access_token) {
      skipped.push({ entryId, accountId, reason: "missing_token" });
      continue;
    }
    targets.push({
      entryId,
      accountId,
      account
    });
  }

  return { targets, skipped };
}

function resolveCodexPreheatModelSelection(requestedModel, allModels, availableModels, fallbackModel = config.codex.defaultModel) {
  const requested = String(requestedModel || "").trim();
  const catalog = buildOfficialCodexModelCandidateIds(availableModels, fallbackModel);
  if (allModels === true) return catalog;
  if (requested) return [requested];
  if (fallbackModel) return [fallbackModel];
  return catalog.slice(0, 1);
}

async function runCodexPreheat(reason = "manual", options = {}) {
  if (config.authMode !== "codex-oauth") {
    throw new Error("Preheat is only available in AUTH_MODE=codex-oauth.");
  }
  if (!isCodexMultiAccountEnabled()) {
    throw new Error("Preheat requires multi-account mode to be enabled.");
  }
  if (codexPreheatRuntime.running) {
    return {
      ok: true,
      busy: true,
      message: "Preheat is already running.",
      summary: codexPreheatRuntime.lastSummary
    };
  }

  const startedAt = Date.now();
  const nowSec = Math.floor(startedAt / 1000);
  codexPreheatRuntime.running = true;
  codexPreheatRuntime.lastRunAt = nowSec;
  codexPreheatRuntime.lastReason = String(reason || "manual");
  codexPreheatRuntime.lastStatus = "running";
  codexPreheatRuntime.lastError = "";

  let saveStore = false;
  let saveHistory = false;
  try {
    const normalized = ensureCodexOAuthStoreShape(codexOAuthStore);
    codexOAuthStore = normalized.store;
    saveStore = saveStore || normalized.changed;

    const availableModels = await getOfficialCodexModelCandidateIds();
    const models = resolveCodexPreheatModelSelection(
      options.model,
      options.allModels === true,
      availableModels,
      config.codex.defaultModel
    );
    const { targets, skipped } = getCodexPreheatTargets(codexOAuthStore);
    const results = [];

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];
      for (let accountIndex = 0; accountIndex < targets.length; accountIndex += 1) {
        const { account, entryId, accountId } = targets[accountIndex];
        const history = getCodexPreheatAccountHistory(entryId);
        if (history) {
          history.run_count = Number(history.run_count || 0) + 1;
          history.last_run_at = nowSec;
          saveHistory = true;
        }

        const result = await refreshCodexUsageSnapshotInStore(codexOAuthStore, entryId || accountId, config.codexOAuth, {
          includeDisabled: true,
          model
        });

        if (result.changed) saveStore = true;
        if (history) {
          if (result.ok) {
            history.success_count = Number(history.success_count || 0) + 1;
            history.last_success_at = nowSec;
            history.last_error = "";
          } else {
            history.failure_count = Number(history.failure_count || 0) + 1;
            history.last_failure_at = nowSec;
            history.last_error = String(result.error || "preheat_failed");
          }
          saveHistory = true;
        }

        if (result.ok) {
          results.push({
            entryId,
            accountId,
            model,
            ok: true,
            primaryRemaining: readUsageRemainingPercent(result.snapshot?.primary),
            secondaryRemaining: readUsageRemainingPercent(result.snapshot?.secondary)
          });
        } else {
          results.push({
            entryId,
            accountId,
            model,
            ok: false,
            error: result.error,
            statusCode: result.statusCode || 0,
            tokenInvalidated: result.tokenInvalidated === true
          });
        }

        const isLastAttempt = modelIndex === models.length - 1 && accountIndex === targets.length - 1;
        if (!isLastAttempt) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    }

    if (saveStore) {
      const normalizedAfterPreheat = ensureCodexOAuthStoreShape(codexOAuthStore);
      codexOAuthStore = normalizedAfterPreheat.store;
      await saveTokenStore(config.codexOAuth.tokenStorePath, codexOAuthStore);
      clearAuthContextCache();
    }
    if (saveHistory) {
      await saveJsonStore(config.codexPreheat.historyPath, codexPreheatHistory);
    }

    const completedAt = Date.now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const successCount = results.filter((x) => x.ok).length;
    const failureCount = results.length - successCount;
    const status = results.length === 0 ? "skipped" : failureCount > 0 ? "partial" : "ok";
    const summary = {
      ok: true,
      reason: String(reason || "manual"),
      status,
      startedAt: nowSec,
      completedAt: Math.floor(completedAt / 1000),
      durationMs,
      totalCandidates: targets.length,
      selectedAccounts: targets.length,
      modelCount: models.length,
      models,
      attempts: results.length,
      selected: results.length,
      success: successCount,
      failed: failureCount,
      skipped: skipped.slice(0, 20),
      results
    };

    codexPreheatRuntime.lastCompletedAt = Math.floor(completedAt / 1000);
    codexPreheatRuntime.lastDurationMs = durationMs;
    codexPreheatRuntime.lastSummary = summary;
    codexPreheatRuntime.lastStatus = status;
    codexPreheatRuntime.lastError = "";
    return summary;
  } catch (err) {
    const completedAt = Date.now();
    const message = String(err?.message || err || "preheat_failed");
    codexPreheatRuntime.lastCompletedAt = Math.floor(completedAt / 1000);
    codexPreheatRuntime.lastDurationMs = Math.max(0, completedAt - startedAt);
    codexPreheatRuntime.lastStatus = "failed";
    codexPreheatRuntime.lastError = message;
    codexPreheatRuntime.lastSummary = {
      ok: false,
      reason: String(reason || "manual"),
      status: "failed",
      startedAt: nowSec,
      completedAt: Math.floor(completedAt / 1000),
      durationMs: codexPreheatRuntime.lastDurationMs,
      error: message
    };
    throw err;
  } finally {
    codexPreheatRuntime.running = false;
  }
}

async function exchangeCodeForToken(code, codeVerifier, oauthConfig) {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", oauthConfig.redirectUri);
  form.set("client_id", oauthConfig.clientId);
  form.set("code_verifier", codeVerifier);
  if (oauthConfig.clientSecret) {
    form.set("client_secret", oauthConfig.clientSecret);
  }

  const resp = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }
  return JSON.parse(text);
}

function mapHttpStatusToGeminiStatus(httpStatus) {
  const code = Number(httpStatus || 400);
  if (code === 401 || code === 403) return "UNAUTHENTICATED";
  if (code === 404) return "NOT_FOUND";
  if (code === 429) return "RESOURCE_EXHAUSTED";
  if (code >= 500) return "INTERNAL";
  return "INVALID_ARGUMENT";
}

function parseGeminiErrorMessage(rawText, fallbackMessage) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fallbackMessage;
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim().length > 0) {
      return parsed.error.message;
    }
    if (typeof parsed?.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
  } catch {
    // ignore and fallback
  }
  return fallbackMessage;
}

function parseGeminiGenerateContentPayload(rawText) {
  const parsed = JSON.parse(rawText);
  if (Array.isArray(parsed)) {
    const lastPayload = [...parsed].reverse().find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    return lastPayload && typeof lastPayload === "object" ? lastPayload : null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function buildOpenAIChatCompletionFromGeminiPayload(payload, requestedModel) {
  const candidate = Array.isArray(payload?.candidates) && payload.candidates.length > 0 ? payload.candidates[0] : null;
  const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = contentParts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("");

  const usage = {
    prompt_tokens: Number(payload?.usageMetadata?.promptTokenCount || 0),
    completion_tokens: Number(payload?.usageMetadata?.candidatesTokenCount || 0),
    total_tokens: Number(payload?.usageMetadata?.totalTokenCount || 0)
  };
  const finishReason = mapGeminiFinishReasonToOpenAI(candidate?.finishReason);
  return buildOpenAIChatCompletion({
    model: requestedModel,
    text,
    finishReason,
    usage
  });
}

function mapHttpStatusToAnthropicErrorType(httpStatus) {
  const code = Number(httpStatus || 400);
  if (code === 401 || code === 403) return "authentication_error";
  if (code === 404) return "not_found_error";
  if (code === 429) return "rate_limit_error";
  if (code >= 500) return "api_error";
  return "invalid_request_error";
}

function resolveCompatErrorStatusCode(err, fallback = 502) {
  const explicit = Number(err?.statusCode);
  if (Number.isFinite(explicit) && explicit >= 100 && explicit <= 599) {
    return explicit;
  }
  const message = String(err?.message || "");
  if (/chatgpt_account_id|oauth token|access token|unauthorized|forbidden/i.test(message)) {
    return 401;
  }
  return fallback;
}

function parseAnthropicErrorMessage(rawText, fallbackMessage) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return fallbackMessage;
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed?.error?.message === "string" && parsed.error.message.trim().length > 0) {
      return parsed.error.message;
    }
    if (typeof parsed?.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
  } catch {
    // ignore and fallback
  }
  return fallbackMessage;
}

function sendAnthropicError(res, { httpStatus = 400, message, type }) {
  res.status(httpStatus).json({
    type: "error",
    error: {
      type: type || mapHttpStatusToAnthropicErrorType(httpStatus),
      message: String(message || "Anthropic request failed.")
    }
  });
}

function sendGeminiError(res, { httpStatus = 400, message, status }) {
  res.status(httpStatus).json({
    error: {
      code: Number(httpStatus || 400),
      message: String(message || "Gemini request failed."),
      status: status || mapHttpStatusToGeminiStatus(httpStatus)
    }
  });
}

async function handleGeminiNativeProxy(req, res) {
  res.locals.protocolType = "gemini-v1beta-native";
  const apiKey = resolveGeminiApiKey(req);
  if (!apiKey) {
    await geminiLocalCompatHelpers.handleGeminiNativeCompat(req, res);
    return;
  }

  const incoming = new URL(req.originalUrl, "http://localhost");
  const isOpenAICompatPath = incoming.pathname.startsWith("/v1beta/openai/");
  const mappedPath = mapGeminiNativePath(incoming.pathname, res);
  const target = new URL(`${mappedPath}${incoming.search}`, config.gemini.baseUrl);
  const isGeminiSseRequest =
    mappedPath.includes(":streamGenerateContent") ||
    String(incoming.searchParams.get("alt") || "").toLowerCase() === "sse" ||
    String(req.headers?.accept || "").toLowerCase().includes("text/event-stream");

  if (mappedPath.includes(":streamGenerateContent") && !target.searchParams.has("alt")) {
    target.searchParams.set("alt", "sse");
  }

  if (!isOpenAICompatPath && !target.searchParams.has("key")) {
    target.searchParams.set("key", apiKey);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (hopByHop.has(name) || name === "content-length" || name === "host") continue;
    if (typeof v === "string") headers.set(k, v);
  }

  if (isOpenAICompatPath) {
    headers.set("authorization", `Bearer ${apiKey}`);
  } else {
    headers.delete("authorization");
    headers.set("x-goog-api-key", apiKey);
  }
  if (isGeminiSseRequest) {
    headers.set("accept", "text/event-stream");
    headers.set("accept-encoding", "identity");
  } else {
    headers.delete("accept-encoding");
  }

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    let parsedBody = getCachedJsonBody(req);
    const contentType = headers.get("content-type") || req.headers?.["content-type"] || "";
    if (parsedBody === undefined && String(contentType).toLowerCase().includes("json")) {
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
    }
    const rawBody = await readRawBody(req);
    init.body = rawBody;
    noteUpstreamRequestAudit(
      res,
      parsedBody ?? rawBody,
      contentType
    );
  }

  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(target.toString(), init, res);
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendGeminiError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await geminiLocalCompatHelpers.handleGeminiNativeCompat(req, res);
      return;
    }
    sendGeminiError(res, {
      httpStatus: upstream.status,
      message: parseGeminiErrorMessage(
        raw,
        `Gemini upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeUpstreamBodyToResponse(upstream, res);
}

function mapGeminiNativePath(pathname, res) {
  const match = String(pathname || "").match(/^\/v1beta\/models\/([^/:]+)(:generateContent|:streamGenerateContent)?$/);
  if (!match) return pathname;
  const requestedModel = decodeURIComponent(match[1]);
  const route = resolveModelRoute(requestedModel, "gemini-v1beta");
  if (res && res.locals) res.locals.modelRoute = route;
  const mappedModel = encodeURIComponent(route.mappedModel);
  const suffix = match[2] || "";
  return `/v1beta/models/${mappedModel}${suffix}`;
}

async function handleAnthropicNativeProxy(req, res) {
  res.locals.protocolType = "anthropic-v1-native";
  const apiKey = resolveAnthropicApiKey(req);
  if (!apiKey) {
    await anthropicLocalCompatHelpers.handleAnthropicNativeCompat(req, res);
    return;
  }

  const target = new URL(req.originalUrl, config.anthropic.baseUrl);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.toLowerCase();
    if (hopByHop.has(name) || name === "content-length" || name === "host") continue;
    if (typeof v === "string") headers.set(k, v);
  }

  headers.set("x-api-key", apiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", config.anthropic.version);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };
  let anthropicStreamRequest = String(req.headers?.accept || "").toLowerCase().includes("text/event-stream");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const rawBody = await readRawBody(req);
    let requestBody = rawBody;
    const incoming = new URL(req.originalUrl, "http://localhost");
    let auditRequestBody = getCachedJsonBody(req) ?? rawBody;
    if (
      anthropicLocalCompatHelpers.isAnthropicNativeMessagesPath(incoming.pathname) &&
      requestBody.length > 0 &&
      readHeaderValue(req, "content-type").toLowerCase().includes("application/json")
    ) {
      try {
        const parsed = await readJsonBody(req);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const mappedRequest = { ...parsed };
          anthropicStreamRequest = anthropicStreamRequest || mappedRequest.stream === true;
          const route = resolveModelRoute(mappedRequest.model || config.anthropic.defaultModel, "anthropic-v1");
          mappedRequest.model = route.mappedModel;
          if (res && res.locals) res.locals.modelRoute = route;
          requestBody = Buffer.from(JSON.stringify(mappedRequest), "utf8");
          auditRequestBody = mappedRequest;
        }
      } catch {
        // keep original body when parse fails
      }
    }
    init.body = requestBody;
    noteUpstreamRequestAudit(
      res,
      auditRequestBody,
      headers.get("content-type") || req.headers?.["content-type"] || ""
    );
  }
  if (anthropicStreamRequest) {
    headers.set("accept", "text/event-stream");
    headers.set("accept-encoding", "identity");
  } else {
    headers.delete("accept-encoding");
  }

  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(target.toString(), init, res);
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendAnthropicError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      type: "api_error"
    });
    return;
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    if (
      config.authMode === "codex-oauth" &&
      isCodexMultiAccountEnabled() &&
      (upstream.status === 401 || upstream.status === 403 || upstream.status === 429)
    ) {
      await anthropicLocalCompatHelpers.handleAnthropicNativeCompat(req, res);
      return;
    }
    sendAnthropicError(res, {
      httpStatus: upstream.status,
      message: parseAnthropicErrorMessage(
        raw,
        `Anthropic upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!hopByHop.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeUpstreamBodyToResponse(upstream, res);
}

async function handleGeminiProtocol(req, res) {
  res.locals.protocolType = "gemini-v1beta-openai-compat";
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname === "/v1/models" || incoming.pathname === "/v1/models/" || incoming.pathname.startsWith("/v1/models/")) {
    res.locals.protocolType = "gemini-v1beta-native";
    const aliasedOriginalUrl = req.originalUrl.replace(/^\/v1\/models/, "/v1beta/models");
    const previousOriginalUrl = req.originalUrl;
    req.originalUrl = aliasedOriginalUrl;
    try {
      await handleGeminiNativeProxy(req, res);
    } finally {
      req.originalUrl = previousOriginalUrl;
    }
    return;
  }

  if (incoming.pathname !== "/v1/chat/completions") {
    sendGeminiError(res, {
      httpStatus: 400,
      message:
        "In UPSTREAM_MODE=gemini-v1beta, supported endpoints are /v1/chat/completions and /v1/models/{model}:{generateContent|streamGenerateContent}.",
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  if (req.method !== "POST") {
    sendGeminiError(res, {
      httpStatus: 405,
      message: "Use POST /v1/chat/completions.",
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  const apiKey = resolveGeminiApiKey(req);
  if (!apiKey) {
    await geminiLocalCompatHelpers.handleGeminiOpenAICompatWithCodex(req, res);
    return;
  }

  let chatReq;
  try {
    const rawBody = await readRawBody(req);
    let parsedBody = getCachedJsonBody(req);
    if (parsedBody === undefined && rawBody.length > 0) {
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
    }
    chatReq = parseOpenAIChatCompletionsLikeRequest(rawBody, config.gemini.defaultModel, parsedBody);
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 400,
      message: err.message,
      status: "INVALID_ARGUMENT"
    });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const contents = conversation
    .map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.text || " " }]
    }))
    .filter((x) => x.parts[0].text.trim().length > 0);
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }

  const generationConfig = {};
  if (chatReq.temperature !== undefined) generationConfig.temperature = chatReq.temperature;
  if (chatReq.top_p !== undefined) generationConfig.topP = chatReq.top_p;
  if (chatReq.max_tokens !== undefined) generationConfig.maxOutputTokens = chatReq.max_tokens;
  if (Array.isArray(chatReq.stop) && chatReq.stop.length > 0) generationConfig.stopSequences = chatReq.stop;
  else if (typeof chatReq.stop === "string" && chatReq.stop.length > 0)
    generationConfig.stopSequences = [chatReq.stop];

  const body = { contents };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  const modelRoute = resolveModelRoute(chatReq.model || config.gemini.defaultModel, "gemini-v1beta");
  const requestedModel = modelRoute.requestedModel;
  const upstreamModel = modelRoute.mappedModel;
  res.locals.modelRoute = modelRoute;
  const geminiAction = chatReq.stream === true ? ":streamGenerateContent" : ":generateContent";
  const url = new URL(
    `${config.gemini.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(upstreamModel)}${geminiAction}`
  );
  if (chatReq.stream === true) {
    url.searchParams.set("alt", "sse");
  }
  noteUpstreamRequestAudit(res, body, "application/json");
  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(
      url.toString(),
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": String(apiKey),
        ...(chatReq.stream === true ? { accept: "text/event-stream", "accept-encoding": "identity" } : {})
      },
      body: JSON.stringify(body)
      },
      res
    );
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    sendGeminiError(res, {
      httpStatus: 502,
      message: details.detail || details.message || err.message,
      status: "UNAVAILABLE"
    });
    return;
  }

  if (chatReq.stream === true) {
    if (!upstream.ok) {
      const raw = await readUpstreamTextOrThrow(upstream).catch(() => "");
      if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
        await geminiLocalCompatHelpers.handleGeminiOpenAICompatWithCodex(req, res);
        return;
      }
      sendGeminiError(res, {
        httpStatus: upstream.status,
        message: parseGeminiErrorMessage(raw, `Gemini upstream request failed with HTTP ${upstream.status}.`)
      });
      return;
    }

    const upstreamContentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!upstreamContentType.includes("text/event-stream")) {
      let raw;
      try {
        raw = await readUpstreamTextOrThrow(upstream);
      } catch (err) {
        sendGeminiError(res, {
          httpStatus: 502,
          message: err.message,
          status: "UNAVAILABLE"
        });
        return;
      }

      let payload;
      try {
        payload = parseGeminiGenerateContentPayload(raw);
      } catch {
        sendGeminiError(res, {
          httpStatus: 502,
          message: `Gemini stream request returned non-SSE content-type: ${upstreamContentType || "unknown"}`,
          status: "INTERNAL"
        });
        return;
      }

      const completion = buildOpenAIChatCompletionFromGeminiPayload(payload, requestedModel);
      res.locals.tokenUsage = completion.usage;
      sendOpenAICompletionAsSse(res, completion, { heartbeatMs: 0 });
      return;
    }

    try {
      const streamResult = await pipeGeminiSseAsOpenAIChatCompletions(upstream, res, {
        model: requestedModel,
        mapGeminiFinishReasonToOpenAI,
        upstreamStreamIdleTimeoutMs: config.upstreamStreamIdleTimeoutMs
      });
      if (streamResult?.usage) {
        res.locals.tokenUsage = streamResult.usage;
      }
    } catch (err) {
      noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
      if (!res.headersSent) {
        sendGeminiError(res, {
          httpStatus: 502,
          message: err.message,
          status: "INTERNAL"
        });
      } else {
        res.end();
      }
    }
    return;
  }

  let raw;
  try {
    raw = await readUpstreamTextOrThrow(upstream);
  } catch (err) {
    sendGeminiError(res, {
      httpStatus: 502,
      message: err.message,
      status: "UNAVAILABLE"
    });
    return;
  }
  if (!upstream.ok) {
    if (shouldFallbackGeminiUpstreamToCompat(req, upstream.status)) {
      await geminiLocalCompatHelpers.handleGeminiOpenAICompatWithCodex(req, res);
      return;
    }
    sendGeminiError(res, {
      httpStatus: upstream.status,
      message: parseGeminiErrorMessage(raw, `Gemini upstream request failed with HTTP ${upstream.status}.`)
    });
    return;
  }

  let parsed;
  try {
    parsed = parseGeminiGenerateContentPayload(raw);
  } catch {
    sendGeminiError(res, {
      httpStatus: 502,
      message: "Gemini returned non-JSON response.",
      status: "INTERNAL"
    });
    return;
  }

  const completion = buildOpenAIChatCompletionFromGeminiPayload(parsed, requestedModel);
  res.locals.tokenUsage = completion.usage;
  res.status(200).json(completion);
}

async function handleAnthropicProtocol(req, res) {
  res.locals.protocolType = "anthropic-v1-openai-compat";
  const incoming = new URL(req.originalUrl, "http://localhost");
  if (incoming.pathname !== "/v1/chat/completions") {
    sendAnthropicError(res, {
      httpStatus: 400,
      message: "In UPSTREAM_MODE=anthropic-v1, currently only /v1/chat/completions is supported.",
      type: "invalid_request_error"
    });
    return;
  }

  if (req.method !== "POST") {
    sendAnthropicError(res, {
      httpStatus: 405,
      message: "Use POST /v1/chat/completions.",
      type: "invalid_request_error"
    });
    return;
  }

  const apiKey = resolveAnthropicApiKey(req);
  if (!apiKey) {
    await anthropicOpenAICompatHelpers.handleAnthropicOpenAICompatWithCodex(req, res);
    return;
  }

  let chatReq;
  try {
    const rawBody = await readRawBody(req);
    let parsedBody = getCachedJsonBody(req);
    if (parsedBody === undefined && rawBody.length > 0) {
      try {
        parsedBody = await readJsonBody(req);
      } catch {
        parsedBody = undefined;
      }
    }
    chatReq = parseOpenAIChatCompletionsLikeRequest(rawBody, config.anthropic.defaultModel, parsedBody);
  } catch (err) {
    sendAnthropicError(res, {
      httpStatus: 400,
      message: err.message,
      type: "invalid_request_error"
    });
    return;
  }

  const { systemText, conversation } = splitSystemAndConversation(chatReq.messages);
  const anthropicMessages = conversation
    .map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.text || " "
    }))
    .filter((msg) => msg.content.trim().length > 0);
  if (anthropicMessages.length === 0) {
    anthropicMessages.push({ role: "user", content: " " });
  }

  const modelRoute = resolveModelRoute(chatReq.model || config.anthropic.defaultModel, "anthropic-v1");
  res.locals.modelRoute = modelRoute;
  const body = {
    model: modelRoute.mappedModel,
    max_tokens: Number(chatReq.max_tokens || 4096),
    messages: anthropicMessages,
    stream: chatReq.stream === true
  };
  if (systemText) body.system = systemText;
  if (chatReq.temperature !== undefined) body.temperature = chatReq.temperature;
  if (chatReq.top_p !== undefined) body.top_p = chatReq.top_p;
  if (Array.isArray(chatReq.stop) && chatReq.stop.length > 0) body.stop_sequences = chatReq.stop;
  else if (typeof chatReq.stop === "string" && chatReq.stop.length > 0) body.stop_sequences = [chatReq.stop];

  const url = `${config.anthropic.baseUrl.replace(/\/+$/, "")}/messages`;
  noteUpstreamRequestAudit(res, body, "application/json");
  let upstream;
  try {
    upstream = await fetchUpstreamWithRetry(
      url,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(apiKey),
        "anthropic-version": config.anthropic.version
      },
      body: JSON.stringify(body)
      },
      res
    );
  } catch (err) {
    const details = extractUpstreamTransportError(err);
    res.status(502).json({
      error: "upstream_unreachable",
      message: details.message || err.message,
      code: details.code || details.name || null,
      detail: details.detail || null,
      retry_count: Number(res.locals?.upstreamRetryCount || 0)
    });
    return;
  }

  if (chatReq.stream === true) {
    if (!upstream.ok) {
      const raw = await readUpstreamTextOrThrow(upstream).catch(() => "");
      sendAnthropicError(res, {
        httpStatus: upstream.status,
        message: parseAnthropicErrorMessage(
          raw,
          `Anthropic upstream request failed with HTTP ${upstream.status}.`
        )
      });
      return;
    }

    try {
      const streamResult = await pipeAnthropicSseAsOpenAIChatCompletions(upstream, res, {
        model: modelRoute.requestedModel,
        mapAnthropicStopReasonToOpenAI,
        upstreamStreamIdleTimeoutMs: config.upstreamStreamIdleTimeoutMs
      });
      if (streamResult?.usage) {
        res.locals.tokenUsage = streamResult.usage;
      }
    } catch (err) {
      noteUpstreamRetry(res, res.locals?.upstreamRetryCount || 0, err);
      if (!res.headersSent) {
        sendAnthropicError(res, {
          httpStatus: 502,
          message: err.message,
          type: "api_error"
        });
      } else {
        res.end();
      }
    }
    return;
  }

  let raw;
  try {
    raw = await readUpstreamTextOrThrow(upstream);
  } catch (err) {
    sendAnthropicError(res, {
      httpStatus: 502,
      message: err.message,
      type: "api_error"
    });
    return;
  }
  if (!upstream.ok) {
    sendAnthropicError(res, {
      httpStatus: upstream.status,
      message: parseAnthropicErrorMessage(
        raw,
        `Anthropic upstream request failed with HTTP ${upstream.status}.`
      )
    });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendAnthropicError(res, {
      httpStatus: 502,
      message: "Anthropic returned non-JSON response.",
      type: "api_error"
    });
    return;
  }

  const text = Array.isArray(parsed?.content)
    ? parsed.content
        .filter((x) => x?.type === "text" && typeof x?.text === "string")
        .map((x) => x.text)
        .join("")
    : "";
  const usage = {
    prompt_tokens: Number(parsed?.usage?.input_tokens || 0),
    completion_tokens: Number(parsed?.usage?.output_tokens || 0),
    total_tokens: Number(parsed?.usage?.input_tokens || 0) + Number(parsed?.usage?.output_tokens || 0)
  };
  const finishReason = mapAnthropicStopReasonToOpenAI(parsed?.stop_reason);
  const completion = buildOpenAIChatCompletion({
    model: modelRoute.requestedModel,
    text,
    finishReason,
    usage
  });
  res.locals.tokenUsage = completion.usage;
  res.status(200).json(completion);
}

function parseOpenAIChatCompletionsLikeRequest(rawBody, defaultModel, parsedBody = undefined) {
  if ((!rawBody || rawBody.length === 0) && parsedBody === undefined) {
    throw new Error("/v1/chat/completions requires a JSON body.");
  }

  let parsed = parsedBody;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new Error("Invalid JSON body for /v1/chat/completions.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON object body for /v1/chat/completions.");
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  return {
    model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : defaultModel,
    messages,
    stream: parsed.stream === true,
    max_tokens: parsed.max_tokens,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    stop: parsed.stop
  };
}

function splitSystemAndConversation(messages) {
  const systemParts = [];
  const conversation = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "user";
    const text = extractOpenAIMessageText(msg.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "assistant") {
      conversation.push({ role: "assistant", text: text || "" });
      continue;
    }

    if (role === "tool") {
      const toolLabel =
        typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 0 ? `tool:${msg.tool_call_id}` : "tool";
      conversation.push({ role: "user", text: `[${toolLabel}] ${text || ""}`.trim() });
      continue;
    }

    conversation.push({ role: "user", text: text || "" });
  }
  return {
    systemText: systemParts.join("\n\n"),
    conversation
  };
}

function extractOpenAIMessageText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const chunks = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.text === "string") {
      parts.push(chunk.text);
      continue;
    }
    if (typeof chunk.input_text === "string") {
      parts.push(chunk.input_text);
      continue;
    }
    if (typeof chunk.output_text === "string") {
      parts.push(chunk.output_text);
      continue;
    }
    if (chunk.type === "image_url" || chunk.type === "input_image") {
      parts.push("[image]");
    }
  }
  return parts.join("");
}

function buildOpenAIChatCompletion({ model, text, finishReason, usage }) {
  return {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || ""
        },
        finish_reason: finishReason || "stop"
      }
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function mapGeminiFinishReasonToOpenAI(reason) {
  const value = String(reason || "").toUpperCase();
  if (value === "MAX_TOKENS") return "length";
  if (value === "STOP" || value === "FINISH_REASON_UNSPECIFIED") return "stop";
  if (value === "SAFETY" || value === "RECITATION" || value === "BLOCKLIST") return "content_filter";
  return "stop";
}

function mapAnthropicStopReasonToOpenAI(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "max_tokens") return "length";
  if (value === "stop_sequence" || value === "end_turn" || value === "tool_use") return "stop";
  return "stop";
}

function mapOpenAIFinishReasonToGemini(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "length") return "MAX_TOKENS";
  if (value === "content_filter") return "SAFETY";
  return "STOP";
}

function mapOpenAIFinishReasonToAnthropic(reason) {
  const value = String(reason || "").toLowerCase();
  if (value === "length") return "max_tokens";
  if (value === "tool_calls") return "tool_use";
  return "end_turn";
}

function isUnsupportedMaxOutputTokensError(statusCode, rawText) {
  if (Number(statusCode || 0) !== 400) return false;
  const text = String(rawText || "").toLowerCase();
  if (!text) return false;
  return text.includes("unsupported parameter") && text.includes("max_output_tokens");
}

function estimateOpenAIChatCompletionTokens(rawBody, parsedBody = undefined) {
  if ((!rawBody || rawBody.length === 0) && parsedBody === undefined) return 0;

  let parsed = parsedBody;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return 0;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const { systemText, conversation } = splitSystemAndConversation(messages);
  const segments = [];
  if (systemText.trim().length > 0) segments.push(systemText);
  for (const item of conversation) {
    if (!item || typeof item !== "object") continue;
    segments.push(`${item.role || "user"}\n${String(item.text || "")}`.trim());
  }
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    segments.push(JSON.stringify(parsed.tools));
  }
  if (parsed.tool_choice !== undefined) {
    segments.push(JSON.stringify(parsed.tool_choice));
  }
  if (parsed.response_format && typeof parsed.response_format === "object") {
    segments.push(JSON.stringify(parsed.response_format));
  }
  if (parsed.metadata && typeof parsed.metadata === "object") {
    segments.push(JSON.stringify(parsed.metadata));
  }

  const fallbackSerialized = JSON.stringify(parsed);
  const combined = segments.filter((part) => typeof part === "string" && part.length > 0).join("\n\n");
  let inputTokens = estimateTokenCountFromText(combined || fallbackSerialized);

  if (messages.length > 0) inputTokens += messages.length * 6;
  if (systemText.trim().length > 0) inputTokens += 4;
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) inputTokens += parsed.tools.length * 20;

  return Math.max(1, Number(inputTokens || 0));
}

async function runDirectChatCompletionTest(prompt) {
  const modelRoute = resolveCodexCompatibleRoute(config.codex.defaultModel);
  const reasoningEffort = resolveReasoningEffort(undefined, {
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    instructions: config.codex.defaultInstructions
  }, modelRoute.mappedModel);
  if (config.upstreamMode === "codex-chatgpt") {
    return await runCodexDirectSelfTest(prompt, reasoningEffort);
  }
  if (config.upstreamMode === "gemini-v1beta") {
    return await runGeminiDirectSelfTest(prompt, reasoningEffort);
  }
  if (config.upstreamMode === "anthropic-v1") {
    return await runAnthropicDirectSelfTest(prompt, reasoningEffort);
  }
  throw new Error(`Unsupported upstream mode for self-test: ${config.upstreamMode}`);
}

async function runCodexDirectSelfTest(prompt, reasoningEffort) {
  const auth = await getValidAuthContext();
  if (!auth.accountId) {
    throw new Error("Cannot run test: missing chatgpt account id.");
  }

  const body = {
    model: config.codex.defaultModel,
    stream: true,
    store: false,
    instructions: config.codex.defaultInstructions,
    reasoning: {
      effort: reasoningEffort
    },
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }]
  };

  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/codex/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "openai-beta": "responses=experimental",
      originator: getCodexOriginator(),
      accept: "text/event-stream",
      "content-type": "application/json",
      "user-agent": "codex-pro-max-admin-test"
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
  }
  const completed = extractCompletedResponseFromSse(raw);
  if (!completed) {
    throw new Error("Upstream test failed: could not parse response.completed event.");
  }
  return {
    model: completed.model || config.codex.defaultModel,
    status: completed.status || "completed",
    reasoningEffort,
    preview: truncate(extractAssistantDisplayTextFromResponse(completed), 240)
  };
}

async function runGeminiDirectSelfTest(prompt, reasoningEffort) {
  if (config.gemini.apiKey) {
    const model = config.gemini.defaultModel;
    const url = `${config.gemini.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": String(config.gemini.apiKey)
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Gemini test failed: invalid JSON response.");
    }
    const candidate = Array.isArray(parsed?.candidates) && parsed.candidates.length > 0 ? parsed.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const preview = truncate(
      parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join(""),
      240
    );
    return {
      model,
      status: "completed",
      reasoningEffort,
      preview
    };
  }

  const result = await runCodexConversationViaOAuth({
    model: config.gemini.defaultModel,
    systemText: config.codex.defaultInstructions,
    conversation: [{ role: "user", text: prompt }]
  });
  return {
    model: result.model || config.gemini.defaultModel,
    status: "completed",
    reasoningEffort,
    preview: truncate(result.text, 240)
  };
}

async function runAnthropicDirectSelfTest(prompt, reasoningEffort) {
  if (config.anthropic.apiKey) {
    const model = config.anthropic.defaultModel;
    const response = await fetch(`${config.anthropic.baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": String(config.anthropic.apiKey),
        "anthropic-version": config.anthropic.version
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
        stream: false
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic test failed: HTTP ${response.status}: ${truncate(raw, 400)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Anthropic test failed: invalid JSON response.");
    }
    const preview = truncate(
      Array.isArray(parsed?.content)
        ? parsed.content
            .filter((x) => x?.type === "text" && typeof x?.text === "string")
            .map((x) => x.text)
            .join("")
        : "",
      240
    );
    return {
      model,
      status: "completed",
      reasoningEffort,
      preview
    };
  }

  const result = await runCodexConversationViaOAuth({
    model: config.anthropic.defaultModel,
    systemText: config.codex.defaultInstructions,
    conversation: [{ role: "user", text: prompt }]
  });
  return {
    model: result.model || config.anthropic.defaultModel,
    status: "completed",
    reasoningEffort,
    preview: truncate(result.text, 240)
  };
}

function getCodexOriginator() {
  if (config.authMode === "codex-oauth") return config.codexOAuth.originator;
  return "pi";
}

function resolveReasoningEffort(value, context = null, modelId = null) {
  const requested = parseReasoningEffortOrFallback(value, null, { allowAdaptive: true });
  const hasExplicitRequest = requested !== null;
  let resolved = null;
  if (requested && requested !== "adaptive") {
    resolved = requested;
  }

  const planModeReasoningEffort =
    !resolved && !hasExplicitRequest && context && typeof context === "object" && context.planMode === true
      ? parseReasoningEffortOrFallback(context.planModeReasoningEffort, null)
      : null;
  if (planModeReasoningEffort) {
    resolved = planModeReasoningEffort;
  }

  if (!resolved) {
    const configured = parseReasoningEffortOrFallback(config.codex.defaultReasoningEffort, "medium", {
      allowAdaptive: true
    });

    if (requested === "adaptive" || configured === "adaptive") {
      resolved = inferAdaptiveReasoningEffort(context);
    } else {
      resolved = configured;
    }
  }

  return clampReasoningEffortForModel(resolved, modelId);
}

function applyReasoningEffortDefaults(target, reasoningEffortFromRequest, context = null, modelId = null) {
  const hasReasoningObject = target.reasoning && typeof target.reasoning === "object" && !Array.isArray(target.reasoning);
  const existingEffort = hasReasoningObject ? target.reasoning.effort : null;
  const resolvedEffort = resolveReasoningEffort(existingEffort ?? reasoningEffortFromRequest, context, modelId);

  target.reasoning = hasReasoningObject ? { ...target.reasoning } : {};
  target.reasoning.effort = resolvedEffort;
}

function inferAdaptiveReasoningEffort(context) {
  const metrics = {
    textChars: 0,
    messageCount: 0,
    imageCount: 0,
    toolCallCount: 0,
    toolDefinitionCount: 0,
    complexityHints: 0
  };

  if (context && typeof context === "object") {
    if (typeof context.instructions === "string") {
      metrics.textChars += context.instructions.length;
    }
    if (Array.isArray(context.tools)) {
      metrics.toolDefinitionCount += context.tools.length;
    }
    if (Array.isArray(context.messages)) {
      analyzeChatMessagesForEffort(context.messages, metrics);
    }
    if (Array.isArray(context.input)) {
      analyzeResponsesInputForEffort(context.input, metrics);
    }
  }

  let score = 0;
  if (metrics.textChars > 900) score += 4;
  else if (metrics.textChars > 450) score += 3;
  else if (metrics.textChars > 180) score += 2;
  else if (metrics.textChars > 80) score += 1;

  if (metrics.messageCount >= 12) score += 2;
  else if (metrics.messageCount >= 5) score += 1;

  if (metrics.toolCallCount > 0) score += 2;
  if (metrics.toolDefinitionCount > 0) score += 1;
  if (metrics.imageCount > 0) score += 1;
  score += Math.min(metrics.complexityHints, 3);

  if (
    score === 0 &&
    metrics.textChars < 80 &&
    metrics.messageCount <= 2 &&
    metrics.toolCallCount === 0 &&
    metrics.toolDefinitionCount === 0 &&
    metrics.imageCount === 0
  ) {
    return "none";
  }
  if (score <= 2) return "low";
  if (score <= 5) return "medium";
  if (score <= 7) return "high";
  return "xhigh";
}

function analyzeChatMessagesForEffort(messages, metrics) {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    metrics.messageCount += 1;
    if (Array.isArray(msg.tool_calls)) {
      metrics.toolCallCount += msg.tool_calls.length;
    }
    analyzeContentValueForEffort(msg.content, metrics);
  }
}

function analyzeResponsesInputForEffort(input, metrics) {
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.role) metrics.messageCount += 1;
    if (item.type === "function_call" || item.type === "function_call_output") {
      metrics.toolCallCount += 1;
      if (typeof item.arguments === "string") metrics.textChars += item.arguments.length;
      if (typeof item.output === "string") metrics.textChars += item.output.length;
    }
    analyzeContentValueForEffort(item.content, metrics);
  }
}

function analyzeContentValueForEffort(content, metrics) {
  if (typeof content === "string") {
    metrics.textChars += content.length;
    metrics.complexityHints += scoreTextComplexityHints(content);
    return;
  }
  if (!content || typeof content !== "object") return;

  const chunks = Array.isArray(content) ? content : [content];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const type = typeof chunk.type === "string" ? chunk.type : "";
    if (type === "image_url" || type === "input_image") {
      metrics.imageCount += 1;
    }
    if (typeof chunk.text === "string") {
      metrics.textChars += chunk.text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.text);
    }
    if (typeof chunk.input_text === "string") {
      metrics.textChars += chunk.input_text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.input_text);
    }
    if (typeof chunk.output_text === "string") {
      metrics.textChars += chunk.output_text.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.output_text);
    }
    if (typeof chunk.refusal === "string") {
      metrics.textChars += chunk.refusal.length;
      metrics.complexityHints += scoreTextComplexityHints(chunk.refusal);
    }
  }
}

function scoreTextComplexityHints(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const punctuationCount =
    (text.match(/[,:;，、；：\n]/g)?.length || 0) + (text.includes("。") ? 1 : 0);
  const lowered = text.toLowerCase();
  const keywords = [
    "analysis",
    "analyze",
    "architecture",
    "design",
    "plan",
    "strategy",
    "risk",
    "deploy",
    "monitor",
    "security",
    "拆解",
    "分析",
    "架構",
    "計畫",
    "风險",
    "風險",
    "部署",
    "監控",
    "資安",
    "流程",
    "步驟"
  ];
  let keywordHits = 0;
  for (const kw of keywords) {
    if (lowered.includes(kw.toLowerCase())) keywordHits += 1;
  }

  let hint = 0;
  if (punctuationCount >= 6) hint += 1;
  if (keywordHits >= 2) hint += 1;
  if (keywordHits >= 5) hint += 1;
  return hint;
}

export { app, mainServer };

export const __testing = createServerTestingExports({
  config,
  acquireCodexAccountLease,
  applyCodexInvalidatedAccountState,
  isCodexAccountLeased,
  pickCodexAccountCandidates,
  removeCodexPoolAccountFromStore,
  isCodexTokenInvalidatedError,
  startExpiredAccountCleanupTimer,
  stopExpiredAccountCleanupTimer,
  getExpiredAccountCleanupTimer: () => expiredAccountCleanupTimer,
  ensureCodexOAuthCallbackServer,
  stopCodexOAuthCallbackServer,
  getCodexOAuthCallbackServer,
  getCloudflaredRuntime: () => cloudflaredRuntime,
  stopCloudflaredTunnel,
  ensureCodexOAuthStoreShape,
  buildOfficialCodexModelCandidateIds,
  resolveCodexPreheatModelSelection,
  normalizeCodexServiceTier,
  normalizeCodexResponsesRequestBody,
  normalizeChatCompletionsRequestBody,
  parseResponsesResultFromSse,
  anthropicLocalCompatHelpers,
  buildCodexResponsesRequestBody,
  handleAnthropicNativeProxy
});

