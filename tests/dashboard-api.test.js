import assert from "node:assert/strict";
import test from "node:test";

import { api } from "../public/dashboard/api.js";

function createTextResponse({ ok = true, status = 200, text = "" } = {}) {
  return {
    ok,
    status,
    async text() {
      return text;
    }
  };
}

async function withFetch(fetchImpl, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl
  });

  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "fetch", descriptor);
    } else {
      delete globalThis.fetch;
    }
  }
}

test("dashboard api sends same-origin credentials and parses JSON responses", async () => {
  const calls = [];

  await withFetch(
    async (path, init) => {
      calls.push({ path, init });
      return createTextResponse({ text: '{"ok":true}' });
    },
    async () => {
      assert.deepEqual(await api("/admin/state", { headers: { accept: "application/json" } }), { ok: true });
    }
  );

  assert.equal(calls[0]?.path, "/admin/state");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(calls[0]?.init?.headers?.accept, "application/json");
});

test("dashboard api preserves malformed successful responses as raw text", async () => {
  await withFetch(
    async () => createTextResponse({ text: "not json" }),
    async () => {
      assert.deepEqual(await api("/admin/state"), { raw: "not json" });
    }
  );
});

test("dashboard api ignores non-string error fields before choosing a fallback message", async () => {
  await withFetch(
    async () =>
      createTextResponse({
        ok: false,
        status: 502,
        text: JSON.stringify({
          message: { nested: "bad gateway" },
          error: "upstream_unavailable"
        })
      }),
    async () => {
      await assert.rejects(
        () => api("/admin/state"),
        (err) => {
          assert.equal(err.message, "upstream_unavailable");
          assert.equal(err.status, 502);
          assert.deepEqual(err.data, {
            message: { nested: "bad gateway" },
            error: "upstream_unavailable"
          });
          return true;
        }
      );
    }
  );
});
