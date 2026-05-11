import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const dashboardHtmlPath = new URL("../public/index.html", import.meta.url);
const publicAccessFeaturePath = new URL("../public/dashboard/public-access.js", import.meta.url);
const recentRequestsUiPath = new URL("../public/dashboard/requests.js", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    for (const token of tokens) this.values.add(String(token));
  }

  remove(...tokens) {
    for (const token of tokens) this.values.delete(String(token));
  }

  toggle(token, force) {
    const value = String(token);
    if (force === true) {
      this.values.add(value);
      return true;
    }
    if (force === false) {
      this.values.delete(value);
      return false;
    }
    if (this.values.has(value)) {
      this.values.delete(value);
      return false;
    }
    this.values.add(value);
    return true;
  }

  contains(token) {
    return this.values.has(String(token));
  }
}

class FakeHTMLElement {
  constructor() {
    this._textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.classList = new FakeClassList();
    this.attributes = new Map();
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
  }

  get textContent() {
    return this._textContent;
  }

  replaceChildren() {
    this._textContent = "";
  }

  append(node) {
    this._textContent += String(node?.textContent ?? node ?? "");
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {}

function createFakeDashboardElement(button = false) {
  return button ? new FakeHTMLButtonElement() : new FakeHTMLElement();
}

function installFakeDashboardDom() {
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLButtonElement = globalThis.HTMLButtonElement;
  const originalDocument = globalThis.document;

  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLButtonElement = FakeHTMLButtonElement;
  globalThis.document = {
    body: {
      style: {
        overflow: ""
      }
    },
    createTextNode(text) {
      return { textContent: String(text ?? "") };
    }
  };

  const restore = () => {
    globalThis.HTMLElement = originalHTMLElement;
    globalThis.HTMLButtonElement = originalHTMLButtonElement;
    globalThis.document = originalDocument;
  };

  return {
    createElement(button = false) {
      return createFakeDashboardElement(button);
    },
    restore
  };
}

function createRecentRequestElements(dom) {
  const elements = new Map();
  for (const [id, element] of [
    ["reqTable", dom.createElement()],
    ["ignoreReqBtn", dom.createElement(true)],
    ["ignoreReqBtnLabel", dom.createElement()],
    ["reqDetailTitle", dom.createElement()],
    ["reqDetailMetaGrid", dom.createElement()],
    ["reqDetailBackdrop", dom.createElement()],
    ["reqDetailReqMeta", dom.createElement()],
    ["reqDetailReqCode", dom.createElement()],
    ["reqDetailReqLoadBtn", dom.createElement(true)],
    ["reqDetailReqCopyBtn", dom.createElement(true)],
    ["reqDetailResMeta", dom.createElement()],
    ["reqDetailResCode", dom.createElement()],
    ["reqDetailResLoadBtn", dom.createElement(true)],
    ["reqDetailResCopyBtn", dom.createElement(true)]
  ]) {
    elements.set(id, element);
  }
  return elements;
}

function escapeTestHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

test("dashboard fallback picker only resolves cancel after focus returns with no files", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /window\.addEventListener\("focus", handleWindowFocus, \{ once: true, capture: true \}\)/);
  assert.match(html, /if \(!settled && \(!input\.files \|\| input\.files\.length === 0\)\) \{/);
  assert.match(html, /\}, 200\);/);
});

test("token import no longer prompts for file vs directory source", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.doesNotMatch(html, /confirm\(t\("confirm_token_import_source"\)\)/);
  assert.match(html, /function canPickTokenImportFilesWithDesktopBridge\(\)/);
  assert.match(html, /await desktopBridge\.pickTokenImportFiles\(\)/);
});

test("dashboard leaves reasoning effort to client requests but keeps service tier config", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.doesNotMatch(html, /id="defaultReasoningEffort"/);
  assert.doesNotMatch(html, /id="planModeReasoningEffort"/);
  assert.doesNotMatch(html, /defaultReasoningEffort:/);
  assert.doesNotMatch(html, /planModeReasoningEffort:/);
  assert.match(html, /id="defaultServiceTier"/);
  assert.match(html, /defaultServiceTier: \$\("defaultServiceTier"\)\.value/);
  assert.match(html, /\$\("defaultServiceTier"\)\.value = state\.config\.defaultServiceTier \|\| "priority";/);
});

