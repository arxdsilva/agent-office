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
| `atrium` | x ∈ [−27, 27], z ∈ [−24, 0]. The street opening is at local (0, 0) | origin (0, 0, 0), θ = 0 |
| `street` (one per bay) | x ∈ [−3, 3], z ∈ [0, 18] | origin (0, 0, 18·k), θ = 0 |
| `wing` / `garden` (right) | x ∈ [0, 24], z ∈ [−9, 9]. The door is at local (0, 0) and the wing extends along +x | origin (3, 0, 18·k + 9), θ = 0 |
| `wing` / `garden` (left) | same module | origin (−3, 0, 18·k + 9), θ = π |
| `cap` (end of building) | x ∈ [−27, 27], z ∈ [0, 0.5]. End wall + window | origin (0, 0, 18·nBays), θ = 0 |

- `garden` (an indoor garden with benches) fills an empty side of a bay, so the building outline stays a clean rectangle 54 m wide.
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
- Optional keys: `room` (`pod-N` / `meeting-A` / `meeting-B` / `booth-N` / `kitchen` / `lounge` / `cafe` / `reception` / `elevator` / `pingpong-N` / `garden`), `screen` (the id of the monitor surface), `led` (id of the booth LED ring).
- **Required counts per module:**
  - **wing:** 24 desk seats (6 pods × 4); `meeting:A` and `meeting:B` with 6 seats each; 4 booth spots; 6 kitchen spots; 8 lounge seats
  - **atrium:** 4 reception spots, 6 elevator spots, 24 cafe seats, 2 ping-pong tables × A/B
  - **garden:** 6 garden spots

## 5. glTF node roles (runtime-driven surfaces)
three.js strips `:` from node names, so the **role is carried in glTF `extras`** (which become `userData`) on the mesh's node:

| `extras.role` | `extras.ref` | Runtime behavior |
|---|---|---|
| `screen` | `desk:3:2`, `meeting:A`, `arcade:0`, `ledwall` | Emissive color or texture set at runtime |
| `led` | `booth:1` | Emissive ring; green when occupied by a waiting agent |
| `sign` | `wing` | A plane whose CanvasTexture shows the provider name (the runtime draws the text) |
| `elevatorDoor` | `0:L`, `0:R`, … | Slides open and closed along local x by ±0.55 m |
| `ceiling` | none | Hidden in orbit view, shown in walk mode |
| `collider` | none | Invisible boxes for walk-mode collision (exported as meshes; the runtime hides them and reads their bounding boxes) |
| `baked` | none | Static mesh with a UV1 lightmap (§6) |

- Monitor screens and LEDs are separate meshes with their own material, so the runtime can change their emissive color per instance. Clone the material per node.

## 6. Lightmaps
- **Per module there is one lightmap atlas:** an 8-bit sRGB PNG holding **irradiance / intensity** (irradiance = Cycles diffuse direct + indirect, without albedo).
- Every mesh with `extras.role = "baked"` has a second UV set (`TEXCOORD_1`) for it.
- **Runtime:** `material.lightMap = tex` (with `tex.channel = 1`, `tex.colorSpace = SRGBColorSpace`, `flipY = false`) and `material.lightMapIntensity = manifest.modules.<m>.lightmap.intensity`.
- Baked meshes should not also receive real-time lighting from the scene lights. The runtime handles this by using a dim ambient light plus an environment map for specular only.

## 7. `manifest.json` (written to `packages/web/public/assets/manifest.json`)
```json
{
  "version": 1,
  "blender": "5.2.2",
  "units": "m",
  "hash": "<sha256 of build inputs>",
  "hdri": "hdri/office.hdr",
  "modules": {
    "atrium": { "file": "atrium.glb", "lightmap": { "file": "atrium.lightmap.png", "intensity": 3.2 },
                "bounds": { "minX": -27, "maxX": 27, "minZ": -24, "maxZ": 0 },
                "anchors": { "...": {} }, "nav": { "nodes": {}, "edges": [] } },
    "street": { "file": "street.glb", "lightmap": { "...": "" }, "bounds": {}, "anchors": {}, "nav": {} },
    "garden": { "file": "garden.glb", "...": "" },
    "cap":    { "file": "cap.glb", "...": "" },
    "wing":   { "themes": { "terracotta": { "file": "wing-terracotta.glb", "lightmap": { "file": "wing-terracotta.lightmap.png", "intensity": 2.8 },
                                            "signColor": "#F4EDE4", "accent": "#D97757" },
                            "nordic": {}, "forest": {}, "ocean": {}, "neon": {}, "brass": {} },
                "bounds": { "minX": 0, "maxX": 24, "minZ": -9, "maxZ": 9 },
                "capacity": { "desk": 24, "meeting": 2, "meetingSeats": 6, "booth": 4, "kitchen": 6, "lounge": 8 },
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
- **Clips are in place:** the root bone has no translation, and the character faces +z (heading 0). Names: `Idle, Walk, TurnL90, TurnR90, SitDown, StandUp, SitIdle, SitType, SitThink, SitTalk, SitLaptop, StandTalk, PhoneCall, DrinkCoffee, LoungeSit, PingPong, Wave, HeadScratch, ElevatorIn`.
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
| `wing-*.glb` | 5 MB each | 150k |
| `street.glb`, `garden.glb`, `cap.glb` | 3 MB each | 60k |
| `character.glb` | 1.5 MB | — |
| `packages/web/public/assets/` total | 45 MB | — |

## 10. Branding
No logos, trademarks or real company names in any asset. Signs are blank planes; the runtime draws the provider id as text.
