# Architecture rule — hexagonal (ports and adapters)

Dependencies point **inward**. The core knows nothing about Node, Electron, Fastify, three.js or the file system. `make arch` (dependency-cruiser, `.dependency-cruiser.cjs`) enforces this and runs in `make check`.

## Where does my change go?

| Change | Goes in | Test with |
|---|---|---|
| A rule or decision (what happens to agents, messages, notifications, hooks, updates) | `core/src/domain/*` (pure, time passed in) | Plain unit tests |
| A new capability an outside actor can trigger | A use case in `core/src/application/*` behind a **narrow driving port** in `core/src/ports/driving.ts` | Use-case tests with fakes from `@agent-office/core/testing` |
| Something the core needs from the world (storage, OS, network, clock) | A **driven port** in `core/src/ports/driven.ts` + an adapter | A **contract suite** in `core/test/contracts` run against the fake *and* the real adapter |
| A new way in (transport, source, UI) | A driving adapter in `adapters/` (Node) or `desktop/src/main` (Electron) that calls driving ports only | Adapter tests + E2E |
| Wiring | `desktop/src/main/composition.ts` (and `index.ts` for Electron objects) | `composition.test.ts` with a fake shell |
| What the UI shows | `web/src/app/view-models.ts` (pure) + `web/src/controller.ts` | View-model and controller tests with fake views and a fake gateway |
| How the UI draws | `web/src/adapters/{three,dom}` | Playwright app E2E + `/run-office` |

## Dependency rule

| Do | Don't |
|---|---|
| `core` imports only `core`, `shared` and `zod` | Import `node:*`, `electron`, `fastify` or `three` in `core`, or use host globals (timers come through `Scheduler`) |
| Adapters depend on **ports** (interfaces), never on other adapters' concrete classes | Reach into `core/src/application/*` from an adapter; import from `@agent-office/core` |
| Only `composition.ts` and `index.ts` construct concrete adapters | `new InMemoryAgentRepository()` anywhere else in `desktop/src/main` |
| The renderer talks to the app only through `OfficeGateway` (`window.agentOffice`) | Import `core`, `adapters`, `electron` or Node in `packages/web` |
| The preload imports only `electron` and `@agent-office/shared/ipc` | Expose `ipcRenderer` or Node APIs to the page |
| Keep each port small and specific to one actor (ISP) | Grow a "god" port because it's convenient |

## Ports and contracts are additive only

Public contracts are used outside this repo, by other agent frameworks and by installed hooks:
- the HTTP API (`/api/events`, inbox, replies, messages)
- the hook's stdout JSON
- the IPC contract (`shared/src/desktop-api.ts`)
- the driven and driving port interfaces

| Do | Don't |
|---|---|
| Add new **optional** fields or new methods on **new** ports | Rename, remove or retype fields; add required parameters to existing methods |
| Keep the compatibility guard (`{agentId}` alone → 202) green | Tighten validation on existing fields without a major-version note in the README |
| Run every implementation (including fakes) through the port's contract suite | Treat a green build as proof: fakes are regenerated with the interface and always compile |

History: the browser UI, `/ws` and static serving were removed when agent-office became a desktop app (before any release). The UI now uses IPC.