test("dashboard custom select changes force autosave for Account Pool Filter", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /multiAccountPoolFilter/);
  for (const value of ["all", "exclude-free", "standard-only", "team-only", "free-only"]) {
    assert.match(html, new RegExp(`<option value="${value}"`));
  }
  assert.match(html, /select\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\);/);
  assert.match(html, /select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\);/);
  assert.match(html, /if \(CONFIG_FIELD_IDS\.includes\(select\.id\)\) \{\s*triggerAutoSaveNow\(\);\s*\}/);
});

test("dashboard account login flow does not seed generated account labels", async () => {
  const poolFeature = await fs.readFile(new URL("../public/app/features/pool.js", import.meta.url), "utf8");

  assert.match(poolFeature, /const raw = win\.prompt\(t\("runtime_connect_account_email_hint"\), ""\);/);
  assert.match(poolFeature, /if \(expectedEmail\) params\.set\("email", expectedEmail\);/);
  assert.match(poolFeature, /params\.set\("slot", String\(slot\)\);/);
  assert.match(poolFeature, /win\.open\(`\/auth\/login\?\$\{params\.toString\(\)\}`, "_blank"\);/);
  assert.doesNotMatch(poolFeature, /label=acc/);
});

test("dashboard copy buttons reuse clipboard fallback helper", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");
  const publicAccessFeature = await fs.readFile(publicAccessFeaturePath, "utf8");

  assert.match(html, /\$\("apiKeyCopyBtn"\)[\s\S]*await copyTextToClipboard\(value\)/);
  assert.match(html, /import \{ createPublicAccessFeature \} from "\.\/dashboard\/public-access\.js";/);
  assert.match(html, /\$\("publicAccessCopyBtn"\)[\s\S]*await publicAccessFeature\.copyCurrentUrl\(\)/);
  assert.match(publicAccessFeature, /async function copyCurrentUrl\(\)[\s\S]*await copyTextToClipboard\(url\)/);
  assert.doesNotMatch(html, /\$\("apiKeyCopyBtn"\)[\s\S]*navigator\.clipboard\.writeText/);
  assert.doesNotMatch(publicAccessFeature, /navigator\.clipboard\.writeText/);
});

test("dashboard keeps one-time API key values out of reusable display names", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /valueEl\.textContent = keyValue \|\| "-";/);
  assert.doesNotMatch(html, /transientApiKeyValues/);
  assert.doesNotMatch(html, /key\?\.value/);
  assert.match(html, /function getApiKeyDisplayName\(key\) {[\s\S]*const label = String\(key\?\.label/);
  assert.match(
    html,
    /function getApiKeyDisplayName\(key\) {[\s\S]*const id = String\(key\?\.id \|\| ""\)\.trim\(\);[\s\S]*return prefix \|\| id;/
  );
});

test("dashboard auth boot renders state before slow secondary hydration", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(
    html,
    /loadProtectedData:\s*async \(\)\s*=> \{\s*await refreshState\(true\);\s*void hydrateDashboardSecondaryData\(\{ forceUsage: true, refreshUsage: true \}\);\s*\}/
  );
  assert.match(
    html,
    /const DASHBOARD_SECONDARY_REFRESH_MS = 30 \* 1000;/
  );
  assert.match(
    html,
    /setInterval\(\(\) => \{\s*if \(document\.hidden\) return;\s*hydrateDashboardSecondaryData\(\{[\s\S]*refreshUsage: false[\s\S]*\}\)\.catch\(\(\) => \{\}\);\s*\}, DASHBOARD_SECONDARY_REFRESH_MS\);/
  );
  assert.doesNotMatch(
    html,
    /loadProtectedData:\s*async \(\)\s*=> \{\s*await loadModelCandidates\(\);\s*await refreshState\(true\);\s*\}/
  );
});

