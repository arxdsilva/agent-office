# Privacy & security rule

The UI can inject text into live agent sessions. Treat the server like a remote control: **fail closed** on auth, **fail open** in the hook.

## Transcripts (Claude Code adapter)

| Do                                                                   | Don't                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Extract only status, tool name, title, model, and snippets ≤80 chars | Log raw transcript lines or message text                                 |
| Allow up to 4000 chars only for an agent's **reply to a UI message** | Persist transcripts or messages to disk (only the token file is written) |
| Skip unreadable files/lines silently (log the path once)             | Send transcript data anywhere except the local WebSocket                 |

## Network

| Do                                                                                            | Don't                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Bind `127.0.0.1` by default                                                                   | Bind `0.0.0.0` by default                                   |
| Enforce Host allowlist (421), Origin check on writes + WS (403), bearer token on writes (401) | Add an endpoint that writes without going through `auth.ts` |
| Validate every input with zod; keep body/array/text limits and the message rate limit         | Trust `agentId`s or text from clients                       |

## Renderer

Render API-provided text with `textContent` and elements built with `document.createElement` (see `web/src/adapters/dom/el.ts`). **Never use `innerHTML`**, never `eval`, and never import dynamically from data.

## Electron checklist (`desktop/src/main/security.ts`, unit-tested + `shell.spec.ts`)

| Do | Don't |
|---|---|
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false` | Relax any of these "temporarily" |
| CSP: `script-src 'self'`, `connect-src 'none'` in production (meta tag); the dev server origin only in dev (header) | Add `unsafe-eval` or remote origins |
| Deny `will-navigate` and every `window.open`; open only `https:` links externally | Load remote content in the app window |
| Allow only the `pointerLock` (walk mode) and `notifications` permissions | Grant camera, mic, geolocation, clipboard and so on |
| Validate every IPC payload with the shared zod schemas and check the sender URL (`isTrustedSender`) | Trust anything coming from the renderer |
| Expose a typed bridge (`window.agentOffice`) from a preload that imports only `electron` + `shared/ipc` | Expose `ipcRenderer`, `require` or Node APIs |
| Write the hook wrapper with mode 0755 into the app's own `userData` | Write executables anywhere else |

## Hook

- Must **fail open**: short timeout (≤1.5s), no output and exit 0 on any error — it must never break or slow a Claude session.
- Messages are handed to Claude as text only. Never execute or interpolate message content into a shell.
- The token is read from `~/.agent-office/token` (mode 0600) and never printed.
- The hook is installed only through an explicit user action (Settings, tray or `make install-hook`), always with a backup. Never install it from tests or code paths that run automatically. The one exception is `heal()`, which refreshes an **already installed** hook.
