# 2D RPG mode: architecture

The 2D RPG mode is an **optional, additive view** of the same live office. The 3D office stays the default (`viewMode: '3d'`), and nothing in the backend, IPC, core or 3D renderer behaves differently because 2D exists. The 2D mode draws the decisions the existing director already makes. It has no behaviour of its own.

## Shape

```
controller.ts ── the same director, view models and DOM panels (chat, permissions, Library…)
      │ SceneView port
SceneHost (adapters/scene-host.ts) ── forwards to the active scene; on a mode switch it creates
      │                              and loads the new scene first, then disposes the old one, then
      │                              replays layout, theme, graphics, links, surfaces, selection, and
      │                              continues every agent from director.resync()
  ┌───┴──────────────┐
ThreeScene         PixelScene (adapters/pixel/*, Canvas2D)
adapters/three/*   uses the pure app/pixel/* modules
```

- **Agents:** `PixelScene.direct(plans)` plays the director's steps with the same `app/motion.ts` player that 3D uses (`setSteps` / `advanceMotion`). It then draws `toPixel(pos)` with a 4-direction sprite chosen from the clip (`app/pixel/anim.ts`). The status icon comes from the agent's real status, so `waiting` shows at once, even while the agent is still walking.
- **The world, at GBA scale (16 px per metre):** `app/pixel/map.ts` builds the map from the same `BuildingLayout` and the Blender-exported floor plan (`manifest.modules.<m>.plan`, graphics contract §11). Floors are 16 px tiles = 1 m cells; **rooms, walls and furniture are pixel rects at their exact plan positions**, not snapped to tiles, so every seat and approach point lands exactly where 3D puts it. Static layers are pre-rendered in 512 px chunks. Only `layout.key` changes rebuild them; status updates never do.
- **The player:** `app/pixel/walk.ts` tests a 0.22 m circle against `PixelMap.solids` (pixel rects, through the `solidIndex` bucket grid), with per-axis sliding and a doorway nudge. It walks at 3 m/s, sprints at 5 m/s with Shift, and **R** makes running the default. The view zooms out in crisp whole-pixel steps (`app/pixel/zoom.ts`: the wheel, `-` / `=`, the HUD's − ⌂ +), down to one device pixel per art pixel. The zoom and run state reach the HUD through the optional `SceneView.zoomBy`/`onZoom`/`onRun` and `PixelHudView.onZoom`/`renderZoom`, wired by the controller. `app/pixel/interact.ts` finds the nearest target in the facing cone. E fires `SceneView.onInteract`, and the controller opens the dialogue (`app/pixel/dialogue-vm.ts`). **Talk** opens the existing chat panel. Permission decisions stay on the existing permission card; the dialogue only offers **Review**.
- **One box for drawing and collision:** `map.ts` decides each object's `box` (px) and orientation once (`fixed` / `strip` / `area` classes from `assets/pixel/src/sizes.json`, `v` art for vertical pieces, wall-mounted pieces against the wall's inner face). The renderer draws the art's base exactly on `box` (`effects.ts` `drawObject`, by `fill`), and `solids` holds exactly those boxes plus the walls. Walls are thin (4 px, centred on the 3D wall body from its `side`/`thick`, with a 12 px face). `assets/pixel/map-invariants.test.ts` (G-1..7) proves it on the real assets: drawn = solid, every approach point free, every agent route passable, objects inside their rooms, no overlapping furniture, mirrored wings, art at the plan's size.
- **Camera modes:** `app/pixel/camera-mode.ts` (pure). Moving never cancels the overview or follow; Esc, Space or travel returns the camera to the player; a pan is cancelled by moving. Player input is suspended only for modal UI (dialogue, Settings, Connect, New session), never for a selected agent, the chat panel or the Library.
- **The HUD:** room, counts, alerts, minimap and directory are DOM (`adapters/dom/pixel-hud.ts`), rendered by the controller at 2 Hz from pure VMs (`hud-vm.ts`, `directory-vm.ts`, `minimap.ts`). The minimap draws a base image rendered once per map (`adapters/pixel/minimap-base.ts`, colours from `app/pixel/minimap-colors.ts`), then the viewport, agents by status, labels and you.
- **Art:** `assets/pixel/src` holds text pixel grids and palettes; `make pixel-assets` builds them into `public/assets/pixel/*.png` + `atlas.json` (`docs/pixel-style.md`). Characters are recoloured per agent from `appearanceOf(id)`, so an agent looks the same in 3D and 2D.

## Files
| Area | Files |
| --- | --- |
| Pure logic (unit-tested) | `web/src/app/pixel/{project,map,walk,interact,anim,npc,rooms,tags,dialogue-vm,hud-vm,directory-vm,minimap,minimap-colors,camera-mode}.ts`, `app/views.ts`, `app/scene-replay.ts`, `app/director.ts` (`issued`, `resync`) |
| Contracts | `web/src/app/pixel/types.ts`, `web/src/app/pixel-copy.ts`, the optional `SceneView` methods and `DialogueView`/`PixelHudView`/`ModeToggleView` in `web/src/ports.ts`, `viewMode` in `shared/src/desktop-api.ts` |
| Canvas2D adapter | `web/src/adapters/pixel/*` (scene, renderer, tiles, sprites, object-art, characters, effects, camera, input, font, minimap-base) |
| Host | `web/src/adapters/scene-host.ts` (+ test) |
| DOM | `web/src/adapters/dom/{dialogue,pixel-hud,mode-toggle}.ts`, `web/src/styles/pixel.css` |
| Assets | `assets/pixel/**` (sources, build, tests), the floor plan export in `assets/blender/**` (`make assets-plan`) |
| Tests | `app/pixel/*.test.ts`, `scene-host.test.ts`, `desktop/e2e/pixel.spec.ts` (X1–X12, 2D polish, ZM-1, RUN-1), `assets/validate.test.ts` (PLAN-*), `assets/pixel/build.test.ts` (sizes against `src/sizes.json`), `assets/pixel/map-invariants.test.ts` (G-1..7) |

## How to…
- **Add an animation:** draw the frames in `assets/pixel/src/characters/`, add it to `anims.json`, run `make pixel-assets`, then map the 3D clip to it in `app/pixel/anim.ts` (the test there is exhaustive over `ClipName`).
- **Add a furniture kind:** export it from Blender (`lib/furniture.py` records `{kind, x, z, w, d, yaw}`), add the kind to `FURNITURE_KINDS`, draw it in `assets/pixel/src/objects/`, then run `make assets-plan pixel-assets`.
- **Check collision by eye:** `__aoDebug.pixelSolid(true)` (with `AGENT_OFFICE_DEBUG=1`) draws the solid grid in red over the map.
- **Measure:** `make perf-pixel` (60 agents; avg ≈ 120 fps, 36 MB of textures on an M3 Pro).
