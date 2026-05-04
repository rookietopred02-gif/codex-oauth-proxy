import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readJsonBody, readRawBody } from "../src/http/request-body.js";

function createReadableRequest(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.method = "POST";
  req.headers = headers;
  return req;
}

test("readRawBody rejects requests above the configured byte limit while streaming", async () => {
  const req = createReadableRequest([Buffer.alloc(4), Buffer.alloc(4)]);

  await assert.rejects(() => readRawBody(req, { maxBytes: 6 }), {
    code: "request_body_too_large",
    statusCode: 413
  });
});

test("readJsonBody rejects oversized content-length before buffering", async () => {
  const req = createReadableRequest(["{}"], {
    "content-length": "128"
  });

  await assert.rejects(() => readJsonBody(req, { maxBytes: 16 }), {
    code: "request_body_too_large",
    statusCode: 413
  });
});
