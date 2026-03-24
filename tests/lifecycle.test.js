import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { startConfiguredServer } from "../src/bootstrap/lifecycle.js";

test("startConfiguredServer keeps request-side HTTP timeouts enabled", async () => {
  const app = createServer((req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });

  const config = {
    host: "127.0.0.1",
    port: 0,
    authMode: "codex-oauth",
    upstreamMode: "codex-chatgpt"
  };

  const lifecycle = startConfiguredServer({
    app,
    config,
    shouldAutostart: false,
    installSignalHandlers: false,
    getActiveUpstreamBaseUrl: () => "https://example.test"
  });

  try {
    await lifecycle.start();

    assert.notEqual(lifecycle.mainServer.requestTimeout, 0);
    assert.notEqual(lifecycle.mainServer.headersTimeout, 0);
    assert.notEqual(lifecycle.mainServer.keepAliveTimeout, 0);
  } finally {
    await lifecycle.stop("TEST");
  }
});