test("dashboard pool usage refresh stays manual on the toolbar button", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.doesNotMatch(html, /id="refreshUsageBtn"/);
  assert.doesNotMatch(html, /Dual-window accounts show 5h\/W; single-window plans \(for example free\) auto-switch to one limit badge\./);
  assert.doesNotMatch(html, /Usage refreshes automatically while the dashboard is open\./);
  assert.doesNotMatch(html, /\$\("refreshUsageBtn"\)\.addEventListener/);
  assert.match(html, /\$\("refreshAllAccountsBtn"\)\.addEventListener\("click", async \(\) => \{/);
  assert.match(html, /await refreshAllAccountStatuses\(\);/);
});

test("dashboard token export downloads one json bundle without asking for a folder", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /function normalizeTokenExportBundle\(data\)/);
  assert.match(html, /async function exportTokensToJsonFile\(\)/);
  assert.match(html, /fileName: sanitizeExportFileName\(String\(data\?\.fileName \|\| ""\), "codex-oauth-account-pool\.json"\)/);
  assert.match(html, /triggerBlobDownload\(fileName, payload\);/);
  assert.match(html, /const legacyFiles = Array\.isArray\(data\?\.files\) \? data\.files : \[\];/);
  assert.match(html, /type: "codex-pro-max-auth-pool-export"/);
  assert.doesNotMatch(html, /showDirectoryPicker\(\{ mode: "readwrite", id: "codex-oauth-token-export" \}\)/);
});

test("dashboard exposes manual and automatic token refresh controls for the account pool", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /id="refreshAllTokensBtn"/);
  assert.match(html, /id="toggleAutoRefreshTokensBtn"/);
  assert.match(html, /id="tokenRefreshStatus"/);
  assert.match(html, /class="preheat-grid preheat-grid--actions"/);
  assert.match(html, /class="preheat-grid preheat-grid--compact"/);
  assert.match(html, /const TOKEN_AUTO_REFRESH_ENABLED_STORAGE_KEY = "codex_proxy_dashboard_token_auto_refresh_enabled";/);
  assert.match(html, /const TOKEN_AUTO_REFRESH_INTERVAL_MS = 30 \* 60 \* 1000;/);
  assert.match(html, /\$\("refreshAllTokensBtn"\)\.addEventListener\("click"/);
  assert.match(html, /\$\("toggleAutoRefreshTokensBtn"\)\.addEventListener\("click"/);
  assert.match(html, /function initAutoTokenRefreshControl\(\)/);
  assert.match(html, /\.preheat-grid--actions > button,/);
  assert.match(html, /\.preheat-grid--compact \.custom-select__trigger,/);
  assert.match(html, /min-height: 36px;/);
});

test("dashboard request detail modal uses load-full controls for packet-heavy payloads", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /id="recentReqCachedInputTotal"/);
  assert.match(html, /id="recentReqRpm"/);
  assert.match(html, /id="recentReqApiKeyTabs"/);
  assert.match(html, /data-i18n="recent_requests_rpm"/);
  assert.match(html, /data-i18n="recent_requests_cached_input"/);
  assert.match(html, /import \{ formatRecentRequestRate, formatTokenMetric, sumRecentRequestTotals \}/);
  assert.match(html, /function fmtToken\(n\) \{\s*return formatTokenMetric\(n\);\s*\}/);
  assert.match(html, /id="reqDetailReqLoadBtn"/);
  assert.match(html, /id="reqDetailResLoadBtn"/);
  assert.match(html, /recentRequestsUi\.loadRequestDetailFullPacket\("requestPacket"\)/);
  assert.match(html, /recentRequestsUi\.loadRequestDetailFullPacket\("responsePacket"\)/);
  assert.match(html, /recentRequestsUi\.copyRequestDetailLog\("requestPacket", "reqDetailReqCopyBtn"\)/);
  assert.match(html, /recentRequestsUi\.copyRequestDetailLog\("responsePacket", "reqDetailResCopyBtn"\)/);
});

test("recent request API key tabs use current runtime key display names", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /function getApiKeyDisplayName\(key\)/);
  assert.match(html, /function getApiKeyDisplayNameById\(id\)/);
  assert.match(html, /const titleText = getApiKeyDisplayName\(k\);/);
  assert.match(
    html,
    /const currentDisplayName = getApiKeyDisplayNameById\(id\);[\s\S]*if \(currentDisplayName\) return currentDisplayName;[\s\S]*const label = String\(row\?\.proxyApiKeyLabel/
  );
});

test("dashboard self-test preserves the result text and only refreshes dashboard state", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /\$\("testResult"\)\.textContent = JSON\.stringify\(result, null, 2\);/);
  assert.match(html, /await refreshState\(true\);/);
  assert.doesNotMatch(html, /await refreshAllAccountStatuses\(\);[\s\S]*self-test/i);
});

