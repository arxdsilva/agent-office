# OpenHands

Status: **built, not yet verified against a real session (R2)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: installed with `uv tool install openhands`
- Entry point: `openhands acp` (ACP). `openhands serve` exists; remote or containerized workspaces need explicit consent.
- Integration kind: ACP

- `initialize` (protocol 1) advertises one auth method, `oauth` ("OAuth with OpenHands Cloud"): a browser
  login, **never called**. Capabilities seen: `loadSession`, `mcpCapabilities {http, sse}`,
  `promptCapabilities {embeddedContext, image}`. Agent info: "OpenHands CLI ACP Agent" 1.16.0 (SDK 1.21.0).
- Help text matched by the probe: `openhands acp --help` -> `usage: openhands acp [-h] [--resume …] …`.
- The CLI is Python: `--version` and `acp --help` each take about 2.3 s cold, so its probe budget is 10 s
  (`OPENHANDS_PROBE_TIMEOUT_MS`) instead of 3 s.
- Modes (from `openhands_cli/acp_impl/confirmation.py`): `always-ask`, `always-approve`, `llm-approve`.
- Not used: `--cloud` (remote workspace, would need `openHandsRemoteConsent`), `--override-with-envs`,
  `--always-approve`.
- Session/new was **not** run (account/LLM use).

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/openhands/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Modes** (default first): `always-ask` Ask before every action · `llm-approve` Ask only for risky
  actions (dangerous) · `always-approve` Auto-approve everything (dangerous).
- **Local only:** the profile never passes `--cloud`; the HTTP agent-server route is not used.
- **Decl:** `PROVIDER_DECLS.openhands` moved from `planned` to `integration.managed: 'acp'`.

## Setup

- Install: `uv tool install openhands` (or pipx).
- Configure the LLM / log in with the CLI itself (`openhands login` for OpenHands Cloud, or its settings).
- The probe needs `openhands acp` in the PATH of the app.

## Verification

Fake-agent contract suites, probe and E2E (including MCP retrieval) pass. A real session is **not yet verified**: run `make verify-providers ONLY=openhands` on a logged-in machine and record the version here.
