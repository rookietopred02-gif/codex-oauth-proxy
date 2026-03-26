import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRequestsStore } from "../src/recent-requests-store.js";

test("recent requests store persists rows outside the index file and reloads full packets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });

  const row = {
    id: "req_large",
    path: "/v1/responses",
    requestPacket: "request-".repeat(20_000),
    upstreamRequestPacket: "upstream-".repeat(20_000),
    responsePacket: "response-".repeat(20_000)
  };

  store.append(row);
  await store.flush();

  const indexRaw = await fs.readFile(historyPath, "utf8");
  const indexJson = JSON.parse(indexRaw);
  assert.equal(indexJson.storageVersion, 2);
  assert.equal(Array.isArray(indexJson.recentRequests), true);
  assert.equal(Object.hasOwn(indexJson.recentRequests[0], "file"), true);
  assert.equal(indexRaw.includes(row.responsePacket), false);

  const reloadedStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  const snapshot = await reloadedStore.load();

  assert.equal(snapshot.recentRequests.length, 1);
  assert.equal(snapshot.recentRequests[0].requestPacket, row.requestPacket);
  assert.equal(snapshot.recentRequests[0].upstreamRequestPacket, row.upstreamRequestPacket);
  assert.equal(snapshot.recentRequests[0].responsePacket, row.responsePacket);
});

test("recent requests store still loads the legacy inline JSON format", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-legacy-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const legacyPayload = {
    updatedAt: Date.now(),
    recentRequests: [
      {
        id: "req_legacy",
        responsePacket: "legacy-response"
      }
    ]
  };

  await fs.writeFile(historyPath, JSON.stringify(legacyPayload, null, 2), "utf8");

  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  const snapshot = await store.load();

  assert.equal(snapshot.recentRequests.length, 1);
  assert.equal(snapshot.recentRequests[0].id, "req_legacy");
  assert.equal(snapshot.recentRequests[0].responsePacket, "legacy-response");
});
