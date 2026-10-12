# Privacy & security rule

The UI can inject text into live agent sessions. Treat the server like a remote control: **fail closed** on auth, **fail open** in the hook.

## Transcripts (Claude Code adapter)

| Do                                                                   | Don't                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Extract only status, tool name, title, model, and snippets ≤80 chars | Log raw transcript lines or message text                                 |
| Allow up to 4000 chars only for an agent's **reply to a UI message** | Persist transcripts or messages to disk (only the token file is written) |
| Skip unreadable files/lines silently (log the path once)             | Send transcript data anywhere except the local WebSocket                 |

## Capabilities (adapters, skills, rules; `docs/capabilities.md`)

| Do                                                                                                                                                                                                                               | Don't                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Keep capability data to names, tool names, hostnames, project basenames, command head words, skill names, rule file names and memory titles                                                                                      | Emit or store URLs, paths, query strings, arguments, command lines, file contents or env values             |
| Emit `AgentEvent.target` only in the §3 grammar (`project:`, `host:`, `cmd:`, `skill:`, `rule:<scope>:`, `memory:`); match paths inside the source adapter                                                                       | Send a full path or URL and let the core "clean it up" (the core drops anything outside the grammar anyway) |
| Read only the **keys** of `mcpServers` in `~/.claude.json` (top level and `projects[<cwd>]` of active sessions)                                                                                                                  | Read or log server commands, args, URLs, env, or any other part of `~/.claude.json`                         |
| Read skills, rules and memory only from the §4 locations (synced skills at exactly `~/.claude/skills/synced/*/*/SKILL.md`): ≤ 4 KB per file, skip files over 256 KB, never follow symlinks, cap 48 skills / 24 rules / 24 memory | Scan other directories, follow links, or parse whole files                                                  |
| Give memory entries their frontmatter `name` only                                                                                                                                                                                | Give memory a summary or read its body: it may hold personal facts                                          |
| Gate discovery on `claudeAdapter` **and** `discoverCapabilities`; log failures without paths                                                                                                                                     | Log paths, file names or error text from discovery                                                          |
| Prove it with fixtures holding secret-looking URLs, paths and commands (`line-mapper.targets.test.ts`, `claude-config-reader.test.ts`, `claude-knowledge-reader.test.ts`)                                                        | Ship a new target form or discovery source without a no-leak test                                           |

## Network

| Do                                                                                            | Don't                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Bind `127.0.0.1` by default                                                                   | Bind `0.0.0.0` by default                                   |
| Enforce Host allowlist (421), Origin check on writes + WS (403), bearer token on writes (401) | Add an endpoint that writes without going through `auth.ts` |
| Validate every input with zod; keep body/array/text limits and the message rate limit         | Trust `agentId`s or text from clients                       |

## Renderer

Render API-provided text with `textContent` and elements built with `document.createElement` (see `web/src/adapters/dom/el.ts`). **Never use `innerHTML`**, never `eval`, and never import dynamically from data.

## Connect panel (`ConnectionInfo`, snippets, clipboard)

| Do                                                                                                                                                                                                  | Don't                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Send only the two data locations (`~`-abbreviated under home; a user-set `AGENT_OFFICE_HOME`/`CLAUDE_PROJECTS_DIR` elsewhere stays whole so snippets work), counts and statuses in `ConnectionInfo` | Send the token, project names, transcript file names or any other path over IPC |
| Make snippets read the token at run time (`$(cat ~/.agent-office/token)`); prove it with a sentinel token in tests                                                                                  | Paste or display the token anywhere in the UI                                   |
| Write the clipboard in main via `app.copyText` (zod, ≤ 4000 chars, trusted sender only)                                                                                                             | Grant the renderer clipboard permission                                         |
| Validate the hook wrapper URL (`127.0.0.1`/`localhost`/`[::1]` + port) before writing it into a script                                                                                              | Interpolate any other value into the wrapper                                    |
| Send the test agent as a fixed payload through the real authenticated route                                                                                                                         | Let renderer input reach the test event                                         |

## Managed sessions and context (`ManagedSessions`, `context.pick`)

| Do                                                                                                                         | Don't                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Keep absolute context paths in main only, behind opaque `ctx_` refs; the renderer gets the basename and a `~` hint         | Put absolute paths in IPC payloads to the renderer, logs or anything persisted |
| Accept context only from the native picker (`ctx:pick`)                                                                    | Accept typed or pasted paths from the renderer                                 |
| Send the agent the absolute paths and tool hints (the user's explicit choice, to their own agent)                          | Read file contents in agent-office to "help"; the agent reads them itself      |
| Show permission requests as `summarizeToolRequest` summaries (≤ 120 chars)                                                 | Send raw tool input to the renderer or log it                                  |
| Offer Bypass only when `allowBypassPermissions` is on (confirm to enable), per session                                     | Default to Bypass or remember it per folder                                    |
| Run managed sessions with the user's own Claude Code login, settings and installed CLI; mark them `AGENT_OFFICE_MANAGED=1` | Store credentials, or let the hook claim or reply inside managed sessions      |
| Let only the session service set `Agent.managed` (the HTTP schema has no such field)                                       | Let HTTP producers mark agents as managed                                      |
| Rate-limit session calls (10/s per agent) and cap sessions at 6                                                            | Allow unbounded process spawning                                               |

## Electron checklist (`desktop/src/main/security.ts`, unit-tested + `shell.spec.ts`)

| Do                                                                                                                                                                                              | Don't                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`                                                                                   | Relax any of these "temporarily"                              |
| Serve production from `app://renderer` (`renderer-protocol.ts`: GET/HEAD only, contained in `out/renderer`, traversal → 403)                                                                    | Load the app from `file://` or add a write path to the scheme |
| CSP: `'self'` only (`script-src 'self' 'wasm-unsafe-eval'`, `connect-src`/`img-src`/`worker-src` add `blob:` (in-memory textures only)) as meta tag + header; the dev server origin only in dev | Add `unsafe-eval` (JS eval) or any remote origin              |
| Deny `will-navigate` and every `window.open`; open only `https:` links externally                                                                                                               | Load remote content in the app window                         |
| Allow only the `pointerLock` (walk mode) and `notifications` permissions                                                                                                                        | Grant camera, mic, geolocation, clipboard and so on           |
| Validate every IPC payload with the shared zod schemas and check the sender URL (`isTrustedSender`)                                                                                             | Trust anything coming from the renderer                       |
| Expose a typed bridge (`window.agentOffice`) from a preload that imports only `electron` + `shared/ipc`                                                                                         | Expose `ipcRenderer`, `require` or Node APIs                  |
| Write the hook wrapper with mode 0755 into the app's own `userData`                                                                                                                             | Write executables anywhere else                               |

## Hook

- Must **fail open**: short timeout (≤1.5s), no output and exit 0 on any error — it must never break or slow a Claude session.
- Messages are handed to Claude as text only. Never execute or interpolate message content into a shell.
- The token is read from `~/.agent-office/token` (mode 0600) and never printed.
- The hook is installed only through an explicit user action (Settings, tray or `make install-hook`), always with a backup. Never install it from tests or code paths that run automatically. The one exception is `heal()`, which refreshes an **already installed** hook.
