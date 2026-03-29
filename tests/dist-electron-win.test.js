import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { formatWindowsBuildStamp, resolveWindowsDistPaths } from "../scripts/dist-electron-win.mjs";

test("formatWindowsBuildStamp produces a filesystem-safe ISO-like stamp", () => {
  const stamp = formatWindowsBuildStamp(new Date("2026-03-29T04:30:45.123Z"));
  assert.equal(stamp, "2026-03-29T04-30-45Z");
});

test("resolveWindowsDistPaths stages unpacked builds under a timestamped win-builds directory", () => {
  const { outputRoot, stageRoot } = resolveWindowsDistPaths(
    "C:/repo/codex-pro-max",
    new Date("2026-03-29T04:30:45.123Z")
  );

  assert.equal(outputRoot, path.join("C:/repo/codex-pro-max", "dist-electron"));
  assert.equal(
    stageRoot,
    path.join("C:/repo/codex-pro-max", "dist-electron", "win-builds", "2026-03-29T04-30-45Z")
  );
});
