---
name: run-office
description: Launch agent-office locally and verify a change in the real UI (screenshot). Use when asked to run, start, demo or screenshot the office, or before calling any scene/UI change done.
---

# Run the office and look at it

1. **Start** (background): `make dev-mock` — server on :4317, Vite on :5173, 9 mock agents + any live Claude Code sessions.
   - Isolated alternative that never touches `~/.agent-office`: `AGENT_OFFICE_HOME=$(mktemp -d) AGENT_OFFICE_MOCK=1 make build start` (single process on :4317).
2. **Wait for health**: poll `curl -s http://127.0.0.1:4317/api/health` until it returns `{"ok":true,...}`.
3. **Drive it**:
   - `make demo-event` — adds a `custom` zone with a "Demo" agent running Bash.
   - `make demo-message` — sends "hello from make" to the first agent (mock agents answer in ~2s).
4. **Look at it**: open http://localhost:5173 (dev) or :4317 (built) in the built-in browser or Claude in Chrome. If neither is available, use Playwright headless with software WebGL (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) and read the screenshot.
5. **Check**:
   - One zone sign per provider, one labelled row per topic, name tags readable and not overlapping.
   - Status colors match the legend; bubbles show the tool for `tool` agents.
   - Click a name tag → panel opens, camera eases to the desk; send a message → ⏳ → ✓ → ✓✓ and a reply.
   - Walk (`F`): WASD moves, desks and walls block you, `E` on an agent opens chat, `Esc` returns.
   - No errors in the browser console.
6. **Stop** every process you started (find them with `lsof -nP -iTCP:4317 -sTCP:LISTEN`); never kill processes you didn't start.

## Troubleshooting

| Symptom                                   | Cause / fix                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE 4317`                         | Another server is running. Reuse it or stop the one _you_ started.                                           |
| UI shows 0 agents, dot amber              | WebSocket refused: wrong token (rebuild/restart) or foreign Host/Origin (use `localhost`).                   |
| Module script served as `text/html`       | Stale `dist/`: run `make build` again.                                                                       |
| No Claude Code sessions appear            | Adapter off (`AGENT_OFFICE_CLAUDE=0`) or no transcript modified in the last 10 min.                          |
| Messages to a Claude Code session stay ⏳ | Hook not installed (`make install-hook`) or the session is idle: delivery happens at the next turn boundary. |
