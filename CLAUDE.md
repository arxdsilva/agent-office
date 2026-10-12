# CLAUDE.md

@AGENTS.md

## Rules — when they apply

| Rule | Apply when |
|---|---|
| `.claude/rules/ARCHITECTURE.md` | Any code change. Check which layer it belongs to, and run `make arch` |
| `.claude/rules/TESTING.md` | Any behavior change (TDD, ≥70% coverage, contract suites) |
| `.claude/rules/PRIVACY_SECURITY.md` | Transcripts, HTTP/IPC routes, auth, the hook, Electron windows and preload, anything that renders text |
| `.claude/rules/SCENE.md` | Any three.js or layout change |
| `.claude/rules/GIT_WORKFLOW.md` | Anything commit-related |
| `.claude/rules/CORE.md` | Always |

## Skills — when to invoke

| Skill | Use for |
|---|---|
| `/run-office` | Launching the app and checking a change visually (screenshot) |
| `/add-port-adapter` | A new driven port or adapter (storage, OS integration, external service) |
| `/add-event-source` | A new agent provider or source (a driving adapter) |
| `/protocol-change` | Changing `AgentEvent`, the HTTP inbox/reply APIs, or the IPC contract |
| `/scene-change` | The 3D scene, layout, controls or labels |
| `/interaction-change` | The inbox, chat panel, Claude Code hook or hook setup |
| `/desktop-change` | Tray, notifications, settings, IPC, updater, windows, packaging |

## Claude-specific notes

- Never run `git add`, `git commit` or `git push`. Prepare the commands for the human.
- Run things through `make`. If Electron starts as plain Node, `ELECTRON_RUN_AS_NODE` leaked in from the editor; the Makefile unsets it.
- After a scene or UI change, verify with `/run-office` and look at a screenshot before calling it done.
- Never install the hook into the user's real `~/.claude/settings.json` without asking. Tests use `CLAUDE_SETTINGS_FILE`.