test("recent requests UI keeps the split module API and preview/full detail flow intact", { concurrency: false }, async () => {
  const { createRecentRequestsUi } = await import(recentRequestsUiPath);
  const dom = installFakeDashboardDom();
  const elements = createRecentRequestElements(dom);
  const clipboardWrites = [];
  const storage = new Map([["recording", "1"]]);
  const apiCalls = [];
  const detailFetchCounts = new Map();

  const row1 = {
    id: "row-1",
    ts: Date.UTC(2026, 3, 11, 10, 0, 0),
    method: "WS",
    transportType: "websocket",
    path: "/responses/v1",
    inputTokens: 11,
    cachedInputTokens: 7,
    outputTokens: 22,
    totalTokens: 33,
    status: 200,
    durationMs: 45,
    requestedModel: "gpt-5",
    mappedModel: "gpt-5.4"
  };
  const row2 = {
    ...row1,
    id: "row-2",
    path: "/responses/v1/other"
  };

  const ui = createRecentRequestsUi({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (path) => {
      apiCalls.push(path);
      if (path === "/admin/requests/row-1") {
        detailFetchCounts.set("row-1", (detailFetchCounts.get("row-1") || 0) + 1);
        return {
          request: {
            requestContentType: "application/json",
            responseContentType: "application/json",
            packetInfo: {
              requestPacket: { chars: 300, bytes: 300 },
              responsePacket: { chars: 100000, bytes: 100000 }
            }
          }
        };
      }
      if (path.includes("/admin/requests/row-1/packet?")) {
        const url = new URL(`https://example.test${path}`);
        const field = url.searchParams.get("field");
        const limit = Number(url.searchParams.get("limit"));
        if (field === "responsePacket" && limit === 65536) {
          return {
            packet: {
              text: "preview-response",
              totalChars: 100000,
              totalBytes: 100000,
              truncated: true
            }
          };
        }
        if (field === "responsePacket" && limit === 100000) {
          return {
            packet: {
              text: "full-response",
              totalChars: 100000,
              totalBytes: 100000,
              truncated: false
            }
          };
        }
        if (field === "requestPacket" && limit === 65536) {
          return {
            packet: {
              text: "preview-request",
              totalChars: 300,
              totalBytes: 300,
              truncated: false
            }
          };
        }
      }
      throw new Error(`Unexpected API call: ${path}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      if (key === "request_detail_load_failed") return `failed:${vars.message}`;
      if (key === "request_detail_content_type") return String(vars.type || "-");
      return key;
    },
    escapeHtml: (value) => String(value),
    fmtToken: (value) => String(value ?? 0),
    formatDateTime: (value, options = {}) =>
      new Intl.DateTimeFormat("en-US", {
        hour12: true,
        ...options
      }).format(new Date(Number(value))),
    copyTextToClipboard: async (text) => {
      clipboardWrites.push(String(text));
    },
    showCopyError(err) {
      throw err;
    },
    readStoredBool(key) {
      const value = storage.get(key);
      if (value === "0") return false;
      if (value === "1") return true;
      return undefined;
    },
    writeStoredString(key, value) {
      storage.set(key, String(value));
    },
    recordingStorageKey: "recording",
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account A",
    resolveCompatibilityHint: () => "-"
  });

  try {
    assert.deepEqual(Object.keys(ui).sort(), [
      "closeRequestDetailModal",
      "copyRequestDetailLog",
      "hasOpenDetail",
      "isRecordingEnabled",
      "loadRequestDetailFullPacket",
      "openRequestDetailModal",
      "renderRecordingToggle",
      "renderRows",
      "reopenActiveDetail",
      "toggleRecording"
    ]);

    ui.renderRecordingToggle();
    assert.equal(elements.get("ignoreReqBtn").classList.contains("is-recording"), true);
    assert.equal(ui.toggleRecording(), false);
    assert.equal(storage.get("recording"), "0");

    ui.renderRows([row1]);
    assert.match(elements.get("reqTable").innerHTML, /data-req-id="row-1"/);
    assert.match(elements.get("reqTable").innerHTML, /WebSocket/);
    assert.match(elements.get("reqTable").innerHTML, /gpt-5 → gpt-5.4/);
    assert.match(elements.get("reqTable").innerHTML, />7</);
    assert.match(elements.get("reqTable").innerHTML, /AM|PM/);

    await ui.openRequestDetailModal("row-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(ui.hasOpenDetail(), true);
    assert.equal(elements.get("reqDetailBackdrop").hidden, false);
    assert.equal(elements.get("reqDetailTitle").textContent, "WS /responses/v1");
    assert.match(elements.get("reqDetailMetaGrid").innerHTML, /req_meta_transport/);
    assert.match(elements.get("reqDetailMetaGrid").innerHTML, /11\/22\/7/);
    assert.match(elements.get("reqDetailMetaGrid").innerHTML, /WebSocket/);
    assert.match(elements.get("reqDetailResCode").textContent, /preview-response/);
    assert.match(elements.get("reqDetailReqCode").textContent, /preview-request/);
    assert.equal(detailFetchCounts.get("row-1"), 1);
    assert(apiCalls.includes("/admin/requests/row-1/packet?field=responsePacket&offset=0&limit=65536"));
    assert(apiCalls.includes("/admin/requests/row-1/packet?field=requestPacket&offset=0&limit=65536"));

    await ui.loadRequestDetailFullPacket("responsePacket");
    assert.equal(elements.get("reqDetailResCode").textContent, "full-response");
    assert(apiCalls.includes("/admin/requests/row-1/packet?field=responsePacket&offset=0&limit=100000"));

    await ui.copyRequestDetailLog("responsePacket", "reqDetailResCopyBtn");
    assert.deepEqual(clipboardWrites, ["full-response"]);

    ui.closeRequestDetailModal();
    assert.equal(ui.hasOpenDetail(), false);
    assert.equal(elements.get("reqDetailBackdrop").hidden, true);

    ui.renderRows([row2]);
    ui.renderRows([row1]);
    await ui.openRequestDetailModal("row-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(detailFetchCounts.get("row-1"), 2);
  } finally {
    dom.restore();
  }
});

test("recent requests table escapes rendered row values", { concurrency: false }, async () => {
  const { createRecentRequestsUi } = await import(recentRequestsUiPath);
  const dom = installFakeDashboardDom();
  const elements = createRecentRequestElements(dom);

  const ui = createRecentRequestsUi({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async () => {
      throw new Error("Detail API should not be called while rendering rows.");
    },
    t: (key) => key,
    tt: (key) => key,
    escapeHtml: escapeTestHtml,
    fmtToken: (value) => `<token-${value}>`,
    formatDateTime: () => '<time data-xss="1">',
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    readStoredBool: () => true,
    writeStoredString: () => {},
    recordingStorageKey: "recording",
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account A",
    resolveCompatibilityHint: () => "-"
  });

  try {
    ui.renderRows([
      {
        id: 'row-"xss"',
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: '<img src=x onerror="alert(1)">',
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 3,
        totalTokens: 4,
        status: "<script>alert(1)</script>",
        durationMs: '<svg onload="alert(1)">'
      }
    ]);

    const html = elements.get("reqTable").innerHTML;
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<svg/i);
    assert.doesNotMatch(html, /<token-/i);
    assert.doesNotMatch(html, /<time/i);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /&lt;script/);
    assert.doesNotMatch(html, /&lt;svg/);
    assert.match(html, /&lt;token-1&gt;/);
    assert.match(html, /&lt;time data-xss=&quot;1&quot;&gt;/);
    assert.match(html, /<td class="req-status-ok">-<\/td>/);
    assert.match(html, /<td>-<\/td>/);
  } finally {
    dom.restore();
  }
});

test("request detail modal escapes rendered metadata values", { concurrency: false }, async () => {
  const { createRecentRequestsUi } = await import(recentRequestsUiPath);
  const dom = installFakeDashboardDom();
  const elements = createRecentRequestElements(dom);

  const ui = createRecentRequestsUi({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (apiPath) => {
      if (apiPath === "/admin/requests/row-meta-xss") {
        return {
          request: {
            requestContentType: "application/json",
            responseContentType: "application/json",
            packetInfo: {
              requestPacket: { chars: 0, bytes: 0 },
              responsePacket: { chars: 0, bytes: 0 }
            }
          }
        };
      }
      if (apiPath.includes("/admin/requests/row-meta-xss/packet?")) {
        return {
          packet: {
            text: "",
            totalChars: 0,
            totalBytes: 0,
            truncated: false
          }
        };
      }
      throw new Error(`Unexpected API call: ${apiPath}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      if (key === "request_detail_content_type") return String(vars.type || "-");
      return key;
    },
    escapeHtml: escapeTestHtml,
    fmtToken: (value) => String(value ?? 0),
    formatDateTime: () => '<time data-xss="1">',
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    readStoredBool: () => true,
    writeStoredString: () => {},
    recordingStorageKey: "recording",
    resolveProtocolLabel: () => '<protocol data-xss="1">',
    resolveModelDisplay: () => '<model data-xss="1">',
    resolveAccountDisplay: () => '<account data-xss="1">',
    resolveCompatibilityHint: () => '<compat data-xss="1">'
  });

  try {
    ui.renderRows([
      {
        id: "row-meta-xss",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: '<img src=x onerror="alert(1)">',
        transportType: "http",
        path: '<svg onload="alert(1)">',
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 3,
        totalTokens: 4,
        status: "<script>alert(1)</script>",
        durationMs: '<iframe src="javascript:alert(1)">',
        upstreamRetryCount: 1,
        upstreamErrorCode: '<error-code data-xss="1">',
        upstreamErrorDetail: '<error-detail data-xss="1">'
      }
    ]);

    await ui.openRequestDetailModal("row-meta-xss");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const html = elements.get("reqDetailMetaGrid").innerHTML;
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<svg/i);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<iframe/i);
    assert.doesNotMatch(html, /<protocol/i);
    assert.doesNotMatch(html, /<model/i);
    assert.doesNotMatch(html, /<account/i);
    assert.doesNotMatch(html, /<compat/i);
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;svg/);
    assert.match(html, /&lt;time/);
    assert.match(html, /&lt;protocol/);
    assert.match(html, /&lt;model/);
    assert.match(html, /&lt;account/);
    assert.match(html, /&lt;compat/);
    assert.match(html, /&lt;error-detail/);
  } finally {
    dom.restore();
  }
});

