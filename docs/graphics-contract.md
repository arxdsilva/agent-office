# Graphics contract: assets ↔ runtime

The single source of truth shared by the Blender pipeline (`assets/blender/**`) and the renderer (`packages/web`). Change it only additively, and update both sides together.

## 1. Coordinates and units
- **Units:** meters. **Runtime / glTF:** Y-up, right-handed. Blender is Z-up; the glTF exporter converts `(x, y, z)_blender → (x, z, −y)_gltf`. **Every value in `manifest.json` and `character.json` is in glTF coordinates.**
- The floor is at `y = 0`. Ceiling height is 3.6 m; the atrium is double height (7.2 m).
- **Heading** `h` (radians): forward = `(sin h, 0, cos h)`. `h = 0` faces +z.
- **Module placement** is a translation plus a yaw `θ` (three.js `rotation.y = θ`):
  - point: `x' = x·cosθ + z·sinθ + tx`, `z' = −x·sinθ + z·cosθ + tz`
  - heading: `h' = h + θ`
- **There is no mirroring, ever.** Left-side wings are rotated by π.

## 2. Building layout (computed at runtime by `planBuilding`)

| Module | Local footprint | World placement |
|---|---|---|
| `atrium` | x ∈ [−33, 33], z ∈ [−24, 0]. The street opening is at local (0, 0) | origin (0, 0, 0), θ = 0 |
| `street` (one per bay) | x ∈ [−3, 3], z ∈ [0, 18] | origin (0, 0, 18·k), θ = 0 |
| `wing` / `garden` (right) | x ∈ [0, 30], z ∈ [−9, 9]. The door is at local (0, 0) and the wing extends along +x. In the wing, x ∈ [24, 30] holds the **Adapters room** (z ∈ [−9, 0]) and the **Library** (z ∈ [0, 9]), each with its own glass door from the pod area | origin (3, 0, 18·k + 9), θ = 0 |
| `wing` / `garden` (left) | same module | origin (−3, 0, 18·k + 9), θ = π |
| `cap` (end of building) | x ∈ [−33, 33], z ∈ [0, 0.5]. End wall + window | origin (0, 0, 18·nBays), θ = 0 |

- `garden` (an indoor garden with benches) fills an empty side of a bay, so the building outline stays a clean rectangle 66 m wide.
- Bays fill in order bay0-R, bay0-L, bay1-R, bay1-L, …

## 3. Navigation graphs
- Each module has `nav.nodes: { [id]: { x, z, width } }` (local coordinates; `width` is the walkable corridor half-width in meters) and `nav.edges: [idA, idB][]` (undirected).
- **Merging rule:** after placement, nodes from different modules whose world positions are within **0.05 m** are the same node. The connector nodes are:
  - atrium node at local (0, 0) ↔ street node at local (0, 0)
  - street nodes at (±3, 9) ↔ wing/garden door node at local (0, 0)
  - street node (0, 18) ↔ the next street's (0, 0), or the cap's node at (0, 0)
- **Requirements:** every anchor's `approach` point lies within 0.05 m of a nav node, or within its corridor `width`. Ensure each approach has a dedicated nav node (`ap:<anchorId>`) connected to the graph. Every graph is connected.

## 4. Anchors
- Anchor ids follow the grammar `<kind>:<group>:<index>[:<sub>]`. Kinds:
  - `seat`: groups `desk:<pod>` (pods 1–6, index 0–3), `meeting:<A|B>`, `lounge`, `cafe`
  - `spot`: groups `kitchen`, `booth`, `reception`, `elevator`, `pingpong:<table>:<A|B>`, `garden`
- In the manifest (module-local glTF coordinates):
  ```json
  "seat:desk:3:2": { "x": 1.2, "y": 0, "z": -4.0, "heading": 3.14159, "pose": "sit",
                     "room": "pod-3", "screen": "desk:3:2", "approach": { "x": 1.2, "z": -3.4 } }
  ```
- `pose` is one of `sit`, `stand`, `lounge`. The anchor's `y` is always the floor (0). Sit clips are authored for a 0.47 m seat, lounge clips for a 0.42 m seat.
- **An anchor's (x, z) is where the character's root bone stands, not the seat center.** In the sit clips the root is the standing spot in front of the chair:
  - `sit`: the seat center is **0.29 m behind** the root (opposite the heading), and the desk edge is about 0.13 m in front.
  - `lounge`: the seat center is **0.36 m behind** the root.
  - `stand`: the root is the spot itself.

  These offsets are also written to `character.json` (`sit` / `lounge`). The renderer places the root exactly at the anchor, with no extra offset.
