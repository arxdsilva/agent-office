# Minimal mode — the live agent hierarchy

Minimal mode (`viewMode: 'minimal'`) is a static, DOM-only view of every agent working on each
project: **Project → main agent → subagents → nested subagents**. Each node shows its
**assigned task** and its **current activity** separately, plus provider, model and lifecycle.
There is no canvas, no camera and no render loop: the page changes only when an agent does.

## Data flow

```
provider adapter ──AgentEvent {parentId, task, ended, status, text, tool}──▶ core applyEvent
   ──Agent DTO──▶ renderer state ──controller──▶ SceneView.setRoster(RosterInput)
   ──▶ MinimalScene: rememberFinished → buildHierarchy (pure) → keyed DOM patch
```

- The core's agents are the only truth. The hierarchy is rebuilt from them on every change
  (`web/src/app/hierarchy.ts`); Minimal mode keeps no tree of its own.
- The one piece of view state is **Recently finished** (`web/src/app/finished.ts`): agents the
  core already dropped (done agents leave after 30 s), at most 5 per parent, 50 overall, 30
  minutes each. It is never persisted; the Session Vault is the durable history.

## Contract (additive)

| Field                    | Where                  | Meaning                                                                                                |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `task` (≤ 200)           | `AgentEvent`, `Agent`  | The objective given at spawn. Merged like every field, so tool events never overwrite it.             |
| `ended`                  | `AgentEvent`, `Agent`  | `completed` · `failed` · `cancelled` · `terminated`, reported by the producer. Sticky once set.       |
| `endedAt`                | `Agent` (set by core)  | The first time `ended` arrived.                                                                        |
| `'minimal'`              | `VIEW_MODES`           | The fourth view mode.                                                                                  |
| `SceneView.setRoster?()` | `web/src/ports.ts`     | Optional; only roster views implement it. `SceneHost` caches and replays it.                          |

## Lifecycle

| Agent state                             | Shown                  |
| --------------------------------------- | ---------------------- |
| `ended: 'completed'`                    | ✓ Completed            |
| `ended: 'failed'`                       | Failed                 |
| `status: 'error'` without `ended`       | Error                  |
| `ended: 'cancelled'`                    | Cancelled              |
| `ended: 'terminated'`                   | Stopped                |
| `status: 'done'` without `ended`        | Ended (cause unknown)  |
| `status: 'waiting'`                     | Waiting                |
| `thinking`                              | Thinking               |
| `tool`                                  | Working (main: Tool use) |
| `idle`, silent > 60 s                   | No recent activity     |

Silence never becomes Completed. A failed tool call is a tool error (`text: 'tool error'`),
not an agent failure. A parent that ends does not end its children.

## Hierarchy rules

- Roots are agents without `parentId`. A child whose parent isn't known yet sits under
  **Waiting for parent** in its project and moves under the parent as soon as it arrives.
- Lineage beats project grouping: a child is shown under its parent's project.
- Order is stable: `since`, then id. Status changes never reorder nodes.
- Any depth is kept; the view indents at most 3 levels and labels deeper ones.
- Task line: `task`, else (main agents) the conversation topic when it isn't just the folder
  name, else "Task not reported". Nothing is invented and no LLM writes labels.

## Provider support

| Provider                 | Subagents                                                                                                    | Task                              | Completion                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------- |
| Claude Code (observed)   | `<session>/subagents/agent-*.jsonl` + `.meta.json` (`agentType`)                                             | `meta.description` (≤ 120, clean) | The sidechain's final `end_turn` → `ended: 'completed'`              |
| HTTP producers           | `parentId`                                                                                                   | `task`                            | `ended`                                                               |
| Others                   | Not reported: their agents are roots. A delegation shows only as the parent's activity.                     | —                                 | `status: 'done'` → Ended                                              |

## Privacy

- The task is the Task tool's short `description`, never the subagent's prompt (sentinel test in
  `line-mapper.test.ts`). Activity lines stay the ≤ 80-char snippets the adapters already emit.
- Everything is rendered with `textContent`.

## Out of scope (next slices)

- Task-reassignment history.
- Subagents of managed Claude SDK sessions (`parent_tool_use_id`, `claude-sdk-runner.ts`).
- OpenCode child sessions; ACP and OpenHands delegation.
- Virtualization (past ~300 visible nodes).
- A per-provider "doesn't report subagents" note (needs a `ProviderDecl` flag).
