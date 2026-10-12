# Testing rule — TDD, ≥70% unit coverage

## TDD is mandatory for behavior changes

1. **Red**: write a failing test and run it; confirm it fails for the expected reason.
2. **Green**: write the minimum code to make it pass.
3. **Refactor**: clean up while the tests stay green.

Never write production code without a red test first. Bug fixes start with a test that reproduces the bug.

## Coverage bar

- Aim for **≥70%** statements, branches, functions and lines on every package you touch. This is measured on the **whole package**, not just the new lines.
- `make coverage` enforces it per package (`shared`, `core`, `adapters`, `desktop`, `web`, `hooks`, `scripts`). The task is **not done** while any package is below 70%.

Excluded from the threshold: thin shells covered by the Playwright Electron suite instead. They are listed in `vitest.config.ts`:

- `desktop/src/main/index.ts`
- `desktop/src/main/window.ts`
- `desktop/src/main/adapters/electron-*.ts`
- `desktop/src/preload/**`
- `web/src/main.ts`
- `web/src/adapters/{three,dom,pixel}/**` (`pixel`: the 2D RPG mode's Canvas2D drawing; its logic lives in the covered `web/src/app/pixel/**`)
- the `scripts/*.mjs` helpers

Do not widen this list without saying so in the PR.

## Layers

| Layer          | Where                                                                             | How                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain         | `core/src/domain/*.test.ts`                                                       | Pure; time passed in                                                                                                                                                               |
| Use cases      | `core/src/application/*.test.ts`                                                  | Fakes from `@agent-office/core/testing`; `ManualScheduler`, `FakeClock`, `FakeSignal` (no real timers)                                                                             |
| Port contracts | `core/test/contracts/*`                                                           | **Mandatory for every driven-port implementation**: fakes in `core/test/fakes.test.ts`, real adapters next to the adapter                                                          |
| Adapters       | `adapters/src/**/*.test.ts`, `desktop/src/main/*.test.ts`, `web/src/**/*.test.ts` | Real core via `adapters/test/support.ts`; temp dirs; in-memory `TranscriptFiles`                                                                                                   |
| Backend E2E    | `adapters/test/e2e.*.test.ts`                                                     | Real HTTP server on port 0 + real hook script; observe via `OfficeQuery.watch`                                                                                                     |
| App E2E        | `desktop/e2e/*.spec.ts`                                                           | Playwright `_electron` drives the **built** app with an isolated profile (`AGENT_OFFICE_USER_DATA`, `AGENT_OFFICE_HOME`, `CLAUDE_SETTINGS_FILE`, `AGENT_OFFICE_MOCK=1`, port 4318) |

## Do / Don't

| Do                                                                                  | Don't                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Use fixtures shaped like real transcripts with **invented** content                 | Copy real transcript content into fixtures                  |
| Put a 1–3 line comment before each request or step in E2E tests saying what and why | Write bare URL sequences no one can read                    |
| Point tests at temp files (`CLAUDE_SETTINGS_FILE`, `AGENT_OFFICE_HOME`)             | Touch the real `~/.claude` or `~/.agent-office` in any test |
| Every behavior change ships an E2E test; UI or app changes ship a Playwright case   | Rely on unit tests alone for a behavior change              |

## 3D assets

| Check                  | Where                                                                                                                                                      | When                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset validation       | `assets/validate.test.ts` (pure checks in `assets/validate.ts`)                                                                                            | **CI**, as part of the unit run: `gltf-validator` reports 0 errors on every glb; manifest shape; budgets (contract §9); anchor counts; nav connectivity and every approach on the graph; character clips with `Walk.speed`/`footPlants`; lightmaps exist; total ≤ 55 MB. It **fails when the assets are missing** (not built, or LFS files not pulled). |
| Blender-side tests     | `assets/blender/tests/` via `make assets-test`                                                                                                             | **Locally only** (CI has no Blender): naming grammar, counts, loop pose continuity, ≤ 4 weights, applied transforms, no logo/trademark text objects.                                                                                                                                                                                                    |
| Behavior E2E           | `desktop/e2e/{building,behavior,quality}.spec.ts`                                                                                                          | `make build test-ui`. Assert on `data-activity` attributes and the panel text, never on pixels. A behavior change (who goes to which room, and when) ships a spec here.                                                                                                                                                                                 |
| Visual and perf review | `make screenshots`, `make asset-previews`, `make perf` (preset matrix), `make perf-low` (SwiftShader; Linux and Windows only, macOS has no software WebGL) | Locally, reported in the PR, not gated (CI renders with software GL).                                                                                                                                                                                                                                                                                   |

- The validator logic has its own fixture tests (a tiny contract-complete asset set generated in a temp dir); extend them when the contract grows.
- Pure renderer modules (`web/src/app/{manifest,building,seating,reservations,behavior,navigation,choreography}.ts`) are unit-tested red-first like any domain code; the three.js adapters stay excluded from coverage.
