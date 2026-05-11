import assert from "node:assert/strict";
import test from "node:test";

import {
  createDashboardStore,
  readStoredBool,
  readStoredNumber,
  readStoredString,
  writeStoredString
} from "../public/app/store.js";

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    get(key) {
      return values.get(String(key));
    }
  };
}

async function withLocalStorage(localStorage, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (localStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: localStorage
    });
  }

  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
}

test("dashboard store snapshots do not expose mutable state containers", () => {
  const store = createDashboardStore({ theme: "dark" });

  const patched = store.patch({ locale: "en" });
  patched.theme = "light";
  const snapshot = store.snapshot();
  snapshot.locale = "zh-hant";

  assert.equal(store.get("theme"), "dark");
  assert.equal(store.get("locale"), "en");
  assert.deepEqual(store.snapshot(), { theme: "dark", locale: "en" });
});

test("stored string helpers tolerate unavailable or failing localStorage", async () => {
  await withLocalStorage(undefined, async () => {
    assert.equal(readStoredString("missing"), null);
    assert.doesNotThrow(() => writeStoredString("key", "value"));
  });

  await withLocalStorage(
    {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("quota exceeded");
      }
    },
    async () => {
      assert.equal(readStoredString("key"), null);
      assert.doesNotThrow(() => writeStoredString("key", "value"));
    }
  );
});

test("stored booleans only accept explicit persisted values", async () => {
  await withLocalStorage(
    createMemoryStorage({
      enabled: "1",
      disabled: "0",
      malformed: "true"
    }),
    async () => {
      assert.equal(readStoredBool("enabled"), true);
      assert.equal(readStoredBool("disabled"), false);
      assert.equal(readStoredBool("missing"), null);
      assert.equal(readStoredBool("malformed"), null);
    }
  );
});

test("stored numbers use fallbacks for absent, malformed, or decimal-form values and clamp valid integers", async () => {
  await withLocalStorage(
    createMemoryStorage({
      invalid: "abc",
      low: "-5",
      high: "99",
      decimal: "7.9"
    }),
    async () => {
      assert.equal(readStoredNumber("missing", 10, 2, 20), 10);
      assert.equal(readStoredNumber("invalid", 10, 2, 20), 10);
      assert.equal(readStoredNumber("low", 10, 2, 20), 2);
      assert.equal(readStoredNumber("high", 10, 2, 20), 20);
      assert.equal(readStoredNumber("decimal", 10, 2, 20), 10);
    }
  );
});
