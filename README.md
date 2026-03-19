# codex-pro-max

Local OpenAI-compatible proxy for Codex/ChatGPT OAuth with a built-in dashboard, multi-account pool management, temp-mail assisted account registration, public access tunneling, request audit, and an Electron desktop shell.

This project now defaults to `AUTH_MODE=codex-oauth`, so the built-in dashboard can drive ChatGPT/Codex OAuth directly without an external auth bootstrap.

The dashboard and ops workflow take inspiration from:

- [lbjlaq/Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)
- [Ethan-W20/openai-auto-register](https://github.com/Ethan-W20/openai-auto-register)

## Features

- OpenAI-compatible proxy endpoints for `Codex/ChatGPT`, `Gemini`, and `Anthropic`
- Built-in dashboard for auth, config, runtime health, pool operations, and request inspection
- Multi-account Codex OAuth pool with usage probes and account switching
- `Account Auto RM` background cleanup for invalidated or probe-failed accounts
- Request audit with recent request history and detail modal
- Temp Mail workflow with bundled runner support in desktop builds
- Desktop Electron app with embedded backend and per-user writable data paths
- Bundled `cloudflared` and Temp Mail runner binaries for packaged desktop builds
- Windows NSIS installer with standard uninstall support

## Requirements

Runtime:

- Node.js 20+
- npm

Build:

- Go toolchain for Temp Mail runner builds
- Windows host for `.exe` installer output
- macOS host for `.dmg`
- Linux host or compatible AppImage toolchain for final Linux package output

## Quick Start

Install dependencies:

```bash
cd codex-pro-max
npm install
```

Create local config:

```bash
cp .env.example .env
```

Start the proxy server:

```bash
npm start
```

Open the dashboard:

```text
http://127.0.0.1:8787/dashboard/
```

## Default Configuration

Minimal default setup:

```env
AUTH_MODE=codex-oauth
UPSTREAM_MODE=codex-chatgpt
UPSTREAM_BASE_URL=https://chatgpt.com/backend-api
CODEX_DEFAULT_MODEL=gpt-5.4
CODEX_DEFAULT_SERVICE_TIER=default
CODEX_DEFAULT_REASONING_EFFORT=adaptive
CODEX_MULTI_ACCOUNT_ENABLED=true
CODEX_MULTI_ACCOUNT_STRATEGY=smart
CODEX_AUTO_LOGOUT_EXPIRED_ACCOUNTS=false
```

Provider quick switch examples:

```env
# Gemini
UPSTREAM_MODE=gemini-v1beta
GEMINI_API_KEY=
GEMINI_DEFAULT_MODEL=gemini-2.5-pro

# Anthropic
UPSTREAM_MODE=anthropic-v1
ANTHROPIC_API_KEY=
ANTHROPIC_DEFAULT_MODEL=claude-sonnet-4-20250514
```

See [.env.example](C:\Users\fi\source\codex-pro-max\.env.example) for the current env surface.

## Dashboard Capabilities

The dashboard can:

- start OAuth login/logout and manage the active account
- import/export account tokens in bulk
- refresh usage and inspect the account pool
- autosave `Proxy Config` into `.env`
- edit Model Router mappings
- change default `service_tier` and `reasoning effort`
- run upstream self-test
- run `Preheat` manually for the selected model or all supported Codex models
- inspect recent proxy requests and clear request history
- run or stop Temp Mail
- configure and start public access through `cloudflared`

## Temp Mail

Temp Mail is available from the dashboard and from packaged desktop builds.

Behavior notes:

- Temp Mail requires `AUTH_MODE=codex-oauth`
- a password is required before starting a run
- if the password field is empty, the dashboard now writes a localized warning directly into the Temp Mail output instead of only showing a generic start failure
- bundled desktop builds prefer the packaged Temp Mail runner; development mode can fall back to `go run`

Relevant implementation:

- [src/temp-mail-controller.js](C:\Users\fi\source\codex-pro-max\src\temp-mail-controller.js)
- [public/index.html](C:\Users\fi\source\codex-pro-max\public\index.html)
- [tools/temp-mail-runner/main.go](C:\Users\fi\source\codex-pro-max\tools\temp-mail-runner\main.go)

## Desktop App

Run the Electron shell in development:

```bash
npm run desktop:dev
```

The desktop shell:

- starts the embedded backend automatically
- opens the dashboard inside Electron
- writes runtime state into Electron `userData`
- keeps writable data out of the install directory

Desktop-mode persistence:

- proxy config autosave -> `userData/.env`
- token stores / API keys / request history / preheat history -> `userData/data/`
- cloudflared runtime downloads -> `userData/bin/`
- bundled `cloudflared` -> app `extraResources/cloudflared/`
- bundled Temp Mail runner -> app `extraResources/temp-mail-runner/`

Relevant files:

- [electron/main.mjs](C:\Users\fi\source\codex-pro-max\electron\main.mjs)
- [electron/preload.mjs](C:\Users\fi\source\codex-pro-max\electron\preload.mjs)
- [src/app-server.js](C:\Users\fi\source\codex-pro-max\src\app-server.js)
- [src/server.js](C:\Users\fi\source\codex-pro-max\src\server.js)

## Packaging

Build packaged desktop resources first:

```bash
npm run build:desktop-resources
```

This builds:

- Temp Mail runner binaries for `win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`
- bundled `cloudflared` binaries for `win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`

Platform packaging commands:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Artifacts are written to `dist-electron/`.

### Windows

- packaging target: NSIS
- installer output: `dist-electron/codex-pro-max Setup <version>.exe`
- standard uninstall entry is included
- uninstall keeps Electron `userData` by default

### Linux

- current packaging target: `AppImage`
- if `electron-builder` cannot finish `AppImage` on the current host, `dist-electron/linux-unpacked/` is still useful for validation
- this project was validated on Kali using the unpacked Linux build plus bundled `cloudflared` and Temp Mail runner

If you copy `linux-unpacked` from Windows to Linux via `scp` or similar, executable bits may be lost. Reapply them before running:

```bash
chmod +x dist-electron/linux-unpacked/codex-pro-max
chmod +x dist-electron/linux-unpacked/chrome-sandbox
chmod +x dist-electron/linux-unpacked/chrome_crashpad_handler
chmod +x dist-electron/linux-unpacked/resources/cloudflared/linux-x64/cloudflared
chmod +x dist-electron/linux-unpacked/resources/temp-mail-runner/linux-x64/temp-mail-runner
```

### macOS

- `.dmg` output must be built on macOS
- the packaged resources already include both `darwin-x64` and `darwin-arm64` binaries for `cloudflared` and Temp Mail runner

## API Usage

Base URL:

```text
http://127.0.0.1:8787/v1
```

Supported proxy endpoints:

- `codex-chatgpt`: `/v1/models`, `/v1/responses`, `/v1/chat/completions`
- `gemini-v1beta`: `/v1/chat/completions`, native Gemini `/v1beta/*`
- `anthropic-v1`: `/v1/chat/completions`, native Anthropic `/v1/messages`

API key behavior:

- if no proxy API keys are configured, calls can be sent without a proxy API key
- after generating dashboard API keys, callers must send one of those keys
- Gemini/Anthropic can run in local facade mode with empty upstream provider keys

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

## Model Router

Model Router supports exact and wildcard mappings:

```json
{
  "gpt-5.4": "gemini-2.5-pro",
  "gpt-4*": "gemini-2.5-flash",
  "claude-*": "claude-sonnet-4-6"
}
```

Priority:

- exact mapping first
- wildcard mapping second
- system fallback last

## Auth Modes

- `codex-oauth`
  - built-in ChatGPT OAuth
  - default mode
  - callback listener: `http://localhost:1455/auth/callback`
- `profile-store`
  - reuses an existing `auth-profiles.json`
- `custom-oauth`
  - bring your own OAuth provider

## Compatibility Notes

- tool calling is supported
- multi-account follow-up requests are pinned by `previous_response_id`
- vision inputs are translated to the correct provider-compatible payloads
- SSE responses are normalized into OpenAI-compatible stream shapes where needed
- recent requests are stored in memory immediately and persisted in debounced batches
- `Proxy Config` autosave persists into `.env`, including reasoning effort and service tier

## Development and Validation

Run tests:

```bash
npm test
```

Current validation focus includes:

- request body caching
- proxy audit serialization
- debounced recent-request persistence
- multi-account token import concurrency
- account auto-remove behavior
- Temp Mail bundled-runner detection
- desktop lifecycle boot/shutdown

## Release Workflow

Typical release sequence:

```bash
npm test
npm run dist:win
git add .
git commit -m "..."
git push origin master
gh release create <tag> <artifact...>
```

If Linux/macOS release artifacts are needed, build them on matching hosts before publishing the release.
