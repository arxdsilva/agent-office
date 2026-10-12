---
name: interaction-change
description: Change how users talk to agents in agent-office — the inbox/messages/replies APIs, message states, the chat panel, the Claude Code hook (hooks/agent-office-hook.mjs) or its installer. Use for any edit to messages.ts, http.ts inbox routes, panel.ts, hooks/ or scripts/hook-install.mjs.
---

# Change agent interaction

Rules: `PRIVACY_SECURITY.md` (the hook fails open; auth fails closed), `ARCHITECTURE.md` (contracts are additive), `TESTING.md`.

1. **Red** — message-state behavior in `packages/server/src/messages.test.ts` (queued → delivered → replied, claim atomic, long-poll).
2. **Routes** — `http.test.ts`: 401 without token, 403 foreign Origin, 404 unknown agent, 429 rate limit, success.
3. **Hook** — `hooks/agent-office-hook.test.ts`:
   - Stop → `{"decision":"block","reason":…}` only when messages exist; posts `last_assistant_message` with `requireAwaiting: true` first.
   - UserPromptSubmit → `hookSpecificOutput.additionalContext`.
   - Server down / bad JSON / missing token / timeout → **no output, exit 0**, within 1.5s.
   - Message text is only ever passed to Claude as text — never to a shell.
4. **Installer** — `scripts/hook-install.test.ts`: idempotent, backup written, foreign hooks untouched, uninstall removes only ours.
5. **E2E** — `packages/server/test/e2e.chat.test.ts` (generic agent) and `e2e.claude-code.test.ts` (adapter + real hook script); `e2e.security.test.ts` stays green.
6. **UI** — `panel.ts` with `textContent` only; smoke test in `packages/web/e2e/smoke.spec.ts`.
7. **Manual check with a real session** — `make dev`, `make install-hook`, message this Claude Code session from the UI while it works; the reply should appear in the panel when its turn ends. `make uninstall-hook` afterwards if you installed it only to test.

Known limit: Claude Code has no hook that can wake an idle session; messages to a waiting session arrive on the user's next prompt. Keep the UI hint honest about this.
