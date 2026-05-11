import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecentRequestsStore } from "../src/recent-requests-store.js";

function responseCompletedUsagePacket({
  inputTokens = 120,
  cachedInputTokens = 96,
  outputTokens = 8,
  totalTokens = 128
} = {}) {
  return (
    "event: response.completed\n" +
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":${inputTokens},"input_tokens_details":{"cached_tokens":${cachedInputTokens}},"output_tokens":${outputTokens},"total_tokens":${totalTokens}}}}\n\n`
  );
}

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

  const malformedBoundsPreview = await reloadedStore.getPacketSliceById("req_large", "responsePacket", {
    offset: "not-a-number",
    limit: "not-a-number"
  });
  assert.equal(malformedBoundsPreview?.offset, 0);
  assert.equal(malformedBoundsPreview?.limit, row.responsePacket.length);
  assert.equal(malformedBoundsPreview?.text, row.responsePacket);
  assert.equal(malformedBoundsPreview?.truncated, false);
});

test("recent requests store tolerates malformed maxEntries config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-max-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: Symbol("max")
  });

  const snapshot = store.append({
    id: "req_safe_max",
    path: "/v1/responses",
    responsePacket: "ok"
  });
  await store.flush();

  assert.equal(snapshot.recentRequests.length, 1);

  const reloadedStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: Symbol("max")
  });
  const reloaded = await reloadedStore.load();

  assert.equal(reloaded.recentRequests.length, 1);
  assert.equal(reloaded.recentRequests[0].id, "req_safe_max");
});

test("recent requests store rejects decimal-form integer bounds", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-decimal-bounds-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: "1.9"
  });

  store.append({
    id: "req_first",
    path: "/v1/responses",
    responsePacket: "first-response"
  });
  const snapshot = store.append({
    id: "req_second",
    path: "/v1/responses",
    responsePacket: "second-response"
  });
  await store.flush();

  assert.equal(snapshot.recentRequests.length, 2);

  const slice = await store.getPacketSliceById("req_second", "responsePacket", {
    offset: "1.9",
    limit: "3.0"
  });

  assert.equal(slice?.offset, 0);
  assert.equal(slice?.limit, "second-response".length);
  assert.equal(slice?.text, "second-response");
  assert.equal(slice?.truncated, false);
});

