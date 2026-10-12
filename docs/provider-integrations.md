# Provider integrations

agent-office shows agents from several AI coding runtimes in one office. It never becomes a runtime
itself: it **observes** sessions the user starts elsewhere, and **manages** sessions it starts through
each provider's **official, documented** interface. This page is the contract for every provider
integration. Code: `packages/shared/src/providers.ts` (types), `packages/core/src/domain/providers.ts`
(declarations, state, capabilities), `packages/adapters/src/providers/**` (runtimes, probes, hooks).

## Architecture

```
 PROVIDER_DECLS (core/domain/providers.ts: id, prefix, caps, integration)   <- the registry
        |
        |  composition.ts binds each provider to:
        v
 +--------------------+   +----------------------------+   +--------------------------------+
 | ProviderProbe      |   | AgentRunner (managed)      |   | Observation hooks (optional)   |
 | --version/--help,  |   | Codex: app-server (JSONL)  |   | provider config file +         |
 | auth check (3 s)   |   | Cursor/Gemini/Copilot: ACP |   | wrapper -> agent-office-       |
 | never starts a     |   | Claude: Agent SDK          |   | observe.mjs -> POST /api/events|
 | session            |   | spawn shell:false          |   | (metadata only, fails open)    |
 +---------+----------+   +--------------+-------------+   +----------------+---------------+
           |                             |                                  |
           +-------------+---------------+----------------------------------+
                         v
        CORE: providerState() - ManagedSessionService - AgentEvent -> Agent (+ caps)
                         |  IPC (ProviderStatus, agents with caps)
                         v
        RENDERER: Connect -> Providers tab, New session, chat panel (controls gated on caps),
                  one office wing per provider
```

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
| claude-code | `launch send-message interrupt stop approve-tools select-model change-mode attach-context chrome` | declared `observe send-message`; the UI keeps the legacy rules: read-only mode pill, Send via the inbox hook when interactive |
| codex | `launch send-message interrupt stop approve-tools select-model change-mode attach-context` | — |
| cursor | `launch send-message interrupt stop approve-tools select-model change-mode attach-context` | `observe` |
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
   overrides: `approvalPolicy`, `sandboxPolicy`, `model`). Note: `thread/start` takes `sandbox` as a
   string (`read-only` | `workspace-write` | `danger-full-access`), but `turn/start` takes
   `sandboxPolicy` as an object (`{type:'readOnly'}`, `{type:'workspaceWrite'}` or
   `{type:'dangerFullAccess'}`). Extra folders have no `thread/start` field: they go out as
   `sandboxPolicy.writableRoots` on `workspaceWrite` (so only when the mode is `ask` or `auto`;
   read-only and full-access send none). An interrupted turn ends with an empty result.
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

`full-access` is marked `dangerous`: it is offered and accepted only when Settings → "Allow Bypass
permissions mode" is on.

### 5.2 ACP agents (Cursor `agent acp`, Gemini `gemini --acp`, Copilot `copilot --acp`)

Official docs: https://agentclientprotocol.com · Cursor https://cursor.com/docs/cli/acp · Gemini
https://geminicli.com/docs/cli/acp-mode/ · Copilot https://docs.github.com/en/copilot (ACP server).
Transport: JSON-RPC 2.0, newline-delimited, over stdio. One shared `AcpRunner`, configured per
provider by an `AcpProfile` (binary, args, preferred auth methods, modes, tool-kind map).

1. `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false, writeTextFile:false}, terminal:false}, clientInfo}` — disconnect if the agent answers another protocol version.
2. `session/new {cwd, mcpServers}` (empty, or only agent-office's project MCP bridge when the project policy allows this provider — docs/projects.md §5) → `{sessionId, modes?, models?, configOptions?}`. On an auth error, `authenticate` once with
   a method listed in the profile's `authMethodPrefer` **and** advertised by the agent (only Cursor
   lists one: `cursor_login`, which reuses `agent login`); if none applies or it fails, exit `auth`.
   Gemini and Copilot list none: their methods start a browser login, take a key or rewrite the
   user's settings, so a logged-in CLI simply opens the session and an unauthenticated one exits
   `auth` ("log in with the CLI"). API keys are never passed.
