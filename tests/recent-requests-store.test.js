import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRequestsStore } from "../src/recent-requests-store.js";

test("recent requests store persists rows outside the index file and reloads summaries by default", async () => {
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
  assert.equal(indexJson.storageVersion, 3);
  assert.equal(Array.isArray(indexJson.recentRequests), true);
  assert.equal(Object.hasOwn(indexJson.recentRequests[0], "file"), true);
  assert.equal(Object.hasOwn(indexJson.recentRequests[0], "summary"), true);
  assert.equal(indexRaw.includes(row.responsePacket), false);

  const reloadedStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  const snapshot = await reloadedStore.load();

  assert.equal(snapshot.recentRequests.length, 1);
  assert.equal(snapshot.recentRequests[0].requestPacket, undefined);
  assert.equal(snapshot.recentRequests[0].upstreamRequestPacket, undefined);
  assert.equal(snapshot.recentRequests[0].responsePacket, undefined);

  const detail = await reloadedStore.getById("req_large");
  assert.equal(detail?.requestPacket, row.requestPacket);
  assert.equal(detail?.upstreamRequestPacket, row.upstreamRequestPacket);
  assert.equal(detail?.responsePacket, row.responsePacket);

  const detailSummary = await reloadedStore.getDetailSummaryById("req_large");
  assert.equal(detailSummary?.requestPacket, undefined);
  assert.equal(detailSummary?.responsePacket, undefined);
  assert.equal(detailSummary?.packetInfo.requestPacket.chars, row.requestPacket.length);
  assert.equal(detailSummary?.packetInfo.upstreamRequestPacket.chars, row.upstreamRequestPacket.length);
  assert.equal(detailSummary?.packetInfo.responsePacket.chars, row.responsePacket.length);

  const preview = await reloadedStore.getPacketSliceById("req_large", "responsePacket", {
    offset: 0,
    limit: 64
  });
  assert.equal(preview?.field, "responsePacket");
  assert.equal(preview?.text, row.responsePacket.slice(0, 64));
  assert.equal(preview?.truncated, true);
  assert.equal(preview?.totalChars, row.responsePacket.length);
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
  assert.equal(snapshot.recentRequests[0].responsePacket, undefined);

  const detail = await store.getById("req_legacy");
  assert.equal(detail?.responsePacket, "legacy-response");
});

test("recent requests store decodes legacy byte-index packet rows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-bytes-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const rowsDirectory = `${historyPath}.rows`;
  const responsePacket =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const legacyResponsePacket = JSON.stringify(
    Object.fromEntries(Buffer.from(responsePacket, "utf8").entries()),
    null,
    2
  );

  await fs.mkdir(rowsDirectory, { recursive: true });
  await fs.writeFile(
    path.join(rowsDirectory, "req_legacy_bytes.json"),
    JSON.stringify(
      {
        id: "req_legacy_bytes",
        path: "/v1/responses",
        responseContentType: "text/event-stream",
        responsePacket: legacyResponsePacket
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    historyPath,
    JSON.stringify(
      {
        storageVersion: 3,
        updatedAt: Date.now(),
        count: 1,
        recentRequests: [
          {
            id: "req_legacy_bytes",
            file: "req_legacy_bytes.json",
            summary: {
              id: "req_legacy_bytes",
              responseContentType: "text/event-stream",
              requestPacketChars: 0,
              requestPacketBytes: 0,
              upstreamRequestPacketChars: 0,
              upstreamRequestPacketBytes: 0,
              responsePacketChars: legacyResponsePacket.length,
              responsePacketBytes: Buffer.byteLength(legacyResponsePacket, "utf8")
            }
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  await store.load();

  const detail = await store.getById("req_legacy_bytes");
  assert.equal(detail?.responsePacket, responsePacket);

  const preview = await store.getPacketSliceById("req_legacy_bytes", "responsePacket", {
    offset: 0,
    limit: 65536
  });
  assert.equal(preview?.text, responsePacket);
  assert.equal(preview?.totalChars, responsePacket.length);
});

test("recent requests store backfills cached input tokens from response packets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-cache-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const responsePacket =
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":96},"output_tokens":8,"total_tokens":128}}}\n\n';
  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });

  store.append({
    id: "req_cached",
    path: "/v1/responses",
    inputTokens: 120,
    outputTokens: 8,
    totalTokens: 128,
    cachedInputTokens: null,
    responsePacket
  });
  await store.flush();

  const snapshot = store.snapshot();
  assert.equal(snapshot.recentRequests[0].cachedInputTokens, 96);

  const reloadedStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  const reloadedSnapshot = await reloadedStore.load();
  assert.equal(reloadedSnapshot.recentRequests[0].cachedInputTokens, 96);
});
