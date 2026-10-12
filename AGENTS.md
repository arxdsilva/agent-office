# agent-office — guide for AI assistants and contributors

agent-office is a local server plus a three.js web page that shows AI agents as workers in a 3D
office. Agents are grouped into **zones by provider** and **rows by conversation topic**. You can
orbit or walk through the office, inspect agents, and **send them messages** that are delivered
into their sessions through a per-agent inbox.

## Data flow

```
 Claude Code .jsonl ─tail─▶ claude-code source ─┐                       ┌─▶ WS /ws ─▶ browser (three.js + chat)
 any agent ─POST /api/events─▶ zod ─────────────┼─▶ AgentStore ────────┤
 mock source (dev) ─────────────────────────────┘   MessageStore ◀─────┘◀─ POST /api/agents/:id/messages (UI)
                                                         │
     Claude Code hook (Stop / UserPromptSubmit) ◀─claim──┤  GET  /api/agents/:id/inbox?claim=1&wait=25
     other agents (long-poll) ◀──────────────────claim───┘  POST /api/agents/:id/replies
```

## Package map

| Path              | Purpose                                                          | May import                    |
| ----------------- | ---------------------------------------------------------------- | ----------------------------- |
| `packages/shared` | Protocol (zod schemas, types), status colors, grouping strategy  | `zod` only                    |
| `packages/server` | Fastify HTTP + WS, stores, auth, sources (`claude-code`, `mock`) | `shared`                      |
| `packages/web`    | Vite + three.js client: scene, layout, chat panel                | `shared` — **never** `server` |
| `hooks/`          | Claude Code hook script (Node, zero deps)                        | nothing                       |
| `scripts/`        | Hook installer                                                   | nothing                       |

## Glossary

| Term                                  | Definition                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent**                             | One worker — a Claude Code session, a subagent, or any external bot — identified by `agentId`.                                                                                                                                 |
| **Event**                             | A partial `AgentEvent` update. Missing fields keep their previous value.                                                                                                                                                       |
| **Source**                            | Producer of events: `http`, `claude-code`, `mock`. Sources only call `store.apply` / `messages.reply`.                                                                                                                         |
| **Provider**                          | Who runs the agent (`claude-code`, `openai-agents`, `langgraph`, …). One **zone** per provider.                                                                                                                                |
| **Topic**                             | What the conversation is about (e.g. Claude Code's session title). One **row** of desks per topic.                                                                                                                             |
| **Grouping**                          | The pluggable function `(agent) => {zone, row}` in `shared/src/grouping.ts`. Office organization lives only here and in `web/src/layout.ts`.                                                                                   |
| **Slot**                              | A desk position. Stable for an agent's lifetime.                                                                                                                                                                               |
| **Status**                            | `idle` (grey, nothing happening) · `thinking` (blue, model is working) · `tool` (amber, running a tool) · `waiting` (green, finished its turn, waiting for a human) · `error` (red) · `done` (dim, finished, removed shortly). |
| **Inbox**                             | Per-agent queue of messages sent from the UI.                                                                                                                                                                                  |
| **Message state**                     | `queued` (not yet picked up) → `delivered` (claimed by the agent) → `replied` (agent answered).                                                                                                                                |
| **Interactive**                       | Something consumed this agent's inbox in the last 10 minutes, so messages will be read.                                                                                                                                        |
| **Hook**                              | `hooks/agent-office-hook.mjs`, installed into Claude Code's `Stop`/`UserPromptSubmit` events; claims the inbox and hands messages to Claude.                                                                                   |
| **Snapshot / Upsert / Remove / Chat** | The four WebSocket message types sent to browsers.                                                                                                                                                                             |

## Commands

Use `make` targets only (`make help` lists them). `make check` is what CI runs.

## Definition of done

- `make check` is green (format, typecheck, coverage ≥70% per package, E2E, build).
- Built with **TDD**: failing test first (red), minimal code (green), refactor.
- Every behavior change has an E2E test; UI changes pass `make test-ui`.
- README and schema tables updated when a public contract changes.
- `.claude/rules/PRIVACY_SECURITY.md` respected.

## Rules

Project rules live in `.claude/rules/` and apply to every AI tool:
`TESTING.md`, `ARCHITECTURE.md`, `PRIVACY_SECURITY.md`, `SCENE.md`, `GIT_WORKFLOW.md`.
