# Kilo Code

Status: **built, not yet verified against a real session (R1)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: 7.8.8 (`kilo` / `kilocode`)
- Entry point: `kilo acp` (ACP over stdio). Kilo keeps its own runtime identity even though its CLI is OpenCode-based.
- Integration kind: ACP

- `initialize` (protocol 1) advertises one auth method, `kilo-login` ("Run `kilo auth login` in the
  terminal"): a hint, **never called**. Capabilities seen match OpenCode's (`loadSession`, `close/fork/list/resume`,
  `mcpCapabilities {http, sse}`).
- Help text matched by the probe: `kilo acp --help` -> "start ACP (Agent Client Protocol) server".
- Primary agents (`kilo agent list`): `ask`, `code`, `debug`, `orchestrator`, `plan`. Modes are those.
- Default permissions: `bash` asks except for a read-only allow list; **edit and webfetch are allowed without
  asking**.
- Session/new was run on 2026-10-13 (see Verification): models and modes both come as `configOptions`.

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/kilo/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Modes** (default first): `code` · `ask` Ask (read-only) · `plan` Plan (read-only) · `debug` ·
  `orchestrator`. None is dangerous.
- **Safe permission defaults:** the profile starts `kilo acp` with
  `KILO_CONFIG_CONTENT={"permission":{"edit":"ask","webfetch":"ask"}}` (verified with `kilo agent list`).
  Shell commands already ask by default.
- **Login hint:** the profile says `kilo auth login` (what the CLI itself advertises and what the Connect
  text says). `PROVIDER_DECLS.kilo.loginHint` still reads `kilocode auth`; the binary is also installed as
  `kilocode`.

## Setup

- Install: `npm i -g @kilocode/cli` (binaries `kilo` and `kilocode`).
- Log in: `kilo auth login`.
- The probe needs `kilo acp` in the PATH of the app.

## Verification

Real session verified on 2026-10-13 with **Kilo 7.8.8** (`pnpm exec tsx scripts/verify-providers.ts --only kilo`), signed out, on the free model `kilo/kilo-auto/free` picked at start:

| detect | auth | start | stream | approve | reply | deny | interrupt | models | modes | stop |
| ------ | ---- | ----- | ------ | ------- | ----- | ---- | --------- | ------ | ----- | ---- |
| pass   | n/a  | pass  | pass   | pass    | pass  | pass | pass      | pass   | pass  | pass |

- Like OpenCode, `session/new` sends modes only as a `mode` config option (`code`, `ask`, `debug`,
  `orchestrator`, `plan`); the runner switches them with `session/set_config_option`.
- Signed out, the default model is a Kilo Gateway model (`kilo/google/gemini-3-pro-image` here): `session/new`
  works, then `session/prompt` fails with `-32603 "Internal error: You need to sign in to use this model."`.
  The profile's `setupError` turns that into a turn error that tells the user to run `kilo auth login` or pick
  another model; the session stays open. To use the default model, run `kilo auth login`.
- Fake-agent contract suites, probe and E2E (including MCP retrieval) pass.
