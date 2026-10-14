# Harness Builder — flows and standards agents must follow

A **harness** is a versioned, reusable set of rules and, optionally, a **flow** attached to projects:
instructions, runtime restrictions, validation gates, ordered steps with checkpoints, and completion
criteria. It describes any kind of work (a content pipeline, a research brief, a support reply, a
release checklist) as much as a coding task. agent-office delivers the applicable rules to
every managed session, blocks restricted actions where the runtime gives it a trusted interception
point, runs the gates through its own trusted runner, and shows the result in the **Compliance
Inspector** (Agent Details → Harness). Shared Memory stays knowledge; a harness is policy.

> Honesty rule: coverage is reported as what the runtime really does. `enforced` means a trusted
> boundary (hook, approval channel, sandbox) stops the action before it happens. Instructions alone
> are shown as **Instruction applied**, never as enforced.

## 1. Model

| Entity | Id | Where stored | Notes |
| --- | --- | --- | --- |
| Harness | `hrn_` | vault `catalog`, record `harness`, key `harness:<id>:<version>` | every version kept; published versions are immutable; an edit opens `version + 1` as a draft |
| Rule | `rul_` | inside the harness | `enforcement`: `instruction`, `runtime-policy` (an `ActionRule`: deny/ask over tools, paths, commands, hosts, roles) or `validation-gate` |
| Gate | `gat_` | inside the harness | `argv[]` (never a shell string), timeout, required, platforms, `pinFiles` |
| Step | `stp_` | inside the harness (`steps[]`, `flowMode`) | name, goal, instructions, roles, `exit` checks (approval · gate · artifact · report), step-scoped policies, optional |
| Flow progress | `fpg_` | `s/<ses>`, record `flow-progress` | one session's step states and check states; stale when the harness version changes |
| Attachment | — | `Project.harnesses[]` | ≤ 16 per project |
| Snapshot | `hsn_` | `s/<ses>`, record `harness-snapshot` | the effective harness and coverage report of one session, written at start |
| Event | `hev_` | `s/<ses>`, record `harness-event` | attached, resolved, instructions-delivered, action-allowed/denied/asked, validation-*; tool name and a ≤ 120-char summary, never raw input |
| Gate result | `gtr_` | `s/<ses>`, record `gate-result` | status, exit code, redacted ≤ 8 KB tail, `pinChanged`, harness version |

Contract: `packages/shared/src/harness.ts` (views, zod args), `packages/core/src/domain/harness-types.ts`
(entities, `ActionPolicy`, `EnforcementDecl`, `EffectiveHarness`, `GateSpec`/`GateRun`).

## 2. Resolution (effective harness)

Order: global → workspace → project → session. Rules are concatenated with their lineage.
Duplicates (same normalized text) are reported. Opposite policy effects on one target resolve
**deny-wins** and are reported. Natural-language pairs that differ only by negation are reported for
review, never merged. A child may add `deny`/`ask`; it can never drop a parent `required` rule.

The snapshot is taken at session start. A later publish never rewrites a running session's policy.

## 2a. Flows

Steps are followed in **sequential** mode (one active step; it is done when every exit check passes,
then the next starts and a managed session receives a system message naming it) or **free** mode (a
checklist). Exit checks: `approval` (the user clicks Approve in the Inspector or the Overview), `gate`
(a fresh pass of one of the harness's gates), `artifact` (a repo-relative glob exists, checked read-only
by the trusted runner), `report` (the agent calls the `report_step` MCP tool, or the user marks it).
Step-scoped `policies` are merged into the effective policy while the step is current (deny wins), so
"no writes under `published/**` before Review" is enforced where the runtime can intercept. Agents
report only `report` checks and only for their own session; approvals, gates and artifacts cannot be
faked by an agent. User overrides (Mark done, Skip, Re-open) are logged. Verification requires every
required step done **and** the gates passing. Attached harnesses with steps run in Applied order.

## 3. Enforcement levels and coverage

| Level | Mechanism | Shown as |
| --- | --- | --- |
| 1 Instruction | system prompt / developer instructions / first message | Instruction applied |
| 2 Runtime | PreToolUse hook (Claude), approval channel (Codex, ACP), sandbox | Enforced by runtime / Partially enforced |
| 3 Validation | gates through the trusted runner, after the agent's turn | Verified / Validation failed |