- Optional keys: `room` (`pod-N` / `meeting-A` / `meeting-B` / `booth-N` / `kitchen` / `lounge` / `cafe` / `reception` / `elevator` / `pingpong-N` / `garden`), `screen` (the id of the monitor surface), `led` (id of the booth LED ring).
- **Room groups added for capabilities** (docs/capabilities.md):
  - `spot:station:<0-7>` (stand, facing the station screen about 0.6 m away, room `adapters`)
  - `seat:reading:<0-3>` (sit, root rule as above, room `library`)
  - `spot:shelf:<0-1>` (stand in front of shelf A/B, room `library`; two people may share a spot using a 0.6 m lateral offset)
- **New anchor kind `port`.** It's a 3D link attach point and the **only kind with y ≠ 0**. It has `{x, y, z}` and no heading, pose or approach:
  - `port:desk:<pod>:<i>`: top of each desk monitor, y ≈ 1.25
  - `port:station:<i>`: top of each station screen, y ≈ 2.3
  - `port:book:<0-23>`: the spine center
  - `port:board:<0-5>`: the board center
  - `port:notebook:<0-7>`
- **Project spaces (additive, atrium only):** the Project Hub, the Handoff Station and the Session Archive. Older manifests without them still parse and fall back to the reception desk:
  - `kiosk:project-directory` (1, stand, room `hub`): the visitor spot in front of the Project Directory kiosk; the kiosk stands 1.1 m ahead along the anchor's heading. The runtime pick proxy and the 2D `project-directory` interaction use it, falling back to the centre of `spot:reception:*` when it is missing.
  - `console:context:<0-5>` (stand, room `hub`): the visitor spot at each of six consoles around the Context Hub core, facing the core. Kind `console` is new (grammar `console:<group>:<index>`); `kiosk` takes a name (`kiosk:<name>`, lowercase and hyphens).
  - `spot:handoff:<0-1>` (stand, room `plaza`): the two sides of the Handoff Station pad, facing each other across the pedestal.
  - `port:archive:<0-11>` (a port, y ≈ 1.6, room-less): the spine of the volume in each of the twelve arched alcoves of the Session Archive, left to right. Alcoves 0–11 are archive volumes for the runtime to label or glow; nothing draws on them yet.
- **Required counts per module:**
  - **wing:** 24 desk seats (6 pods × 4); `meeting:A` and `meeting:B` with 6 seats each; 4 booth spots; 6 kitchen spots; 8 lounge seats; **8 station spots; 4 reading seats; 2 shelf spots; ports for all 24 desks, 8 stations, 24 books, 6 boards and 8 notebooks**
  - **atrium:** 4 reception spots, 6 elevator spots, 24 cafe seats, 2 ping-pong tables × A/B; **1 `kiosk:project-directory`, 6 `console:context:*`, 2 `spot:handoff:*`, 12 `port:archive:*`**
  - **garden:** 6 garden spots

## 5. glTF node roles (runtime-driven surfaces)
three.js strips `:` from node names, so the **role is carried in glTF `extras`** (which become `userData`) on the mesh's node:

| `extras.role` | `extras.ref` | Runtime behavior |
|---|---|---|
| `screen` | `desk:3:2`, `meeting:A`, `arcade:0`, `ledwall` | Emissive color or texture set at runtime |
| `led` | `booth:1` | Emissive ring; green when occupied by a waiting agent |
| `sign` | `wing` | A plane whose CanvasTexture shows the provider name (the runtime draws the text) |
| `elevatorDoor` | `0:L`, `0:R`, … | Slides open and closed along local x by ±0.55 m |
| `screen` | `context:<0-5>` | A Context Hub console screen (atrium). The runtime sets its emissive colour and strength: a steady glow, a pulse while a real retrieval runs through the project MCP station (`mcp:agent-office-memory`) |
| `screen` | `context-core` | The Context Hub core: the glowing column (atrium); pulses on the same signal as the consoles |
| `ceiling` | none | Hidden in orbit view, shown in walk mode |
| `collider` | none | Invisible boxes for walk-mode collision (exported as meshes; the runtime hides them and reads their bounding boxes) |
| `baked` | none | Static mesh with a UV1 lightmap (§6) |

- Monitor screens and LEDs are separate meshes with their own material, so the runtime can change their emissive color per instance. Clone the material per node.

