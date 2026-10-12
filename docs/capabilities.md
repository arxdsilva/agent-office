# Capabilities: adapters, skills and rules

This defines what agents of a provider **can use**, and how a tool call is classified as using it. It is shared by the backend (core + adapters), the renderer and the assets. Types live in `packages/shared/src/protocol.ts` (`Capability`, `CapabilityDecl`, `CAPABILITY_*`).

- **adapter**: a connection to the outside world (filesystem, shell, web, subagents, MCP servers, APIs, databases). It's shown in the wing's **Adapters room**, one **station** each.
- **skill**: reusable instructions an agent can invoke. It's shown in the wing's **Library** as a **book** on the shelves.
- **rule**: guidance the agent reads: project `CLAUDE.md`/`AGENTS.md`, `.claude/rules/*.md`, user rules, and memory entries. It's shown in the Library as a **board**, or a **notebook** for memory.

## 1. Capability ids

| Category | Kind | id | label |
|---|---|---|---|
| adapter | filesystem | `fs` | Filesystem |
| adapter | shell | `shell` | Shell |
| adapter | web | `web` | Web |
| adapter | subagents | `subagents` | Subagents |
| adapter | mcp / database | `mcp:<server>` | Prettified server name (below) |
| adapter | api | `api:<name>` | As declared |
| skill | skill | `skill:<name>` | `<name>` (with `plugin:` prefix kept) |
| rule | project-rules | `rule:project:CLAUDE.md`, `rule:project:AGENTS.md` | `CLAUDE.md (<project>)` |
| rule | rule | `rule:project:<file>`, `rule:user:<file>` | `<file>` |
| rule | user-rules | `rule:user:CLAUDE.md` | `CLAUDE.md (you)` |
| rule | memory | `memory:<slug>` | The frontmatter `name` |

**Prettifying MCP server names:** strip the prefixes `claude_ai_` and `plugin_`, split on `_` and `-`, and title-case each word, keeping words that are already all caps. So `claude_ai_Google_Drive` becomes **Google Drive** and `github` becomes **Github**. The kind is `database` if the server name matches `/(db|sql|postgres|mongo|redis|sqlite)/i`; otherwise it's `mcp`.

## 2. Classifying a tool call: `classifyUse(provider, tool, target?)`

