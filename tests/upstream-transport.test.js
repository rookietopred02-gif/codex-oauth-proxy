import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithUpstreamRetry, isPreviousResponseIdUnsupportedError } from "../src/upstream-transport.js";

async function withTimeout(promise, message, ms = 200) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("isPreviousResponseIdUnsupportedError accepts only HTTP 400 status values", () => {
  const reason = "previous_response_id is an unsupported parameter";
  assert.equal(isPreviousResponseIdUnsupportedError(400, reason), true);
  assert.equal(isPreviousResponseIdUnsupportedError("400", reason), true);
  assert.equal(isPreviousResponseIdUnsupportedError("400.0", reason), false);
  assert.equal(isPreviousResponseIdUnsupportedError(400.1, reason), false);
  assert.equal(isPreviousResponseIdUnsupportedError(600, reason), false);
  assert.equal(
    isPreviousResponseIdUnsupportedError(Symbol("status"), reason),
    false
  );
});

test("fetchWithUpstreamRetry treats decimal-form status strings as non-retryable", async () => {
  let fetchCalls = 0;

  const result = await fetchWithUpstreamRetry(
    "https://example.test/v1/responses",
    { method: "POST" },
    {
      retryDelaysMs: [0],
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          status: "503.0",
          statusText: "Service Unavailable"
        };
      },
      sleepImpl: async () => {
        assert.fail("malformed status strings must not be retried");
      }
    }
  );

  assert.equal(fetchCalls, 1);
  assert.equal(result.response.status, "503.0");
  assert.equal(result.attempts, 1);
  assert.equal(result.retryCount, 0);
});

test("fetchWithUpstreamRetry ignores malformed retry timing options", async () => {
  let fetchCalls = 0;
  const slept = [];

  const result = await fetchWithUpstreamRetry(
    "https://example.test/v1/responses",
    { method: "POST" },
    {
      requestTimeoutMs: Symbol("timeout"),
      retryDelaysMs: [Symbol("delay"), "1.9", "0", "bad-delay", -1],
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response("try again", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "text/plain" }
          });
        }
        return new Response("ok", { status: 200 });
      },
      sleepImpl: async (ms) => {
        slept.push(ms);
      }
    }
  );

  assert.equal(fetchCalls, 2);
  assert.deepEqual(slept, [0]);
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 2);
  assert.equal(result.retryCount, 1);
});

test("fetchWithUpstreamRetry does not convert malformed retry delays into zero-delay retries", async () => {
  let fetchCalls = 0;

  await assert.rejects(
    fetchWithUpstreamRetry(
      "https://example.test/v1/responses",
      { method: "POST" },
      {
        retryDelaysMs: [Symbol("delay"), "1.9", -1],
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("try again", {
            status: 503,
            statusText: "Service Unavailable"
          });
        },
        sleepImpl: async () => {
          assert.fail("malformed retry delays must not schedule retries");
        }
      }
    ),
    /HTTP 503/
  );

  assert.equal(fetchCalls, 1);
});

test("fetchWithUpstreamRetry bounds stalled retry response previews", async () => {
  let fetchCalls = 0;
  let cloneCanceled = false;
  let originalCanceled = false;
  const retryEvents = [];
  const slept = [];

  const result = await withTimeout(
    fetchWithUpstreamRetry(
      "https://example.test/v1/responses",
      { method: "POST" },
      {
        requestTimeoutMs: 0,
        retryBodyPreviewTimeoutMs: 5,
        retryDelaysMs: [0],
        fetchImpl: async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return {
              status: 503,
              statusText: "Service Unavailable",
              clone() {
                return {
                  body: {
                    async cancel() {
                      cloneCanceled = true;
                    }
                  },
                  async text() {
                    return await new Promise(() => {});
                  }
                };
              },
              body: {
                async cancel() {
                  originalCanceled = true;
                }
              }
            };
          }
          return new Response("ok", { status: 200 });
        },
        sleepImpl: async (ms) => {
          slept.push(ms);
        },
        onRetry: async (event) => {
          retryEvents.push(event);
        }
      }
    ),
    "stalled retry response preview blocked retry"
  );

  assert.equal(fetchCalls, 2);
  assert.equal(cloneCanceled, true);
  assert.equal(originalCanceled, true);
  assert.deepEqual(slept, [0]);
  assert.equal(retryEvents[0]?.code, "HTTP_503");
  assert.equal(retryEvents[0]?.detail, "HTTP 503 Service Unavailable");
  assert.equal(result.response.status, 200);
  assert.equal(result.retryCount, 1);
  assert.equal(result.lastTransportError?.code, "HTTP_503");
});

test("fetchWithUpstreamRetry bounds stalled retry response body discards", async () => {
  let fetchCalls = 0;
  let arrayBufferCalled = false;
  const slept = [];

  const result = await withTimeout(
    fetchWithUpstreamRetry(
      "https://example.test/v1/responses",
      { method: "POST" },
      {
        retryBodyPreviewTimeoutMs: 5,
        retryDelaysMs: [0],
        fetchImpl: async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return {
              status: 503,
              statusText: "Service Unavailable",
              async arrayBuffer() {
                arrayBufferCalled = true;
                return await new Promise(() => {});
              }
            };
          }
          return new Response("ok", { status: 200 });
        },
        sleepImpl: async (ms) => {
          slept.push(ms);
        }
      }
    ),
    "stalled retry response body discard blocked retry"
  );

  assert.equal(fetchCalls, 2);
  assert.equal(arrayBufferCalled, true);
  assert.deepEqual(slept, [0]);
  assert.equal(result.response.status, 200);
  assert.equal(result.retryCount, 1);
});
