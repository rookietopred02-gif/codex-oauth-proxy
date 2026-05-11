import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  getRequestBodyErrorStatus,
  isRequestBodyError,
  isRequestBodyTooLargeError,
  readJsonBody,
  readRawBody
} from "../src/http/request-body.js";

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

test("readJsonBody tags invalid JSON as a client request error", async () => {
  const req = createReadableRequest(["{\"not\":"]);

  await assert.rejects(() => readJsonBody(req), {
    code: "invalid_json",
    statusCode: 400,
    message: "Body must be valid JSON."
  });
});

test("request body error helpers classify parser and size failures", () => {
  const invalidJson = Object.assign(new Error("Body must be valid JSON."), {
    code: "invalid_json",
    statusCode: 400
  });
  const oversized = Object.assign(new Error("Request body exceeds the 16 byte limit."), {
    code: "request_body_too_large",
    statusCode: 413
  });
  const upstreamFailure = Object.assign(new Error("upstream failed"), {
    code: "ECONNRESET",
    statusCode: 502
  });

  assert.equal(isRequestBodyError(invalidJson), true);
  assert.equal(isRequestBodyError(oversized), true);
  assert.equal(isRequestBodyError(upstreamFailure), false);
  assert.equal(isRequestBodyTooLargeError(invalidJson), false);
  assert.equal(isRequestBodyTooLargeError(oversized), true);
  assert.equal(getRequestBodyErrorStatus(invalidJson), 400);
  assert.equal(getRequestBodyErrorStatus(oversized), 413);
  assert.equal(getRequestBodyErrorStatus({ statusCode: 700 }, 413), 413);
  assert.equal(getRequestBodyErrorStatus({ statusCode: "401.9" }, 413), 413);
  assert.equal(getRequestBodyErrorStatus({ statusCode: "413.0" }, 400), 400);
});

test("request body numeric bounds tolerate malformed numeric values", async () => {
  const req = createReadableRequest(["{}"], {
    "content-length": Symbol("content-length")
  });

  const parsed = await readJsonBody(req, { maxBytes: Symbol("max-bytes") });

  assert.deepEqual(parsed, {});
  assert.equal(getRequestBodyErrorStatus({ statusCode: Symbol("status") }, 413), 413);
});

test("request body numeric bounds reject decimal-form byte metadata", async () => {
  const decimalMetadataReq = createReadableRequest(["{}"], {
    "content-length": "128.0"
  });

  assert.deepEqual(await readJsonBody(decimalMetadataReq, { maxBytes: "1.0" }), {});

  const oversizedReq = createReadableRequest([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(1)], {
    "content-length": "16.5"
  });

  await assert.rejects(() => readRawBody(oversizedReq, { maxBytes: 16 }), {
    code: "request_body_too_large",
    statusCode: 413
  });
});