| `station` | `<0-7>` | The adapter station screen. CanvasTexture drawn from `stationVM`; carries `extras.width`/`height` |
| `led` | `station:<0-7>` | The station floor ring; glows in the capability color while it's used |
| `screen` | `adapters-core` | Emissive strips on the core column of the Adapters room |
| `book` | `<0-23>` | A spine surface. The runtime draws the skill name on a per-shelf CanvasTexture atlas; carries `extras.width`/`height` |
| `board` | `<0-5>` | A rule board surface (title, scope badge, summary) |
| `notebook` | `<0-7>` | A memory notebook label |
| `sign` | `adapters`, `library` | Room signs; the runtime draws "Adapters" and "Library" |
| `glass` | none | Glass panes (not baked; cheap transparent material at runtime) |

## 6. Lightmaps
- **Per module there is one lightmap atlas:** an 8-bit sRGB PNG holding **irradiance / intensity** (irradiance = Cycles diffuse direct + indirect, without albedo).
- Every mesh with `extras.role = "baked"` has a second UV set (`TEXCOORD_1`) for it.
- **Runtime:** `material.lightMap = tex` (with `tex.channel = 1`, `tex.colorSpace = SRGBColorSpace`, `flipY = false`) and `material.lightMapIntensity = manifest.modules.<m>.lightmap.intensity`.
- Baked meshes should not also receive real-time lighting from the scene lights. The runtime handles this by using a dim ambient light plus an environment map for specular only.
- **Size tiers (additive):** `lightmap.variants?: { full, half, quarter }` lists images at full, ½ and ¼ resolution (e.g. `atrium.lightmap.half.webp`). The build writes WebP q95 from the 24-bit bake (sharp `lanczos3` for the downscales; SSIM ≥ 0.97 against the bake, checked by `--verify --visual`). `lightmap.file` is the full tier; readers fall back to it when `variants` is absent. The presets choose the tier (Minimal ¼, Low and Medium ½, High and Ultra full).
- The lossless 8-bit PNG bake stays in `assets/out/` as the source for `--repack`; `public/assets` ships only the WebP tiers.

## 6b. Textures (additive)
- **WebP/PNG only, no KTX2:** three's Basis transcoder (emscripten embind) needs eval (`new Function`), which the app's CSP forbids. Glb textures stay WebP q82 (base colour ≤ 1024², other slots ≤ 512²), and no glb may use `KHR_texture_basisu`.
- Every glb texture carries `extras.hash` (on the glTF image, so three puts it in `texture.userData.hash`): the first 12 hex chars of sha1 over the shipped image's decoded RGBA pixels. The runtime keeps **one GPU texture per hash across all modules**, so the six wings share their material textures (26 unique images).

## 7. `manifest.json` (written to `packages/web/public/assets/manifest.json`)
```json
{
  "version": 1,
  "blender": "5.2.2",
  "units": "m",
  "hash": "<sha256 of build inputs>",
  "hdri": "hdri/office.hdr",
  "modules": {
    "atrium": { "file": "atrium.glb", "lightmap": { "file": "atrium.lightmap.full.webp", "intensity": 3.2, "variants": { "full": "atrium.lightmap.full.webp", "half": "atrium.lightmap.half.webp", "quarter": "atrium.lightmap.quarter.webp" } },
                "bounds": { "minX": -27, "maxX": 27, "minZ": -24, "maxZ": 0 },
                "anchors": { "...": {} }, "nav": { "nodes": {}, "edges": [] } },
    "street": { "file": "street.glb", "lightmap": { "...": "" }, "bounds": {}, "anchors": {}, "nav": {} },
    "garden": { "file": "garden.glb", "...": "" },
    "cap":    { "file": "cap.glb", "...": "" },
    "wing":   { "themes": { "terracotta": { "file": "wing-terracotta.glb", "lightmap": { "file": "wing-terracotta.lightmap.full.webp", "intensity": 2.8, "variants": {} },
                                            "signColor": "#F4EDE4", "accent": "#D97757" },
                            "nordic": {}, "forest": {}, "ocean": {}, "neon": {}, "brass": {} },
                "bounds": { "minX": 0, "maxX": 24, "minZ": -9, "maxZ": 9 },
                "capacity": { "desk": 24, "meeting": 2, "meetingSeats": 6, "booth": 4, "kitchen": 6, "lounge": 8, "stations": 8, "books": 24, "boards": 6, "notebooks": 8, "readingSeats": 4 },
                "anchors": {}, "nav": {} }
  },
  "character": { "file": "character.glb", "meta": "character.json" }
}
```
- Every wing theme has **identical geometry for anchors and nav** (same builder; only materials and decor differ), so `anchors` and `nav` are listed once for `wing`.
- Wing ids in pinned order: `terracotta` (claude-code), `nordic` (openai-agents), `forest` (langgraph), `ocean`, `neon`, `brass`.

