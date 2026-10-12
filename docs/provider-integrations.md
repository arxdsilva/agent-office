# Provider integrations

agent-office shows agents from several AI coding runtimes in one office. It never becomes a runtime
itself: it **observes** sessions the user starts elsewhere, and **manages** sessions it starts through
each provider's **official, documented** interface. This page is the contract for every provider
integration. Code: `packages/shared/src/providers.ts` (types), `packages/core/src/domain/providers.ts`
(declarations, state, capabilities), `packages/adapters/src/providers/**` (runtimes, probes, hooks).

> Status: being implemented (plan "multi-provider platform"). Sections marked _(filled in P5)_ get
> real verification results.

## 1. Two modes, never confused

| Mode | Who starts the session | What agent-office can do | Example |
| --- | --- | --- | --- |
| **Observed** | The user, in their terminal or IDE | Show it (status, tool, project, model). Control only where a documented surface allows it (Claude Code's inbox hook). | `codex` in a terminal, Cursor IDE agent, `gemini` |
| **Managed** | agent-office, through the provider's protocol | Prompt, stream, approve tools, interrupt, stop, change mode/model where supported | New Session → Codex / Cursor CLI / Gemini CLI / Copilot CLI |

A session's abilities are **capabilities** on the agent (`Agent.caps`). The UI shows a control only
when the capability is there: an observed Cursor agent has no working Send button; a provider that
can't change models has no model menu.

## 2. Providers

| Provider | Id | Agent id prefix | Managed via | Observed via | Tested version |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `cc:` | Claude Agent SDK | Transcripts (`~/.claude/projects`) + inbox hook | 2.1.270 |
| OpenAI Codex | `codex` | `cx:` | `codex app-server` (stdio JSONL) | — (no documented surface) | 0.162.1 |
| Cursor | `cursor` | `cu:` | `agent acp` (ACP) | Cursor hooks (`~/.cursor/hooks.json`) | agent 2026.10.01-e373342 |
| Gemini CLI | `gemini` | `gm:` | `gemini --acp` (ACP) | Gemini hooks (`~/.gemini/settings.json`) | 0.63.0 |
| GitHub Copilot CLI | `copilot` | `gh:` | `copilot --acp` (ACP, public preview) | Copilot hooks (`~/.copilot/hooks/*.json`) | 1.0.96 |
| ChatGPT | `chatgpt` | — | — (disabled) | — (disabled) | — |

Ids are provider-scoped: `<prefix><native id>`. Sessions are **never** merged by project folder. The
same session seen twice (a managed session whose provider also fires hooks) is de-duplicated by id:
hooks exit early inside managed sessions (`AGENT_OFFICE_MANAGED=1`) and core drops observer events for
ids a managed session owns.

## 3. Capabilities

`SESSION_CAPS`: `observe`, `launch`, `send-message`, `interrupt`, `stop`, `approve-tools`,
`select-model`, `change-mode`, `attach-context`, `chrome`, `resume`.

| Provider | Managed session caps | Observed session caps |
| --- | --- | --- |
| claude-code | `launch send-message interrupt stop approve-tools select-model change-mode attach-context chrome` | legacy rules (`caps` absent): read-only mode pill; Send via the inbox hook when interactive |
| codex | `launch send-message interrupt stop approve-tools select-model change-mode attach-context` | — |
| cursor | `launch send-message interrupt stop approve-tools change-mode attach-context` (+ `select-model` when the session reports models) | `observe` |
| gemini | as cursor | `observe` |
| copilot | as cursor | `observe` |
| chatgpt | — | — |

`resume` is declared by no provider yet (see §9). An ended managed session keeps only `observe` and
`stop` (to retire it).

**UI gating** (`web/src/app/view-models.ts`), when `caps` is present:

| Control | Needs |
| --- | --- |
| Send / composer | `send-message`; else disabled with "Observation only — reply in <provider>" |
| Stop / Interrupt | `stop` / `interrupt` |
| Permission card | `approve-tools` |
| Mode menu | `change-mode` (`managed.modes`, else Claude's `PERMISSION_MODES`) |
| Model menu | `select-model` |
| Use… → Chrome | `chrome` |
| Attach files/folders | `attach-context` |

## 4. Provider state (Connect → Providers)

`PROVIDER_STATES`, decided by core `providerState(decl, probe, {enabled, liveSessions, hooks})` in this
precedence (first match wins):

1. `disabled` — the user turned it off (new providers start disabled; Claude follows `claudeAdapter`).
2. `not-installed` — no CLI and no hooks.
3. `error` — the probe failed or timed out (hint `probe-failed` / `probe-timeout`).
4. `unsupported-version` — the CLI lacks the flag/subcommand we use (`--acp`, `app-server`).
5. `needs-auth` — the provider reported missing login (hint `login-required`).
6. `needs-setup` — hooks invalid or outdated (hints `hooks-invalid-config`, `hooks-outdated`, `hooks-need-enable`).
7. `connected` — live sessions of this provider in the office.
8. `observe-only` — hooks installed, no managed runtime available.
9. `managed-available` — the runtime is ready to start sessions.
10. `installed` — detected, nothing set up yet.

`disconnected` is used when a provider had live sessions and its runtime exited unexpectedly.

**Detection never starts a session.** Probes run `<cli> --version` and `<cli> --help` (and, for Codex,
`account/read` on a short-lived app-server) with a 3 s timeout, only when the Connect panel opens, on
**Check again**, and at startup for enabled providers. Each probe is isolated: one failing never
affects another provider.

## 5. Managed runtimes

All runtimes implement the core `AgentRunner` port (`packages/core/src/ports/driven.ts`) and pass the
`managedRuntimeContract` suite. Shared infrastructure: `providers/common/process.ts` (spawn with
`shell:false`, `AGENT_OFFICE_MANAGED=1`, kill the process tree on close, exit classification) and
`providers/common/jsonrpc.ts` (NDJSON JSON-RPC peer, `dialect: 'jsonrpc2' | 'codex'`).

### 5.1 Codex (`codex app-server`)

Official docs: https://learn.chatgpt.com/docs/app-server · https://github.com/openai/codex.
Transport: stdio JSONL; JSON-RPC **without** the `"jsonrpc"` field. Schemas for the installed version:
`codex app-server generate-json-schema --out <dir>` (checked by `scripts/codex-schema-check.mjs`).

1. Spawn `codex app-server`. `initialize {clientInfo:{name:'agent-office',title,version}}` → `initialized` (no params).
2. `account/read {refreshToken:false}` → `{requiresOpenaiAuth, account|null}`; login required and no
   account: exit `auth` ("Run `codex login`"). Models come from `model/list` (`id` = the model's
   `model` field; hidden models are skipped).
3. `thread/start {cwd, model?, approvalPolicy, sandbox}` → `thread.id`; agent id `cx:<threadId>`.
4. Each message → `turn/start {threadId, input:[{type:'text', text}]}` (queued while a turn runs).
5. `turn/interrupt {threadId, turnId}`; mode/model changes apply on the next `turn/start` (per-turn
   overrides). Note: `thread/start` takes `sandbox` as a string, but `turn/start` overrides take
   `sandboxPolicy` as an object (`{type:'readOnly'|'workspaceWrite'|'dangerFullAccess'}`). Extra
   folders have no `thread/start` field: they go out as `sandboxPolicy.workspaceWrite.writableRoots` on
   the first turn (ignored in read-only and full-access). An interrupted turn ends with an empty result.
6. Server→client requests we answer: `item/commandExecution/requestApproval` and
   `item/fileChange/requestApproval` → `{decision}`. Any other server request
   (`item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, …) is declined
   with `-32601 Method not found` so the agent never hangs (this includes the legacy
   `execCommandApproval`/`applyPatchApproval` and `item/permissions/requestApproval`). The file-change
   approval carries no paths, so the card's path comes from the earlier `fileChange` item; a command
   approval may have a null `command`, which falls back to the item's command.

Mode presets (`ModeOption`; `AskForApproval` = `untrusted | on-request | never`, `SandboxMode` =
`read-only | workspace-write | danger-full-access`):

| Mode id | Label | approvalPolicy | sandbox |
| --- | --- | --- | --- |
| `read-only` | Read only | on-request | read-only |
| `ask` (default) | Ask before changes | untrusted | workspace-write |
| `auto` | Auto in workspace | on-request | workspace-write |
| `full-access` | Full access (dangerous) | never | danger-full-access |

### 5.2 ACP agents (Cursor `agent acp`, Gemini `gemini --acp`, Copilot `copilot --acp`)

Official docs: https://agentclientprotocol.com · Cursor https://cursor.com/docs/cli/acp · Gemini
https://geminicli.com/docs/cli/acp-mode/ · Copilot https://docs.github.com/en/copilot (ACP server).
Transport: JSON-RPC 2.0, newline-delimited, over stdio. One shared `AcpRunner`, configured per
provider by an `AcpProfile` (binary, args, preferred auth method, mode labels, tool-kind map).

1. `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false, writeTextFile:false}, terminal:false}, clientInfo}` — disconnect if the agent answers another protocol version.
2. `session/new {cwd, mcpServers:[]}` → `{sessionId, modes?}`. On an auth error, `authenticate` once with
   a method that reuses the CLI's existing login (e.g. Cursor `cursor_login`); if that fails, exit `auth`.
   API keys are never passed.
3. Each message → `session/prompt {sessionId, prompt:[{type:'text', text}]}` (one at a time; queued).
4. `session/cancel` (notification) on interrupt; every open permission request is answered `cancelled`.
5. `session/set_mode {sessionId, modeId}` for mode changes.
6. Unknown `session/update` kinds and provider extensions (`cursor/*`) are ignored; blocking extension
   requests get the documented "method not found" error.

### 5.3 Permission decisions

The renderer's three decisions map to each protocol. We **never** send `allow_always` or
`acceptForSession`: those can persist beyond the session in the provider's own store.

| UI decision | ACP option kind | Codex decision |
| --- | --- | --- |
| Allow once | `allow_once` | `accept` |
| Allow for this session | `allow_once` + agent-office's per-session allow-set | `accept` + the allow-set |
| Deny | `reject_once` | `decline` |
| (interrupt / stop) | outcome `cancelled` | `cancel` |

Adapters normalize tool kinds before core sees them (Bash, Edit, Read, Grep, WebFetch, …), so the
shared `summarizeToolRequest` produces the ≤ 120-char card text. Raw tool titles and inputs never reach
the renderer.

### 5.4 Event mapping (managed)

| Native | Status / tool | Notes |
| --- | --- | --- |
| Codex `turn/started`, reasoning item | thinking | |
| Codex item `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` | tool `Bash` / `Edit` / `mcp` / `WebSearch` | no command text |
| Codex `item/agentMessage/delta` | — | accumulated into the reply (≤ 4000 chars, managed chat only) |
| Codex `turn/completed` completed / interrupted / failed | waiting (+reply) / idle / error | |
| ACP `agent_thought_chunk`, `plan` | thinking | plan text never forwarded |
| ACP `tool_call {kind}` | tool: read→Read, edit/delete/move→Edit, search→Grep, execute→Bash, fetch→WebFetch, think→thinking, other→Tool | raw `title` never forwarded |
| ACP `tool_call_update` completed / failed | thinking | |
| ACP `agent_message_chunk` | — | accumulated into the reply |
| ACP `current_mode_update` | `modeId` | |
| ACP prompt `stopReason` end_turn / cancelled / refusal / max_tokens / max_turn_requests | waiting (+reply) / idle / error / waiting / waiting | |

## 6. Observation hooks (Cursor, Gemini CLI, Copilot CLI)

One script, `hooks/agent-office-observe.mjs --provider <id>`, run by the provider through a wrapper in
agent-office's `userData` (like the Claude hook). It maps the hook's stdin to an `AgentEvent` and posts
it to the local API. It **fails open**: always exit 0, print nothing (empty output = allow in every
format), 1.5 s network timeout, and it exits immediately inside managed sessions. Claude Code's own
hook (`hooks/agent-office-hook.mjs`) is unchanged.

**Only non-blocking events are subscribed.** Events that can veto or rewrite an action
(`preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeSubmitPrompt`,
`subagentStart` (Cursor), `BeforeTool`, `BeforeAgent`, `BeforeModel`, `BeforeToolSelection`, `permissionRequest`,
`userPromptTransformed`) are never used — Copilot's `preToolUse` even fails closed when a hook crashes.

| Provider | Config (ours only) | Event → status |
| --- | --- | --- |
| Cursor | `~/.cursor/hooks.json` (merged) | `sessionStart`→idle · `afterAgentThought`→thinking · `postToolUse`→tool · `afterShellExecution`→Bash · `afterFileEdit`→Edit · `afterMCPExecution`→mcp · `stop`→waiting · `sessionEnd`→done. Subagents aren't shown: `subagentStart` can allow/deny (not used) and `subagentStop` carries no subagent or parent id |
| Gemini CLI | `hooks` in `~/.gemini/settings.json` (merged) | `SessionStart`→idle · `AfterModel`→thinking · `AfterTool`→tool · `AfterAgent`→waiting · `Notification`→waiting · `SessionEnd`→done |
| Copilot CLI | `~/.copilot/hooks/agent-office.json` (own file) | `sessionStart`→idle · `userPromptSubmitted`→thinking (if non-blocking) · `postToolUse`/`postToolUseFailure`→tool · `errorOccurred`→error · `agentStop`→waiting · `subagentStart`/`subagentStop`→child · `sessionEnd`→done |

Copilot's camelCase payloads carry no event name, so each Copilot entry sets `env: {AGENT_OFFICE_HOOK_EVENT: <event>}` (a documented hook field). Copilot subagents are keyed by `agentName` (`gh:<sessionId>.<agentName>`).

Ids: Cursor `cu:<conversation_id>`, Gemini `gm:<session_id>`, Copilot `gh:<sessionId>`
(`^[A-Za-z0-9._-]{1,160}$`, else dropped). Name and topic: the project basename. Never forwarded:
prompts, tool input, commands, paths, `transcript_path`, `user_email`.

**Installing** is an explicit action (Connect → provider → Install hooks). The installer backs the
file up once (`<file>.agent-office.bak`), merges only entries marked `agent-office-observe`, refuses
invalid JSON (state `needs-setup`), is idempotent, and **Remove** deletes only our entries (or our own
file). `heal()` at startup refreshes hooks that are already installed (e.g. after a port change).

## 7. Privacy and security

See `.claude/rules/PRIVACY_SECURITY.md` → Providers. In short: metadata only (tool name, project
basename, status, model, ≤ 80-char snippets); agent text only into a managed session's own chat; no
prompts, commands, paths, emails or env values in events, IPC or logs; no credential handling (each
CLI's own login is reused); no auto-approve; dangerous modes behind `allowBypassPermissions`;
`shell:false` and no user-controlled arguments.

## 8. Adding a provider

1. **Declare it.** Add the id to `PROVIDER_IDS` (`shared/src/providers.ts`) and a `ProviderDecl` to
   `PROVIDER_DECLS` (`core/src/domain/providers.ts`): label, prefix, managed and observed caps.
2. **Managed runtime.** ACP agent → a new `AcpProfile` in `adapters/src/providers/<id>/profile.ts`
   (binary, args, auth method, mode labels, tool-kind map). Other protocol → a runner implementing
   `AgentRunner` with a `decl`, built on `providers/common/{process,jsonrpc}.ts`.
3. **Probe.** `adapters/src/providers/<id>/probe.ts` (`--version`, `--help` flag check).
4. **Observation (optional).** A hook format in `core/src/domain/provider-hooks.ts` (subscribed and
   blocking events, config shape) + `adapters/src/providers/<id>/hook-format.ts` (paths) + a `mapEvent`
   branch in `hooks/agent-office-observe.mjs`.
5. **Register** it in `packages/desktop/src/main/composition.ts` (`ProviderBinding`).
6. **Test it**: run `managedRuntimeContract`, `providerProbeContract` and (for hooks) `hookFormatContract`
   against it, with fixtures shaped like the real protocol; add the no-leak fixtures.

No other provider, renderer or core service changes. The provider gets its own office wing
automatically (grouping by provider).

## 9. Not supported (on purpose)

- **Codex external sessions**: no documented observation surface; an app-server agent-office starts
  does not control the user's terminal or IDE sessions.
- **ChatGPT**: disabled. ChatGPT can only reach an MCP server over public HTTPS or OpenAI's Secure MCP
  Tunnel; agent-office runs locally and never scrapes browser sessions, cookies or app storage.
- **Messaging, interrupting or approving in hook-observed Cursor/Gemini/Copilot sessions**: their hooks
  don't offer it; the UI says where to reply.
- **Resume across app restarts** (`session/load`, `thread/resume`), ACP client fs/terminal methods,
  injecting MCP servers, automated login or approvals, Copilot inside VS Code.

## 10. Capability matrix (verified) _(filled in P5)_

| Provider | Detect | Auth check | Start | Stream | Approve | Deny | Interrupt | Stop | Modes | Models | Observe |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | | | | | | | | | | | |
| Codex | | | | | | | | | | | |
| Cursor | | | | | | | | | | | |
| Gemini CLI | | | | | | | | | | | |
| Copilot CLI | | | | | | | | | | | |

## 11. Setup and troubleshooting _(filled in P5)_