Coverage per capability (computed from each runner's `EnforcementDecl` plus the session mode):

| Runtime | instructions | tool-deny | path-deny | command-deny | fs-isolation | subagents |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code (managed) | enforced (system prompt; subagents via SubagentStart) | enforced (disallowedTools + PreToolUse) | enforced (PreToolUse); partial for symlinks without sandbox | partial (argv heuristic); enforced for file effects with the SDK sandbox | enforced when the harness asks for the SDK sandbox, else none | enforced (same hook, `agent_id`) |
| Codex (managed) | enforced (`developerInstructions`) | enforced for commands (approval floor `untrusted`) | partial (in-workspace writes may not escalate) | partial (known-safe list bypasses; heuristic) | partial (sandbox `workspace-write` floor) | unsupported |
| ACP (OpenCode, Cursor, …) | instruction-only (first message) | partial (only requests the agent raises) | unsupported | unsupported | unsupported | unsupported |
| Observed sessions | n/a | unsupported | unsupported | unsupported | unsupported | unsupported |

Command rules match `argv[0]` after a hand-written tokenizer; substitutions, `eval` and unparseable
quoting turn into **ask**. They are always reported *partial* unless an OS sandbox is on (the spec's
warning about regex matching on shell strings).

`strict` launch policy: a `required` rule at `unsupported` blocks the start (`StartResult.code:
'harness'`). `advisory`: the dialog shows the limitation and the user may proceed. A hard restriction
is never silently turned into a prompt.

## 4. Validation gates

Gate argv comes only from the published harness version in the vault, never from the repository.
The runner spawns with `shell: false`, a scrubbed environment (no `AGENT_OFFICE_*`, nothing matching
token/secret/key/password/credential/auth/cookie/session), a timeout that kills the process tree, and
keeps a redacted 8 KB tail. `pinFiles` (Makefile, package.json, …) are hashed at session start and at
gate time; a change voids verification. Verified = every required gate of the current harness version
passed after the session's last write. Failures are fed back to the agent (≤ 4000 chars) within the
retry budget.

Completion states shown next to the provider's own lifecycle: agent-reported, validation-pending,
validation-failed, harness-verified, user-approved.

## 5. Import

Sources: `AGENTS.md` (nested too), `CLAUDE.md`, `.claude/rules/**/*.md`, `.cursor/rules/**/*.mdc`,
`.cursorrules`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`;
`Makefile` targets and CI job names only as gate *suggestions*. Read-only, no symlinks, ≤ 256 KB per
file, ≤ 64 KB parsed, ≤ 200 files. Nothing discovered is executed. Provenance keeps the format,
repo-relative path, hash, globs and import time. The result is always a **draft**; publishing is a
user action. Provider files are never written or replaced.

## 6. Security

- Only the user principal may read or manage harnesses (`authz.ts`: `harness.read`, `harness.manage`).
  The only harness-related MCP tool is `report_step`, scoped to the calling session's own flow
  progress and to `report` checks: agents cannot weaken their own rules, approve their own steps, or
  touch other sessions; `propose_memory` only ever creates pending memory.
- Events and gate output are redacted before storage; raw tool input never leaves main.
- The renderer is never the enforcement authority; decisions are made in core and the runners.
- Everything is in the encrypted vault; sentinel tests prove no plaintext leak.

## 7. IPC and UI

`AgentOfficeApi.projects.harness.*` (`packages/shared/src/desktop-api.ts`), channels `hrn:*` (incl.
`hrn:reorder`, `hrn:flow`, `hrn:flow-approve`, `hrn:flow-mark-done`, `hrn:flow-skip`,
`hrn:flow-reopen`), push `ProjectMessage {type:'harness'}`; `ProjectSummary.harnessIds` carries the
Applied order; `settings.layout.harnessOrder` the user's library order; `sessions.answer(…, answers)`
answers a question card.

Stable DOM ids: sidebar `#sb-harness`; pane `#ws-harness` (`#hb-title`, `#hb-tabs` with `#hb-tab-<tab>`,
`#hb-panels` with `#hb-panel-<tab>`, `#hb-scope`, `.hb-library .hb-card[data-harness-id]`, `.hb-applied
.hb-applied-row[data-harness-id]`, `.hb-dropzone`, `#hb-error`, `#hb-live`); confirm `#hb-confirm` (body
level); agent panel `#p-tabs` (`#p-tab-details`, `#p-tab-harness`), `#p-harness` (`.ih-steps .ih-step
[data-step-id][data-state]`, `.ih-gate`, `.ih-deny`), `#p-question[data-source]`, `#p-step-confirm`;
Minimal mode `.mm-harness[data-verification][data-coverage][data-completion]`; New Session `#ns-harness`;
dashboard `#pd-harness`; Overview approvals in `#ov-approvals`.

## 8. Status

Slice 1: Claude Code and Codex runtime enforcement, import of AGENTS.md / CLAUDE.md / `.claude/rules` /
Cursor rules, the Inspector, Minimal badges. Slice 2: OpenCode/Kilo config-content enforcement, other
ACP providers, templates, drift UI, history. Slice 3: harness test sandbox, the Engineering Standards
station in 2D/3D, promote-memory-to-rule.

## 8. Agent questions

A Claude Code `AskUserQuestion` call (or an ACP/Codex equivalent when one exists) is shown as a
**question card** in Agent Details: the prompts, their options and an "Other…" field. Managed sessions
are answered from the card (`sessions.answer(agentId, requestId, 'allow', answers)` → the runner returns
`updatedInput` with `answers`); observed sessions show the card read-only ("Answer in the Claude Code
terminal"). The question text (≤ 300 chars × 4, option labels ≤ 80, descriptions ≤ 200) is the one
bounded exception to the 80-char snippet rule; it is shown live only and never written to the vault or
to harness events. "Allow for this session" never applies to a question. A plain question at the end of
a reply is surfaced as "Asked: …" without any protocol change.