## 8. Character (`character.glb` + `character.json`)
- **One skinned character.** Material names: `skin`, `shirt`, `pants`, `hair`, `shoes`, `eyes`, `badge`. The runtime tints `skin`, `shirt`, `pants`, `hair` and `badge` per agent by cloning the materials.
- **Optional meshes** are identified by `extras.accessory`: `hairA`, `hairB`, `hairC`, `hairD`, `glasses`, `headset`, `badge`. All are hidden by default except `hairA`.
- **Props** are identified by `extras.prop` (`laptop`, `cup`, `phone`, `paddle`) and parented to bone `prop.R`, hidden by default.
- Bones (22 deform + `prop.R`): `root, hips, spine, chest, neck, head, shoulder.L/R, upperarm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R, toe.L/R`.
- **Clips are in place:** the root bone has no translation, and the character faces +z (heading 0). Names: `Idle, Walk, TurnL90, TurnR90, SitDown, StandUp, SitIdle, SitType, SitThink, SitTalk, SitLaptop, StandTalk, PhoneCall, DrinkCoffee, LoungeSit, PingPong, Wave, HeadScratch, ElevatorIn`, **plus `StandInteract`** (a loop: standing at a tall screen, swiping), **`SitRead`** (a loop: seated, reading the book prop) and **`ShelfPick`** (one-shot: reaching for a shelf at about 1.5 m and bringing a book to the chest). Props add **`book`**.
- `character.json`:
  ```json
  { "height": 1.75, "seatHeight": 0.47, "loungeSeatHeight": 0.42,
    "clips": { "Walk": { "duration": 1.0667, "loop": true, "speed": 1.4, "footPlants": [0, 0.5] },
               "SitDown": { "duration": 1.2, "loop": false }, "...": {} } }
  ```
  `speed` is the ground speed (m/s) the clip was authored for. `footPlants` is a list of normalized cycle phases.
- **Budgets:** ≤ 8k triangles for the base with all hair variants hidden, ≤ 1.5 MB glb.

## 9. Budgets (checked by `assets/validate.test.ts`)

| File | Max size | Max triangles |
|---|---|---|
| `atrium.glb` | 12 MB | 250k |
| `wing-*.glb` | 6 MB each | 190k (includes the Adapters room and Library) |
| `street.glb`, `garden.glb`, `cap.glb` | 3 MB each | 60k |
| `character.glb` | 1.5 MB | — |
| `packages/web/public/assets/` total | 55 MB | — |
| GPU texture memory estimate (all 6 themes, RGBA8 × 4/3, deduped by `extras.hash`): full / ½ / ¼ lightmap tier | 340 / 150 / 110 MB | — |

## 9b. Accepted deviations (reported by the asset builder, all additive)
- Ceiling meshes also carry `TEXCOORD_1` and `extras.lightmap=true`.
- Glass panes use `extras.role="glass"` and aren't baked.
- Sign and LED-wall nodes (and station, book and board surfaces) carry `extras.width` and `extras.height`.
- The lightmap `intensity` already includes the π factor three.js Lambert shading needs.
- Anchors live only in the manifest; there are no glTF empties.
- Static meshes are joined per material and lightmapped, so there's no GPU instancing.
- Reception monitors are static, not runtime screens.
- Lightmaps ship as WebP q95 tiers, not PNG. Earlier builds wrote the PNG with sharp's `effort` option, which quietly switched to a 256-colour palette (up to 69 levels off the bake). The tiers now come from the 24-bit bake.
- Measured after `make assets-repack`: 40.6 MB on disk. GPU estimate: 86.5 MB of glb textures (26 unique) plus lightmaps, giving 328 MB at full, 147 MB at ½ and 102 MB at ¼.

## 10. Branding
No logos, trademarks or real company names in any asset. Signs are blank planes; the runtime draws the provider id as text.

