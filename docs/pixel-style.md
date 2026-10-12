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

## Sizes and projection

- **Tiles:** 16×16 px at 0.5 m. **Characters:** 16×24 px, one tile wide; the head overlaps the tile above; the
  anchor is the feet (8, 23). **Font:** 5×7 cells, caps 6 rows, descenders on row 7, proportional, 1 px spacing.
- **Projection:** GBA three-quarter top-down. A wall is a 16 px top (autotiled) plus a 32 px face (`face-hi`,
  `face-lo`) on the two rows south of it. Furniture shows its top surface and its front face; the footprint sits
  at the bottom of the frame and the frame extends upwards for height.
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
| `objects` | `kind` → `variants[facing or state]` → `{frame, themed, foot: [tw, th], solid, sortY, interactive?, screen?, text?, stretch?, seat?, flat?}`. Themed frames are `${frame}@${theme}`. The anchor is the footprint's top-left; `sortY` is the feet line below it. `screen`/`text` are rects for runtime drawing (status colour, sign text); `stretch: [l, r]` lets a renderer repeat the middle columns |
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
- **An object:** add `@frame kind[@facing]` to `src/objects/*.px` with `@meta {"foot":[tw,th]}`; give facings `s`,
  `n`, `e`, `w` where the shape is directional.
- **An animation:** add poses (reusing parts) and the animation to `src/characters/anims.json`; new parts go in the
  `characters/*.px` files with the `char` palette.
- Copies: `@frame b from=a flip=x|y dx=… dy=… wrap=1 edgeL=k` reuse a grid in the same file.
- Then run `make pixel-assets`, look at `assets/pixel/previews/`, and run `pnpm vitest run --project unit assets/pixel`
  (parse, references, contract coverage, budget ≤ 2 MB, deterministic bytes).
