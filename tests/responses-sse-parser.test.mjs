import assert from "node:assert/strict";
import test from "node:test";

process.env.CODEX_PRO_MAX_DISABLE_AUTOSTART = "1";

const { __testing } = await import("../src/server.js");

test("parseResponsesResultFromSse reconstructs a completed response from incremental SSE events", () => {
  const raw = [
    'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}',
    'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"Read","arguments":""}}',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"file_path\\":\\"README.md\\"}"}'
  ].join("\n");

  const parsed = __testing.parseResponsesResultFromSse(raw);
  assert.equal(parsed.failed, null);
  assert.ok(parsed.completed);
  assert.equal(parsed.completed.status, "completed");
  assert.equal(parsed.completed.output[0].type, "message");
  assert.deepEqual(parsed.completed.output[0].content, [{ type: "output_text", text: "hello" }]);
  assert.equal(parsed.completed.output[1].type, "function_call");
  assert.equal(parsed.completed.output[1].call_id, "call_1");
  assert.equal(parsed.completed.output[1].arguments, '{"file_path":"README.md"}');
});

test("parseResponsesResultFromSse preserves response.failed details", () => {
  const raw =
    'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"worker crashed"},"status_code":503}}\n';

  const parsed = __testing.parseResponsesResultFromSse(raw);
  assert.equal(parsed.completed, null);
  assert.deepEqual(parsed.failed, {
    message: "worker crashed",
    statusCode: 503
  });
});

test("parseResponsesResultFromSse reconstructs reasoning summaries from incremental SSE events", () => {
  const raw = [
    'data: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","summary":[]}}',
    'data: {"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0,"part":{"type":"summary_text","text":""}}',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Compare"}',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":" both paths."}',
    'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Pick the faster one."}'
  ].join("\n");

  const parsed = __testing.parseResponsesResultFromSse(raw);
  assert.equal(parsed.failed, null);
  assert.ok(parsed.completed);
  assert.equal(parsed.completed.output[0].type, "reasoning");
  assert.deepEqual(parsed.completed.output[0].summary, [
    {
      type: "summary_text",
      text: "Compare both paths."
    }
  ]);
  assert.equal(parsed.completed.output[1].type, "message");
  assert.deepEqual(parsed.completed.output[1].content, [{ type: "output_text", text: "Pick the faster one." }]);
});
