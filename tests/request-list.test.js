import assert from "node:assert/strict";
import test from "node:test";

import { createRequestListUi } from "../public/dashboard/request-list.js";

function escapeTestHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function throwingString() {
  return {
    toString() {
      throw new Error("bad string");
    }
  };
}

function createRequestListForTable(reqTable, overrides = {}) {
  return createRequestListUi({
    $(id) {
      assert.equal(id, "reqTable");
      return reqTable;
    },
    t: (key) => key,
    escapeHtml: escapeTestHtml,
    fmtToken: (value) => (value === undefined ? "-" : String(value)),
    formatDateTime: () => "10:00 AM",
    readStoredBool: () => true,
    writeStoredString: () => {},
    recordingStorageKey: "recording",
    ...overrides
  });
}

test("request list treats malformed statuses as non-error rows", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);

  assert.doesNotThrow(() =>
    ui.renderRows([
      {
        id: "row-symbol-status",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: Symbol("bad-status"),
        durationMs: 12
      }
    ])
  );

  assert.match(reqTable.innerHTML, /req-status-ok/);
  assert.match(reqTable.innerHTML, /<td class="req-status-ok">-<\/td>/);
  assert.doesNotMatch(reqTable.innerHTML, /Symbol\(bad-status\)|NaN|Infinity|\[object Object\]/);
});

test("request list still marks numeric and numeric-string errors as bad", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);

  ui.renderRows([
    {
      id: "row-number-status",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: 500,
      durationMs: 12
    },
    {
      id: "row-string-status",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: "429",
      durationMs: 8
    }
  ]);

  assert.equal((reqTable.innerHTML.match(/req-status-bad/g) || []).length, 2);
});

test("request list treats fractional and out-of-range statuses as non-error rows", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);

  ui.renderRows([
    {
      id: "row-fractional-status",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: "401.9",
      durationMs: 12
    },
    {
      id: "row-decimal-status",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: "401.0",
      durationMs: 10
    },
    {
      id: "row-out-of-range-status",
      ts: Date.UTC(2026, 3, 11, 10, 0, 0),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: 700,
      durationMs: 8
    }
  ]);

  assert.equal((reqTable.innerHTML.match(/req-status-ok/g) || []).length, 3);
  assert.equal((reqTable.innerHTML.match(/<td class="req-status-ok">-<\/td>/g) || []).length, 3);
  assert.doesNotMatch(reqTable.innerHTML, />401\.9<|>401\.0<|>700</);
});

test("request list safely formats malformed durations", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);

  assert.doesNotThrow(() =>
    ui.renderRows([
      {
        id: "row-symbol-duration",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: Symbol("bad-duration")
      },
      {
        id: "row-negative-duration",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/chat/completions",
        status: 200,
        durationMs: -5
      },
      {
        id: "row-exponent-duration",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: "1e3"
      },
      {
        id: "row-hex-duration",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: "0x10"
      },
      {
        id: "row-boolean-duration",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: true
      }
    ])
  );

  assert.match(reqTable.innerHTML, /<td>-<\/td>/);
  assert.doesNotMatch(
    reqTable.innerHTML,
    /Symbol\(bad-duration\)|NaN|Infinity|undefined ms|-5 ms|1000 ms|16 ms|true ms|1 ms/
  );
});

test("request list safely formats malformed text metadata", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);
  const badText = throwingString();

  assert.doesNotThrow(() =>
    ui.renderRows([
      {
        id: "row-bad-text",
        ts: Date.UTC(2026, 3, 11, 10, 0, 0),
        method: badText,
        transportType: badText,
        path: badText,
        requestedModel: badText,
        mappedModel: badText,
        status: 200,
        durationMs: 12
      }
    ])
  );

  assert.match(reqTable.innerHTML, /<td>-<\/td>/);
  assert.doesNotMatch(reqTable.innerHTML, /bad string|\[object Object\]/);
});

test("request list safely formats malformed timestamps without an injected formatter", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable, {
    formatDateTime: undefined
  });

  assert.doesNotThrow(() =>
    ui.renderRows([
      {
        id: "row-symbol-ts",
        ts: Symbol("bad-ts"),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: 12
      }
    ])
  );

  assert.match(reqTable.innerHTML, /<td>-<\/td>/);
});

test("request list safely falls back when the injected timestamp formatter throws", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable, {
    formatDateTime() {
      throw new Error("date formatter failed");
    }
  });

  assert.doesNotThrow(() =>
    ui.renderRows([
      {
        id: "row-formatter-failure",
        ts: Symbol("bad-ts"),
        method: "POST",
        transportType: "http",
        path: "/v1/responses",
        status: 200,
        durationMs: 12
      }
    ])
  );

  assert.match(reqTable.innerHTML, /<td>-<\/td>/);
  assert.doesNotMatch(reqTable.innerHTML, /date formatter failed|Symbol\(bad-ts\)/);
});

test("request list safely derives fallback ids from malformed timestamps", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable);

  const result = ui.renderRows([
    {
      ts: Symbol("bad-ts"),
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: 200,
      durationMs: 12
    }
  ]);

  assert.deepEqual([...result.visibleIds], ["request-0"]);
  assert.equal(result.requestDetailMap.has("request-0"), true);
  assert.doesNotMatch(reqTable.innerHTML, /Symbol\(bad-ts\)|\[object Object\]/);
});

test("request list rejects decimal-form fallback timestamps", () => {
  const reqTable = { innerHTML: "" };
  const ui = createRequestListForTable(reqTable, {
    formatDateTime: undefined
  });

  const result = ui.renderRows([
    {
      ts: "1770000000123.5",
      method: "POST",
      transportType: "http",
      path: "/v1/responses",
      status: 200,
      durationMs: 12
    }
  ]);

  assert.deepEqual([...result.visibleIds], ["request-0"]);
  assert.match(reqTable.innerHTML, /<td>-<\/td>/);
  assert.doesNotMatch(reqTable.innerHTML, /1770000000123\.5/);
});
