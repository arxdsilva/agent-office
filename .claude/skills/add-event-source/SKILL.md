---
name: add-event-source
description: Add a new agent source/provider to agent-office (e.g. LangGraph, OpenAI Agents SDK, OpenTelemetry GenAI spans, Claude Code hooks). Use when asked to support or ingest agents from another framework or data source.
---

# Add an event source

Rules that apply: `TESTING.md` (TDD, ≥70%), `ARCHITECTURE.md`, `PRIVACY_SECURITY.md`.

First ask: can the producer just `POST /api/events`? If yes, document it in the README instead of adding code.

1. **Red** — `packages/server/src/sources/<name>.test.ts`: fixtures shaped like the real data with **invented** content. Test a pure mapper `toEvent(raw, ctx): AgentEvent | null`:
   - identity (`agentId` stable and namespaced, e.g. `lg:<id>`), `parentId` for sub-agents
   - `provider` (the zone) and `topic` (the row) — what would a user call this conversation?
   - status mapping onto `idle | thinking | tool | waiting | error | done`
   - malformed input → `null`
2. **Green** — `packages/server/src/sources/<name>.ts`: the mapper plus a class with `start()` / `stop()` / a testable `tick()`. It may only call `store.apply()` (and `messages.reply()` for replies). Never throw out of `tick()`.
3. **Config** — flag/env in `config.ts` (+ `config.test.ts`) and `.env.example`; register in `src/index.ts`.
4. **E2E** — `packages/server/test/e2e.<name>.test.ts`: real source → real server → WebSocket client sees the agent in the right zone/row.
5. **Docs** — README "Sources" section: what is read, what is ignored, privacy notes.
6. **Privacy check** — only status, tool, title, model and ≤80-char snippets leave the source; nothing is logged raw.
7. `make check`, then `/run-office` to see the new zone.
