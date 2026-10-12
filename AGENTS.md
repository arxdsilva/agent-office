# agent-office — guide for AI assistants and contributors

agent-office is a **desktop app** (Electron) that shows AI agents as workers in a 3D office. Agents
are grouped into **zones by provider** and **rows by conversation topic**. You can orbit or walk
through the office, inspect agents, and **send them messages**, which reach Claude Code sessions
through an opt-in hook and other agents through an inbox API. It lives in the tray and raises
native notifications when an agent waits for you or replies.

## Architecture: hexagonal (ports and adapters)

```
                 ┌──────────────────── driving (primary) adapters ────────────────────┐
                 │  HttpApi (Fastify)   IpcApi (Electron)   ClaudeCodeTailer   MockAgents│
                 └──────────────┬──────────────────┬───────────────┬────────────────────┘
                                │ call driving ports (use-case interfaces)
                 ┌──────────────▼──────────────────▼───────────────▼────────────────────┐
                 │ CORE  application/ use cases  ──uses──▶  domain/ (pure rules)        │
                 │       ports/driving.ts (in)          ports/driven.ts (out)          │
                 └──────────────┬───────────────────────────────────────────────────────┘
                                │ implemented by driven (secondary) adapters
                 ┌──────────────▼───────────────────────────────────────────────────────┐
                 │ InMemory repos + event bus · JsonFileSettings · ClaudeSettingsFile    │
                 │ FsHookRunner · TimerScheduler · ElectronNotifier/Tray/Updater/Login   │
                 └──────────────────────────────────────────────────────────────────────┘
   composition root: packages/desktop/src/main/{composition,index}.ts — the only code that knows concrete classes
```

The renderer (`packages/web`) is its own small hexagon. Its pure `app/` layer (state, layout, view
models) and its `controller.ts` talk to ports (`OfficeGateway`, `SceneView`, `PanelView`, …).
Those ports are implemented by the preload gateway, the three.js scene and the DOM adapters.

## Packages and the dependency rule (enforced by `make arch`)

