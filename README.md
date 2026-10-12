# agent-office

**Walk through your AI agents like an office.** agent-office is a desktop app (macOS, Windows,
Linux) that shows every running AI agent as a worker at a desk in a 3D office:

- Agents are grouped into **zones by provider** and **rows by conversation topic**.
- You see at a glance who is thinking, who is running a tool and who is waiting for you.
- You can **message them** without leaving the app.

![agent-office](docs/screenshot.png)

## Features

- **Live 3D office.** Claude Code, OpenAI Agents, LangGraph or your own framework each get a zone. Every conversation topic gets a row, and subagents sit next to their parent.
- **Chat with agents.** Messages go into a per-agent inbox. Claude Code sessions receive them through an opt-in hook, and any other agent can long-poll the inbox over HTTP.
- **Tray and notifications.** The app keeps running in the tray or menu bar, with live counts. You get a native notification when an agent starts waiting for you, replies, or hits an error.
- **Zero-config Claude Code.** Running sessions and their subagents appear automatically, read from the transcripts Claude Code already writes.
- **Walk mode.** First-person WASD through the office. Press `E` to talk to the agent you're looking at.
- **One-click hook setup** from Settings, with a backup of your Claude Code settings.
- **Auto-update** from GitHub Releases. See the platform notes below.

## Download

Get the latest installer from [Releases](https://github.com/arxdsilva/agent-office/releases):

| OS                              | File                 | Notes                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon and Intel) | `.dmg`               | Builds are **unsigned** until a Developer ID is configured. First launch: right-click the app → **Open**, or run `xattr -dr com.apple.quarantine /Applications/agent-office.app`. Unsigned macOS builds can't self-update, so the app shows a download link when a new version is out. |
| Windows                         | `.exe` (NSIS)        | SmartScreen may warn on first run because the build is unsigned. Auto-updates.                                                                                                                                                                                                         |
| Linux                           | `.AppImage` / `.deb` | AppImage auto-updates. `.deb` notifies you instead.                                                                                                                                                                                                                                    |

## Using it with Claude Code

1. Open agent-office. Any Claude Code session active in the last 10 minutes appears in the `claude-code` zone, in a row named after the session title.
2. **To message sessions:** ⚙ Settings → **Install hook**. You can also use the tray menu, or the button shown in the chat panel.

When you send a message:

| Session state                       | Delivery                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working (thinking or running tools) | When its current turn ends, the **Stop** hook hands Claude your message and Claude continues with it. Claude's answer is posted back to the chat when that turn finishes. |
| Idle, waiting for you               | On your next prompt in Claude Code, the **UserPromptSubmit** hook adds the message as context. Claude Code has no hook that can wake an idle session.                     |

How the hook works:

- It's a small wrapper in the app's data folder that runs the app's own binary in Node mode, so you don't need Node installed.
- It **fails open**: if the app isn't running, it exits silently within 1.5s and never blocks your session.
- Installing writes `~/.claude/settings.json.agent-office.bak` first.
- **Uninstall the hook (Settings) before deleting the app.**

**What is read from transcripts:** line types, tool names, the short Bash/Agent `description`, the model, the session title and the subagent type. Snippets are capped at 80 characters, and prompts and outputs are never shown. Nothing is logged or stored. The exception is Claude's answer to a message you sent from the app, which is shown in the chat.

## HTTP API (for any agent framework)

While the app runs, it serves a local API on `127.0.0.1:4317`; the port can be changed in Settings. Every write needs the token in `~/.agent-office/token` (created on first start, mode `0600`).

```sh
TOKEN=$(cat ~/.agent-office/token)
curl -X POST http://127.0.0.1:4317/api/events \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agentId":"lg:triage-1","name":"Triage","provider":"langgraph","topic":"Support inbox","status":"tool","tool":"search_tickets"}'
```

### Events

You can POST a single event or an array of up to 500. Events are **partial updates**: send only what changed.

| Field      | Type        | Required | Meaning                                                     |
| ---------- | ----------- | -------- | ----------------------------------------------------------- |
| `agentId`  | string ≤200 | yes      | Stable id. Namespace it, e.g. `lg:triage-1`.                |
| `name`     | string ≤100 |          | Label above the agent's head                                |
| `provider` | string ≤100 |          | Zone. Defaults to `source`, then `http`.                    |
| `topic`    | string ≤200 |          | Row. Defaults to `untitled`.                                |
| `model`    | string ≤100 |          | Shown in the chat panel                                     |
| `kind`     | string ≤100 |          | Role or type, e.g. `planner`                                |
| `parentId` | string ≤200 |          | Spawning agent; this agent sits next to it                  |
| `status`   | enum        |          | `idle` · `thinking` · `tool` · `waiting` · `error` · `done` |
| `tool`     | string ≤100 |          | Tool in use, shown when `status` is `tool`                  |
| `text`     | string ≤500 |          | Short activity line                                         |
| `source`   | string ≤50  |          | Producer name                                               |
| `ts`       | epoch ms    |          | Event time. Older events never overwrite newer state.       |

Timing rules:

- `thinking` and `tool` revert to `idle` after 60 seconds without events.
- Agents that stay silent for 10 minutes are removed.
- `done` agents leave after 30 seconds.

### Inbox: let users talk to your agent