| `tool` | `target` | Result |
|---|---|---|
| `Read`, `Edit`, `Write`, `MultiEdit`, `Glob`, `Grep`, `NotebookEdit`, `LS` | `project:<b>` or none | adapter `fs` |
| `Read` | `skill:<name>` | skill `skill:<name>` (reading a SKILL.md counts as using the skill) |
| `Read` | `rule:<scope>:<file>` | rule `rule:<scope>:<file>` |
| `Read` | `memory:<slug>` | rule `memory:<slug>` |
| `Edit`/`Write`/`MultiEdit` | `rule:…`/`skill:…`/`memory:…` | adapter `fs` (editing isn't consulting); a source sends `project:<b>` in this case |
| `Bash`, `BashOutput`, `KillShell` | `cmd:<word>` | adapter `shell` |
| `WebFetch`, `WebSearch` | `host:<h>` or none | adapter `web` |
| `Agent`, `Task` | none | adapter `subagents` |
| `Skill` | `skill:<name>` | skill `skill:<name>` |
| `mcp__<server>__<tool>` | none | adapter `mcp:<server>` (tool = `<tool>`) |
| `TodoWrite`, `ExitPlanMode`, `AskUserQuestion`, `ToolSearch`, other harness tools | any | **null** (not a capability) |
| Any other tool from a non-Claude provider | the event's `capability` if set | that capability; else adapter `api:<tool>` |

## 3. The `target` grammar (privacy)
Sources may send **only** these forms in `AgentEvent.target` (≤ 100 chars):

| Form | Example | Produced from |
|---|---|---|
| `project:<basename>` | `project:workspace` | The session cwd basename, never a file path |
| `host:<hostname>` | `host:github.com` | `WebFetch input.url`, hostname only |
| `cmd:<word>` | `cmd:git` | The first token of a Bash command, `[a-z0-9._-]{1,20}`; if anything else, omit it |
| `skill:<name>` | `skill:run-office` | `Skill input.skill`, or a `SKILL.md` directory name, `[A-Za-z0-9:_-]{1,80}` |
| `rule:<scope>:<file>` | `rule:project:TESTING.md` | `Read` of `<cwd>/CLAUDE.md`, `<cwd>/AGENTS.md`, `<cwd>/.claude/rules/*.md` (scope `project`) or `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` (scope `user`); file basename only |
| `memory:<slug>` | `memory:agent-office-project` | `Read` of `~/.claude/projects/*/memory/<slug>.md` |

**Never** emit full paths, URLs, query strings, arguments, command lines, file contents or env values. Tests in the source adapter prove this with fixtures containing secret-looking strings.

## 4. Discovery (declared capabilities)
- **Built-in adapters** for `claude-code`: `fs`, `shell`, `web`, `subagents`. They're always declared.
- **Configured MCP servers:** `ClaudeConfigReader` reads only the **keys** of `mcpServers` in `~/.claude.json`, both top-level and `projects[<cwd>]` for active session cwds. It never reads commands, args or env.
- **Skills and rules:** `ClaudeKnowledgeReader`, for the user scope and each active cwd.
  - **Skills:** `~/.claude/skills/*/SKILL.md`, synced skills at exactly `~/.claude/skills/synced/*/*/SKILL.md` (scope `user`), `<cwd>/.claude/skills/*/SKILL.md`, and `~/.claude/plugins/**/skills/*/SKILL.md` (scope `plugin`). It reads the frontmatter `name` and `description`, with the description cut to 160 chars as `summary`.
  - **Rules:** `<cwd>/CLAUDE.md`, `<cwd>/AGENTS.md`, `<cwd>/.claude/rules/*.md`, `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`. The title is the first `# ` heading (or the file name); the summary is the first prose sentence, up to 160 chars.
  - **Memory:** `~/.claude/projects/<encoded cwd>/memory/*.md`, frontmatter `name` only, with **no summary**.
  - **Limits:** at most 48 skills, 24 rules and 24 memory entries per provider. Files over 256 KB are skipped; only frontmatter and the first 4 KB are parsed. No symlinks are followed. It re-scans every 60 s.
- Both readers are gated by the settings `claudeAdapter` **and** `discoverCapabilities` (default true).
- **Generic providers:** `POST /api/providers/:provider/capabilities` with `CapabilityDecl[]` (≤ 64; token required).
- **Observed capabilities** (used but not declared) appear with `declared: false`.

## 5. Rooms and behaviors (renderer)

| Category | Room | Call (overlay, agent stays put) | Visit (agent walks there) | Return |
|---|---|---|---|---|
| adapter | Adapters, station `0..7` (fs → 0, shell → 1, web → 2, subagents → 3, others first-seen; overflow on 7 as "+N more") | `status: tool` mapped to it: a **dash link** from the agent's port to the station port, while the tool is active plus a 0.6 s fade | Same adapter **≥ 20 s continuously**, or **≥ 4 calls within 60 s** → `spot:station:<i>`, `StandInteract` | After 8 s without use (dwell 15 s) |
| skill | Library, book `0..23` (project, user, plugin; then by name) | A **page-particle link**, gold, to the book port; the spine glows for 6 s | **≥ 2 distinct skill/rule uses within 60 s**, or a skill while idle/thinking ≥ 10 s → `spot:shelf:<n>` `ShelfPick` → `seat:reading:<i>` `SitRead` (book prop) | After 10 s without library use (dwell 20 s) |
| rule | Library, board `0..5` (project CLAUDE/AGENTS, project rules, user rules) | A page-particle link, ivory; the board glows for 6 s | As for skills | As for skills |
| rule (memory) | Library, notebook `0..7` | A page-particle link, soft green; the notebook glows | As for skills | As for skills |

- **Priorities:** `leaving` > `booth` > `meeting` > `connection-visit` = `library-visit` (whichever came first) > `desk-*` > breaks.
- Meeting members only get links.
- If a station or reading seat is taken, the agent falls back to a link from where it is.

## 6. Link colors
fs `#4F8CFF` · shell `#F5A524` · web `#2CB6A0` · subagents `#8B5CF6` · mcp `#EC4899` · database `#22C55E` · api `#F97316` · skill `#E8B74A` (gold) · rule `#F1E9D2` (ivory) · memory `#9BD3A4`.

## 7. API

All writes need the token from `~/.agent-office/token` and a `Host` of `localhost:<port>` or `127.0.0.1:<port>` (default port 4317).

**Declare capabilities** for a provider: `POST /api/providers/:provider/capabilities`, a JSON array of `CapabilityDecl` (at most 64 per request). Declarations merge with what was observed; usage counters are kept. Responses: `202 {"declared": n}`, `400` (invalid body or provider name), `401` (no or bad token), `413` (more than 64).

```sh
TOKEN=$(cat ~/.agent-office/token)
curl -s -X POST http://127.0.0.1:4317/api/providers/langgraph/capabilities \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[
    {"id": "mcp:postgres", "category": "adapter", "kind": "database", "label": "Postgres", "sees": ["db: analytics"]},
    {"id": "api:chat", "category": "adapter", "kind": "api", "label": "Chat", "tools": ["post_message"]},
    {"id": "skill:triage", "category": "skill", "kind": "skill", "label": "triage", "summary": "Sort incoming tickets."},
    {"id": "rule:project:AGENTS.md", "category": "rule", "kind": "project-rules", "label": "AGENTS.md (support-bot)", "scope": "project"}
  ]'
```

**Report a tool call** that uses a capability: `POST /api/events` with `status: "tool"`. Either let the core classify it from `tool` + `target` (§2), or name the capability explicitly with `capability` (it wins when well-formed). A `target` outside the §3 grammar is ignored.

```sh
# Classified: an MCP tool, and a skill invocation.
curl -s -X POST http://127.0.0.1:4317/api/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId": "bot-1", "provider": "langgraph", "status": "tool", "tool": "mcp__github__create_issue"}'
curl -s -X POST http://127.0.0.1:4317/api/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId": "bot-1", "status": "tool", "tool": "Skill", "target": "skill:triage"}'

# Explicit: a custom tool that uses the declared Postgres adapter.
curl -s -X POST http://127.0.0.1:4317/api/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId": "bot-1", "status": "tool", "tool": "run_query", "capability": "mcp:postgres"}'
```

The agent stays in the capability's `active` list until it leaves `tool` status or is removed. The UI receives `{type: "capabilities", provider, capabilities}` (at most one per provider every 250 ms) and `snapshot.capabilities`.
