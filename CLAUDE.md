# CLAUDE.md

@AGENTS.md

## Rules — when they apply

| Rule                                | Apply when                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `.claude/rules/TESTING.md`          | Any behavior change (always TDD, ≥70% coverage)                                        |
| `.claude/rules/ARCHITECTURE.md`     | Touching package boundaries, sources, protocol, or office organization                 |
| `.claude/rules/PRIVACY_SECURITY.md` | Transcripts, HTTP/WS routes, auth, the hook, or anything rendering text in the browser |
| `.claude/rules/SCENE.md`            | Any three.js / layout change                                                           |
| `.claude/rules/GIT_WORKFLOW.md`     | Anything commit-related                                                                |
| `.claude/rules/CORE.md`             | Always                                                                                 |

## Skills — when to invoke

| Skill                 | Use for                                                       |
| --------------------- | ------------------------------------------------------------- |
| `/run-office`         | Launching the app and checking a change visually (screenshot) |
| `/add-event-source`   | Adding a new agent provider/source                            |
| `/protocol-change`    | Changing `AgentEvent`, inbox/reply APIs, or WS messages       |
| `/scene-change`       | Changing the 3D scene, layout or controls                     |
| `/interaction-change` | Changing the inbox, chat panel, or Claude Code hook           |

## Claude-specific notes

- Never run `git add`, `git commit` or `git push` — prepare the commands for the human.
- Run things through `make`, not ad-hoc commands.
- After a scene or UI change, verify with `/run-office` and look at a screenshot before calling it done.
