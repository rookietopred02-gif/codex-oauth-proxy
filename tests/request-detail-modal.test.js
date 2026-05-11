import assert from "node:assert/strict";
import test from "node:test";

import { createRequestDetailModal } from "../public/dashboard/request-detail-modal.js";

class FakeClassList {
  add() {}
  remove() {}
}

class FakeHTMLElement {
  constructor() {
    this._textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.classList = new FakeClassList();
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
}

class FakeHTMLButtonElement extends FakeHTMLElement {}

function installFakeDom() {
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

  return () => {
    globalThis.HTMLElement = originalHTMLElement;
    globalThis.HTMLButtonElement = originalHTMLButtonElement;
    globalThis.document = originalDocument;
  };
}

function createElements() {
  return new Map([
    ["reqDetailTitle", new FakeHTMLElement()],
    ["reqDetailMetaGrid", new FakeHTMLElement()],
    ["reqDetailBackdrop", new FakeHTMLElement()],
    ["reqDetailReqMeta", new FakeHTMLElement()],
    ["reqDetailReqCode", new FakeHTMLElement()],
    ["reqDetailReqLoadBtn", new FakeHTMLButtonElement()],
    ["reqDetailReqCopyBtn", new FakeHTMLButtonElement()],
    ["reqDetailResMeta", new FakeHTMLElement()],
    ["reqDetailResCode", new FakeHTMLElement()],
    ["reqDetailResLoadBtn", new FakeHTMLButtonElement()],
    ["reqDetailResCopyBtn", new FakeHTMLButtonElement()]
  ]);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function throwingNumber() {
  return {
    valueOf() {
      throw new Error("bad number");
    },
    toString() {
      throw new Error("bad string");
    }
  };
}

test("request detail modal ignores malformed numeric metadata, timestamps, and packet sizes", async () => {
  const restore = installFakeDom();
  const elements = createElements();
  const badNumber = throwingNumber();
  let rowStatus = "401.9";

  const modal = createRequestDetailModal({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    },
    api: async (path) => {
      if (path === "/admin/requests/row-malformed" || path === "/admin/requests/row-decimal-status") {
        return {
          request: {
            requestContentType: "text/plain",
            responseContentType: "text/plain",
            packetInfo: {
              requestPacket: { chars: Symbol("request-chars"), bytes: Symbol("request-bytes") },
              responsePacket: { chars: badNumber, bytes: Infinity }
            }
          }
        };
      }
      if (
        path.includes("/admin/requests/row-malformed/packet?") ||
        path.includes("/admin/requests/row-decimal-status/packet?")
      ) {
        return {
          packet: {
            text: "packet-preview",
            totalChars: Symbol("packet-chars"),
            totalBytes: badNumber,
            truncated: false
          }
        };
      }
      throw new Error(`unexpected path: ${path}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      return key;
    },
    escapeHtml,
    fmtToken: () => "-",
    formatDateTime() {
      throw new Error("date formatter failed");
    },
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account",
    resolveCompatibilityHint: () => "-",
    getRequestRowById: () => ({
      id: "row-malformed",
      ts: Symbol("ts"),
      method: badNumber,
      path: badNumber,
      transportType: badNumber,
      durationMs: -42,
      upstreamRetryCount: Symbol("retry"),
      status: rowStatus,
      upstreamErrorCode: badNumber,
      upstreamErrorDetail: badNumber
    })
  });

  try {
    await modal.openRequestDetailModal("row-malformed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = [
      elements.get("reqDetailMetaGrid").innerHTML,
      elements.get("reqDetailReqMeta").textContent,
      elements.get("reqDetailResMeta").textContent,
      elements.get("reqDetailReqCode").textContent,
      elements.get("reqDetailResCode").textContent
    ].join("\n");

    assert.match(rendered, /req_meta_latency/);
    assert.match(rendered, /<div class="k">req_meta_latency<\/div><div class="v">-<\/div>/);
    assert.match(rendered, /<div class="k">req_meta_status<\/div><div class="v">-<\/div>/);
    assert.doesNotMatch(rendered, /req_meta_upstream_retries/);
    assert.doesNotMatch(rendered, /date formatter failed|NaN|Infinity|Symbol|\[object Object\]|>401\.9</);

    rowStatus = "401.0";
    await modal.openRequestDetailModal("row-decimal-status");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const decimalRendered = elements.get("reqDetailMetaGrid").innerHTML;
    assert.match(decimalRendered, /<div class="k">req_meta_status<\/div><div class="v">-<\/div>/);
    assert.doesNotMatch(decimalRendered, /<div class="k">req_meta_status<\/div><div class="v">401<\/div>/);
  } finally {
    restore();
  }
});

test("request detail modal rejects decimal-form counters and packet sizes", async () => {
  const restore = installFakeDom();
  const elements = createElements();

  const modal = createRequestDetailModal({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    },
    api: async (path) => {
      if (path === "/admin/requests/row-decimal-counters") {
        return {
          request: {
            requestContentType: "text/plain",
            responseContentType: "text/plain",
            packetInfo: {
              requestPacket: { chars: "7.5", bytes: "12.5" },
              responsePacket: { chars: "9.5", bytes: "42.9" }
            }
          }
        };
      }
      if (path.includes("/admin/requests/row-decimal-counters/packet?")) {
        return {
          packet: {
            text: "packet-preview",
            totalChars: "9.5",
            totalBytes: "42.9",
            truncated: false
          }
        };
      }
      throw new Error(`unexpected path: ${path}`);
    },
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "request_detail_packet_meta") return `${vars.type}|${vars.size}|${vars.mode}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      return key;
    },
    escapeHtml,
    fmtToken: () => "-",
    formatDateTime: () => "Apr 11, 2026",
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account",
    resolveCompatibilityHint: () => "-",
    getRequestRowById: () => ({
      id: "row-decimal-counters",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      path: "/v1/responses",
      transportType: "http",
      durationMs: "1e3",
      upstreamRetryCount: "2.5",
      status: 200
    })
  });

  try {
    await modal.openRequestDetailModal("row-decimal-counters");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = [elements.get("reqDetailMetaGrid").innerHTML, elements.get("reqDetailResMeta").textContent].join(
      "\n"
    );

    assert.match(rendered, /<div class="k">req_meta_latency<\/div><div class="v">-<\/div>/);
    assert.doesNotMatch(rendered, /req_meta_upstream_retries|>2\.5<|1000 ms|1e3|42\.9|12\.5|9\.5|7\.5/);
    assert.match(rendered, /text\/plain\|0 B\|request_detail_packet_preview/);
  } finally {
    restore();
  }
});

test("request detail modal rejects decimal-form timestamps on formatter fallback", async () => {
  const restore = installFakeDom();
  const elements = createElements();

  const modal = createRequestDetailModal({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    },
    api: async () => ({
      request: {
        requestContentType: "text/plain",
        responseContentType: "text/plain",
        packetInfo: {
          requestPacket: { chars: 0, bytes: 0 },
          responsePacket: { chars: 0, bytes: 0 }
        }
      }
    }),
    t: (key) => key,
    tt: (key, vars = {}) => {
      if (key === "request_detail_title_fmt") return `${vars.method} ${vars.path}`;
      if (key === "token_usage_format") return `${vars.input}/${vars.output}/${vars.cachedInput}`;
      return key;
    },
    escapeHtml,
    fmtToken: () => "-",
    formatDateTime() {
      throw new Error("date formatter failed");
    },
    copyTextToClipboard: async () => {},
    showCopyError(err) {
      throw err;
    },
    resolveProtocolLabel: () => "Responses",
    resolveModelDisplay: () => "gpt-5.4",
    resolveAccountDisplay: () => "Account",
    resolveCompatibilityHint: () => "-",
    getRequestRowById: () => ({
      id: "row-decimal-timestamp",
      ts: "1775000000000.9",
      method: "POST",
      path: "/v1/responses",
      transportType: "http",
      durationMs: 12,
      status: 200
    })
  });

  try {
    await modal.openRequestDetailModal("row-decimal-timestamp");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = elements.get("reqDetailMetaGrid").innerHTML;
    assert.match(rendered, /<div class="k">req_meta_request_time<\/div><div class="v">-<\/div>/);
    assert.doesNotMatch(rendered, /date formatter failed|1775000000000\.9/);
  } finally {
    restore();
  }
});
