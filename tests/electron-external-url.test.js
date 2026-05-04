import assert from "node:assert/strict";
import test from "node:test";

import { isSafeExternalUrl, isTrustedBackendNavigationUrl } from "../electron/external-url.mjs";

test("Electron external URL policy only allows HTTPS by default", () => {
  assert.equal(isSafeExternalUrl("https://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("http://example.com/docs"), false);
  assert.equal(isSafeExternalUrl("file:///C:/Windows/System32/calc.exe"), false);
  assert.equal(isSafeExternalUrl("ms-msdt:/id PCWDiagnostic"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
});

test("Electron backend navigation policy requires exact backend origin", () => {
  assert.equal(isTrustedBackendNavigationUrl("http://127.0.0.1:8787/dashboard/", "http://127.0.0.1:8787"), true);
  assert.equal(isTrustedBackendNavigationUrl("http://127.0.0.1:8787.evil.test/dashboard/", "http://127.0.0.1:8787"), false);
  assert.equal(isTrustedBackendNavigationUrl("https://127.0.0.1:8787/dashboard/", "http://127.0.0.1:8787"), false);
});
