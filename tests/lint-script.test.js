import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInlineModuleTempPrefix,
  extractInlineModuleFiles,
  isLintEntrypoint,
  sourceRoots
} from "../scripts/lint.mjs";

test("extractInlineModuleFiles stages inline modules outside the source tree", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pro-max-lint-fixture-"));
  const htmlPath = path.join(fixtureRoot, "public", "index.html");
  let inlineFiles = [];

  try {
    await fs.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.writeFile(
      htmlPath,
      '<!doctype html><script type="module">const value = 1;\nconsole.log(value);</script>\n',
      "utf8"
    );

    inlineFiles = await extractInlineModuleFiles(htmlPath);

    assert.equal(inlineFiles.length, 1);
    assert.notEqual(path.dirname(inlineFiles[0]), path.dirname(htmlPath));
    assert.ok(
      path.resolve(path.dirname(inlineFiles[0])).toLowerCase().startsWith(
        path.resolve(buildInlineModuleTempPrefix()).toLowerCase()
      )
    );
  } finally {
    await Promise.all([...new Set(inlineFiles.map((filePath) => path.dirname(filePath)))].map((dirPath) =>
      fs.rm(dirPath, { recursive: true, force: true })
    ));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("isLintEntrypoint resolves relative argv paths against cwd", () => {
  assert.equal(isLintEntrypoint("scripts/lint.mjs"), true);
  assert.equal(isLintEntrypoint("scripts/check-format.mjs"), false);
});

test("lint source roots cover split public frontend modules", () => {
  assert.ok(sourceRoots.includes("public/app"));
  assert.ok(sourceRoots.includes("public/dashboard"));
});
