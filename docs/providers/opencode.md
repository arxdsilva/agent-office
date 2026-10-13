# OpenCode

Status: **built, not yet verified against a real session (R1)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: 1.19.0
- Entry point: `opencode acp` (ACP over stdio). `opencode serve` (headless HTTP server, `--port`, `--hostname`) is used only to list past sessions and, opt-in, to observe a server you run.
- Integration kind: ACP

- `initialize` (protocol 1) advertises one auth method, `opencode-login` ("Run `opencode auth login` in the
  terminal"): a hint, so it is **never called** (`authMethodPrefer` is empty). A configured model is what
  lets `session/new` work. Capabilities seen: `loadSession`, `sessionCapabilities {close, fork, list, resume}`,
  `mcpCapabilities {http, sse}`.
- Help text matched by the probe: `opencode acp  start ACP (Agent Client Protocol) server`
  (`opencode acp --help`).
- Primary agents (`opencode agent list`): `build`, `plan` (the others are subagents). These are the modes.
- Default permissions allow edit, bash and webfetch without asking: no card would ever show.
- Session/new was **not** run (it would use the account), so models and the advertised mode ids are from the
  docs and `agent list`, not from a live answer.

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/opencode/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Modes** (default first): `build` Build · `plan` Plan (read-only). None is dangerous.
- **Safe permission defaults:** the profile starts `opencode acp` with
  `OPENCODE_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}`. Verified with
  `opencode agent list`: the three rules appear as `ask` over the user's config. Fail closed: the user's own
  config cannot widen it for managed sessions.
- **History / observe:** not this page's runtime; see "History and observation" below.
- **Decl note:** `PROVIDER_DECLS.opencode.integration.managed` is `'http'` while this runtime is ACP;
  the lead decides which runner binds the provider in composition (currently the ACP one).

## History and observation

Both go through OpenCode's own server API (`opencode serve`), never its database files. Verified
against the OpenAPI document opencode 1.19.0 serves at `GET /doc`, on 127.0.0.1, with listing only
(no session was created and no prompt was sent with the user's account).

**Endpoints used (all `GET`, read-only):**

| Endpoint | For |
| --- | --- |
| `/global/health` → `{healthy: true, version}` | ready poll of the short-lived server |
| `/experimental/session?roots=true&limit=N` | history: sessions across all projects, newest first (`/session` is limited to the server's own folder) |
| `/session/{sessionID}/message` | transcript pages: `[{info, parts}]` |
| `/global/event` (SSE, `data:` lines only, no `id:`) | observer: `{directory, payload: {type, properties}}` for every folder |

**Auth:** `OPENCODE_SERVER_PASSWORD` makes `opencode serve` require HTTP Basic, user `opencode`
(`OPENCODE_SERVER_USERNAME`); without it the server is open on 127.0.0.1. agent-office never reads or
forwards that variable.

- **History** (`OpenCodeHistorySource`, `providers/opencode/opencode-history.ts`): lists top-level,
  non-archived sessions → `PastSession` with the OpenCode session id, ref `tr_oc_<sessionId>`, the
  session directory as `cwd` (main only, for project matching), a title ≤ 80 chars and the created and
  updated times. It lists nothing until OpenCode is turned on in Connect. The server it reads is the
  one the user runs (observe setting; no credentials sent), else a short-lived
  `opencode serve --hostname 127.0.0.1 --port <free> --pure` started in `<userData>/opencode-history`
  through `spawnRuntime` (`shell:false`, `AGENT_OFFICE_MANAGED=1`) with a fresh random password per
  run, stopped after 30 s unused (SIGTERM, SIGKILL after 3 s).
- **Transcripts** (`OpenCodeTranscriptReader`, registered as `oc` in the `TranscriptReaders` router):
  read on demand; only text parts (not synthetic or ignored ones) and tool names, ≤ 4000 chars per
  message. Reasoning, files, tool input and output are never taken. Nothing is cached or copied. Refs
  carry the session id, so they still read after a restart.
- **Observer** (`OpenCodeObserver`, opt-in `settings.openCodeObserve {enabled, port}`, off by default):
  one `GET /global/event` on `127.0.0.1:<port>`, reconnecting with backoff (1 s doubling to 30 s).
  Events for `oc:<sessionId>`: status (`session.status` busy/retry → thinking, idle → waiting;
  `session.idle`, permission and question requests → waiting; `session.error` → error; deleted or
  archived → done; tool parts → `tool` with the shared name), model and model provider, parent session,
  and the project basename as name and topic. No text field at all: prompts, replies, titles, tool
  input and output, paths, URLs and env values are never emitted. Sessions agent-office manages are
  skipped. Connection state: `off`, `connecting`, `connected`, `unreachable`, `auth-required` (a
  password-protected server can't be observed, since agent-office never holds its password).
- **Tests:** `common/http/{sse,http-json,local-server}.test.ts`, `opencode-{history,transcripts,observer}.test.ts`
  (sentinel no-leak fixtures), `e2e.opencode.test.ts` against `test/fakes/fake-opencode-server.mjs`,
  and the composition test.

## Setup

- Install: `npm i -g opencode-ai`.
- Log in / configure a model: `opencode auth login`. agent-office never stores or forwards credentials.
- The probe needs `opencode acp` in the PATH of the app.

## Verification

Fake-agent contract suites, probe and E2E (including MCP retrieval) pass. A real session is **not yet verified**: run `make verify-providers ONLY=opencode` on a logged-in machine and record the version here.
