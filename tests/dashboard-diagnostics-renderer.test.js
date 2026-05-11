import assert from "node:assert/strict";
import test from "node:test";

import { renderExpiredAccountCleanupState, renderPreheatStatus } from "../public/app/renderers/diagnostics.js";

function createDeps(elements = new Map()) {
  return {
    $(id) {
      if (!elements.has(id)) {
        elements.set(id, { className: "", textContent: "" });
      }
      return elements.get(id);
    },
    t(key) {
      return key;
    },
    tt(key, vars = {}) {
      const pairs = Object.entries(vars)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join("|");
      return `${key}:${pairs}`;
    },
    fmtUnixSec(value) {
      return Number.isFinite(value) && value > 0 ? `ts:${value}` : "-";
    }
  };
}

function throwingValue() {
  return {
    valueOf() {
      throw new Error("bad number");
    },
    toString() {
      throw new Error("bad string");
    }
  };
}

test("diagnostics preheat renderer ignores malformed numeric summary values", () => {
  const elements = new Map();
  const deps = createDeps(elements);
  const bad = throwingValue();

  renderPreheatStatus(deps, {
    lastRunAt: Symbol("run"),
    lastCompletedAt: bad,
    lastDurationMs: "not-a-duration",
    lastStatus: Symbol("status"),
    running: true,
    lastSummary: {
      status: Symbol("summary"),
      success: Symbol("success"),
      failed: "not-a-count",
      modelCount: Infinity,
      selectedAccounts: bad,
      attempts: -4
    }
  });

  const text = elements.get("preheatStatus").textContent;
  assert.match(text, /status=idle/);
  assert.match(text, /success=0/);
  assert.match(text, /failed=0/);
  assert.match(text, /models=0/);
  assert.match(text, /accounts=0/);
  assert.match(text, /attempts=0/);
  assert.match(text, /duration=0/);
  assert.doesNotMatch(text, /NaN|Infinity|Symbol|\[object Object\]|not-a-/);
});

test("diagnostics cleanup renderer ignores malformed counters and timestamps", () => {
  const elements = new Map();
  const deps = createDeps(elements);
  const bad = throwingValue();

  renderExpiredAccountCleanupState(deps, {
    lastRunAt: Symbol("run"),
    lastCompletedAt: bad,
    lastRemovedCount: "not-a-count",
    lastReason: bad,
    lastStatus: Symbol("status"),
    running: false
  });

  const text = elements.get("expiredAccountCleanupStatus").textContent;
  assert.match(text, /status=idle/);
  assert.match(text, /removed=0/);
  assert.match(text, /reason=-/);
  assert.doesNotMatch(text, /NaN|Infinity|Symbol|\[object Object\]|not-a-/);
});

test("diagnostics renderers reject decimal-form integer metadata", () => {
  const elements = new Map();
  const deps = createDeps(elements);

  renderPreheatStatus(deps, {
    lastRunAt: "100.9",
    lastCompletedAt: "101.0",
    lastDurationMs: "42.8",
    lastStatus: "ok",
    running: false,
    lastSummary: {
      status: "ok",
      success: "1.9",
      failed: "2.0",
      modelCount: "3.1",
      selectedAccounts: "4.0",
      selected: "5.9"
    }
  });

  const preheatText = elements.get("preheatStatus").textContent;
  assert.match(preheatText, /success=0/);
  assert.match(preheatText, /failed=0/);
  assert.match(preheatText, /models=0/);
  assert.match(preheatText, /accounts=0/);
  assert.match(preheatText, /attempts=0/);
  assert.match(preheatText, /duration=0/);
  assert.doesNotMatch(preheatText, /ts:100\.9|ts:101\.0|42\.8|1\.9|2\.0|3\.1|4\.0|5\.9/);

  renderExpiredAccountCleanupState(deps, {
    lastRunAt: "200.9",
    lastCompletedAt: "201.0",
    lastRemovedCount: "6.9",
    lastReason: "timer",
    lastStatus: "ok",
    running: false
  });

  const cleanupText = elements.get("expiredAccountCleanupStatus").textContent;
  assert.match(cleanupText, /removed=0/);
  assert.doesNotMatch(cleanupText, /ts:200\.9|ts:201\.0|6\.9/);
});
