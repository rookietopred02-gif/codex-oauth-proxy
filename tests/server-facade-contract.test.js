import assert from "node:assert/strict";
import test from "node:test";

test("server.js keeps the public facade contract available for dynamic import consumers", async () => {
  process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";

  const serverModule = await import(`../src/server.js?facade-contract=${Date.now()}`);

  assert.equal(typeof serverModule.startServer, "function");
  assert.equal(typeof serverModule.stopServer, "function");
  assert.equal("app" in serverModule, true);
  assert.equal("mainServer" in serverModule, true);

  assert.equal(typeof serverModule.__testing, "object");
  assert.equal(typeof serverModule.__testing.ensureCodexOAuthCallbackServer, "function");
  assert.equal(typeof serverModule.__testing.getCodexOAuthCallbackServer, "function");
  assert.equal(typeof serverModule.__testing.getCloudflaredRuntime, "function");
  assert.equal(typeof serverModule.__testing.stopCloudflaredTunnel, "function");
  assert.equal(typeof serverModule.__testing.buildCodexResponsesRequestBody, "function");
});
