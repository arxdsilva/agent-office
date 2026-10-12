# Pixel style guide (2D RPG mode)

The optional 2D view draws the same office as the 3D view, as a warm GBA-era top-down RPG town turned into a
software HQ. All of its art is **original**, authored as text grids in `assets/pixel/src/**` and compiled by
`make pixel-assets` (`node assets/pixel/build.mjs`) into `packages/web/public/assets/pixel/`. Graphics contract §12
holds the budget; this page holds the look and the atlas schema.

## Rules

| Do | Don't |
|---|---|
| Draw every pixel yourself in a `.px` grid with palette keys | Copy, trace or "reference closely" any Nintendo, Game Freak or other third-party sprite, tile or font |
| Keep signs, boards and screens blank; draw text at runtime with the bitmap font | Put a logo, trademark, brand or company name in any asset |
| Use the palettes in `src/palettes.json` | Introduce an ad-hoc hex colour in a grid |
| Check `assets/pixel/previews/*.png` after every change | Ship art you have only seen as text |

## Scale: 16 px per metre (GBA scale)

- **One tile is 16×16 px = 1 m.** Floors are drawn per 1 m cell. **Furniture, walls and rooms are not snapped
  to tiles**: the map places them at their exact floor-plan position in pixels (16 px/m, rounded to whole
  pixels), so the 2D office is the 3D office at a fixed scale, and agents sit exactly where 3D seats them.
- **Characters:** 16×24 px (one metre wide, chunky GBA proportions); the anchor is the feet (8, 23).
  **Font:** 5×7 cells, caps 6 rows, descenders on row 7, proportional, 1 px spacing.
- **Furniture art is drawn to size.** Each kind has a canonical size in `assets/pixel/src/sizes.json`: its **base**
  (the footprint in px, which is also the solid box) and its **overhang** (px drawn above the base, the 3/4
  view). A frame is `base.w` wide and `base.h + overhang` tall; declare it with
  `@meta {"footPx":[w,h]}`. `v` / `e` / `w` art swaps the base (`[h, w]`). `build.test.ts` checks every frame
  against the table; the map checks every placed object against its plan footprint (±25%).
- **Classes** (`sizes.json` `class`): **fixed** pieces are one frame at the base size; **strip** pieces
  (counters, bookshelves, benches, planters, the cafe bar, the LED wall) are a repeat **unit** of the given
  thickness, tiled along any length; **area** pieces (rugs, the elevator bank, pools, bleachers) are a 9-slice
  frame whose edges come from its outer 4 px.

| Kind | Metres | Base px | Overhang | | Kind | Metres | Base px | Overhang |
|---|---|---|---|---|---|---|---|---|
| desk | 1.6×0.8 | 26×13 | 12 | | sofa | 2.75×0.92 | 44×15 | 8 |
| chair | 0.55 | 10×10 | 10 | | armchair | 0.82 | 13×13 | 8 |
| meeting-table | 2.4×1.1 | 38×18 (v 18×38) | 8 | | fridge | 0.7×0.65 | 11×10 | 20 |
| booth | 1.4 | 22×22 | 22 | | island | 2.64×1.05 | 42×17 | 10 |
| station | 1.68×0.4 | 27×7 | 18 | | reception-desk | 4.36×1.64 | 70×26 | 14 |
| board / tv / sign | ~1.0–1.6×0.1 | 16×4 / 26×4 / 26×4 | 18 / 14 / 8 | | pingpong | 2.74×1.52 | 44×24 (v 24×44) | 6 |
| plant | 0.5 | 8×8 | 14 | | cafe-table | 0.9 | 14×14 | 8 |

  Strips: bench 7 thick (unit 24), planter 8 (16), kitchen-counter 10 (32), cafe-bar 11 (32), bookshelf 7 (32,
  overhang 24), led-wall 4 (48, overhang 26). The full table, with the remaining kinds, is `sizes.json`.
- **Walls** are thin: a **4 px** top strip (solid and drawn, centred on the 3D wall body) and a **12 px** 3/4 face
  drawn above a horizontal wall when a room lies south of it. Glass walls use the glass top and a translucent
  face. Doors are gaps at their real width (the narrowest, 1 m, is 16 px).
- **Projection:** GBA three-quarter top-down. Furniture shows its top surface and its front face; the base sits at
  the bottom of the frame and the frame extends upwards for height.
- **Light** comes from the top-left: highlights on top and left edges, shadows on bottom and right edges, and a
  soft translucent contact shadow (`:` / `;`) under furniture and along walls (`shade/*` tiles).
- **Outlines:** 1 px dark outline on characters and objects, never on floors. Character outlines are the darkest
  step of their own ramp ("sel-out"), so a red shirt has a deep red outline.
- **Ramps:** at most 4 shades per material: highlight, base, shadow, outline.

## Palettes

- `office`: about 36 shared colours (ink, greys, oak, walnut, glass, leaves, metal, screen glow, a few accents,
  concrete, grass) plus translucent keys for shadows (`:` `;`), glass (`~` `=` `^`) and warm light (`%` `&`).
- `themes`: 11 slot keys swapped per wing, mirroring the 3D themes (`assets/blender/themes.py`): `F G H` floor,
  `W V U` wall, `A B C` accent (base, dark, light), `R` rug, `T` trim. Any grid using a slot key is rendered once
  per theme (`house` for the atrium and street, then terracotta, nordic, forest, ocean, neon, brass).
  Each theme also names its floor (`atlas.themes[t].floor`): parquet, wood, concrete, terrazzo or carpet.
- `char`: character keys. Numbers are ramp indices into `recolorSource`; strings are fixed colours (eyes, mouth,
  blush, glasses, headset).
