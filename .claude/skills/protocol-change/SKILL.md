---
name: protocol-change
description: Change agent-office's public contracts — AgentEvent fields, inbox/reply/messages APIs, WebSocket ServerMessage shapes, or the hook's output. Use whenever packages/shared/src/index.ts or an /api route's request/response shape changes.
---

# Change a public contract (additive only)

External agents and installed hooks depend on these shapes. See `ARCHITECTURE.md`.

1. **Red** — add a case to `packages/shared/src/index.test.ts` for the new field/shape. The compatibility guard (`{agentId}` alone parses; unknown fields ignored) must stay green.
2. **Green** — add the field as **optional** in the zod schema / type. Never rename, remove, retype, or make a field required.
3. **Store** — if it's agent state: merge logic + tests in `packages/server/src/store.ts` (`apply` merges only defined fields; decide if it's a visible field that triggers `upsert`).
4. **Server** — route handling + `http.test.ts` (400 for invalid input, success path).
5. **Web** — reducer (`socket.ts`) tests, then rendering (`avatar.ts` / `panel.ts`) using `textContent` only.
6. **E2E** — extend the relevant `packages/server/test/e2e.*.test.ts`.
7. **Docs** — README schema tables and examples.
8. `make check` and `make test-ui`.

A breaking change is only allowed with an explicit major-version note in the README and the user's agreement.
