import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const dashboardHtmlPath = new URL("../public/index.html", import.meta.url);
const publicAccessFeaturePath = new URL("../public/dashboard/public-access.js", import.meta.url);
const packageJsonPath = new URL("../package.json", import.meta.url);

test("dashboard fallback picker only resolves cancel after focus returns with no files", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(html, /window\.addEventListener\("focus", handleWindowFocus, \{ once: true, capture: true \}\)/);
  assert.match(html, /if \(!settled && \(!input\.files \|\| input\.files\.length === 0\)\) \{/);
  assert.match(html, /\}, 200\);/);
});

test("token import no longer prompts for file vs directory source", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.doesNotMatch(html, /confirm\(t\("confirm_token_import_source"\)\)/);
  assert.match(html, /function canPickTokenImportFilesWithDesktopBridge\(\)/);
  assert.match(html, /await desktopBridge\.pickTokenImportFiles\(\)/);
});

test("dashboard copy buttons reuse clipboard fallback helper", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");
  const publicAccessFeature = await fs.readFile(publicAccessFeaturePath, "utf8");

  assert.match(html, /\$\("apiKeyCopyBtn"\)[\s\S]*await copyTextToClipboard\(value\)/);
  assert.match(html, /import \{ createPublicAccessFeature \} from "\.\/dashboard\/public-access\.js";/);
  assert.match(html, /\$\("publicAccessCopyBtn"\)[\s\S]*await publicAccessFeature\.copyCurrentUrl\(\)/);
  assert.match(publicAccessFeature, /async function copyCurrentUrl\(\)[\s\S]*await copyTextToClipboard\(url\)/);
  assert.doesNotMatch(html, /\$\("apiKeyCopyBtn"\)[\s\S]*navigator\.clipboard\.writeText/);
  assert.doesNotMatch(publicAccessFeature, /navigator\.clipboard\.writeText/);
});

test("dashboard auth boot renders state before slow secondary hydration", async () => {
  const html = await fs.readFile(dashboardHtmlPath, "utf8");

  assert.match(
    html,
    /loadProtectedData:\s*async \(\)\s*=> \{\s*await refreshState\(true\);\s*void hydrateDashboardSecondaryData\(\{ forceUsage: true \}\);\s*\}/
  );
  assert.match(
    html,
    /setInterval\(\(\) => \{\s*if \(document\.hidden\) return;\s*hydrateDashboardSecondaryData\(\{[\s\S]*refreshModels: false/
  );
  assert.doesNotMatch(
    html,
    /loadProtectedData:\s*async \(\)\s*=> \{\s*await loadModelCandidates\(\);\s*await refreshState\(true\);\s*\}/
  );
});

test("public access start reuses persisted auto-install setting", async () => {
  const { createPublicAccessFeature } = await import(publicAccessFeaturePath);
  const elements = new Map([
    ["publicAccessMode", { value: "quick" }],
    ["publicAccessHttp2", { checked: true }],
    ["publicAccessToken", { value: "" }],
    ["publicAccessStatus", { textContent: "", disabled: false }],
    ["publicAccessUrl", { textContent: "", disabled: false }],
    ["publicAccessInstallBtn", { disabled: false }],
    ["publicAccessStartBtn", { disabled: false }],
    ["publicAccessStopBtn", { disabled: false }],
    ["publicAccessLocalBinding", { textContent: "" }]
  ]);
  const requests = [];
  const feature = createPublicAccessFeature({
    $: (id) => {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
    api: async (path, options = undefined) => {
      requests.push({ path, options });
      if (path === "/admin/public-access/start") {
        return {
          status: {
            installed: true,
            running: true,
            installInProgress: false,
            url: "https://example.trycloudflare.com"
          }
        };
      }
      throw new Error(`Unexpected API call: ${path}`);
    },
    t: (key) => key,
    tt: (key) => key,
    syncCustomSelect: () => {},
    copyTextToClipboard: async () => {}
  });

  await feature.start();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/admin/public-access/start");
  const body = JSON.parse(String(requests[0].options?.body || "{}"));
  assert.deepEqual(body, { mode: "quick", useHttp2: true });
  assert.equal(Object.prototype.hasOwnProperty.call(body, "autoInstall"), false);
});

test("package.json no longer points verify:claude-agent-sdk at a missing file", async () => {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(Object.prototype.hasOwnProperty.call(pkg.scripts, "verify:claude-agent-sdk"), false);
});