- `ramps`: `[highlight, base, shadow, outline]` for every skin, shirt, pants and hair colour that
  `appearanceOf()` (`web/src/app/motion.ts`) can pick, plus `shoes`, `outfit` (the player's cap) and `jacket`.

## Characters

Parts (`src/characters/*.px`): heads (s, n, e; talk and blink variants), bodies (stand, walk, sit, lounge), arms
(18 poses: down, swing, type, lap, chin, gesture, hold, phone, up, scratch, out, paddle), hair a–d, glasses,
headset, cap, jacket, badge and props. `anims.json` composes **poses** from parts (`dy` lowers head and arms:
3 seated, 4 lounging, 1 on a footfall or a breath) and lists **animations**. West is east mirrored.

The build composes each pose, then splits it into recolourable layers, so the runtime only stacks and tints:

| Layer (draw order) | Recolour group | Notes |
|---|---|---|
| body | skin | head, hands, eyes, mouth |
| shoes, pants, shirt | shoes, pants, shirt | disjoint from body |
| jacket | (fixed) | player only: the inner tee; the player's shirt uses `ramps.jacket.default` |
| badge | badge | lanyard in the team's shirt colour (`plan.teamOf`) |
| hair-a … hair-d | hair | one per agent (`hairA`–`hairD`) |
| glasses, headset | (fixed) | optional |
| cap | outfit | player only |

Overlays are masked under the arms, so a hand at the ear or on the head is drawn over the hair.

| Animation | Frames | | Animation | Frames |
|---|---|---|---|---|
| idle | 2 (+ blink) | | phone | 2 |
| walk | 4 | | stand-interact | 2 |
| sit | 1 | | coffee | 2 |
| sit-type | 2 | | lounge | 1 (+ blink) |
| sit-think | 2 | | pingpong | 2 |
| sit-talk | 2 | | confused | 2 |
| idle-talk | 2 | | wave | 2 (one-shot, 1.33 s) |
| read | 1 (+ blink) | | elevator-in / -out | 3 (one-shot, 1.33 s, alpha) |

Plus `sit-down` and `stand-up` (2 frames each). The **player** is the same base with a cap, a jacket and the
`marker` effect above the head, so they're never mistaken for an agent.

## Atlas schema (`atlas.json`)

| Field | Shape |
|---|---|
| `sheets` | `{tiles, objects, characters, effects, font, ui}` → `{file, w, h}`; plus `frame.png` (the 9-slice alone) |
| `frames` | `"<prefix>:<name>"` → `{sheet, x, y, w, h, ax, ay}`; draw at `(pos.x - ax, pos.y - ay)`. Prefixes `tile: obj: char: fx: glyph: ui:` |
| `tiles`, `tileIds` | `tiles[id]` = `{id, name, theme?, frame, layer, solid, mask?}` (id 0 = empty); `tileIds["name@theme" or "name"]` → id. Look up `name@theme` first, then `name` |
| `tileSets` | `wallTop` (`wall/top-%mask%`, N=1 E=2 S=4 W=8 when the neighbour is wall), `wallFace` hi/lo per wall kind, `rug` 9-slice, `shade` |
| `objects` | `kind` → `variants[facing or state]` → `{frame, themed, footPx: [w, h], foot: [tw, th] (= ceil(footPx/16), for the minimap), solid, sortY, interactive?, screen?, text?, stretch?, seat?, flat?}`. Themed frames are `${frame}@${theme}`. The anchor is the base's top-left; `sortY` is the base's bottom edge. The atlas header carries `pxPerMetre: 16`. `screen`/`text` are rects for runtime drawing (status colour, sign text); `stretch: [l, r]` lets a renderer repeat the middle columns |
| `characters` | `size`, `anchor`, `layers`, `recolor: {source, groups}`, `poses["<pose>-<dir>"] = {hand, propBehind, seated}`, `props` |
| `animations` | `[{name, dir, loop, frames: [{ref: "<pose>-<dir>", ms, alpha?}]}]`, every animation × s n e w |
| `clipDurations` | animation → seconds per cycle (the 2D scene reports them to the director) |
| `effects` | `name` → `{loop, frames: [{ref, ms}], tint?}`: thinking, gear, bang, cross, sparkle, page, beam, prompt-e, booth-glow, marker, shadow, select |
| `font` | `{cell, lineHeight, glyphs: {char: {frame, w, advance}}}`: white glyphs, tint at runtime |
| `ui` | `frame` (24×24, `slice: 8`), `frame-dark`, `tag`, `cursor`, `key` |
| `themes`, `palettes` | per-theme floor and slot colours; ramps for recolouring |

Recolouring: a pixel equal to `recolor.source[i]` becomes `ramp[i]` of the layer's group.

## Adding art

- **A tile:** add an `@frame floor/xyz` block (16×16) to a file in `src/tiles/`. Use theme slots for wing colours,
  `@meta {"solid":true}` for blocking tiles and `@meta {"autotile":true,"edge":"T"}` for 16 neighbour masks.
- **An object:** add `@frame kind[@facing]` to `src/objects/*.px` with `@meta {"footPx":[w,h]}` at the size in `sizes.json`; give facings `s`,
  `n`, `e`, `w` where the shape is directional.
- **An animation:** add poses (reusing parts) and the animation to `src/characters/anims.json`; new parts go in the
  `characters/*.px` files with the `char` palette.
- Copies: `@frame b from=a flip=x|y dx=… dy=… wrap=1 edgeL=k` reuse a grid in the same file.
- Then run `make pixel-assets`, look at `assets/pixel/previews/`, and run `pnpm vitest run --project unit assets/pixel`
  (parse, references, contract coverage, budget ≤ 2 MB, deterministic bytes).