| Package             | Role                                                                      | May import                                                          |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/shared`   | Contracts: DTOs, zod schemas, IPC API, status colors, grouping strategy   | `zod`                                                               |
| `packages/core`     | Domain, use cases, ports. **Pure**: no Node, Electron, Fastify or three   | `shared`, `zod`                                                     |
| `packages/adapters` | Node adapters: HTTP API, transcript tailer, mock agents, fs/memory/system | `core`, `shared`, Node, `fastify`                                   |
| `packages/desktop`  | Electron adapters, preload, composition root, packaging, app E2E          | `core`, `adapters`, `shared`, `electron`                            |
| `packages/web`      | Renderer (three.js + DOM)                                                 | `shared`, `three`; **never** `core`, `adapters`, `electron` or Node |
| `hooks/`            | Claude Code hook script, an external client of the HTTP API               | Node only                                                           |
| `scripts/`          | Dev CLIs (hook installer, arch check, icon rendering)                     | anything                                                            |

## Glossary

| Term                                  | Definition                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                             | One worker (a Claude Code session, a subagent, or any external bot), identified by `agentId`.                                                                                   |
| **Event**                             | A partial `AgentEvent` update. Missing fields keep their previous value.                                                                                                        |
| **Provider / zone**                   | Who runs the agent (`claude-code`, `langgraph`, …). There is one office zone per provider.                                                                                      |
| **Topic / row**                       | What the conversation is about. There is one row of desks per topic.                                                                                                            |
| **Grouping**                          | `(agent) => {zone, row}` in `shared/src/grouping.ts`. Office organization lives only here and in the renderer's pure `app/` layer (building, seating).                          |
| **Slot**                              | A desk position. It stays stable for the agent's lifetime.                                                                                                                      |
| **Status**                            | `idle` (grey) · `thinking` (blue) · `tool` (amber) · `waiting` (green: finished its turn, waiting for a human) · `error` (red) · `done` (dim, removed soon).                    |
| **Inbox / message state**             | The per-agent queue of UI messages. States: `queued` → `delivered` (the agent claimed it) → `replied`.                                                                          |
| **Interactive**                       | Something read this agent's inbox in the last 10 minutes.                                                                                                                       |
| **Hook**                              | `hooks/agent-office-hook.mjs`, run by Claude Code on `Stop` and `UserPromptSubmit` through a generated wrapper. It claims the inbox and posts Claude's answer back.             |
| **Domain**                            | Pure rules in `core/src/domain`: functions of their inputs plus time.                                                                                                           |
| **Use case / service**                | `core/src/application/*`: implements driving ports using driven ports.                                                                                                          |
| **Driving port**                      | An interface the outside calls (`ReportActivity`, `AgentInbox`, `UserChat`, `OfficeQuery`, …).                                                                                  |
| **Driven port**                       | An interface the core needs (`AgentRepository`, `Notifier`, `Updater`, `Scheduler`, …).                                                                                         |
| **Adapter**                           | A concrete implementation of a port (Fastify, Electron, fs, memory, three.js, DOM).                                                                                             |
| **Contract test**                     | A reusable suite in `core/test/contracts` that every implementation of a driven port must pass (fakes included).                                                                |
| **Composition root**                  | `desktop/src/main/composition.ts` plus `index.ts`, which wire every concrete adapter.                                                                                           |
| **Main process / renderer / preload** | Electron's privileged Node side, the sandboxed page, and the typed bridge between them (`window.agentOffice`).                                                                  |
| **IPC contract**                      | `shared/src/desktop-api.ts` (`AgentOfficeApi`, channel names, payload schemas). Additive only.                                                                                  |
| **View model**                        | Pure data the DOM adapters render (`web/src/app/view-models.ts`).                                                                                                               |
| **Tray model**                        | Pure data for the tray menu (`core/src/domain/tray.ts`).                                                                                                                        |
| **Graphics contract**                 | `docs/graphics-contract.md`: coordinates, anchors, nav graphs, glTF roles, clips and budgets shared by the Blender pipeline and the renderer. Additive only.                    |
| **Module**                            | One Blender-built building piece exported as a `.glb`: `atrium`, `street`, `wing`, `garden` or `cap`. Placed at runtime by translation + yaw, never mirrored.                   |
| **Atrium**                            | The entrance module: elevators, reception, cafe, game area and the LED stats wall.                                                                                              |
| **Main Street**                       | The 6 m boulevard (`street` modules, one per bay) that joins the atrium to the wings.                                                                                           |
| **Wing**                              | A provider's themed office module (desk pods, meeting rooms A/B, phone booths, kitchen, lounge). One per provider, in pinned or hash order.                                     |
| **Annex**                             | An extra wing for a provider with more than 24 agents.                                                                                                                          |
| **Pod**                               | A group of 4 desks in a wing. One conversation topic claims a pod.                                                                                                              |
| **Anchor**                            | A named spot from the manifest (`seat:desk:3:2`, `spot:booth:1`, …) with position, heading, pose and approach point. The only source of positions.                              |
| **Approach point**                    | The point 0.6 m in front of an anchor where a walking agent arrives before turning and sitting or standing.                                                                     |
| **Nav graph**                         | Per-module walkable nodes (with corridor width) and edges, merged across modules at connector nodes. Paths are planned on it.                                                   |
| **Activity**                          | What an agent is doing in the office: `arriving`, `desk-work`, `desk-think`, `desk-error`, `desk-idle`, `meeting`, `booth`, `kitchen`, `lounge`, `cafe`, `pingpong`, `leaving`. |
| **Intent**                            | The director's decision for one agent: an activity, its target anchor and since when.                                                                                           |
| **Reservation**                       | A claim on a room or spot (whole meeting room, one booth seat, …) so agents never share a seat.                                                                                 |
| **Choreography**                      | Turning an intent change into a sequence of steps (stand up, walk, face, sit, play a clip) without snapping.                                                                    |
| **Step**                              | One unit of a choreography: `clip`, `move` (a timed path), `face`, `prop`, `teleport` or `fade`.                                                                                |
| **Quality preset**                    | The `graphicsQuality` setting: `auto`, `low`, `medium`, `high`, `ultra`. Applied live through `SceneView.setQuality`.                                                           |
| **Lightmap**                          | Baked indirect + direct lighting per module (a PNG on UV1), applied by the renderer to `baked` meshes.                                                                          |

## Commands

Use `make` targets only (`make help` lists them). `make check` is what CI runs. `make test-ui`
drives the built app with Playwright.

## Definition of done

- `make check` is green: format, typecheck, **arch**, coverage ≥70% per package, E2E, build.
- The work was built with **TDD**: a failing test first (red), minimal code (green), then refactor.
- New infrastructure comes with an adapter that passes the port's **contract suite**.
- Behavior changes have an E2E test (`packages/adapters/test/`). App and UI changes pass `make test-ui`.
- Public contracts (HTTP API, IPC API, hook output) change additively only, and the README tables are updated.
- `.claude/rules/PRIVACY_SECURITY.md` is respected, including the Electron checklist.

## Rules

Project rules live in `.claude/rules/` and apply to every AI tool: `ARCHITECTURE.md`,
`TESTING.md`, `PRIVACY_SECURITY.md`, `SCENE.md`, `GIT_WORKFLOW.md`.
