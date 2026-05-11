import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeSseBlocks,
  parseSseJsonEventBlock,
  readUpstreamChunkWithIdleTimeout,
  takeNextSseBlock
} from "../src/http/sse-runtime.js";
import { DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS } from "../src/upstream-timeouts.js";

async function assertReadTimeoutDelay(timeoutMs, expectedDelay) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays = [];
  let cancelReason = null;
  const reader = {
    read() {
      return new Promise(() => {});
    },
    async cancel(reason) {
      cancelReason = reason;
    }
  };

  globalThis.setTimeout = (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return { unref() {} };
  };
  globalThis.clearTimeout = () => {};

  try {
    await assert.rejects(
      () => readUpstreamChunkWithIdleTimeout(reader, null, timeoutMs),
      (err) => {
        assert.equal(err.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
        assert.match(err.message, new RegExp(`${expectedDelay}ms`));
        return true;
      }
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(delays, [expectedDelay]);
  assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
}

test("readUpstreamChunkWithIdleTimeout cancels stalled upstream readers", async () => {
  let cancelReason = null;
  const reader = {
    read() {
      return new Promise(() => {});
    },
    async cancel(reason) {
      cancelReason = reason;
    }
  };

  await assert.rejects(
    () => readUpstreamChunkWithIdleTimeout(reader, null, 5),
    (err) => {
      assert.equal(err.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
      assert.match(err.message, /5ms/);
      return true;
    }
  );
  assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
});

test("readUpstreamChunkWithIdleTimeout rejects timeout when cancellation resolves pending reads", async () => {
  let cancelReason = null;
  const stream = new ReadableStream({
    cancel(reason) {
      cancelReason = reason;
    }
  });
  const reader = stream.getReader();

  try {
    await assert.rejects(
      () => readUpstreamChunkWithIdleTimeout(reader, { body: stream }, 5),
      (err) => {
        assert.equal(err.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
        assert.match(err.message, /5ms/);
        return true;
      }
    );
    assert.equal(cancelReason?.code, "UPSTREAM_STREAM_IDLE_TIMEOUT");
  } finally {
    reader.releaseLock();
  }
});

test("readUpstreamChunkWithIdleTimeout bypasses timers when disabled", async () => {
  let cancelled = false;
  const chunk = { done: false, value: new Uint8Array([1, 2, 3]) };
  const reader = {
    async read() {
      return chunk;
    },
    async cancel() {
      cancelled = true;
    }
  };

  assert.equal(await readUpstreamChunkWithIdleTimeout(reader, null, 0), chunk);
  assert.equal(cancelled, false);
});

test("readUpstreamChunkWithIdleTimeout accepts integer-form timeout strings", async () => {
  await assertReadTimeoutDelay("7", 7);
});

for (const { label, timeoutMs } of [
  { label: "symbol", timeoutMs: Symbol("timeout") },
  { label: "fractional", timeoutMs: 7.5 },
  { label: "decimal-form", timeoutMs: "7.0" }
]) {
  test(`readUpstreamChunkWithIdleTimeout falls back for ${label} timeouts`, async () => {
    await assertReadTimeoutDelay(timeoutMs, DEFAULT_UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
  });
}

test("consumeSseBlocks emits complete blocks and final unterminated buffers", async () => {
  const encoder = new TextEncoder();
  const blocks = [];
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: a\ndata: {"type":"a"}\n\n'));
        controller.enqueue(encoder.encode('event: b\ndata: {"type":"b"}'));
        controller.close();
      }
    })
  };

  await consumeSseBlocks(upstream, {
    timeoutMs: 0,
    onBlock(block) {
      blocks.push(block);
    }
  });

  assert.deepEqual(blocks, [
    'event: a\ndata: {"type":"a"}',
    'event: b\ndata: {"type":"b"}'
  ]);
  assert.deepEqual(parseSseJsonEventBlock(blocks[0]), { type: "a" });
  assert.deepEqual(takeNextSseBlock(`${blocks[0]}\n\nrest`)?.rest, "rest");
});
