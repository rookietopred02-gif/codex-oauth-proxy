# OpenAI Responses v1 alignment audit

Reviewed on **April 11, 2026** against the internal source-of-truth spec at `.omx/specs/deep-interview-responses-v1-openai-alignment.md` and these official OpenAI docs:

- Responses API: create, retrieve, delete, cancel, input items list  
  https://platform.openai.com/docs/api-reference/responses/create  
  https://platform.openai.com/docs/api-reference/responses/retrieve  
  https://platform.openai.com/docs/api-reference/responses/delete  
  https://platform.openai.com/docs/api-reference/responses/cancel  
  https://platform.openai.com/docs/api-reference/responses/input-items
- Built-in tools guide (`responses` mode):  
  https://platform.openai.com/docs/guides/tools?api-mode=responses
- Text generation instruction guidance and conversation state guidance, rechecked on **May 4, 2026**:
  - https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following
  - https://developers.openai.com/api/docs/guides/conversation-state#passing-context-from-the-previous-response

## Current repo evidence

### Runtime surfaces already encoded in the repo
- `src/protocols/openai/responses-contract.js` now splits:
  - official methods: `create`, `retrieve`, `delete`, `list_input_items`, `cancel`
  - repo-local extension methods: `compact`, `input_tokens`
- `src/protocols/openai/request-normalization.js` currently:
  - forces `stream=true`
  - forces `store=false`
  - injects `include += reasoning.encrypted_content`
  - treats `instructions` as current-turn only during `previous_response_id` continuations
  - accepts local alias fields `messages` and `reasoning_effort`
  - drops `temperature` and `top_p` on the codex-backed Responses path
- `src/routes/proxy-handlers.js` replays locally stored Responses chains when Codex upstream cannot consume official `previous_response_id` directly. A local chain miss is rejected instead of being silently downgraded to a fresh turn.
- `src/protocols/openai/responses-compat.js` has explicit streaming/output-item preservation logic for:
  - `message`
  - `reasoning`
  - `function_call`
  - `web_search_call`
- `tests/responses-compat.test.js` already encodes the desired preservation behavior for newer official/tool-driven output subtypes such as:
  - `file_search_call`
  - `code_interpreter_call`
  - `image_generation_call`
  - `computer_call_output`
  - `mcp_list_tools`
  - `mcp_approval_request`
  - `mcp_call`
  - `custom_tool_call`
  - shell/local-shell call variants

## Gap audit

### 1) Method contract drift
Official docs expose the normal Responses REST surface around create/retrieve/delete/cancel plus response input-item listing. The repo now keeps `compact` and `input_tokens` separated as repo-local extensions instead of mixing them into the official contract fixture.

**Current status:** fixed at the contract/fixture layer; runtime support for the repo-local extensions remains intentional and documented.

### 2) Tool taxonomy drift
The official tools guide for Responses mode documents a broader built-in tool surface than plain function tools alone, including remote MCP, image generation, code interpreter, file search, web search, and computer use. The current normalization layer mostly passes through `tools`/`tool_choice`, but the audit should treat built-in-tool coverage as incomplete until each official tool type is verified end-to-end.

**Current status:** function tools are normalized explicitly, and official built-in tool families are now preserved intentionally and regression-tested as explicit passthrough shapes. They are still passthrough-oriented rather than deeply rewritten, which is the safer compatibility choice for now.

### 3) Output item subtype drift
The current SSE/result reconstruction code explicitly recognizes only a small subset of output item types. That creates a parity risk when upstream sends newer official Responses items and the terminal `response.completed` payload is empty or partial. The existing tests already capture the expected forward-compatible behavior; the runtime code still needs to match that expectation.

**Current status:** the runtime preserves arbitrary streamed output items and regression tests now cover representative built-in tool call item types as well as message/reasoning/function-call reconstruction.

### 4) Compatibility transforms that must stay documented
Some request transforms are deliberate repo compatibility choices rather than official parity:
- forced `stream=true`
- forced `store=false`
- automatic `reasoning.encrypted_content` include
- local replay of known `previous_response_id` chains for the Codex backend, without surfacing a user-visible compatibility warning on successful replay
- local aliases `messages` and `reasoning_effort`
- dropping `temperature` and `top_p` for codex-backed Responses

The proxy must not carry instructions from older turns into a continuation. Official guidance says `instructions` applies only to the current response generation request, so local replay preserves explicit current-turn developer/system instructions but does not reintroduce earlier request-level instructions.

These are reasonable only if they remain explicitly documented as compatibility divergences instead of being presented as native OpenAI Responses behavior.

## Recommended implementation/test checklist

- Separate official Responses methods from repo-local extensions in fixtures and docs.
- Verify built-in tool passthrough/normalization for every official Responses tool family that the proxy intends to support.
- Preserve newer official output item subtypes during SSE reconstruction even when `response.completed.output` is empty.
- Keep alias/forced-value transforms covered by tests and clearly labeled as compatibility behavior.

## Notes for integration

This file is intentionally written as an audit artifact for the current branch state. If implementation changes land, update this note together with the final runtime/test evidence so the documentation reflects the merged behavior rather than today's pre-merge snapshot.
