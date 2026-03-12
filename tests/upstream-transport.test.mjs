import assert from "node:assert/strict";
import test from "node:test";

import {
  extractUpstreamTransportError,
  fetchWithUpstreamRetry,
  isPreviousResponseIdUnsupportedError
} from "../src/upstream-transport.js";

test("fetchWithUpstreamRetry retries retryable transport failures and succeeds", async () => {
  let calls = 0;
  const retryEvents = [];
  const response = { ok: true, status: 200 };

  const result = await fetchWithUpstreamRetry("https://example.test/upstream", {}, {
    retryDelaysMs: [0, 0, 0],
    sleepImpl: async () => {},
    onRetry: async (event) => retryEvents.push(event),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("fetch failed");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return response;
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.response, response);
  assert.equal(result.retryCount, 2);
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].code, "ETIMEDOUT");
});

test("fetchWithUpstreamRetry stops after exhausting retry budget", async () => {
  let calls = 0;

  await assert.rejects(
    async () =>
      fetchWithUpstreamRetry("https://example.test/upstream", {}, {
        retryDelaysMs: [0, 0],
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls += 1;
          const err = new Error("socket hang up");
          err.code = "ECONNRESET";
          throw err;
        }
      }),
    (err) => {
      assert.equal(calls, 3);
      assert.equal(err.retryCount, 2);
      assert.equal(err.upstreamTransport.code, "ECONNRESET");
      assert.equal(err.upstreamTransport.retryable, true);
      return true;
    }
  );
});

test("fetchWithUpstreamRetry retries transient upstream HTTP responses and succeeds", async () => {
  let calls = 0;
  const retryEvents = [];

  const result = await fetchWithUpstreamRetry("https://example.test/upstream", {}, {
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    onRetry: async (event) => retryEvents.push(event),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          clone() {
            return { text: async () => '{"error":"upstream_unreachable"}' };
          },
          arrayBuffer: async () => Buffer.alloc(0)
        };
      }
      return { ok: true, status: 200 };
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.response.ok, true);
  assert.equal(result.retryCount, 2);
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].code, "HTTP_502");
});

test("fetchWithUpstreamRetry stops after exhausting retry budget on transient upstream HTTP responses", async () => {
  let calls = 0;

  await assert.rejects(
    async () =>
      fetchWithUpstreamRetry("https://example.test/upstream", {}, {
        retryDelaysMs: [0, 0],
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls += 1;
          return {
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            clone() {
              return { text: async () => "temporarily overloaded" };
            },
            arrayBuffer: async () => Buffer.alloc(0)
          };
        }
      }),
    (err) => {
      assert.equal(calls, 3);
      assert.equal(err.retryCount, 2);
      assert.equal(err.upstreamTransport.code, "HTTP_503");
      assert.equal(err.upstreamTransport.retryable, true);
      return true;
    }
  );
});

test("extractUpstreamTransportError keeps nested transport details", () => {
  const err = new Error("outer");
  err.cause = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });

  const details = extractUpstreamTransportError(err);

  assert.equal(details.code, "ETIMEDOUT");
  assert.equal(details.retryable, true);
  assert.match(details.detail, /ETIMEDOUT/);
});

test("isPreviousResponseIdUnsupportedError identifies replay compatibility failures", () => {
  assert.equal(
    isPreviousResponseIdUnsupportedError(400, '{"detail":"Unsupported parameter: previous_response_id"}'),
    true
  );
  assert.equal(isPreviousResponseIdUnsupportedError(400, '{"detail":"Unsupported parameter: something_else"}'), false);
  assert.equal(isPreviousResponseIdUnsupportedError(502, '{"detail":"Unsupported parameter: previous_response_id"}'), false);
});