3. Each message → `session/prompt {sessionId, prompt:[{type:'text', text}]}` (one at a time; queued).
4. `session/cancel` (notification) on interrupt; every open permission request is answered `cancelled`.
5. `session/set_mode {sessionId, modeId}` for mode changes. Start options (mode, model) that the agent
   rejects keep the agent's defaults and are logged without detail.
6. **Models** (`select-model`): taken from the agent's own `session/new` answer: a `configOptions`
   entry with `category: 'model'` (changed with `session/set_config_option`) or else
   `models.availableModels` (changed with `session/set_model`). If it offers neither, the model
   menu is empty.
7. **Extra folders:** `additionalDirectories` is sent to `session/new` only when the agent advertises
   `sessionCapabilities.additionalDirectories`. No tested CLI does, so extra folders are not sent to
   Cursor, Gemini or Copilot sessions.
8. Unknown `session/update` kinds and provider extensions (`cursor/*`) are ignored; blocking extension
   requests get the documented "method not found" error.

Modes per profile (`id` is what agent-office stores; `native` is the agent's id when it differs).
`dangerous` modes need "Allow Bypass permissions mode":

| Provider | Mode ids (default first) | Dangerous |
| --- | --- | --- |
| Cursor | `agent` Agent · `plan` Plan (read-only) · `ask` Ask (no edits) | — |
| Gemini CLI | `default` Ask before tools · `autoEdit` Auto-approve edits · `yolo` Auto-approve everything · `plan` Plan (read-only; used only if the user enabled it, i.e. the agent advertises it) | `autoEdit`, `yolo` |
| Copilot CLI | `agent` · `plan` · `autopilot` Autopilot (allow all). Short ids map to the agent's URL ids `https://agentclientprotocol.com/protocol/session-modes#agent` / `#plan` / `#autopilot` | `autopilot` |

A mode must be in the profile **and** advertised by the agent; otherwise it is not applied.

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
`beforeTabFileRead`, `subagentStart` (Cursor), `BeforeTool`, `BeforeAgent`, `BeforeModel`,
`BeforeToolSelection`, `permissionRequest`, `userPromptTransformed`) are never used — Copilot's `preToolUse` even fails closed when a hook crashes.

| Provider | Config (ours only) | Event → status |
| --- | --- | --- |
| Cursor | `~/.cursor/hooks.json` (merged) | `sessionStart`→idle · `afterAgentThought`→thinking · `postToolUse`→tool · `afterShellExecution`→Bash · `afterFileEdit`→Edit · `afterMCPExecution`→mcp · `stop`→waiting · `sessionEnd`→done. **Subagents are not shown**: `subagentStart` can allow/deny (not subscribed) and `subagentStop` (subscribed, but the script ignores it) carries no subagent or parent id |
| Gemini CLI | `hooks` in `~/.gemini/settings.json` (merged) | `SessionStart`→idle · `AfterModel`→thinking · `AfterTool`→tool · `AfterAgent`→waiting · `Notification`→waiting · `SessionEnd`→done |
| Copilot CLI | `~/.copilot/hooks/agent-office.json` (own file) | `sessionStart`→idle · `userPromptSubmitted`→thinking · `postToolUse`/`postToolUseFailure`→tool · `errorOccurred`→error · `agentStop`→waiting · `subagentStart`/`subagentStop`→child · `sessionEnd`→done |

Copilot's camelCase payloads carry no event name, so each Copilot entry sets `env: {AGENT_OFFICE_HOOK_EVENT: <event>}` (a documented hook field); the script falls back to inferring the event from the payload's shape. Entry shapes: Cursor `{command, timeout: 5, failClosed: false}`; Gemini a group `{hooks:[{type:'command', name:'agent-office-observe', command, timeout: 5000}]}`; Copilot `{type:'command', command, timeoutSec: 5, env}`. Copilot subagents are keyed by `agentName` (`gh:<sessionId>.<agentName>`).

