# Cline

Status: **built, not yet verified against a real session (R2)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: 3.0.70
- Entry point: `cline --acp` (ACP mode).
- Integration kind: ACP

- `initialize` (protocol 1) advertises three auth methods: `cline`, `cline-pass`, `openai-codex` ("Sign in
  with …"): browser logins that write the user's credentials, **never called**. Capabilities seen:
  `loadSession`, `promptCapabilities {image, audio: false, embeddedContext: false}`; no `mcpCapabilities` and no
  `sessionCapabilities`.
- Help text matched by the probe: `cline --help` lists `--acp  Run in Agent Client Protocol (ACP) mode`.
- `cline --help`: `--auto-approve <boolean>` defaults to **true** ("approve all tools"); `--yolo` also exists.
- Session/new was **not** run (account use).

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/cline/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Arguments:** `cline --acp --auto-approve false`: turns off the CLI's default of approving every tool.
  ⚠️ verify: whether ACP mode then asks through `session/request_permission` is not confirmed; until a
  real run shows a permission request, treat Cline as possibly acting without cards.
- **Modes** (default first, ⚠️ verify the advertised ids): `act` Act · `plan` Plan (read-only). None dangerous.
- **MCP:** Cline does not advertise `mcpCapabilities`, so the stdio bridge may be ignored; retrieval is
  proven only against the fake agent.
- **Decl:** `PROVIDER_DECLS.cline` moved from `planned` to `integration.managed: 'acp'` with the shared ACP caps.

## Setup

- Install: `npm i -g cline`.
- Log in: `cline auth`.
- The probe needs `cline --acp` in the PATH of the app.

## Verification

Fake-agent contract suites, probe and E2E (including MCP retrieval) pass. A real session is **not yet verified**: run `make verify-providers ONLY=cline` on a logged-in machine and record the version here.