## 11. Floor plan (additive; used by the optional 2D RPG mode)
- `manifest.modules.<m>.plan` (the wing plan is shared by every theme), in **module-local metres**, written by the Blender build (`lib/geometry.py`, `lib/furniture.py`, module scripts) and merged by `node assets/build.mjs --plan-only` (`make assets-plan`). It doesn't touch the glbs or lightmaps.
- `rooms: [{ id, name, rect: [x0, z0, x1, z1], floor? }]`: every anchor's `extras.room` names one of these rooms.
- `walls: [{ a: [x, z], b: [x, z], kind: 'solid' | 'glass' | 'curtain', openings?: [[t0, t1]], side?: -1 | 1, thick?: m }]`: `side` is the side of the a→b line the wall body extends to (−1 left, +1 right, module-local), and `thick` is the body thickness. The 2D map uses them to place a wall on the tile its 3D body occupies, the same in mirrored wings. openings are door and gap intervals in metres along a→b. Every nav edge that crosses a wall must pass through an opening.
- `furniture: [{ kind, x, z, w, d, yaw, ref? }]`: `kind` is from `FURNITURE_KINDS` (`packages/web/src/app/pixel/types.ts`). `ref` links interactive pieces to anchors (`station:<i>`, `book:<i>`, `board:<i>`, `notebook:<i>`, `booth:<i>`). Only furniture that exists in the 3D module is listed.
- **Project spaces (additive):** new kinds `kiosk` (Project Directory dais and screen, `interact` project-directory), `context-core`, `console`, `handoff-pad`, `archive-alcove` (a strip along x; the Session Archive arcade) and `lectern`. The plan also has the rooms `hub` (Project Hub, x ∈ [−18.2, −11], z ∈ [−24, −13.4]) and `archive` (Session Archive, x ∈ [−11, 0], z ∈ [−24, −21]), and the Handoff Station disc is a `rug` around a `handoff-pad`. The old `waiting` room ends at x = −18.2 and `plaza` starts at z = −21 (`plaza-s` fills x ∈ [0, 3], z ∈ [−24, −21]). The kiosk's visitor spot is `kiosk:project-directory`.
- **Optional:** the 3D renderer ignores it, and the 2D mode shows a "map data missing" card without it.
- **Details (as exported):**
  - `rect` is axis-aligned in module space. Rooms tile each module without overlapping (rooms without anchors, such as `hall`, `vestibule`, `plaza`, `court`, `storage`, `pods-north`/`pods-south`, cover the rest of the floor). `floor` is one of `wood`, `carpet`, `tile`, `concrete`.
  - Walls are centre lines. Only floor-level cuts are `openings` (raised wall cuts are windows); touching cuts are merged. A glass partition's door is its opening. Walls built without the kit (the wing's x = 23.92 front and z = 0 partition, the atrium's reception screen, the cap's outer skin) are recorded with `plan_wall`. A nav edge that only touches a wall line at a node doesn't cross it.
  - Furniture: `(x, z)` is the footprint centre, `w` runs along the piece's local x and `d` along its local z, and `yaw` is its rotation about +y with the §1 placement convention (`three.js rotation.y`), normalized to (−π, π].
  - The wing plan is shared by every theme: rooms and walls must match across themes, and furniture is the intersection of all six themes (theme-only decor, such as the neon arcade or extra plants, is left out). Pod chairs are listed at their nominal spot (the 3D chair has a small per-theme jitter).
  - Mappings where the kit has no exact kind: lounge coffee table → `cafe-table`, wing storage cabinets → `kitchen-counter`, meeting-room whiteboards → `board` (no `ref`), atrium bleachers → `bench`, the garden's reflecting pool → `planter`. Only floor-standing pots are `plant`; tabletop decor, lamps, pendants, living walls, murals and LED rings aren't listed.
  - `ref` is set on `booth:<i>`, `station:<i>` and `board:<i>`. Books and notebooks are reached through their `port:book:<i>` / `port:notebook:<i>` anchors; the library shelves are one `bookshelf` each and the notebook display is one `notebook-rack`.
  - Checked by `assets/validate.ts` (`checkPlans`, PLAN-1..5): shape and kinds, walls and openings within the bounds, every seat/spot inside the room its `extras.room` names (or any room when it has none), approach points outside solid furniture (rugs aren't solid), and nav edges crossing walls only through openings.

## 12. Pixel assets (additive; the optional 2D RPG mode)
- **Sources:** `assets/pixel/src/**`, hand-authored text pixel grids plus palettes (`docs/pixel-style.md`). **Build:** `make pixel-assets` → `packages/web/public/assets/pixel/{tiles,objects,characters,effects,font}.png` + `atlas.json`.
- **Sizes:** 16 px per metre (16×16 px floor tiles = 1 m; furniture at its plan size per `assets/pixel/src/sizes.json`); characters 16×24 px; a 5×7 bitmap font. Original work (MIT); no copied or traced third-party sprites, tiles or fonts; no logos.
- **Budget:** ≤ 2 MB total, included in the 55 MB asset budget (§9).
