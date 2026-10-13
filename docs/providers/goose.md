# goose

Status: **built, not yet verified against a real session (R1)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: 1.54.0
- Entry point: `goose acp` (ACP over stdio). `goose serve` also exists (ACP over HTTP/WebSocket); not used.
- Integration kind: ACP

- `initialize` (protocol 1) advertises one auth method, `goose-provider` ("Run `goose configure` to set up
  your AI provider and API key"): a terminal setup step, **never called**. Capabilities seen: `loadSession`,
  `sessionCapabilities {list, delete, close}`, `mcpCapabilities {http: true, sse: false}`.
- Help text matched by the probe: `goose acp --help` -> "Run goose as an ACP agent server on stdio".
- goose's own default mode is `auto` (no approvals), so the profile starts sessions in `approve`.
- History: `goose session list --format json` returns an array of `{id, working_dir, name, created_at,
  updated_at, last_message_at, message_count, archived_at, …}` and `goose session export
  --session-id=<id> --format json` returns `conversation[]` messages `{id, role, created, content[]}` with
  content blocks `text`, `toolRequest`, `toolResponse`, `thinking`. Verified with an **invented** Claude-format
  `.jsonl` imported into a throwaway `GOOSE_PATH_ROOT` (the user's goose data was not touched).
- Session/new was run on 2026-10-13 but stopped at provider setup (see Verification), so the mode ids below
  still come from goose's documented permission modes and are applied only if the agent advertises them.

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/goose/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Modes** (default first): `approve` Ask before tools · `smart_approve` Ask only for risky tools
  (dangerous) · `auto` Auto-approve everything (dangerous) · `chat` Chat only (no tools).
- **History** (`providers goose`, `sources/goose/`): `GooseHistorySource` lists sessions from the JSON
  listing (archived ones skipped, ids checked against `^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$` so they can never
  read as a flag), refs are `tr_go_<id>`. `GooseTranscriptReader` reads one conversation on demand through
  `goose session export` and keeps text blocks and tool names only (tool-name extraction from `toolRequest`
  blocks is best effort: not seen in a real goose conversation yet). `working_dir` stays in main. Both run
  `goose` with fixed arguments, no shell, 15 s and 32 MB bounds, and list nothing until goose is enabled in
  Connect.

## Setup

- Install: `brew install block-goose-cli` (or the vendor script).
- Configure a provider and model: `goose configure`.
- The probe needs `goose acp` in the PATH of the app.

## Verification

Real run on 2026-10-13 with **goose 1.54.0**: **blocked on user setup**. No AI provider is configured on this
machine, so `session/new` answers `-32603 "Internal error"` with data `Failed to resolve provider: Configuration
value not found: GOOSE_PROVIDER`.

| detect | auth | start | stream | approve | reply | deny | interrupt | models | modes | stop |
| ------ | ---- | ----- | ------ | ------- | ----- | ---- | --------- | ------ | ----- | ---- |
| pass   | n/a  | setup | n/a    | n/a     | n/a   | n/a  | n/a       | n/a    | n/a   | pass |

- Fixed: this used to end as "goose could not be started". The profile's `setupError` now maps it to the auth
  exit: "goose has no AI provider set up. Run `goose configure` in a terminal, then start the session again."
- To finish verifying: run `goose configure`, then `make verify-providers ONLY=goose`.
- Fake-agent contract suites, probe and E2E (including MCP retrieval) pass.
