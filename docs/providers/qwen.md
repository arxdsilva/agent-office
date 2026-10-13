# Qwen Code

Status: **built, not yet verified against a real session (R1)**. This page is updated as the integration is verified; the README
and `docs/provider-integrations.md` list it as supported only after a real-CLI check.

## Verified on this machine

- Installed version: 0.25.1
- Entry point: `qwen --acp` (ACP over stdio). `--mcp-config` and `--allowed-mcp-server-names` exist; MCP goes through ACP `mcpServers`.
- Integration kind: ACP

- `initialize` (protocol 1) advertises one auth method, `openai` ("Requires setting the `OPENAI_API_KEY`
  environment variable"): an API key, **never called**. `qwen auth` is removed in 0.25.1; the user configures
  a model in Qwen's own settings. Capabilities seen: `loadSession`, `sessionCapabilities {list, resume}`,
  `mcpCapabilities {sse, http}`, `promptCapabilities {image, audio, embeddedContext}`.
- Help text matched by the probe: `qwen --help` lists `--acp  Starts the agent in ACP mode`.
- Approval modes (`--approval-mode`): `plan`, `default`, `auto-edit`, `auto`, `yolo`.
- Session/new was run on 2026-10-13 and stopped at auth (see Verification); the mode ids are applied only if the agent advertises them.

## Integration

Managed sessions run through the shared `AcpRunner` (docs/provider-integrations.md §5.2) with the
profile in `packages/adapters/src/providers/qwen/`. Transport is JSON-RPC 2.0 over stdio; agent-office
advertises no client `fs` or `terminal`. Observed caps: none (no observation surface).

- **Managed caps:** launch, send-message, interrupt, stop, approve-tools, select-model (from the agent's
  own `session/new` answer), change-mode.
- **Permissions:** `allow_once` / `reject_once` only. "Always allow" is agent-office's own per-session set;
  `allow_always` is never sent.
- **MCP:** the project bridge is passed in `session/new mcpServers` (stdio) only when the project policy
  allows it; covered by `e2e.acp.test.ts` for this profile against the fake agent.
- **Events:** status and tool names only (shared tool-kind map). Thoughts, plans, commands, paths and tool
  output never reach events, IPC or logs; sentinel tests in `oss-acp-profiles.test.ts` and `e2e.acp.test.ts`.
- **Modes** (default first): `default` Ask before tools · `plan` Plan (read-only) · `auto-edit` Auto-approve
  edits (dangerous) · `auto` Auto-approve safe actions (dangerous) · `yolo` Auto-approve everything (dangerous).

## Setup

- Install: `npm i -g @qwen-code/qwen-code`.
- Configure a model in Qwen Code's settings (run `qwen` once). agent-office never passes an API key.
- The probe needs `qwen --acp` in the PATH of the app.

## Verification

Real run on 2026-10-13 with **Qwen Code 0.25.1**: **needs a login**. `session/new` answers `-32000
"Authentication required: Use Qwen Code CLI to authenticate first."`; the session ends with the auth hint
("Run `qwen`"). detect pass, start blocked, stop pass. To finish: run `qwen` and set up auth or a model
(`/auth`), then `make verify-providers ONLY=qwen`.

Fake-agent contract suites, probe and E2E (including MCP retrieval) pass.
