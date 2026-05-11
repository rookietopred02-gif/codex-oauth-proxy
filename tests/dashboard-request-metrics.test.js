import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTokenMetric,
  formatRecentRequestRate,
  parseTokenMetric,
  sumRecentRequestTotals
} from "../public/dashboard/request-metrics.js";

test("parseTokenMetric accepts finite numeric metrics only", () => {
  assert.equal(parseTokenMetric(12), 12);
  assert.equal(parseTokenMetric("7"), 7);
  assert.equal(parseTokenMetric(""), null);
  assert.equal(parseTokenMetric("   "), null);
  assert.equal(parseTokenMetric(null), null);
  assert.equal(parseTokenMetric(undefined), null);
  assert.equal(parseTokenMetric("nope"), null);
  assert.equal(parseTokenMetric(-1), null);
  assert.equal(parseTokenMetric("-7"), null);
  assert.equal(parseTokenMetric("0x10"), null);
  assert.equal(parseTokenMetric("1e3"), null);
  assert.equal(parseTokenMetric("1.5"), null);
  assert.equal(parseTokenMetric(1.5), null);
  assert.equal(parseTokenMetric(Infinity), null);
  assert.equal(parseTokenMetric(true), null);
  assert.equal(parseTokenMetric({ valueOf: () => 3 }), null);
});

test("formatRecentRequestRate preserves dashboard RPM display behavior", () => {
  assert.equal(formatRecentRequestRate(0), "0");
  assert.equal(formatRecentRequestRate(-1), "0");
  assert.equal(formatRecentRequestRate(Number.NaN), "0");
  assert.equal(formatRecentRequestRate(Symbol("rpm")), "0");
  assert.equal(formatRecentRequestRate(true), "0");
  assert.equal(formatRecentRequestRate("1e3"), "0");
  assert.equal(formatRecentRequestRate("0x10"), "0");
  assert.equal(formatRecentRequestRate({ valueOf: () => 3 }), "0");
  assert.equal(
    formatRecentRequestRate({
      valueOf() {
        throw new Error("coercion failed");
      }
    }),
    "0"
  );
  assert.equal(formatRecentRequestRate("1"), "1");
  assert.equal(formatRecentRequestRate("1.5"), "1.5");
  assert.equal(formatRecentRequestRate(1.5), "1.5");
  assert.equal(formatRecentRequestRate(99.94), "99.9");
  assert.equal(formatRecentRequestRate(99.95), "100");
  assert.equal(formatRecentRequestRate(100.4), "100");
});

test("formatTokenMetric formats numeric token strings without broad coercion", () => {
  assert.equal(formatTokenMetric(12), "12");
  assert.equal(formatTokenMetric("7"), "7");
  assert.equal(formatTokenMetric("1200"), "1.2k");
  assert.equal(formatTokenMetric(100400), "100k");
  assert.equal(formatTokenMetric(""), "-");
  assert.equal(formatTokenMetric("0x10"), "-");
  assert.equal(formatTokenMetric("1e3"), "-");
  assert.equal(formatTokenMetric(1.5), "-");
});

test("sumRecentRequestTotals tracks known token columns and timestamped request rate", () => {
  const startedAt = Date.UTC(2026, 3, 11, 10, 0, 0);

  assert.deepEqual(
    sumRecentRequestTotals([
      {
        ts: startedAt,
        inputTokens: "10",
        cachedInputTokens: 4,
        outputTokens: "5",
        totalTokens: "20"
      },
      {
        ts: startedAt + 120_000,
        inputTokens: "unknown",
        cachedInputTokens: "6",
        outputTokens: 7,
        totalTokens: null
      },
      {
        ts: 0,
        inputTokens: 1,
        cachedInputTokens: "",
        outputTokens: 2,
        totalTokens: ""
      }
    ]),
    {
      count: 3,
      input: 11,
      cachedInput: 10,
      output: 14,
      total: 30,
      rpm: 1,
      knownInput: 2,
      knownCachedInput: 2,
      knownOutput: 3,
      knownTotal: 3
    }
  );
});

test("sumRecentRequestTotals uses a one-minute minimum RPM window", () => {
  assert.equal(
    sumRecentRequestTotals([
      {
        ts: Date.UTC(2026, 3, 11, 10, 0, 0)
      },
      {
        ts: Date.UTC(2026, 3, 11, 10, 0, 30)
      }
    ]).rpm,
    2
  );
});

test("sumRecentRequestTotals ignores malformed timestamps while preserving row count", () => {
  assert.deepEqual(
    sumRecentRequestTotals([
      {
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        inputTokens: 2,
        outputTokens: 3
      },
      {
        ts: Symbol("bad-ts"),
        totalTokens: 8
      },
      {
        ts: {
          valueOf() {
            throw new Error("coercion failed");
          }
        },
        inputTokens: 1
      }
    ]),
    {
      count: 3,
      input: 3,
      cachedInput: 0,
      output: 3,
      total: 14,
      rpm: 1,
      knownInput: 2,
      knownCachedInput: 0,
      knownOutput: 1,
      knownTotal: 3
    }
  );
});

test("sumRecentRequestTotals ignores object and boolean timestamp coercion", () => {
  const startedAt = Date.UTC(2026, 3, 11, 10, 0, 0);

  const totals = sumRecentRequestTotals([
    { ts: startedAt, inputTokens: 1 },
    { ts: true, inputTokens: 1 },
    {
      ts: {
        valueOf() {
          return startedAt + 30_000;
        }
      },
      outputTokens: 1
    }
  ]);

  assert.equal(totals.count, 3);
  assert.equal(totals.input, 2);
  assert.equal(totals.output, 1);
  assert.equal(totals.total, 3);
  assert.equal(totals.rpm, 1);
});
