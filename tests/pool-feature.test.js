import assert from "node:assert/strict";
import test from "node:test";

import { createPoolFeature } from "../public/app/features/pool.js";

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}

class FakeHTMLElement {
  constructor() {
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.title = "";
    this.classList = new FakeClassList();
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {}

function installFakeDom() {
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLButtonElement = globalThis.HTMLButtonElement;
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLButtonElement = FakeHTMLButtonElement;
  return () => {
    globalThis.HTMLElement = originalHTMLElement;
    globalThis.HTMLButtonElement = originalHTMLButtonElement;
  };
}

function createElements() {
  const elements = new Map();
  for (const id of [
    "poolTotal",
    "poolHealthyRatio",
    "poolPrimaryAvg",
    "poolSecondaryAvg",
    "poolCooldownCount",
    "poolRiskCount",
    "poolLowQuotaCount",
    "poolRiskHint",
    "allAccountsTitle",
    "currentAccountCard",
    "recommendList",
    "accountPoolCards",
    "tokenRefreshStatus"
  ]) {
    elements.set(id, new FakeHTMLElement());
  }
  for (const id of ["refreshUsageBtn", "refreshAllAccountsBtn", "refreshAllTokensBtn", "toggleAutoRefreshTokensBtn"]) {
    elements.set(id, new FakeHTMLButtonElement());
  }
  return elements;
}

function createFeature(elements) {
  return createPoolFeature({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    },
    api: async () => ({}),
    t: (key) => key,
    tt: (key, vars = {}) =>
      `${key}:${Object.entries(vars)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join("|")}`,
    escapeHtml: (value) => String(value ?? ""),
    fmtUnixSec: (value) => String(value || "-"),
    fmtCooldown: (value) => String(value || "-"),
    shortId: (value) => String(value || "-"),
    setTextAndPulse(id, text) {
      elements.get(id).textContent = String(text);
    }
  });
}

function throwingNumber() {
  return {
    valueOf() {
      throw new Error("bad number");
    }
  };
}

test("pool feature ignores malformed dashboard metrics", () => {
  const restore = installFakeDom();
  const elements = createElements();
  const feature = createFeature(elements);
  const bad = throwingNumber();

  try {
    feature.render({
      auth: {
        accounts: [],
        enabledAccountCount: Symbol("enabled"),
        multiAccountEnabled: true,
        poolMetrics: {
          avgPrimaryRemaining: Symbol("primary"),
          avgSecondaryRemaining: Infinity,
          lowQuotaCount: bad
        }
      }
    });

    feature.renderTokenRefreshStatus({
      state: "done",
      refreshed: Symbol("refreshed"),
      total: bad
    });

    assert.equal(elements.get("poolHealthyRatio").textContent, "0%");
    assert.equal(elements.get("poolPrimaryAvg").textContent, "-");
    assert.equal(elements.get("poolSecondaryAvg").textContent, "-");
    assert.equal(elements.get("poolLowQuotaCount").textContent, "0");
    assert.match(elements.get("tokenRefreshStatus").textContent, /refreshed=0/);
    assert.match(elements.get("tokenRefreshStatus").textContent, /total=0/);
    assert.doesNotMatch(
      [
        elements.get("poolRiskHint").textContent,
        elements.get("poolPrimaryAvg").textContent,
        elements.get("poolSecondaryAvg").textContent,
        elements.get("tokenRefreshStatus").textContent
      ].join("\n"),
      /NaN|Infinity|Symbol|\[object Object\]/
    );
  } finally {
    restore();
  }
});

test("pool feature rejects decimal-form integer dashboard metrics", () => {
  const restore = installFakeDom();
  const elements = createElements();
  const feature = createFeature(elements);

  try {
    feature.render({
      auth: {
        accounts: [
          {
            entryId: "entry_low_quota",
            accountId: "acct_low_quota",
            label: "Low quota",
            enabled: true,
            lowQuota: true
          }
        ],
        enabledAccountCount: "2.9",
        multiAccountEnabled: true,
        poolMetrics: {
          avgPrimaryRemaining: "77.6",
          avgSecondaryRemaining: "62.2",
          lowQuotaCount: "3.9"
        }
      }
    });

    feature.renderTokenRefreshStatus({
      state: "done",
      refreshed: "1.9",
      total: "2.0"
    });

    assert.equal(elements.get("poolHealthyRatio").textContent, "0%");
    assert.equal(elements.get("poolPrimaryAvg").textContent, "78%");
    assert.equal(elements.get("poolSecondaryAvg").textContent, "62%");
    assert.equal(elements.get("poolLowQuotaCount").textContent, "1");
    assert.match(elements.get("tokenRefreshStatus").textContent, /refreshed=0/);
    assert.match(elements.get("tokenRefreshStatus").textContent, /total=0/);
  } finally {
    restore();
  }
});