Model comes from the payload where it exists (Cursor `model`, Gemini `AfterModel` request model); Copilot sends none. Ids: Cursor `cu:<conversation_id>`, Gemini `gm:<session_id>`, Copilot `gh:<sessionId>`
(`^[A-Za-z0-9._-]{1,160}$`, else dropped). Name and topic: the project basename. Never forwarded:
prompts, tool input, commands, paths, `transcript_path`, `user_email`.

**Installing** is an explicit action (Connect → provider → Install hooks). The installer backs the
file up once (`<file>.agent-office.bak`), merges only entries marked `agent-office-observe`, refuses
invalid JSON (state `needs-setup`), is idempotent, and **Remove** deletes only our entries (or our own
file). Wrappers live in `<app userData>/hook/agent-office-observe-<provider>.sh` (`.cmd` on
Windows) and are removed with the hooks. `heal()` at startup refreshes hooks that are already installed (e.g. after a port change).

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
  injecting MCP servers other than agent-office's own project bridge (docs/projects.md §5), automated login or approvals, Copilot inside VS Code.

## 10. Capability matrix (verified)

Run on macOS, 2026-10-12, with `make verify-providers` against the real, logged-in CLIs (section 11).

| Provider | Version | Detect | Auth | Start | Stream | Approve | Reply | Deny | Interrupt | Models | Modes | Stop | Observe hooks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.270 | covered by existing session and E2E suites (unchanged) | | | | | | | | | | | n/a (transcripts + inbox hook) |
| Codex | 0.162.1 | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a (no surface) |
| Cursor | 2026.10.01-e373342 | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pending |
| Copilot CLI | 1.0.96 | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pending |
| Gemini CLI | 0.63.0 | pass | needs login | not verified | not verified | not verified | not verified | not verified | not verified | not verified | not verified | not verified | pending |

Legend:

- **pass**: checked against the real CLI by `scripts/verify-providers.ts` (a temp folder, harmless prompts).
- **n/a**: not applicable. For Cursor and Copilot, authentication is not checkable up front; it is
  checked when the session starts (`session/new`), so a missing login shows up as the `start` check.
- **needs login / not verified**: the CLI was installed but not logged in on the test machine. Gemini's
  protocol is verified against the fake ACP agent, and a real `initialize` plus `session/new` reached
  the CLI's auth error (`-32000 Gemini API key is missing`), but the session checks need a login.
- **pending**: observation hooks are verified against fixtures and the real hook script end to end with
  the local API (`e2e.observe-hooks`); verification with the real provider firing the hooks is pending.
- Codex protocol subset: `make codex-schema-check` found 52/52 expectations against 0.162.1.

Handshakes observed on the real CLIs:

- Cursor advertises auth method `cursor_login` and 44 models.
- Copilot advertises `copilot-login` (a terminal login) and 19 models, plus the config options
  `reasoning_effort` and `allow_all`.
- No tested CLI advertises `additionalDirectories`, so extra folders are not sent to ACP agents.

## 11. Setup and troubleshooting

Every provider follows the same path:

1. **Install** the CLI and **log in** with its own command (agent-office never logs in for you).
2. Open **Connect → Providers**, switch the provider **Enabled** (new providers start off), press
   **Check again**. The card should read **Ready** (or **Observing**).
3. **Start a managed session**: ⊕ New session → pick the provider, a folder, a mode and a model.
   (Codex and managed ACP sessions need nothing else.)
4. Optionally **Install hooks** on the card (Cursor, Gemini, Copilot) so sessions you start in their own
   terminal or IDE appear in the office, read-only. **Remove hooks** undoes it.

| Provider | Install | Log in |
| --- | --- | --- |
| Codex | `npm i -g @openai/codex` (or `brew install codex`); needs `codex app-server` | `codex login` |
| Cursor | Cursor CLI: `curl https://cursor.com/install -fsS \| bash`; the binary is `agent` | `agent login` |
| Gemini CLI | `npm i -g @google/gemini-cli`; needs `gemini --acp` | run `gemini` once and sign in |
| Copilot CLI | `npm i -g @github/copilot`; needs `copilot --acp` (public preview) | `copilot login` |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | run `claude`, then `/login` |

