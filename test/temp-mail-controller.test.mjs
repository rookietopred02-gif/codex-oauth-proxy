import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createTempMailController, normalizeTempMailConfig } from "../src/temp-mail-controller.js";

function createFakeChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write(chunk) {
      onWrite(String(chunk || ""), child);
      return true;
    }
  };
  child.kill = () => {
    child.emit("exit", 0, "SIGTERM");
  };
  return child;
}

test("normalizeTempMailConfig enforces worker toggle", () => {
  const normalized = normalizeTempMailConfig({
    count: 2,
    password: "pw",
    workers: 9,
    nextDelaySeconds: 7,
    allowParallel: false
  });
  assert.equal(normalized.effectiveWorkers, 1);
  assert.equal(normalized.workers, 9);
  assert.equal(normalized.nextDelaySeconds, 7);
});

test("temp mail controller imports token events and finishes run", async () => {
  const imports = [];
  const controller = createTempMailController({
    rootDir: "C:/tmp/repo",
    isSupported: () => true,
    probeRunnerImpl: async () => ({ ok: true, version: "go1.24" }),
    importTokens: async (items) => {
      imports.push(...items);
      return {
        imported: items.length,
        accountPoolSize: items.length,
        usageProbe: { probed: items.length }
      };
    },
    spawnImpl: () =>
      createFakeChild((chunk, child) => {
        const message = JSON.parse(chunk.trim());
        if (message.type !== "start") return;
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ type: "log", text: "[00:00:01] started", level: "info" }) + "\n");
          child.stdout.write(
            JSON.stringify({
              type: "token",
              payload: { access_token: "tok", email: "temp@example.com", name: "Temp User" }
            }) + "\n"
          );
          child.stdout.write(JSON.stringify({ type: "done", success: 1, fail: 0, total: 1, stopped: false }) + "\n");
          child.emit("exit", 0, null);
        });
      })
  });

  await controller.start({ count: 1, password: "pw", workers: 1, nextDelaySeconds: 0, allowParallel: false });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const state = controller.getState();
  assert.equal(imports.length, 1);
  assert.equal(state.running, false);
  assert.equal(state.lastResult.summary.success, 1);
  assert.ok(state.logs.some((entry) => String(entry.text).includes("started")));
});

test("temp mail controller stop flips stopping state and exits cleanly", async () => {
  let childRef = null;
  const controller = createTempMailController({
    rootDir: "C:/tmp/repo",
    isSupported: () => true,
    probeRunnerImpl: async () => ({ ok: true, version: "go1.24" }),
    importTokens: async () => ({ imported: 0, accountPoolSize: 0, usageProbe: { probed: 0 } }),
    spawnImpl: () => {
      childRef = createFakeChild((chunk, child) => {
        const message = JSON.parse(chunk.trim());
        if (message.type === "stop") {
          setImmediate(() => {
            child.stdout.write(JSON.stringify({ type: "done", success: 0, fail: 0, total: 1, stopped: true }) + "\n");
            child.emit("exit", 0, null);
          });
        }
      });
      return childRef;
    }
  });

  await controller.start({ count: 1, password: "pw", workers: 1, nextDelaySeconds: 0, allowParallel: false });
  const stoppingState = await controller.stop();
  assert.equal(stoppingState.stopping, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const finalState = controller.getState();
  assert.equal(finalState.running, false);
  assert.equal(finalState.stopping, false);
  assert.equal(finalState.lastResult.summary.stopped, true);
});
