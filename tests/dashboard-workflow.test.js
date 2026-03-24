import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const dashboardHtmlPath = new URL("../public/index.html", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

test("dashboard fallback picker only resolves cancel after focus returns with no files", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /window\.addEventListener\("focus", handleWindowFocus, \{ once: true, capture: true \}\)/);
  assert.match(html, /if \(!settled && \(!input\.files \|\| input\.files\.length === 0\)\) \{/);
  assert.match(html, /\}, 200\);/);
});

test("dashboard copy buttons reuse clipboard fallback helper", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /\$\("apiKeyCopyBtn"\)[\s\S]*await copyTextToClipboard\(value\)/);
  assert.match(html, /\$\("publicAccessCopyBtn"\)[\s\S]*await copyTextToClipboard\(url\)/);
  assert.doesNotMatch(html, /\$\("apiKeyCopyBtn"\)[\s\S]*navigator\.clipboard\.writeText/);
  assert.doesNotMatch(html, /\$\("publicAccessCopyBtn"\)[\s\S]*navigator\.clipboard\.writeText/);
});

test("package.json no longer points verify:claude-agent-sdk at a missing file", async () => {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts, "verify:claude-agent-sdk"), false);
});
