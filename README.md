# codex-oauth-proxy

Localhost OpenAI-compatible proxy for Codex/ChatGPT OAuth, with a built-in control dashboard.

This now defaults to `AUTH_MODE=codex-oauth`, so you can authenticate directly from this project.

The dashboard style and control surface are inspired by the operational flow in [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager): auth control, runtime config, health checks, and request monitoring in one UI.

## 1. Install

```bash
cd codex-oauth-proxy
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Default setup:

```env
AUTH_MODE=codex-oauth
# Dashboard label: openai-v1 (internally codex-chatgpt)
UPSTREAM_MODE=codex-chatgpt
UPSTREAM_BASE_URL=https://chatgpt.com/backend-api
CODEX_DEFAULT_MODEL=gpt-5.4
CODEX_DEFAULT_REASONING_EFFORT=adaptive
CODEX_PREHEAT_BATCH_SIZE=2
```

Protocol quick switch examples:

```env
# Gemini
UPSTREAM_MODE=gemini-v1beta
# Optional:
# - empty => local Gemini-compatible facade (no real Gemini key needed)
# - set key => pass-through to official Gemini upstream
GEMINI_API_KEY=

# Anthropic
UPSTREAM_MODE=anthropic-v1
# Optional:
# - empty => local Anthropic-compatible facade (no real Anthropic key needed)
# - set key => pass-through to official Anthropic upstream
ANTHROPIC_API_KEY=
```

## 3. Start

```bash
npm start
```

## 4. Open Dashboard

```text
http://127.0.0.1:8787/dashboard/
```

Use the dashboard to:

- trigger OAuth login/logout
- edit runtime proxy settings
- edit Model Router mappings (`exact` + `*` wildcard)
- tune default reasoning effort (`adaptive|none|low|medium|high|xhigh`)
- manually run account preheat from dashboard (`Run Preheat Now`)
- run upstream self-tests (works for `codex-chatgpt`, `gemini-v1beta`, and `anthropic-v1`)
- inspect recent proxy requests and latencies

## 5. API Usage

Base URL:

```text
http://127.0.0.1:8787/v1
```

API key:

- if no proxy API keys are configured, requests can be sent without a proxy API key
- once you generate dashboard API keys or set `LOCAL_API_KEY` / `PROXY_API_KEY`, callers must send one of those keys
- in `gemini-v1beta` / `anthropic-v1`, API key can be left empty to use local protocol facade powered by Codex OAuth
- with Model Router enabled, model IDs can be remapped across protocols (for example `gpt-5.4 -> gemini-2.5-pro`)

Supported endpoints:

- `UPSTREAM_MODE=codex-chatgpt` (UI label `openai-v1`): `/v1/models`, `/v1/responses`, `/v1/chat/completions`
- `UPSTREAM_MODE=gemini-v1beta`: `/v1/chat/completions`, native Gemini `/v1beta/*`
- `UPSTREAM_MODE=anthropic-v1`: `/v1/chat/completions`, native Anthropic `/v1/messages`

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.4",
    "messages":[{"role":"user","content":"say hello"}],
    "stream": true
  }'
```

Model Router examples:

```json
{
  "gpt-5.4": "gemini-2.5-pro",
  "gpt-4*": "gemini-2.5-flash",
  "claude-*": "claude-sonnet-4-6"
}
```

Priority:

- exact mapping (`gpt-5.4`) wins first
- wildcard mapping (`gpt-4*`) wins second
- system fallback mapping wins last

## 6. Compatibility Notes

- tool calling is supported (request/stream/non-stream/follow-up tool outputs)
- vision input is supported:
  - Chat Completions `image_url` gets mapped to responses `input_image`
- SSE stream is translated into OpenAI chat chunk format (`chat.completion.chunk`)
- Recent Proxy Requests token columns auto-format to `k` units above 1000 (e.g. `1.2k`)
- Gemini native:
  - no key: handled by local Gemini-compatible facade (`/v1beta/models`, `:generateContent`, `:streamGenerateContent`)
  - with key: pass-through to official Gemini upstream (`x-goog-api-key`, `?key=`, or bearer)
- Anthropic native:
  - no key: handled by local Anthropic-compatible facade (`/v1/messages`, supports stream)
  - with key: pass-through to official Anthropic upstream (`x-api-key` or bearer, auto-adds `anthropic-version`)

## 7. Auth Modes

- `codex-oauth`:
  - built-in ChatGPT OAuth (default)
  - callback listener: `http://localhost:1455/auth/callback`
  - token store at `CODEX_TOKEN_STORE_PATH`
- `profile-store`:
  - reuses a local/shared `auth-profiles.json` source
- `custom-oauth`:
  - bring-your-own OAuth provider config
