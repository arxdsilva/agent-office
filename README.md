# agent-office

**agent-office. Your projects. Every agent. One shared memory.**

An agent is temporary. A project is persistent. agent-office is a desktop app (macOS, Windows, Linux) that keeps your projects, their sessions, memory, decisions, tasks and handoffs in one encrypted local place, and shows the agents working on them in a 3D or 2D office.

![The Project Dashboard: active agents, recent activity, completed work, tasks and project knowledge for one project](docs/screenshots/project-dashboard.png)

<table>
<tr>
<td width="50%"><img src="docs/screenshots/office-3d-projects.png" width="100%" alt="The 3D office with a project selected: its agents are highlighted in their wing"></td>
<td width="50%"><img src="docs/screenshots/office-2d-projects.png" width="100%" alt="The 2D RPG office with the same project selected"></td>
</tr>
<tr>
<td>The 3D office, focused on one project.</td>
<td>The same project in the 2D RPG view.</td>
</tr>
</table>

## Why agent-office

Coding agents start fresh every time. You re-explain the same decisions, a session ends and its context is gone, and a second tool knows nothing about what the first one did.

- **Projects outlive agents.** A project holds its repositories, sessions, memory, decisions, tasks and handoffs. All of it stays readable when every agent is offline and after a restart.
- **Memory you control.** Knowledge is kept as reviewable items with provenance. Agents can propose memory; only you approve it.
- **Any provider, one place.** Claude Code, Codex, Cursor, Gemini, Copilot and any HTTP agent share the same projects. You can hand a task from one provider to another with a reviewed bundle.
- **Local and encrypted.** Project data lives in an encrypted vault on your machine. Provider transcripts are referenced, not copied.
- **The office is still here.** Agents are shown as workers in a 3D (or 2D) office, grouped by provider and conversation topic, so you can see at a glance who is working, waiting for you, or stuck.

## Projects-first workspace

The app opens on the **Overview** once a project exists; the `startView` setting can pick the Overview or the Office instead.

- **Overview:** every project, the agents waiting for you, recent completions and decisions, pending approvals, unfinished handoffs, unassigned sessions, and whether the vault is encrypted.
- **Project Dashboard:** one project: active agents, recent activity, completed work, tasks, and knowledge (memory by kind). Actions start an agent, open memory or sessions, or prepare a handoff.
- **Sidebar:** Overview, Office, Projects, Sessions, Memory, and the project list with counts.
- **Command palette:** `Cmd+K` (`Ctrl+K` on Windows and Linux) searches projects, sessions and memory, and runs actions.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/overview.png" width="100%" alt="The Global Overview: project cards with active agents, pending reviews and recent activity"></td>
<td width="50%"><img src="docs/screenshots/palette.png" width="100%" alt="The command palette (Cmd+K) listing projects, sessions and actions"></td>
</tr>
<tr>
<td>The Overview across all projects.</td>
<td>The command palette.</td>
</tr>
</table>

Projects are found from repositories, not folder names. Several repositories can belong to one project, and a session whose repository matches nothing stays **unassigned** until you decide. Details: [`docs/projects.md`](docs/projects.md).

## Shared Memory and the Context Engine

Memory items have a **scope** (`global`, `project`, `session`, and an experimental `workspace`), a **kind** (instruction, constraint, decision, fact, note) and a **state**.

- **Review and approval.** New items, including ones an agent proposes, start as `pending`. You approve, reject, edit, merge or supersede them. Edits keep earlier versions.
- **Provenance.** Each item records where it came from: a Session Vault message, an imported note, or an agent proposal (shown with an "agent-proposed" badge).
- **Project MCP server.** Managed sessions can retrieve approved memory through a local MCP server with the tools `search_memory`, `get_project_context`, `list_decisions` and `propose_memory`. Each session gets its own scoped token, revoked when the session ends. Results are labelled as reference data, not instructions.
- **Context Engine.** It ranks the approved items a session may read (kind, scope, relevance to the objective, recency, pinned first) into a bundle with a size budget. Every item says why it was included or left out.
- **Context Inspector.** For an agent it separates what is **available** (what the project policy exposes), what was **retrieved** (real MCP calls), and what was **delivered** (bundles agent-office put into a first message or handoff). It never claims what a model used internally.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/project-memory.png" width="100%" alt="Project memory: items by kind and state, with approve, reject and edit actions and provenance"></td>
<td width="50%"><img src="docs/screenshots/context-inspector.png" width="100%" alt="The Context Inspector: available, retrieved and delivered context for one agent"></td>
</tr>
<tr>
<td>Memory review: pending items wait for your approval.</td>
<td>The Context Inspector: available, retrieved, delivered.</td>
</tr>
</table>

## Sessions and Handoffs

Every agent session becomes a **session record** that stays after the agent leaves. Its origin is **managed** (started in agent-office), **observed** (started elsewhere) or **imported** (past Claude Code history, experimental).

- **Session Vault:** browse sessions by project, provider and state, read agent-office's chat for a session, and open an old Claude Code session by reading its own transcript on demand.
- **Search:** deep search across sessions and memory.
- **Save as memory:** turn any Session Vault message into a memory draft that keeps the session and message as provenance.
- **Handoff:** pick a session and a target provider, set an objective, review the context bundle that will be sent, and launch a managed session with it. The bundle is what you reviewed, nothing else. Handoffs need the target provider to have a managed runtime.
- **Tasks:** you create tasks and confirm them. Each shows an evidence level (`agent-reported`, `user-confirmed`). Agents never write tasks.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/session-vault.png" width="100%" alt="The Session Vault: a session's messages with a Save as memory action"></td>
<td width="50%"><img src="docs/screenshots/handoff.png" width="100%" alt="The handoff dialog: objective, target provider and the context bundle to review"></td>
</tr>
<tr>
<td>The Session Vault, with Save as memory.</td>
<td>A cross-provider handoff with a reviewed bundle.</td>
</tr>
</table>

## 2D and 3D: projects in the office

The office is not a separate product: it shows the same projects. Both renderers use the same commands and panels.