test("recent requests store replaces malformed persisted updatedAt values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-updated-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  await fs.writeFile(
    historyPath,
    JSON.stringify(
      {
        storageVersion: 3,
        updatedAt: "not-a-number",
        recentRequests: []
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
  const snapshot = await store.load();

  assert.equal(Number.isFinite(snapshot.updatedAt), true);
  assert.ok(snapshot.updatedAt > 0);
});

test("recent requests store replaces decimal-form persisted updatedAt values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-decimal-updated-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  await fs.writeFile(
    historyPath,
    JSON.stringify(
      {
        storageVersion: 3,
        updatedAt: "12345.9",
        recentRequests: []
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
  const beforeLoad = Date.now();
  const snapshot = await store.load();
  const afterLoad = Date.now();

  assert.ok(snapshot.updatedAt >= beforeLoad);
  assert.ok(snapshot.updatedAt <= afterLoad);
});

test("recent requests store rejects decimal-form storage versions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-decimal-version-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  await fs.writeFile(
    historyPath,
    JSON.stringify(
      {
        storageVersion: "3.0",
        updatedAt: Date.now(),
        recentRequests: [
          {
            file: "req_decimal_version.json",
            summary: {
              id: "req_decimal_version",
              path: "/v1/responses"
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
  const snapshot = await store.load();

  assert.equal(snapshot.recentRequests.length, 0);
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

test("recent requests store ignores split-row index paths outside the rows directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-traversal-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const outsideRowPath = path.join(tempDir, "outside-row.json");

  await fs.writeFile(
    outsideRowPath,
    JSON.stringify(
      {
        id: "req_escape",
        responsePacket: "outside-secret"
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
            id: "req_escape",
            file: "../outside-row.json",
            summary: {
              id: "req_escape",
              responsePacketChars: 14,
              responsePacketBytes: 14
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
  const snapshot = await store.load();

  assert.equal(snapshot.recentRequests.length, 0);
  assert.equal(await store.getById("req_escape"), null);
});

test("recent requests store rebuilds malformed split packet metadata from row files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-packet-meta-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const rowsDirectory = `${historyPath}.rows`;
  const responsePacket = "actual-response";

  await fs.mkdir(rowsDirectory, { recursive: true });
  await fs.writeFile(
    path.join(rowsDirectory, "req_packet_meta.json"),
    JSON.stringify(
      {
        id: "req_packet_meta",
        path: "/v1/responses",
        requestPacket: "",
        upstreamRequestPacket: "",
        responsePacket
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
            id: "req_packet_meta",
            file: "req_packet_meta.json",
            summary: {
              id: "req_packet_meta",
              requestPacketChars: 0,
              requestPacketBytes: 0,
              upstreamRequestPacketChars: 0,
              upstreamRequestPacketBytes: 0,
              responsePacketChars: "1e3",
              responsePacketBytes: "0x10"
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

  const summary = await store.getDetailSummaryById("req_packet_meta");
  assert.equal(summary?.packetInfo.responsePacket.chars, responsePacket.length);
  assert.equal(summary?.packetInfo.responsePacket.bytes, Buffer.byteLength(responsePacket, "utf8"));
});

test("recent requests store backfills cached input tokens from response packets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-cache-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const responsePacket = responseCompletedUsagePacket();
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

test("recent requests store replaces malformed row token metrics with packet usage", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-malformed-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const store = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });

  store.append({
    id: "req_malformed_usage",
    path: "/v1/responses",
    inputTokens: "1e3",
    cachedInputTokens: "1.5",
    outputTokens: -8,
    totalTokens: "0x10",
    responsePacket: responseCompletedUsagePacket()
  });
  await store.flush();

  assert.deepEqual(
    {
      inputTokens: store.snapshot().recentRequests[0].inputTokens,
      cachedInputTokens: store.snapshot().recentRequests[0].cachedInputTokens,
      outputTokens: store.snapshot().recentRequests[0].outputTokens,
      totalTokens: store.snapshot().recentRequests[0].totalTokens
    },
    {
      inputTokens: 120,
      cachedInputTokens: 96,
      outputTokens: 8,
      totalTokens: 128
    }
  );

  const reloadedStore = createRecentRequestsStore({
    filePath: historyPath,
    maxEntries: 5
  });
  const reloadedSnapshot = await reloadedStore.load();
  assert.equal(reloadedSnapshot.recentRequests[0].inputTokens, 120);
  assert.equal(reloadedSnapshot.recentRequests[0].cachedInputTokens, 96);
  assert.equal(reloadedSnapshot.recentRequests[0].outputTokens, 8);
  assert.equal(reloadedSnapshot.recentRequests[0].totalTokens, 128);
});

test("recent requests store backfills malformed split cached-input summaries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-recent-requests-split-cache-"));
  const historyPath = path.join(tempDir, "recent-requests.json");
  const rowsDirectory = `${historyPath}.rows`;
  const responsePacket = responseCompletedUsagePacket();

  await fs.mkdir(rowsDirectory, { recursive: true });
  await fs.writeFile(
    path.join(rowsDirectory, "req_split_malformed_cached.json"),
    JSON.stringify(
      {
        id: "req_split_malformed_cached",
        path: "/v1/responses",
        cachedInputTokens: "1e3",
        responsePacket
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
            id: "req_split_malformed_cached",
            file: "req_split_malformed_cached.json",
            summary: {
              id: "req_split_malformed_cached",
              cachedInputTokens: "1e3",
              requestPacketChars: 0,
              requestPacketBytes: 0,
              upstreamRequestPacketChars: 0,
              upstreamRequestPacketBytes: 0,
              responsePacketChars: responsePacket.length,
              responsePacketBytes: Buffer.byteLength(responsePacket, "utf8")
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
  const snapshot = await store.load();

  assert.equal(snapshot.recentRequests[0].cachedInputTokens, 96);
});
