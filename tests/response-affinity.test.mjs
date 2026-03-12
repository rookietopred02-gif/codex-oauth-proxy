import test from "node:test";
import assert from "node:assert/strict";

import { createResponseAffinityStore, extractPreviousResponseId } from "../src/response-affinity.js";

test("extractPreviousResponseId returns the request chain id when present", () => {
  const rawBody = Buffer.from(JSON.stringify({ previous_response_id: "resp_123" }), "utf8");
  assert.equal(extractPreviousResponseId(rawBody), "resp_123");
});

test("extractPreviousResponseId ignores invalid payloads", () => {
  assert.equal(extractPreviousResponseId(Buffer.from("{", "utf8")), "");
  assert.equal(extractPreviousResponseId(Buffer.from(JSON.stringify(["resp_123"]), "utf8")), "");
  assert.equal(extractPreviousResponseId(Buffer.alloc(0)), "");
});

test("response affinity store remembers and refreshes pinned accounts", () => {
  const store = createResponseAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
  store.remember("resp_a", { poolEntryId: "acct:a", accountId: "account-a" }, 1_000);

  assert.deepEqual(store.lookup("resp_a", 2_000), {
    responseId: "resp_a",
    poolEntryId: "acct:a",
    accountId: "account-a",
    updatedAt: 2_000
  });
  assert.equal(store.size(), 1);
});

test("response affinity store evicts expired entries", () => {
  const store = createResponseAffinityStore({ ttlMs: 100, maxEntries: 4 });
  store.remember("resp_a", { poolEntryId: "acct:a" }, 1_000);
  store.prune(1_200);

  assert.equal(store.lookup("resp_a", 1_200), null);
});

test("response affinity store evicts oldest entries when max size is exceeded", () => {
  const store = createResponseAffinityStore({ ttlMs: 10_000, maxEntries: 2 });
  store.remember("resp_a", { poolEntryId: "acct:a" }, 1_000);
  store.remember("resp_b", { poolEntryId: "acct:b" }, 1_100);
  store.remember("resp_c", { poolEntryId: "acct:c" }, 1_200);

  assert.equal(store.lookup("resp_a", 1_300), null);
  assert.equal(store.lookup("resp_b", 1_300)?.poolEntryId, "acct:b");
  assert.equal(store.lookup("resp_c", 1_300)?.poolEntryId, "acct:c");
});

test("response affinity store forgets stale pinned chains", () => {
  const store = createResponseAffinityStore({ ttlMs: 10_000, maxEntries: 4 });
  store.remember("resp_a", { poolEntryId: "acct:a", accountId: "account-a" }, 1_000);

  assert.equal(store.forget("resp_a"), true);
  assert.equal(store.lookup("resp_a", 2_000), null);
  assert.equal(store.forget("resp_missing"), false);
});
