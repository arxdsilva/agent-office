# Night City (Special 3D): Assets

Status: **R1 built**. Contract: `docs/graphics-contract.md` §13 (wall ids) and §14 (the Night City set).

## Commands

| Command | What |
|---|---|
| `make special-assets` | final build (Cycles bakes: hq-atrium and command at 4096 px / 384 spp, skyline at 1024 / 64) → `packages/web/public/special3d/` + `assets/special3d/out/` |
| `make special-assets-draft` | fast build (1024 / 24, skyline 256 / 8) → `public/special3d/` + `assets/special3d/draft/` |
| `make special-assets-test` | Blender-side tests (`assets/blender/special3d/tests/test_special.py`) |
| `node assets/special3d/build.mjs --previews [--shots a,b]` | Eevee stills of the placed set → `assets/previews/special3d/` (`ASSET_PREVIEW_ENGINE=EEVEE`; Cycles otherwise) |
| `node assets/special3d/build.mjs --verify` | re-validate `public/special3d` with the `special` profile |
| `--modules hq-atrium,command,skyline`, `--jobs N`, `--skip-character` | partial builds reuse earlier fragments in `assets/cache/special-work-<quality>` |

The special build shares the optimizer (WebP textures with `extras.hash`, exact `_WALLID`, meshopt), the
lightmap tiers, the Poly Haven pins and the Blender helpers with the classic build (`assets/lib/pipeline.mjs`).
It never reads or writes `packages/web/public/assets`, and the classic build never touches `public/special3d`.

## Layout of the sources

| Path | What |
|---|---|
| `assets/special3d/build.mjs` | orchestrator (Blender runs, merge, optimize, publish, verify) |
| `assets/blender/special3d/build.py` | Blender entry: per module build → bake → export glb + lightmap + manifest fragment; `--previews`; `--hdri` |
| `hq_atrium.py`, `command.py`, `skyline.py` | the modules (each exposes `PLACEMENT` and `build(g, A, P, rng)`) |
| `palette.py` | materials and the generated textures |
| `props.py` | the prop kit (pods, chairs, gates, elevators, bonsai, sofas, racks, booths, terminals, the brand mark, …) |
| `navkit.py` | links anchor approaches to hubs without crossing walls or colliders |
| `env.py` | the procedural night HDRI (`hdri/night.hdr`) and the bake/preview world |
| `character_cyber.py` | the cyber character (classic rig + clips, new outfits) |
| `tests/test_special.py` | Blender-side checks |

## Manifest (`packages/web/public/special3d/manifest.json`)

```json
{ "version": 1, "set": "special", "blender": "5.2.2", "units": "m", "hash": "…", "hdri": "hdri/night.hdr",
  "modules": {
    "hq-atrium": { "file": "hq-atrium.glb",
                   "lightmap": { "file": "hq-atrium.lightmap.full.webp", "intensity": 3.1,
                                 "variants": { "full": "…", "half": "…", "quarter": "…" } },
                   "bounds": {}, "placement": { "x": 0, "z": 0, "yaw": 0 }, "height": 14,
                   "connectors": { "command": { "x": 20, "z": -9 } },
                   "anchors": {}, "nav": { "nodes": {}, "edges": [] }, "plan": {} },
    "command":   { "…": "", "placement": { "x": 20, "z": -9, "yaw": 0 }, "departments": { "0": { "pods": 6, "seats": 24, "accent": "cyan" } } },
    "skyline":   { "…": "", "bands": 3, "streetY": -220, "anchors": {}, "nav": { "nodes": {}, "edges": [] } } },
  "character": { "file": "character-cyber.glb", "meta": "character-cyber.json" } }
```

- `placement`, `height`, `connectors`, `departments`, `bands` and `streetY` are additive keys of this set.
- Nav nodes may carry `y` (mezzanine height); anchors are always on the floor (`y = 0`).
- `plan` follows contract §11; every wall has `id` and `h` (§13), and baked and ceiling meshes carry
  `_WALLID`, so the cutaway works here as in Classic.

## Roles (contract §5 + §14)

| Role | Refs | Notes |
|---|---|---|
| `holo` | `display` (20 × 9 m), `project-directory`, `command-display` (four outward panels, `extras.faces = 4`) | `extras.width/height`; placeholder dashboard emission |
| `screen` | `ws:<d>:<p>:<s>` (144, `extras.count` monitors), `display-ticker`, `provider:<0–5>`, `meet:A|B` | |
| `led` | `booth:<0–3>` | the booth's indicator ring |
| `elevatorDoor` | `<0–3>:L|R` | slides ±0.55 m along local x |
| `rain-glass` | the curtain-wall panes | replace with the rain shader |
| `glass` | partitions, railings, gate flaps (frosted) | |
| `ad` | `ad:<0–7>` | `extras.width/height/band`; placeholder abstract art |
| `neon` | `neon:<0–5>` | `extras.flicker` = looped `[on s, off s, on s, off s]`, `phase`, `color` |
| `traffic` | `lane-<0–3>` | a faint guide ribbon; `extras.points` (flat xyz, module coords), `stride` 3, `speed` m/s, `closed` |
| `baked` / `ceiling` / `collider` | | skyline baked meshes carry `extras.band` (0–2) |

## Budgets (checked by `validateAssets(dir, 'special')`)

| File | Max size | Max tris |
|---|---|---|
| `hq-atrium.glb` | 16 MB | 300k |
| `command.glb` | 14 MB | 260k |
| `skyline.glb` | 6 MB | 120k |
| `character-cyber.glb` | 1.8 MB | 9k base |
| `public/special3d` total | 70 MB | — |

The classic set keeps its own 55 MB total, measured over `public/assets` only.

## Licensing

New CC0 Poly Haven textures are pinned in `assets/blender/polyhaven.json` and listed in `assets/LICENSES.md`.
Everything else (geometry, the generated textures, the night HDRI, the character's outfits) is original
work under the repository's MIT license. Git LFS covers `public/special3d/**` (glb, png, webp, hdr) and
`assets/special3d/out/**`. The draft output dir `assets/special3d/draft/` should be gitignored, like
`assets/draft/`.
