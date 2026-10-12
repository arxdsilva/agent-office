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

## Web

Render API-provided text with `textContent` / `CSS2DObject` elements built via `document.createElement`. **Never `innerHTML`**, no `eval`, no dynamic import from data.

## Hook

- Must **fail open**: short timeout (≤1.5s), no output and exit 0 on any error — it must never break or slow a Claude session.
- Messages are handed to Claude as text only. Never execute or interpolate message content into a shell.
- The token is read from `~/.agent-office/token` (mode 0600) and never printed.