- **Project Hub:** the atrium room with the **Project Directory** kiosk. Walk up to it (or use the reception desk) to pick a project; the office focuses its agents and flies to its main wing.
- **Context Hub core:** a glowing column ringed by six consoles. It is the project MCP station; it pulses only when a real memory retrieval happens.
- **Handoff Station:** a pad in the plaza where two visitors face each other. It is a place in the building; handoffs themselves are started from the agent panel or a project.
- **Session Archive:** twelve arched alcoves between the Project Hub and the plaza. They are placed in the building but do not show content yet. With a project selected, the Library shelves already show archive volumes by time bucket (never one book per record).
- The LED wall shows the selected project's counts.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/project-directory-3d.png" width="100%" alt="The Project Directory kiosk in the 3D atrium"></td>
<td width="50%"><img src="docs/screenshots/project-directory-2d.png" width="100%" alt="The Project Directory kiosk in the 2D RPG view"></td>
</tr>
<tr>
<td>The Project Directory in 3D.</td>
<td>The Project Directory in 2D.</td>
</tr>
</table>

Layout contract: [`docs/graphics-contract.md`](docs/graphics-contract.md). Room details: [`docs/projects.md`](docs/projects.md) §10.

## The office

![The whole office from above: the atrium, Main Street and three provider wings](docs/screenshots/hero-overview.png)

<img src="docs/screenshots/walkthrough.webp" width="100%" alt="A camera fly-through: the atrium, Main Street, then the claude-code wing with its desks, meeting room, Adapters room and Library">

