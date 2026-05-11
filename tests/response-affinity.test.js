import assert from "node:assert/strict";
import test from "node:test";

import { createResponseAffinityStore, extractPreviousResponseId } from "../src/response-affinity.js";

test("extractPreviousResponseId accepts only JSON object string ids", () => {
  assert.equal(
    extractPreviousResponseId(Buffer.from(JSON.stringify({ previous_response_id: " resp_123 " }), "utf8")),
    "resp_123"
  );
  assert.equal(extractPreviousResponseId(Buffer.from("{", "utf8")), "");
  assert.equal(extractPreviousResponseId(Buffer.from(JSON.stringify([]), "utf8")), "");
  assert.equal(extractPreviousResponseId(Buffer.from(JSON.stringify({ previous_response_id: 42 }), "utf8")), "");
  assert.equal(extractPreviousResponseId(""), "");
});

test("response affinity store expires stale previous_response_id pins", () => {
  const store = createResponseAffinityStore({ ttlMs: 10, maxEntries: 4 });

  assert.equal(store.remember("", { poolEntryId: "entry_a" }, 1000), null);
  assert.deepEqual(store.remember(" resp_a ", { poolEntryId: " entry_a ", accountId: " acct_a " }, 1000), {
    responseId: "resp_a",
    poolEntryId: "entry_a",
    accountId: "acct_a",
    updatedAt: 1000
  });

  assert.deepEqual(store.lookup("resp_a", 1005), {
    responseId: "resp_a",
    poolEntryId: "entry_a",
    accountId: "acct_a",
    updatedAt: 1005
  });
  assert.equal(store.lookup("resp_a", 1016), null);
  assert.equal(store.size(), 0);
});

test("response affinity store ignores malformed numeric options and timestamps", () => {
  const store = createResponseAffinityStore({ ttlMs: Symbol("ttl"), maxEntries: Symbol("max") });

  const remembered = store.remember("resp_a", { poolEntryId: "entry_a" }, Symbol("now"));
  assert.equal(remembered?.responseId, "resp_a");
  assert.equal(remembered?.poolEntryId, "entry_a");
  assert.equal(Number.isFinite(remembered?.updatedAt), true);

  const refreshed = store.lookup("resp_a", Symbol("later"));
  assert.equal(refreshed?.poolEntryId, "entry_a");
  assert.equal(Number.isFinite(refreshed?.updatedAt), true);
  assert.equal(store.size(), 1);
});

test("response affinity store rejects decimal-form numeric options", () => {
  const ttlStore = createResponseAffinityStore({ ttlMs: "10.9", maxEntries: 4 });
  ttlStore.remember("resp_ttl", { poolEntryId: "entry_ttl" }, 1000);
  assert.equal(ttlStore.lookup("resp_ttl", 1012)?.poolEntryId, "entry_ttl");

  const maxEntriesStore = createResponseAffinityStore({ ttlMs: 1000, maxEntries: "1.9" });
  maxEntriesStore.remember("resp_a", { poolEntryId: "entry_a" }, 1000);
  maxEntriesStore.remember("resp_b", { poolEntryId: "entry_b" }, 1001);

  assert.equal(maxEntriesStore.lookup("resp_a", 1002)?.poolEntryId, "entry_a");
  assert.equal(maxEntriesStore.lookup("resp_b", 1003)?.poolEntryId, "entry_b");
});

test("response affinity store rejects decimal-form timestamps", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);

  const store = createResponseAffinityStore({ ttlMs: 10, maxEntries: 4 });

  assert.deepEqual(store.remember("resp_decimal", { poolEntryId: "entry_decimal" }, "1000.9"), {
    responseId: "resp_decimal",
    poolEntryId: "entry_decimal",
    accountId: "",
    updatedAt: 2000
  });

  now = 2005;
  assert.deepEqual(store.lookup("resp_decimal", "2005.9"), {
    responseId: "resp_decimal",
    poolEntryId: "entry_decimal",
    accountId: "",
    updatedAt: 2005
  });

  now = 2016;
  assert.equal(store.lookup("resp_decimal", "2016.9"), null);
});

test("response affinity store evicts least recently used pins over the limit", () => {
  const store = createResponseAffinityStore({ ttlMs: 1000, maxEntries: 2 });

  store.remember("resp_a", { poolEntryId: "entry_a" }, 1000);
  store.remember("resp_b", { poolEntryId: "entry_b" }, 1001);
  assert.equal(store.lookup("resp_a", 1002)?.poolEntryId, "entry_a");
  store.remember("resp_c", { poolEntryId: "entry_c" }, 1003);

  assert.equal(store.lookup("resp_b", 1004), null);
  assert.equal(store.lookup("resp_a", 1004)?.poolEntryId, "entry_a");
  assert.equal(store.lookup("resp_c", 1004)?.poolEntryId, "entry_c");
});

test("response affinity store can forget and clear pins", () => {
  const store = createResponseAffinityStore({ ttlMs: 1000, maxEntries: 4 });

  store.remember("resp_a", { poolEntryId: "entry_a" }, 1000);
  store.remember("resp_b", { poolEntryId: "entry_b" }, 1001);
  assert.equal(store.forget("resp_a"), true);
  assert.equal(store.forget("resp_missing"), false);
  assert.equal(store.lookup("resp_a", 1002), null);
  assert.equal(store.size(), 1);

  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.lookup("resp_b", 1003), null);
});
