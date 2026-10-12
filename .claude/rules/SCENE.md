# Scene rule (three.js)

| Do                                                                                         | Don't                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Reuse geometries/materials from the shared cache in `adapters/three/office.ts`             | Create a new geometry/material per avatar or per frame |
| `dispose()` geometries, materials and remove CSS2D elements when an avatar is removed      | Leave detached objects in memory                       |
| Take colors only from `shared/src/status-colors.ts`                                        | Hard-code status colors in web code                    |
| Take positions only from manifest anchors (via `app/building.ts` + `app/seating.ts`)       | Hard-code a position, seat or path in web code         |
| Keep `update(dt)` allocation-free (reuse vectors)                                          | `new Vector3()` inside the render loop                 |
| Stay within budget: 200 agents at 60 fps on a laptop (`POST /api/mock?n=200` in mock mode) | Ship a scene change without checking the budget        |
| Verify visually with `/run-office` + screenshot                                            | Call a scene change done from tests alone              |

The scene is an adapter: `web/src/adapters/three/scene.ts` implements the `SceneView` port. What to show comes from the controller (`sync(agents, layout)`, `select(id)`). Picks go back through `onPick`. Keep decisions out of the scene.

## Assets, building and animation

The contract between the Blender pipeline and the renderer is `docs/graphics-contract.md`. Change it only additively, and both sides together.

| Do                                                                                                                                                                                                           | Don't                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Produce every `.glb` with `make assets` from `assets/blender/**` (see `/asset-change`)                                                                                                                       | Hand-edit a `.glb`, or export one from the Blender GUI           |
| Stay within the budgets (contract §9): atrium ≤ 12 MB / 250k tris, wing ≤ 6 MB / 190k (with the Adapters room and Library), street/garden/cap ≤ 3 MB / 60k, character ≤ 1.5 MB with ≤ 8k tris, total ≤ 55 MB | Ship an asset that `assets/validate.test.ts` rejects             |
| Keep the visible scene ≤ 600k triangles and ≤ 400 draw calls (`?stats` overlay); instance furniture                                                                                                          | Add per-object meshes where an instance would do                 |
| Author clips **in place** (root motion stripped); scale `Walk` timeScale with speed (`speed / clips.Walk.speed`) so feet don't slide                                                                         | Move a character by root motion, or play Walk at a fixed rate    |
| Crossfade every clip change (0.25 s default, sit ↔ stand 0.15 s, walk → idle 0.3 s); loops start and end on the same pose                                                                                    | Snap between clips or positions                                  |
| Drive props, screens, LEDs and signs through glTF `extras` roles (contract §5)                                                                                                                               | Find nodes by name (three.js strips `:` from names)              |
| Draw sign text at runtime from the provider id as plain text                                                                                                                                                 | Put any third-party logo, trademark or company name in an asset  |
| Check performance with `make perf` (150 mock agents, FPS report) at the Medium preset                                                                                                                        | Call a scene change done without a perf number                   |
| Respect the `graphicsQuality` preset (`SceneView.setQuality`); E2E runs on Low because CI uses software GL                                                                                                   | Hard-code post-processing or shadow settings outside the presets |

## Low-spec rules (graphics settings)

| Do                                                                                                                                                                | Don't                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Put every per-frame cost behind an `Effective` lever (`web/src/app/quality.ts`): presets, Advanced overrides and power saver all flow through `effectiveGraphics` | Add per-frame work that Minimal or Low can't turn down             |
| Let the frame pacer decide when to render (`frame-pacer.ts`); the controller combines page and window visibility                                                  | Read `document.hidden` in the scene to second-guess the controller |
| Ship glb textures as WebP with `extras.hash`, lightmaps as full/½/¼ WebP tiers (`make assets-repack`)                                                             | Use KTX2/Basis: its transcoder needs `eval`, which the CSP forbids |
| Frame Library and Adapters views with `app/framing.ts` from inside the room                                                                                       | Hand-place camera bookmarks                                        |
| Check `make perf` (preset matrix) and, on Linux or Windows, `make perf-low`                                                                                       | Call a graphics change done without a before/after number          |

## Two renderers, one office (2D RPG mode)

| Do                                                                                                        | Don't                                                                   |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Keep both renderers behind `SceneView`; the controller talks only to `SceneHost`                          | Import a scene class in the controller, or let one scene call the other |
| Draw the director's plans in both views (`motion.ts` steps); put 2D logic in `app/pixel/*` (pure, tested) | Add behaviour (where agents go, when) in `adapters/pixel/*`             |
| Keep the 2D mode additive: 3D stays the default, and the 3D specs pass unchanged                          | Change 3D behaviour or existing specs for 2D                            |
| Build pixel art from `assets/pixel/src` (`make pixel-assets`), original only                              | Hand-edit the atlas PNGs or use third-party sprites, tiles or fonts     |