- **Live 3D office.** Each provider gets a themed wing. Every topic gets a desk pod, and agents walk to meeting rooms, phone booths, the kitchen and the game area to act out what they do.
- **Talk to agents.** Messages go into a per-agent inbox ([Talk to agents](#talk-to-agents)). Start managed sessions with permission cards ([Managed sessions](#managed-sessions)).
- **Adapters room and Library.** Stations show what an agent can reach; skills, rules and memory titles are books, boards and notebooks ([Adapters](#adapters), [Library](#library)).
- **2D RPG mode, walk mode, tray and notifications, graphics presets, light and dark themes.** See the sections below.

## Tour

The office is one floor of a headquarters building. Where an agent is tells you what it is doing; name tags and the chat panel say it in words too, for example "In meeting room A with 2 subagents" or "Waiting for you in booth 3".

<table>
<tr>
<td width="50%"><img src="docs/screenshots/atrium-reception.png" width="100%" alt="Agents stepping out of an elevator and walking past reception"></td>
<td width="50%"><img src="docs/screenshots/atrium-cafe-ledwall.png" width="100%" alt="The cafe tables under the LED stats wall"></td>
</tr>
<tr>
<td><b>Atrium.</b> New agents step out of the elevators and check in at reception. Finished agents walk back and leave.</td>
<td>Idle agents take a coffee at the cafe; the LED wall counts agents, work, waits and meetings live.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/main-street.png" width="100%" alt="Main Street from above, with an agent walking to its wing"></td>
<td width="50%"><img src="docs/screenshots/game-area.png" width="100%" alt="Two ping-pong matches in the game area"></td>
</tr>
<tr>
<td><b>Main Street.</b> The boulevard between the wings.</td>
<td>The game area: two agents on a long idle break pair up for ping-pong.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/wing-terracotta.png" width="100%" alt="The claude-code wing in the terracotta theme"></td>
<td width="50%"><img src="docs/screenshots/themes-gallery.png" width="100%" alt="The six wing themes side by side"></td>
</tr>
<tr>
<td><b>Wings.</b> <code>claude-code</code> in terracotta: desk pods by topic, booths, meeting rooms, kitchen and lounge. A provider with more than 24 agents gets an annex wing.</td>
<td>Six themes: terracotta, nordic, forest, ocean, brass and neon. Wing signs show the provider id as plain text.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/desk-pod.png" width="100%" alt="A desk pod with agents typing and thinking"></td>
<td width="50%"><img src="docs/screenshots/error-state.png" width="100%" alt="An agent scratching its head at a red monitor"></td>
</tr>
<tr>
<td><b>Desks.</b> One pod per topic: agents type (amber monitor, running a tool) or think (blue).</td>
<td>An agent that hit an error stands up and scratches its head at a red monitor.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/meeting-room.png" width="100%" alt="A parent agent and two subagents around the meeting table"></td>
<td width="50%"><img src="docs/screenshots/phone-booth.png" width="100%" alt="Two agents on the phone in booths with green lights"></td>
</tr>
<tr>
<td><b>Meeting rooms.</b> A parent agent and its active subagents work as a team in room A or B.</td>
<td><b>Phone booths.</b> A green light means the agent finished its turn and is <strong>waiting for you</strong>. Click it to reply.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/kitchen-lounge.png" width="100%" alt="Idle agents at the kitchen island and on the lounge sofas"></td>
<td width="50%"><img src="docs/screenshots/elevator-arrival.webp" width="100%" alt="Clip: new agents arrive through the elevators and walk past reception to their wings"></td>
</tr>
<tr>
<td><b>Kitchen and lounge.</b> After 45 seconds idle, agents take a break here or at the cafe.</td>
<td><b>Arrival.</b> New agents arrive through the elevators and walk to their wing.</td>
</tr>
</table>

## Talk to agents

Click an agent (or its name tag) to open the chat panel: the camera follows it, the panel says
what it is doing, and you can send it a message. Delivery state shows as ✓ (delivered to the
agent) and ✓✓ (replied).

<table>
<tr>
<td width="50%"><img src="docs/screenshots/chat-panel.png" width="100%" alt="The chat panel next to the selected agent, with a message and its reply"></td>
<td width="50%"><img src="docs/screenshots/chat-roundtrip.webp" width="100%" alt="Clip: typing a message, the hook delivering it, and the agent's answer arriving"></td>
</tr>
<tr>
<td>The chat panel: activity, model, connections and skills used, and the thread.</td>
<td>A round trip: the hook hands Claude the message when its turn ends and posts the answer back.</td>
</tr>
</table>

**Delivery hint.** The panel says exactly how a message will reach the agent:

| Agent                                                   | Hint                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claude Code, hook not installed                         | "Not connected: install the Claude Code hook…" with **Install hook**                    |
| Claude Code, hook installed, session not checked in yet | "Hook installed ✓ · This session checks in after its current turn or your next prompt." |
| Claude Code, connected                                  | When the message is delivered (end of the current turn, or your next prompt)            |
| Subagent                                                | "Subagents can't read messages. Message its parent instead." with **Open parent**       |
| Managed session                                         | None: messages go straight in                                                           |

**Context and tools.** Every composer has **+ Context** (files or folders from a native picker) and **Use…** (Chrome browser, MCP servers, built-ins, skills). The agent receives the absolute paths and a "use these tools" line with your message; the app shows only file names. Terminal sessions get them through the hook as text.

**Mode and model.** Every Claude Code agent shows its permission mode and model. Terminal sessions show them read-only (they report their mode through the hook); change them in the terminal (Shift+Tab, `/model`).

## Managed sessions

Start Claude Code from agent-office: **⊕ New session** (top right), pick a folder, a model and a mode, and write the first message. The session runs with your own Claude Code login and settings, through the installed `claude` CLI, on this machine.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/new-session.png" width="100%" alt="The New Claude Code session dialog: folder, name, model, mode, extra folders, Chrome and the first message"></td>
<td width="50%"><img src="docs/screenshots/managed-session.png" width="100%" alt="A managed session's panel with the mode menu open, and a folder and Chrome browser attached to the next message"></td>
</tr>
<tr>
<td>New session: folder, model, mode, extra folders and an optional Chrome browser.</td>
<td>Switch mode (Default, Accept edits, Plan, Auto, Don't ask) and model live, and attach context.</td>
</tr>
</table>

![A permission card: Bash pnpm test, with Allow once, Always allow Bash this session, and Deny](docs/screenshots/permission-card.png)

- **Mode and model** change live, for the rest of the session. Each change is noted in the thread.
- **Permission cards:** when the session needs approval (Default mode), the agent waits in a phone booth and the panel shows a short summary, never the raw tool input: **Allow once**, **Always allow \<tool\> this session**, or **Deny**.
- **Interrupt** stops the current turn; **Stop** ends the session (the agent leaves by elevator). Quitting the app asks before stopping running sessions.
- **Bypass permissions** mode is hidden unless you turn on Settings → "Allow Bypass permissions mode" (with a confirmation).
- Up to 6 sessions run at once. They end when the app quits.
- Needs Claude Code installed and signed in (`claude`, then `/login`).

## Appearance

Settings → **Appearance**: System (default), Light or Dark. Everything follows it: panels, name tags, the loading screen, the window and the 3D scene's background. Both themes have the same features, and text contrast is at least 4.5:1 in each (checked by `desktop/e2e/theme.spec.ts`).

![The same managed session panel in the light and dark themes](docs/screenshots/themes.png)

## Adapters

Every wing has an **Adapters room**: one **station** per connection its agents can use. Each
station's screen lists what it **can see** (for example `project: shop-api`, `cmd: git`,
`host: docs.example.com`) and its tools; a ring on the floor lights up in the connection's color
while it's in use.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/adapters-room.png" width="100%" alt="The Adapters room: eight stations around the core column, agents working at three of them"></td>
<td width="50%"><img src="docs/screenshots/adapters-links.png" width="100%" alt="Agents at their desks calling tools, with links to the Adapters room"></td>
</tr>
<tr>
<td>Stations: Filesystem, Shell, Web, Subagents, then MCP servers, APIs and databases.</td>
<td>A tool call draws a flowing link from the agent's desk to the station, colored by kind.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/adapters-visit.png" width="100%" alt="An agent working standing at the Mail station"></td>
<td width="50%"><img src="docs/screenshots/connection-panel.png" width="100%" alt="The connection panel for the Web station"></td>
</tr>
<tr>
<td>Sustained use: the agent walks to the station and works there standing.</td>
<td>Click a station for its panel: what it can see, its tools, who uses it and how often.</td>
</tr>
</table>

<img src="docs/screenshots/adapter-link.webp" width="100%" alt="Clip: a web call raises a link from a desk to the Web station; with sustained use the agent walks there">

- **Call vs visit.** A tool call that uses a connection shows a link while the tool runs (plus a
  0.6 s fade); the agent stays at its desk. Using the same connection for 20 s continuously, or 4
  times within 60 s, sends the agent to the station. It returns after 8 s without use.
- **Where connections come from:**
  - **Built-ins** for Claude Code: Filesystem, Shell, Web and Subagents.
  - **Configured MCP servers:** only the server **names** from `~/.claude.json` (never commands,
    arguments or env). `claude_ai_*` connectors appear once used.
  - **Observed tools:** a tool used but not declared appears as an undeclared station.
  - **Declared by any framework** through the HTTP API (below).
- **Privacy:** sources send only names, host names, project basenames and the first word of a
  command (`cmd:git`); never URLs, paths, arguments, command lines, file contents or env values.
  See [`docs/capabilities.md`](docs/capabilities.md).

```sh
TOKEN=$(cat ~/.agent-office/token)
curl -s -X POST http://127.0.0.1:4317/api/providers/langgraph/capabilities \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[
    {"id": "mcp:postgres", "category": "adapter", "kind": "database", "label": "Postgres", "sees": ["db: analytics"]},
    {"id": "api:chat", "category": "adapter", "kind": "api", "label": "Chat", "tools": ["post_message"]}
  ]'
# A tool call that uses it: classified from tool + target, or named explicitly with "capability".
curl -s -X POST http://127.0.0.1:4317/api/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId": "bot-1", "provider": "langgraph", "status": "tool", "tool": "run_query", "capability": "mcp:postgres"}'
```

## Library

Next to the Adapters room, every wing has a **Library**: the provider's **skills** are books with
readable spines, its **rules** are boards on the wall with their title and first sentence, and
its **memory** entries are notebooks on a rack. There's a reading table for agents who need to
sit down with a book.

**📚 Library** (top right) lists all of it, for any provider: Skills, Rules, Memory and Adapters tabs, with search, scope, summary and usage. That includes the items that don't fit on the shelves ("Not on a shelf"). Pick one and the camera flies to it, close enough to read, and its panel opens. In the 3D view, hover a spine, board, notebook or station to see its name, and click it to open it. The **Library ▾** and **Adapters ▾** view buttons fly to any provider's rooms, including a head-on **Rules wall** view.

![The Library browser next to a close-up of the skill shelves, with the picked skill's panel open](docs/screenshots/library-browser.png)

<table>
<tr>
<td width="50%"><img src="docs/screenshots/library-room.png" width="100%" alt="The Library: shelves of skill books, rule boards on the wall, two agents reading at the table"></td>
<td width="50%"><img src="docs/screenshots/library-call.png" width="100%" alt="Agents consulting a skill and reading a rule from their desks"></td>
</tr>
<tr>
<td>Skill books on the shelves, rule boards on the wall, the reading table.</td>
<td>Consulting a skill or reading a rule from the desk: a stream of pages, and the spine or board glows.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/library-reading.png" width="100%" alt="An agent reading a skill book at the table"></td>
<td width="50%"><img src="docs/screenshots/capability-panel-skill.png" width="100%" alt="The capability panel for a skill"></td>
</tr>
<tr>
<td>Several uses in a row: the agent picks the book from the shelf and reads it at the table.</td>
<td>Click a book, board or notebook: its description, scope and who used it.</td>
</tr>
</table>

<img src="docs/screenshots/library-visit.webp" width="100%" alt="Clip: an agent invokes a skill, reads a rule, then walks to the Library, picks the book and sits down to read">

- **What's discovered** (Claude Code; Settings → "Discover capabilities"):
  - **Skills:** `~/.claude/skills`, the project's `.claude/skills` and plugin skills: name and
    description (first 160 characters).
  - **Rules:** the project's `CLAUDE.md`, `AGENTS.md` and `.claude/rules/*.md`, and your
    `~/.claude/CLAUDE.md` and `~/.claude/rules`: title and first sentence.
  - **Memory:** titles only, never the content.
- **Call vs visit.** A `Skill` call or a `Read` of a rule glows its book or board for 6 s and
  draws a page link; the agent stays put. Two different skills or rules within 60 s (or a skill
  while idle or thinking for 10 s) send the agent to the Library to pick the book and read. It
  returns after 10 s without library use.
- **Other frameworks** declare skills and rules with the same capabilities API, and report use
  with `"tool": "Skill", "target": "skill:<name>"` or `"tool": "Read", "target": "rule:project:<file>"`:

```sh
curl -s -X POST http://127.0.0.1:4317/api/providers/langgraph/capabilities \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[
    {"id": "skill:triage", "category": "skill", "kind": "skill", "label": "triage", "summary": "Sort incoming tickets."},
    {"id": "rule:project:AGENTS.md", "category": "rule", "kind": "project-rules", "label": "AGENTS.md (support-bot)", "scope": "project"}
  ]'
```

## Tray and notifications

The app keeps running in the tray (menu bar on macOS) when you close the window. The tray menu
shows live counts per status, the agents waiting for you, and shortcuts to the hook and settings.
A native notification tells you when an agent starts waiting, replies to you, or hits an error;
click it to jump to that agent.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/tray-menu.png" width="100%" alt="The macOS menu-bar menu with live agent counts"></td>
<td width="50%"><img src="docs/screenshots/notification.png" width="100%" alt="A native notification: an agent is waiting for you"></td>
</tr>
<tr>
<td>The tray menu: counts, who's waiting, hook and settings.</td>
<td>A notification when an agent waits for you.</td>
</tr>
</table>

## Settings

⚙ Settings: install or remove the Claude Code hook, turn sessions and capability discovery on or
off, notifications, open at login, the local API port, the graphics preset (with the live frame
rate) and updates.

![The settings dialog](docs/screenshots/settings.png)

## Walk mode

Press `F` or **🚶 Walk** to walk through the office in first person: WASD to move, Shift to
sprint, `E` to talk to the agent (or open the station, book or board) under the crosshair, and
`Esc` to go back to orbiting. Ceilings appear while you walk.

![First-person view inside the claude-code wing](docs/screenshots/walk-mode.png)

## Graphics

⚙ Settings → **Graphics** picks a quality preset. Everything applies immediately and is saved with your settings.

| Preset  | For                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto    | The default. Starts from what your computer can do (software rendering → Minimal, integrated graphics → Low, Apple M1/M2 → Medium, faster GPUs → High), then steps down or up to keep the frame rate smooth, never above that starting tier. |
| Minimal | Very old or software-rendered computers: 30 fps, ¾ resolution, no shadows or effects, name tags only nearby, static links, the smallest lightmaps.                                                                                           |
| Low     | Laptops with integrated graphics: 60 fps, contact shadows only, no post-processing, nearby name tags, half-size lightmaps.                                                                                                                   |
| Medium  | Balanced: soft shadows, glow and anti-aliasing.                                                                                                                                                                                              |
| High    | Ambient occlusion and sharper shadows, up to Retina pixel density.                                                                                                                                                                           |
| Ultra   | Native pixel density, the largest shadow maps and more animated characters at full detail.                                                                                                                                                   |

![Settings → Graphics: quality, the live frame rate and GPU memory, power saver, and the Advanced options](docs/screenshots/graphics-settings.png)

- **Live numbers:** "Now" shows the frame rate, the preset in force, an estimate of GPU memory and the drawing size.
- **Power saver:** 15 fps while the window isn't focused, no rendering while it's hidden or minimized, and optionally a lighter preset on battery.
- **Advanced:** override single features on top of the preset: resolution, frame-rate limit, shadows, effects, character detail, name tags (all, nearby, or only the selected agent), capability links (animated, static or off) and building detail. "(custom)" marks overrides; **Reset to preset** clears them.
- **If 3D can't start** (no WebGL), a card explains it and offers software rendering on Windows and Linux. macOS has no software WebGL fallback, so that option isn't offered there.
- **Smaller on the GPU:** textures shared across the building are loaded once, and lightmaps come in three sizes picked by the preset.

Low (left) and Ultra (right), same view:

![The same desk pod at the Low and Ultra presets](docs/screenshots/quality-compare.png)

## 2D RPG mode (optional)

Prefer pixels? The **3D Office | 2D RPG** switch (top right) shows the **same live office** as a GBA-style, top-down pixel-art world. It's an extra view, not a replacement: the 3D office stays the default, and switching doesn't restart agents or lose chats, sessions or permissions.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/pixel-wing.png" width="100%" alt="The 2D RPG mode: the player character in a provider wing, with agents, name tags and status icons"></td>
<td width="50%"><img src="docs/screenshots/pixel-dialogue.png" width="100%" alt="An RPG dialogue box for an agent, with Talk, Details and Follow"></td>
</tr>
<tr>
<td>Walk the office with WASD or the arrow keys. Agents act out their real status.</td>
<td>Walk up to an agent and press <b>E</b>: Talk opens the usual chat panel.</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/screenshots/pixel-overview.png" width="100%" alt="The whole 2D office from above: lobby, Main Street and three themed wings, labelled"></td>
<td width="50%"><img src="docs/screenshots/pixel-minimap.png" width="100%" alt="The 2D minimap: rooms, walls, wing and room labels, agents by status, the player and the camera's view"></td>
</tr>
<tr>
<td><b>O</b>: the overview, a labelled floor plan. Click to pan; keep walking while it's open.</td>
<td><b>M</b>: the minimap. Click to pan there, Shift-click to travel.</td>
</tr>
</table>

![Zoomed out in 2D: two wings, Main Street and the atrium on one screen, at crisp whole-pixel scale](docs/screenshots/pixel-zoomed-out.png)

![The 2D Library: bookshelves for skills and boards for rules](docs/screenshots/pixel-library.png)

- **The same agents, the same places:** agents arrive by elevator, sit at their pod, meet with their subagents, wait in phone booths, visit the Library and the Adapters room, and leave by elevator, exactly as in 3D. The 2D view draws the same decisions.
- **Talk to agents:** **E** (or a click) opens a dialogue. **Talk** opens the regular chat panel, with history, context, tools, and a managed session's mode, model and permission card. Subagents point you to their parent.
- **Library and Adapters:** E on a bookshelf, board or station opens its details or the Library browser.
- **Never miss a request:** alerts at the top right ("! Ada is waiting for you", "needs approval") take you there. **M** opens the minimap, **J** a directory with fast travel, **O** the overview, and the mouse wheel zooms.
- **Walk in every view:** you can keep moving while the overview is open, while following an agent, and with the chat panel or Library open (typing in a text field never moves you). **Space** or **Esc** brings the camera back to you.
- **What you see is what blocks:** furniture collides exactly where it's drawn, walls sit where they are in 3D, and every corridor and door the agents use is walkable.
- **GBA scale:** 16 px per metre, so one screen shows most of a wing and the office is a short walk across. Every desk, booth and chair is exactly where it is in 3D. Walk at 3 m/s, sprint with Shift, **R** to run by default, and **-** / **=** (or − ⌂ + in the HUD) to zoom out in crisp steps down to most of the office.
- Original pixel art (no third-party sprites), 16 px tiles, crisp integer scaling. It runs at 120 fps with 36 MB of textures, and works without WebGL.

How it's built (one `SceneView` port, two renderers): [docs/2d-architecture.md](docs/2d-architecture.md).

## Characters

Every agent is one of a family of hand-made characters (varied skin tones, hair, glasses,
headsets and badges), modeled, rigged and animated in Blender by committed scripts. They have 22
in-place animation clips, blended with crossfades: typing, thinking, talking, phoning, drinking
coffee, lounging, ping-pong, waving, walking, stepping out of the elevator, working at a station,
picking a book from the shelf and reading.

![The character lineup and one frame of 16 of the animation clips](docs/screenshots/characters.png)

## Providers

agent-office can **manage** sessions it starts and **observe** sessions you start elsewhere. It uses each provider's documented interface and your own CLI login; it never stores credentials. Each provider gets its own wing.

![Connect → Providers: one card per AI provider with its version, state, capabilities and setup actions](docs/screenshots/providers.png)

| Provider             | Observe                                             | Managed sessions                      | Project MCP memory                   | Native resume |
| -------------------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------ | ------------- |
| Claude Code          | Yes (transcripts, opt-in inbox hook)                | Yes (Claude Agent SDK)                | Yes (verified with 2.1.270)          | Experimental  |
| Codex                | No (no documented surface)                          | Yes (`codex app-server`)              | Yes (verified with 0.162.1)          | No            |
| Cursor               | Yes, read-only (hooks)                              | Yes (`agent acp`)                     | Experimental (ACP)                   | No            |
| Gemini CLI           | Yes, read-only (hooks)                              | Yes (`gemini --acp`)                  | Experimental (ACP)                   | No            |
| GitHub Copilot       | Yes, read-only (hooks)                              | Yes (`copilot --acp`, public preview) | Experimental (ACP)                   | No            |
| ChatGPT              | No                                                  | No (disabled)                         | No                                   | No            |
| HTTP / any framework | Yes ([HTTP API](#http-api-for-any-agent-framework)) | No                                    | No (observed sessions never get MCP) | No            |

Observed sessions never get project memory over MCP; only managed sessions do. Tested CLI versions and the capability matrix: [`docs/provider-integrations.md`](docs/provider-integrations.md).

**To enable one:** install its CLI and log in with the CLI's own command, then open **🔌 Connect → Providers**, turn the provider on and press **Check again**. A **Ready** card means you can start a session with **⊕ New session**. For Cursor, Gemini and Copilot you can also click **Install hooks** to see sessions you start in their own terminal or IDE. Detection never starts a session.

Limitations:

- **Codex sessions started outside agent-office are not visible.** Start Codex sessions from the app.
- **ChatGPT is disabled.** It needs a public HTTPS endpoint or OpenAI's MCP tunnel.
- **Observed Cursor, Gemini and Copilot sessions are read-only.** You can't message, interrupt or approve them from the app. Cursor subagents aren't shown. Cursor and Copilot hooks are still pending a real-CLI check, and Gemini real sessions need a login.
- Extra folders aren't sent to ACP agents (none of the tested CLIs accepts them).
- Modes that skip approvals (Codex Full access, Gemini Auto-approve, Copilot Autopilot) need Settings → "Allow Bypass permissions mode".

`make verify-providers` re-checks the real CLIs on your machine (it uses your accounts).

## Install and quick start

### Download

Get the latest installer from [Releases](https://github.com/arxdsilva/agent-office/releases):

| OS                              | File                 | Notes                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon and Intel) | `.dmg`               | Builds are **unsigned** until a Developer ID is configured. First launch: right-click the app → **Open**, or run `xattr -dr com.apple.quarantine /Applications/agent-office.app`. Unsigned macOS builds can't self-update, so the app shows a download link when a new version is out. |
| Windows                         | `.exe` (NSIS)        | SmartScreen may warn on first run because the build is unsigned. Auto-updates.                                                                                                                                                                                                         |
| Linux                           | `.AppImage` / `.deb` | AppImage auto-updates. `.deb` notifies you instead.                                                                                                                                                                                                                                    |

### Connect your agents

Open the app. If the office is empty, a card offers three ways in. The **🔌 Connect** button (next to ⚙) shows the same choices at any time, with live status for each:

| Way in            | What you do                                                                                                                                                                              | You'll see                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**   | Nothing: run `claude` in any project. To message sessions from the app, click **Install** under "Let me message agents".                                                                 | "● 1 active session". The agent walks in through the elevator to the `claude-code` wing.                                      |
| **Any framework** | Copy the ready-made curl, Python or JavaScript snippet from **Connect → Any framework** into your agent. It already has the right port and reads the token from `~/.agent-office/token`. | "✓ Received from `<provider>`". The provider's wing appears. **Send a test agent** checks the whole path from inside the app. |
| **Demo**          | **Try the demo**                                                                                                                                                                         | 9 sample agents across 3 providers, to explore the rooms, links and chat                                                      |

<table><tr>
<td><img src="docs/screenshots/empty-state.png" alt="An empty office: a card offers Claude Code, any framework over HTTP, or a demo, each with live status" width="100%"></td>
<td><img src="docs/screenshots/connect-panel.png" alt="The Connect panel on the Any framework tab: endpoint, token location, a copyable curl snippet and a received-event confirmation" width="100%"></td>
</tr></table>

The **Connected** tab lists every provider, its agent count and how it's connected (transcripts, hook, HTTP or demo), with a button to fly to its wing. If port 4317 is taken, the Any framework tab says so and lets you pick another port. The Claude Code hook follows the new port automatically.

### Using it with Claude Code

1. Open agent-office. Any Claude Code session active in the last 10 minutes appears in the `claude-code` wing, at a desk pod named after the session title. Its subagents sit next to it, and join it in a meeting room while they work.
2. **To message sessions:** 🔌 Connect → Claude Code → **Install**. You can also use ⚙ Settings, the tray menu, or the button shown in the chat panel.

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

**Capabilities:** the wing's Adapters room shows the built-in connections and the names of your configured MCP servers; its Library shows your skills, rules and memory titles (see [Adapters](#adapters) and [Library](#library)). Turn this off in Settings → "Discover capabilities".

**What is read from transcripts:** line types, tool names, the short Bash/Agent `description`, the model, the session title and the subagent type. For capabilities, only the tool's target in a short form: a project basename, a host name, the first word of a Bash command, or a skill, rule or memory name. Snippets are capped at 80 characters, and prompts and outputs are never shown. Nothing is logged or stored. The exception is Claude's answer to a message you sent from the app, which is shown in the chat.

![Claude Code sessions in the claude-code wing](docs/screenshots/wing-terracotta.png)

## HTTP API (for any agent framework)

While the app runs, it serves a local API on `127.0.0.1:4317`; the port can be changed in Settings or in **Connect → Any framework**, which also has a ready-made snippet for curl, Python and JavaScript. Every write needs the token in `~/.agent-office/token` (created on first start, mode `0600`).

```sh
TOKEN=$(cat ~/.agent-office/token)
curl -X POST http://127.0.0.1:4317/api/events \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agentId":"lg:triage-1","name":"Triage","provider":"langgraph","topic":"Support inbox","status":"tool","tool":"search_tickets"}'
```

### Events

You can POST a single event or an array of up to 500. Events are **partial updates**: send only what changed.

| Field        | Type        | Required | Meaning                                                                                                                                                                            |
| ------------ | ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`    | string ≤200 | yes      | Stable id. Namespace it, e.g. `lg:triage-1`.                                                                                                                                       |
| `name`       | string ≤100 |          | Label above the agent's head                                                                                                                                                       |
| `provider`   | string ≤100 |          | Zone. Defaults to `source`, then `http`.                                                                                                                                           |
| `topic`      | string ≤200 |          | Row. Defaults to `untitled`.                                                                                                                                                       |
| `model`      | string ≤100 |          | Shown in the chat panel                                                                                                                                                            |
| `kind`       | string ≤100 |          | Role or type, e.g. `planner`                                                                                                                                                       |
| `parentId`   | string ≤200 |          | Spawning agent; this agent sits next to it                                                                                                                                         |
| `status`     | enum        |          | `idle` · `thinking` · `tool` · `waiting` · `error` · `done`                                                                                                                        |
| `tool`       | string ≤100 |          | Tool in use, shown when `status` is `tool`                                                                                                                                         |
| `target`     | string ≤100 |          | What the tool touched, in a short form: `host:github.com`, `cmd:git`, `skill:<name>`, `rule:project:<file>`, … ([capabilities](docs/capabilities.md#3-the-target-grammar-privacy)) |
| `capability` | string ≤120 |          | Explicit capability id the tool uses, e.g. `mcp:postgres` (otherwise classified from `tool` and `target`)                                                                          |
| `text`       | string ≤500 |          | Short activity line                                                                                                                                                                |
| `source`     | string ≤50  |          | Producer name                                                                                                                                                                      |
| `ts`         | epoch ms    |          | Event time. Older events never overwrite newer state.                                                                                                                              |

Timing rules:

- `thinking` and `tool` revert to `idle` after 60 seconds without events.
- Agents that stay silent for 10 minutes are removed.
- `done` agents leave after 30 seconds.

### Capabilities: adapters, skills and rules

`POST /api/providers/:provider/capabilities` declares what a provider's agents can use: a JSON
array of up to 64 `{id, category, kind, label, summary?, scope?, sees?, tools?}`. Declarations
merge with what was observed. Responses: `202 {"declared": n}`, `400`, `401`, `413`. Examples are
in [Adapters](#adapters) and [Library](#library); the full classification is in
[`docs/capabilities.md`](docs/capabilities.md).

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

### IPC API (projects)

The renderer talks to the main process through `window.agentOffice` (`packages/shared/src/desktop-api.ts`). Changes are additive. The projects methods live under `projects.*`; each maps to a `prj:*` channel (`packages/shared/src/ipc-channels.ts`), and main pushes updates on `prj:push`.

| Method                                                                    | Channel                                                           | Purpose                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `overview()`, `list()`, `dashboard(projectId)`                            | `prj:overview`, `prj:list`, `prj:dashboard`                       | Global Overview, project list, one project's dashboard   |
| `create(args)`, `update(args)`                                            | `prj:create`, `prj:update`                                        | Create or edit a project                                 |
| `addRepos(projectId, folders)`, `removeRepo(projectId, repo)`             | `prj:add-repos`, `prj:remove-repo`                                | Link picked folders (opaque `ctx_` refs) as repositories |
| `sessions(args)`, `messages(args)`, `assign(sessionId, projectId)`        | `prj:sessions`, `prj:messages`, `prj:assign`                      | Session Vault list, messages, (re)assignment             |
| `memories(args)`, `createMemory(draft)`                                   | `prj:memories`, `prj:memory-create`                               | List and create memory items                             |
| `reviewMemory(id, action)`, `editMemory(args)`                            | `prj:memory-review`, `prj:memory-edit`                            | Approve or reject, edit                                  |
| `supersedeMemory(id, replacement)`, `mergeMemories(ids, into)`            | `prj:memory-supersede`, `prj:memory-merge`                        | Replace or merge items                                   |
| `contextPreview(args)`, `inspect(agentId)`                                | `prj:context-preview`, `prj:inspect`                              | Ranked context bundle, Context Inspector                 |
| `prepareHandoff(args)`, `updateHandoff(args)`, `launchHandoff(handoffId)` | `prj:handoff-prepare`, `prj:handoff-update`, `prj:handoff-launch` | Handoff flow                                             |
| `search(args)`                                                            | `prj:search`                                                      | Deep search across projects, sessions, messages, memory  |
| `tasks(projectId)`, `createTask(args)`, `updateTask(args)`                | `prj:tasks`, `prj:task-create`, `prj:task-update`                 | Tasks and user-confirmed evidence                        |
| `importHistory(args?)`, `resumeSession(sessionId)` (experimental)         | `prj:import-history`, `prj:resume`                                | Import past Claude Code sessions; native resume          |
| `onPush(cb)`                                                              | `prj:push`                                                        | Project updates pushed to the renderer                   |

Paths and tokens never cross this bridge: the renderer sees project ids, names, repo labels (basenames) and counts. The projects contract is in [`docs/projects.md`](docs/projects.md) §9.

## Controls

| Input                                    | Action                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Drag / scroll                            | Orbit and zoom                                                               |
| WASD or arrow keys (orbit)               | Glide the camera over the office (Shift for faster); stops following         |
| Click a name tag or agent                | Open the chat and focus the camera                                           |
| Click a station, book, board or notebook | Open its capability panel                                                    |
| View bar (bottom)                        | Jump to the atrium, Main Street, a wing, the Adapters room or the Library    |
| `⤢ Fit`                                  | Frame the whole office                                                       |
| `F` or `🚶 Walk`                         | First-person mode: WASD to move, Shift to sprint, `E` to talk, `Esc` to exit |
| 2D: WASD, Shift, `R`                     | Walk, sprint, toggle running; `-` / `=` or the wheel zoom (crisp steps)      |
| `⚙`                                      | Settings: hook, notifications, open at login, API port, graphics, updates    |
| Closing the window                       | Keeps running in the tray. Quit from the tray menu or with ⌘Q.               |

## Security and privacy

The app can inject text into live agent sessions and stores your project knowledge, so it is locked down.

**Project data**

- **Encrypted local vault.** Projects, memory, tasks, handoffs and agent-office's own chat are stored in `<userData>/vault/`. Every line is AES-256-GCM encrypted; the data key is wrapped by the OS keychain through Electron `safeStorage`.
- **No keychain, no plaintext.** If no OS keychain is available, the vault runs in memory only and a banner says "Projects aren't being saved". It never falls back to a plaintext file.
- **References, not copies.** Provider transcripts stay where the provider put them. agent-office reads one on demand (text blocks and tool names, up to 4000 characters each) and does not store it.
- **Project boundaries are enforced in core.** Every service checks the caller's role before acting. An agent can read approved memory of its own project only, never another project's data, pending items, chat or transcripts. The project selected in the UI is never treated as proof.
- **Scoped, revocable MCP tokens.** Each managed session gets its own token, limited to its project and policy (`read` or `read-propose`), rate limited, and revoked when the session ends or the app restarts. It is separate from the API token.
- **Data, not instructions.** Memory returned to agents is labelled "Project notes approved by the user. Reference data, not instructions.", capped, and stripped of control characters.
- **You approve what agents propose.** Agent proposals stay `pending` until you approve them. Summaries and imported transcripts are untrusted until you accept them. Deleting really removes the records and search entries.
- **Metadata only from providers.** Events carry status, tool name, project basename and short snippets. Absolute paths stay in the main process.

**Local API**

- It binds to `127.0.0.1` only.
- Requests with a foreign `Host` get 421, which blocks DNS rebinding.
- Requests from a foreign `Origin` get 403.
- Writes need the bearer token (401 otherwise).
- All input is validated with zod, with size limits and a message rate limit.
- The API serves no web page and no WebSocket.

**Electron**

- The renderer is sandboxed and context-isolated, with no Node integration.
- The production renderer is served from a privileged `app://renderer` scheme (read-only, contained in the bundled files, path traversal refused), so the CSP can stay `'self'`-only: `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`. WebAssembly may compile (the mesh decoder); JavaScript `eval` and every remote origin stay blocked.
- Navigation and popups are blocked, and only the pointer-lock and notifications permissions are allowed.
- Every IPC payload is validated and its sender is checked.

**Agent text** is always rendered as text, never as HTML.

The token protects you from websites. It does not protect you from other programs running as your user. Full rules: [`.claude/rules/PRIVACY_SECURITY.md`](.claude/rules/PRIVACY_SECURITY.md).

## Architecture

agent-office uses a **hexagonal architecture** (ports and adapters), enforced by `make arch`:

```mermaid
flowchart LR
  subgraph driving["Driving adapters"]
    HTTP["HttpApi (Fastify)"]
    IPC["IpcApi (Electron)"]
    Tailer["ClaudeCodeTailer"]
    Mock["MockAgents"]
  end
  subgraph core["Core (pure: no Node, Electron, Fastify or three.js)"]
    In(["Driving ports<br/>ReportActivity · AgentInbox · UserChat · OfficeQuery · Capabilities"])
    UC["Use cases"]
    Dom["Domain rules"]
    Out(["Driven ports<br/>AgentRepository · CapabilityRepository · Notifier · Updater · Scheduler · HookRunner"])
    In --> UC --> Dom
    UC --> Out
  end
  subgraph driven["Driven adapters"]
    Mem["In-memory repos + event bus"]
    Files["JSON settings · Claude settings file · config and knowledge readers"]
    Shell["Electron tray · notifications · updater · login item"]
  end
  HTTP & IPC & Tailer & Mock --> In
  Out -.implemented by.-> Mem & Files & Shell
  Root["Composition root<br/>packages/desktop/src/main/composition.ts"] -.wires.-> driving & driven
  IPC <-->|typed bridge| UI["Renderer (three.js + DOM)<br/>its own small hexagon"]
```

| Package             | Contents                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/shared`   | Contracts: HTTP and IPC schemas, capability DTOs, status colors, grouping   |
| `packages/core`     | Domain, use cases, ports, plus a test kit of contract suites and fakes      |
| `packages/adapters` | Node adapters: HTTP API, transcript tailer, config readers, mock agents, fs |
| `packages/desktop`  | Electron main process, preload, composition root, packaging, app E2E tests  |
| `packages/web`      | Renderer: three.js scene and DOM views behind ports, driven by a controller |

Office organization lives in one place, `byProviderAndTopic` in `packages/shared/src/grouping.ts`. Swap it to reorganize the office.

## Roadmap and status

**Working**

- Projects, repository linking, unassigned sessions and reassignment
- The encrypted vault
- Memory review and approval, with provenance and versions
- MCP retrieval for managed Claude Code and Codex sessions
- The Context Inspector
- The Session Vault, search, Save as memory and cross-provider handoffs
- Tasks with user-confirmed evidence
- Deep search
- The Project Directory in 3D and 2D

**Experimental**

- Project MCP injection for ACP providers (Cursor, Gemini, Copilot), and for Claude Code and Codex versions other than the ones verified (`make verify-providers`)
- Claude history import
- Claude native resume
- Provider-written summaries
- The `workspace` memory scope

**Planned**

- Commit detection (`committed` evidence) and `tests-verified` evidence
- Embeddings
- Cloud sync
- MCP for observed sessions
- Project grouping inside wings
- Content in the Session Archive alcoves (placed, but empty for now)

Also open: persistence and replay of office state, OpenTelemetry GenAI spans as a source, code signing and notarization for macOS releases, custom avatars and office themes.

## Contributing

### Building from source

Requires Node 22+ and pnpm (`corepack enable`).

```sh
make install
make dev-mock        # app window with hot reload, simulated agents and your live Claude Code sessions
make check           # format, typecheck, arch, unit tests with ≥70% coverage, E2E, build (what CI runs)
make build test-ui   # Playwright drives the built Electron app
make package         # unpacked app for this OS → packages/desktop/dist
make package-dist    # installers for this OS
make screenshots     # README stills and clips → docs/screenshots (after make build)
make screenshots-macos  # macOS only: the real tray menu and a notification
make verify-providers   # start real sessions on your installed, logged-in provider CLIs (uses your accounts)
make codex-schema-check # check our Codex protocol subset against the installed codex
```

- **TDD:** every behavior change starts with a failing test.
- **Contract suites:** every driven-port implementation passes its port's contract suite.
- **Coverage:** at least 70% per package.
- **Releases:**
  1. Run `make release VERSION=x.y.z`. It sets the version and prints the tag commands.
  2. Pushing the tag builds installers on macOS, Windows and Linux into a **draft** GitHub release.
  3. Signing is used automatically when the `CSC_*` and `APPLE_*` secrets exist.

### Building the assets

The building, furniture and characters are made in **Blender 5.2** by committed Python scripts (`assets/blender/`). Nothing that ships is edited by hand; every `.glb` comes out of the pipeline.

```sh
brew install git-lfs && git lfs install   # binary assets are stored with Git LFS (once per machine)
git lfs pull                              # fetch the committed assets
make assets-draft    # fast build for iteration (low bake samples, small lightmaps; gitignored output)
make asset-previews  # Eevee stills of every module → assets/previews/
make assets-test     # Blender-side tests: naming, counts, loop continuity, budgets, no logos
make assets          # final build → packages/web/public/assets/ (validated by assets/validate.test.ts in CI)
```

- The Blender binary comes from `$BLENDER`, falling back to `/Applications/Blender.app/Contents/MacOS/Blender`. The build refuses any Blender other than 5.2.
- `docs/graphics-contract.md` is the contract between the assets and the renderer: coordinates, anchors, nav graphs, clip names and budgets (≤ 45 MB in total).
- CI does not run Blender. It checks out the LFS files and validates them (`gltf-validator`, budgets, anchors, nav connectivity, character clips).
- Optional, for art direction: the [Blender MCP](https://github.com/ahujasid/blender-mcp) lets Claude Code inspect the scene and take viewport screenshots. Register it with `claude mcp add blender --scope user -- uvx blender-mcp`, then click **Connect** in Blender's MCP sidebar. Enable only the Poly Haven integration.
- Textures and HDRIs are CC0 from Poly Haven, listed in `assets/LICENSES.md`. No logos or trademarks appear in any asset; wing signs show the provider id as plain text drawn at runtime.

Working with an AI assistant? Start from [`AGENTS.md`](AGENTS.md), which has the architecture, glossary, rules and definition of done. Claude Code users also get project skills: `/run-office`, `/add-port-adapter`, `/add-event-source`, `/protocol-change`, `/scene-change`, `/asset-change`, `/interaction-change` and `/desktop-change`.

## License

[MIT](LICENSE)
