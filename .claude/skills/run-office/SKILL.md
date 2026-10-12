---
name: run-office
description: Launch the agent-office desktop app locally and verify a change in the real UI (screenshot). Use when asked to run, start, demo or screenshot the app, or before calling any scene/UI/desktop change done.
---

# Run the app and look at it

1. **Quick visual check (headless, isolated profile):** `make build`, then drive the built app with Playwright `_electron`:
   - `_electron.launch({ args: ['.'], cwd: 'packages/desktop', env })`
   - `env` is `process.env` **without any `ELECTRON_*` vars**, plus `AGENT_OFFICE_USER_DATA`, `AGENT_OFFICE_HOME` and `CLAUDE_SETTINGS_FILE` pointing at a temp dir, `AGENT_OFFICE_MOCK=1`, `AGENT_OFFICE_CLAUDE=0`, `PORT=4318`.
   - `packages/desktop/e2e/app.ts` (`launch()`) already does this.
   - Then `win.screenshot()` and read the image.
2. **Interactive:** `make dev-mock` opens the window with hot reload, simulated agents and your live Claude Code sessions. Then:
   - `make demo-event` adds a `custom` zone with a "Demo" agent.
   - `make demo-message` messages the first agent.
3. **Check:**
   - One zone sign per provider and one labelled row per topic; name tags readable.
   - Status colors match the legend.
   - Clicking a tag opens the chat; sending goes ⏳ → ✓ → ✓✓ with a reply from mock agents.
   - ⚙ Settings shows the hook state.
   - Closing the window keeps the tray icon.
   - No errors in the console.
4. **Stop** every app instance you started (`app.close()` or tray → Quit). Never kill processes you didn't start.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SyntaxError: … 'electron' does not provide an export named …`, "Node.js vXX" in the output | `ELECTRON_RUN_AS_NODE=1` inherited from VS Code/Cursor. Use `make` targets or strip `ELECTRON_*` from the env. |
| Red "Port … is busy" banner | Another instance or process owns the port. Change it in Settings or use `PORT=` for this run. |
| Window opens but shows nothing | Run `make build` again (stale `out/`), or check the devtools console for CSP errors. |
| No Claude Code sessions | The adapter is off, or no transcript was modified in the last 10 minutes. |
| Messages to a Claude Code session stay ⏳ | The hook isn't installed (Settings), or the session is idle. Delivery happens at the next turn boundary. |
