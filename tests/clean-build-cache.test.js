import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { removeBuildCache, resolveBuildCacheDir } from "../scripts/clean-build-cache.mjs";

test("clean build cache resolves only the project dist-electron directory", () => {
  assert.equal(resolveBuildCacheDir("C:/repo/codex-pro-max"), path.join("C:/repo/codex-pro-max", "dist-electron"));
});

test("clean build cache refuses unexpected target paths without deleting", async () => {
  const expectedPath = path.join("C:/repo/codex-pro-max", "dist-electron");
  const rmCalls = [];

  await assert.rejects(
    () =>
      removeBuildCache(path.join("C:/repo/codex-pro-max", "build"), {
        expectedPath,
        fs: {
          async rm(...args) {
            rmCalls.push(args);
          }
        },
        log() {}
      }),
    /Refusing to remove unexpected path/
  );

  assert.deepEqual(rmCalls, []);
});

test("clean build cache removes the expected path with recursive force", async () => {
  const expectedPath = path.join("C:/repo/codex-pro-max", "dist-electron");
  const rmCalls = [];
  const logs = [];

  await removeBuildCache(expectedPath, {
    expectedPath,
    fs: {
      async rm(...args) {
        rmCalls.push(args);
      }
    },
    log(message) {
      logs.push(message);
    }
  });

  assert.deepEqual(rmCalls, [[path.resolve(expectedPath), { recursive: true, force: true }]]);
  assert.deepEqual(logs, [`[clean:build-cache] removed ${path.resolve(expectedPath)}`]);
});