Check the vendor's own install page if a command above has changed; agent-office only needs the
binary on the `PATH` of the app. ⚠️ verify: install commands are the vendors' public ones, not tested here.

### Card states and hints

| Card shows | State | What it means and what to do |
| --- | --- | --- |
| ○ Off | `disabled` | You turned it off. Switch **Enabled** on. |
| ○ Not installed | `not-installed` (hint `install-cli`) | No CLI on the `PATH` and no hooks. Install it, then **Check again**. |
| ✗ Error | `error` (`probe-timeout` / `probe-failed`) | The CLI did not answer within 3 s, or the check failed. **Check again**; run `<cli> --version` in a terminal. |
| ⚠ Update the CLI | `unsupported-version` (`update-cli`) | The CLI lacks `--acp` / `app-server`. Update it. |
| ○ Needs login | `needs-auth` (`login-required`) | Run the login command from the table, then **Check again**. |
| ⚠ Needs setup | `needs-setup` (`hooks-invalid-config`, `hooks-outdated`, `hooks-need-enable`) | The hooks file is not valid JSON (fix it by hand; agent-office never overwrites invalid JSON), or the hooks are out of date (app moved, updated, port changed): **Repair hooks**. |
| ● Connected | `connected` | Live sessions of this provider are in the office. |
| ● Observing | `observe-only` | Hooks installed, no managed runtime available. |
| ● Ready | `managed-available` | The runtime can start sessions. |
| ◌ Installed | `installed` | Detected, nothing set up. |
| ⚠ Disconnected | `disconnected` | Had sessions and the runtime exited unexpectedly. |

Codex always shows the hint "Sessions started elsewhere can't be observed: start them here"
(`no-observation-surface`); ChatGPT shows "Opt-in: needs a public HTTPS endpoint or the OpenAI MCP
tunnel" (`opt-in-tunnel`) and cannot be enabled.

A managed session that ends with a login or crash message: log in again with the CLI and start a new
session. A session never stores or shows credentials, and stderr is never logged raw.

### Verify against the real CLIs

```sh
make verify-providers              # all installed, logged-in providers; uses your accounts
pnpm exec tsx scripts/verify-providers.ts --only codex,cursor --json
make codex-schema-check            # our Codex protocol subset vs. the installed codex's schema
```

`verify-providers` starts a real session in a temp folder per provider, asks it to run a harmless
command (`node -e "console.log(6*7)"`), approves, denies, interrupts, switches mode and model, stops, and
checks no process is left behind. It prints a pass / fail / n/a matrix. Nothing outside the temp
folder is touched.

### Hook files and removing them by hand

**Remove hooks** on the card is the normal way. By hand, delete only the entries whose command contains
`agent-office-observe`:

| Provider | File | By hand |
| --- | --- | --- |
| Cursor | `~/.cursor/hooks.json` (or `$CURSOR_HOOKS_FILE`) | Delete the entries marked `agent-office-observe`. Backup: `hooks.json.agent-office.bak` |
| Gemini CLI | `hooks` in `~/.gemini/settings.json` (or `$GEMINI_SETTINGS_FILE`) | Delete the `agent-office-observe` hooks (the file is otherwise yours). Backup: `settings.json.agent-office.bak` |
| Copilot CLI | `~/.copilot/hooks/agent-office.json` (or under `$COPILOT_HOOKS_DIR`) | Delete the whole file: it is ours alone. |

The wrapper scripts are in `<app userData>/hook/` (`agent-office-observe-<provider>.sh`); delete them
with the hooks. Claude Code's own hook is separate (`~/.claude/settings.json`, Settings → hook).

### Gemini CLI login

Run `gemini` once in a terminal and sign in; agent-office never calls Gemini's `authenticate`
methods (they open a browser, take an API key or rewrite your Gemini settings). If the card says
**Needs login** or a session ends with "Gemini API key is missing", the CLI is not signed in.
Note: Google replaced Gemini CLI with Antigravity for unpaid users on 2026-06-18, so a free account may
no longer be able to use `gemini` at all; paid accounts, API-key and Vertex setups are what remains.
⚠️ verify: confirm the current eligibility on Google's announcement before relying on it.