| Method and path                                                       | Who calls it   | Purpose                                                  |
| --------------------------------------------------------------------- | -------------- | -------------------------------------------------------- |
| `GET /api/agents/:id/inbox?claim=1&wait=25`                           | Your agent     | Long-poll; returns `{messages}` and marks them delivered |
| `POST /api/agents/:id/replies` `{text, inReplyTo?, requireAwaiting?}` | Your agent     | Answer; the app shows it and marks the message replied   |
| `POST /api/agents/:id/messages` `{text}`                              | Scripts or CLI | Queue a message (the app itself uses IPC)                |
| `GET /api/agents`, `GET /api/agents/:id/messages`, `GET /api/health`  | Anyone local   | Read-only                                                |

```python
import json, os, urllib.request

BASE = "http://127.0.0.1:4317/api/agents/lg%3Atriage-1"
TOKEN = open(os.path.expanduser("~/.agent-office/token")).read().strip()

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=body and json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")

while True:
    for msg in call("GET", "/inbox?claim=1&wait=25")["messages"]:
        answer = f"on it: {msg['text']}"          # ← hand the message to your agent here
        call("POST", "/replies", {"text": answer, "inReplyTo": msg["id"]})
```

## Security

The app can inject text into live agent sessions, so it is locked down:

- **Local API**
  - It binds to `127.0.0.1` only.
  - Requests with a foreign `Host` get 421, which blocks DNS rebinding.
  - Requests from a foreign `Origin` get 403.
  - Writes need the bearer token (401 otherwise).
  - All input is validated with zod, with size limits and a message rate limit.
  - The API serves no web page and no WebSocket.
- **Electron**
  - The renderer is sandboxed and context-isolated, with no Node integration.
  - The production CSP is `script-src 'self'; connect-src 'none'`.
  - Navigation and popups are blocked, and only the pointer-lock and notifications permissions are allowed.
  - Every IPC payload is validated and its sender is checked.
- **Agent text** is always rendered as text, never as HTML.

The token protects you from websites. It does not protect you from other programs running as your user.

## Controls

| Input                     | Action                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| Drag / scroll             | Orbit and zoom                                                               |
| Click a name tag or agent | Open the chat and focus the camera                                           |
| `⤢ Fit`                   | Frame the whole office                                                       |
| `F` or `🚶 Walk`          | First-person mode: WASD to move, Shift to sprint, `E` to talk, `Esc` to exit |
| `⚙`                       | Settings: hook, notifications, open at login, API port, updates              |
| Closing the window        | Keeps running in the tray. Quit from the tray menu or with ⌘Q.               |

## Architecture

agent-office uses a **hexagonal architecture** (ports and adapters), enforced by `make arch`:

```
 driving adapters ─▶  HttpApi · IpcApi · ClaudeCodeTailer · MockAgents
                         │ driving ports (ReportActivity, AgentInbox, UserChat, OfficeQuery, …)
 core (pure)       ─▶  domain rules + use cases          ← no Node, Electron, Fastify or three.js
                         │ driven ports (AgentRepository, Notifier, Updater, Scheduler, HookRunner, …)
 driven adapters   ─▶  in-memory repos · JSON settings · Claude settings file · Electron tray/notifications/updater
 composition root  ─▶  packages/desktop/src/main/composition.ts
```

| Package             | Contents                                                                     |
| ------------------- | ---------------------------------------------------------------------------- |
| `packages/shared`   | Contracts: HTTP and IPC schemas, status colors, grouping strategy            |
| `packages/core`     | Domain, use cases, ports, plus a test kit of contract suites and fakes       |
| `packages/adapters` | Node adapters: HTTP API, transcript tailer, mock agents, file system, memory |
| `packages/desktop`  | Electron main process, preload, composition root, packaging, app E2E tests   |
| `packages/web`      | Renderer: three.js scene and DOM views behind ports, driven by a controller  |

Office organization lives in one place, `byProviderAndTopic` in `packages/shared/src/grouping.ts`. Swap it to reorganize the office.

## Building from source

Requires Node 22+ and pnpm (`corepack enable`).

```sh
make install
make dev-mock        # app window with hot reload, simulated agents and your live Claude Code sessions
make check           # format, typecheck, arch, unit tests with ≥70% coverage, E2E, build (what CI runs)
make build test-ui   # Playwright drives the built Electron app
make package         # unpacked app for this OS → packages/desktop/dist
make package-dist    # installers for this OS
```

- **TDD:** every behavior change starts with a failing test.
- **Contract suites:** every driven-port implementation passes its port's contract suite.
- **Coverage:** at least 70% per package.
- **Releases:**
  1. Run `make release VERSION=x.y.z`. It sets the version and prints the tag commands.
  2. Pushing the tag builds installers on macOS, Windows and Linux into a **draft** GitHub release.
  3. Signing is used automatically when the `CSC_*` and `APPLE_*` secrets exist.

Working with an AI assistant? Start from [`AGENTS.md`](AGENTS.md), which has the architecture, glossary, rules and definition of done. Claude Code users also get project skills: `/run-office`, `/add-port-adapter`, `/add-event-source`, `/protocol-change`, `/scene-change`, `/interaction-change` and `/desktop-change`.

## Roadmap

- Office organization v2 (the grouping strategy is pluggable)
- Persistence and replay, as a new `AgentRepository` adapter
- OpenTelemetry GenAI spans as a source
- Code signing and notarization for macOS releases
- Custom avatars and office themes

## License

[MIT](LICENSE)
