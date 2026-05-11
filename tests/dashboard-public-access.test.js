import assert from "node:assert/strict";
import test from "node:test";

import { createPublicAccessFeature } from "../public/dashboard/public-access.js";

function createElements() {
  return new Map([
    ["publicAccessMode", { value: "quick" }],
    ["publicAccessHttp2", { checked: true }],
    ["publicAccessToken", { value: "", disabled: false, placeholder: "" }],
    ["publicAccessStatus", { textContent: "", disabled: false }],
    ["publicAccessUrl", { textContent: "", disabled: false }],
    ["publicAccessInstallBtn", { disabled: false }],
    ["publicAccessStartBtn", { disabled: false }],
    ["publicAccessStopBtn", { disabled: false }],
    ["publicAccessLocalBinding", { textContent: "" }]
  ]);
}

function createFeature(elements) {
  return createPublicAccessFeature({
    $(id) {
      const element = elements.get(id);
      if (!element) throw new Error(`missing element: ${id}`);
      return element;
    },
    api: async () => ({}),
    t(key) {
      return key;
    },
    tt(key, vars = {}) {
      const pairs = Object.entries(vars)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join("|");
      return `${key}:${pairs}`;
    },
    syncCustomSelect() {},
    copyTextToClipboard: async () => {}
  });
}

test("public access UI ignores malformed runtime port fields", () => {
  const elements = createElements();
  const feature = createFeature(elements);

  feature.applyConfigFromState({
    config: {
      activeRuntimePort: Symbol("active-port"),
      runtimePort: "not-a-port",
      publicAccess: {
        mode: "quick",
        useHttp2: true
      }
    },
    publicAccess: {
      installed: true,
      running: true,
      mode: "quick",
      localPort: Symbol("local-port"),
      pid: Symbol("pid"),
      version: "test-version",
      url: "https://public.example.test"
    }
  });

  assert.match(elements.get("publicAccessLocalBinding").textContent, /port=8787/);
  assert.match(elements.get("publicAccessStatus").textContent, /port=8787/);
  assert.match(elements.get("publicAccessStatus").textContent, /pid=-/);
  assert.equal(elements.get("publicAccessUrl").textContent, "https://public.example.test");
  assert.doesNotMatch(elements.get("publicAccessStatus").textContent, /NaN|Infinity|Symbol|not-a-port/);
});

test("public access UI rejects decimal-form runtime port fields", () => {
  const elements = createElements();
  const feature = createFeature(elements);

  feature.applyConfigFromState({
    config: {
      activeRuntimePort: "8788.9",
      runtimePort: "9898.1",
      publicAccess: {
        mode: "quick",
        useHttp2: true
      }
    },
    publicAccess: {
      installed: true,
      running: true,
      mode: "quick",
      localPort: "8080.9",
      pid: "1234.9",
      version: "test-version",
      url: "https://public.example.test"
    }
  });

  assert.match(elements.get("publicAccessLocalBinding").textContent, /port=8787/);
  assert.match(elements.get("publicAccessStatus").textContent, /port=8787/);
  assert.match(elements.get("publicAccessStatus").textContent, /pid=-/);
  assert.doesNotMatch(elements.get("publicAccessLocalBinding").textContent, /8788|9898/);
  assert.doesNotMatch(elements.get("publicAccessStatus").textContent, /8080|1234/);
});