test("request detail copy resets the button when the packet is empty", { concurrency: false }, async () => {
  const { createRecentRequestsUi } = await import(recentRequestsUiPath);
  const dom = installFakeDashboardDom();
  const elements = createRecentRequestElements(dom);
  const clipboardWrites = [];

  const ui = createRecentRequestsUi({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (apiPath) => {
      if (apiPath === "/admin/requests/row-empty") {
        return {
          request: {
            requestContentType: "application/json",
            responseContentType: "application/json",
            packetInfo: {
              requestPacket: { chars: 0, bytes: 0 },
              responsePacket: { chars: 0, bytes: 0 }
            }
          }
        };
      }
      if (apiPath.includes("/admin/requests/row-empty/packet?")) {
        return {
          packet: {
            text: "",
            totalChars: 0,
            totalBytes: 0,
            truncated: false
          }
        };
      }
      throw new Error(`Unexpected API call: ${apiPath}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      if (key === "request_detail_load_failed") return `failed:${vars.message}`;
      if (key === "request_detail_content_type") return String(vars.type || "-");
      return key;
    },
    escapeHtml: (value) => String(value),
    fmtToken: (value) => String(value ?? 0),
    formatDateTime: (value, options = {}) =>
      new Intl.DateTimeFormat("en-US", {
        hour12: true,
        ...options
      }).format(new Date(Number(value))),
    copyTextToClipboard: async (text) => {
      clipboardWrites.push(String(text));
    },
    showCopyError(err) {
      throw err;
    },
    readStoredBool: () => true,
    writeStoredString: () => {},
    recordingStorageKey: "recording",
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account A",
    resolveCompatibilityHint: () => "-"
  });

  try {
    ui.renderRows([
      {
        id: "row-empty",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        status: 200,
        durationMs: 1
      }
    ]);

    await ui.openRequestDetailModal("row-empty");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ui.copyRequestDetailLog("responsePacket", "reqDetailResCopyBtn");

    assert.deepEqual(clipboardWrites, []);
    assert.equal(elements.get("reqDetailResCopyBtn").textContent, "request_detail_copy");
  } finally {
    dom.restore();
  }
});

test("request detail modal cancels chunked packet rendering after close", { concurrency: false }, async () => {
  const { createRecentRequestsUi } = await import(recentRequestsUiPath);
  const dom = installFakeDashboardDom();
  const elements = createRecentRequestElements(dom);
  const largeResponse = "x".repeat(50_000);

  const ui = createRecentRequestsUi({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (apiPath) => {
      if (apiPath === "/admin/requests/row-large") {
        return {
          request: {
            requestContentType: "application/json",
            responseContentType: "text/event-stream",
            packetInfo: {
              requestPacket: { chars: 0, bytes: 0 },
              responsePacket: { chars: largeResponse.length, bytes: largeResponse.length }
            }
          }
        };
      }
      if (apiPath.includes("/admin/requests/row-large/packet?")) {
        const url = new URL(`https://example.test${apiPath}`);
        if (url.searchParams.get("field") === "responsePacket") {
          return {
            packet: {
              text: largeResponse,
              totalChars: largeResponse.length,
              totalBytes: largeResponse.length,
              truncated: false
            }
          };
        }
        return {
          packet: {
            text: "",
            totalChars: 0,
            totalBytes: 0,
            truncated: false
          }
        };
      }
      throw new Error(`Unexpected API call: ${apiPath}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      if (key === "request_detail_content_type") return String(vars.type || "-");
      return key;
    },
    escapeHtml: (value) => String(value),
    fmtToken: (value) => String(value ?? 0),
    formatDateTime: (value, options = {}) =>
      new Intl.DateTimeFormat("en-US", {
        hour12: true,
        ...options
      }).format(new Date(Number(value))),
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    readStoredBool: () => true,
    writeStoredString: () => {},
    recordingStorageKey: "recording",
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account A",
    resolveCompatibilityHint: () => "-"
  });

  try {
    ui.renderRows([
      {
        id: "row-large",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        status: 200,
        durationMs: 1
      }
    ]);

    await ui.openRequestDetailModal("row-large");
    assert.equal(elements.get("reqDetailResCode").textContent.length, 16 * 1024);
    ui.closeRequestDetailModal();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(elements.get("reqDetailResCode").textContent.length, 16 * 1024);
  } finally {
    dom.restore();
  }
});

test("public access start reuses persisted auto-install setting", async () => {
  const { createPublicAccessFeature } = await import(publicAccessFeaturePath);
  const elements = new Map([
    ["publicAccessMode", { value: "quick" }],
    ["publicAccessHttp2", { checked: true }],
    ["publicAccessToken", { value: "" }],
    ["publicAccessStatus", { textContent: "", disabled: false }],
    ["publicAccessUrl", { textContent: "", disabled: false }],
    ["publicAccessInstallBtn", { disabled: false }],
    ["publicAccessStartBtn", { disabled: false }],
    ["publicAccessStopBtn", { disabled: false }],
    ["publicAccessLocalBinding", { textContent: "" }]
  ]);
  const requests = [];
  const feature = createPublicAccessFeature({
    $: (id) => {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (path, options = undefined) => {
      requests.push({ path, options });
      if (path === "/admin/public-access/start") {
        return {
          status: {
            installed: true,
            running: true,
            installInProgress: false,
            url: "https://example.trycloudflare.com"
          }
        };
      }
      throw new Error(`Unexpected API call: ${path}`);
    },
    t: (key) => key,
    tt: (key) => key,
    syncCustomSelect: () => {},
    copyTextToClipboard: async () => {}
  });

  await feature.start();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/admin/public-access/start");
  const body = JSON.parse(String(requests[0].options?.body || "{}"));
  assert.deepEqual(body, { mode: "quick", useHttp2: true });
  assert.equal(Object.prototype.hasOwnProperty.call(body, "autoInstall"), false);
});

test("package.json no longer points verify:claude-agent-sdk at a missing file", async () => {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(
    pkg.scripts["release:gate"],
    "npm run check && npm test"
  );
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts, "verify:claude-agent-sdk"), false);
});

test("package.json release gate is wired to existing repo validation commands", async () => {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  assert.equal(pkg.scripts.check, "npm run lint && npm run format:check && npm run typecheck && npm run test:smoke");
  assert.equal(pkg.scripts["release:gate"], "npm run check && npm test");

  for (const scriptName of ["lint", "format:check", "typecheck", "test:smoke", "test", "check", "release:gate"]) {
    assert.equal(typeof pkg.scripts[scriptName], "string", `expected npm script ${scriptName} to exist`);
  }
});

test("package.json smoke gate covers streaming and account routing suites", async () => {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const smokeScript = String(pkg.scripts["test:smoke"] || "");

  for (const suite of [
    "tests/proxy-handlers.test.js",
    "tests/request-normalization.test.js",
    "tests/responses-websocket-server.test.js",
    "tests/responses-compat.test.js",
    "tests/account-lease-selection.test.js",
    "tests/clean-build-cache.test.js"
  ]) {
    assert.ok(smokeScript.includes(suite), `expected smoke script to include ${suite}`);
  }
});
