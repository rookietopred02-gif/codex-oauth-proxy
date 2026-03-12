import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRequestsStore, normalizeRecentRequestsStore } from "../src/recent-requests-store.js";

test("normalizeRecentRequestsStore accepts legacy arrays and trims to max entries", () => {
  const normalized = normalizeRecentRequestsStore([{ id: "a" }, { id: "b" }, { id: "c" }], 2);

  assert.equal(normalized.count, 2);
  assert.deepEqual(
    normalized.recentRequests.map((row) => row.id),
    ["a", "b"]
  );
});

test("recent requests store persists appended rows and clears cleanly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-requests-"));
  const filePath = path.join(tempDir, "recent-requests.json");
  const store = createRecentRequestsStore({ filePath, maxEntries: 3 });

  await store.load();
  store.append({ id: "req_1", status: 200 });
  store.append({ id: "req_2", status: 502 });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.count, 2);
  assert.deepEqual(
    persisted.recentRequests.map((row) => row.id),
    ["req_2", "req_1"]
  );

  store.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const cleared = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(cleared.count, 0);
  assert.deepEqual(cleared.recentRequests, []);
});
