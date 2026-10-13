# Night City (Special 3D): Art direction

Status: **R1 built** (hq-atrium, command, skyline, character-cyber). Contract: `docs/graphics-contract.md` §13–§14.

An original cyberpunk corporate headquarters for the fictional **Meridian Dynamics**: a tall, dark atrium with a
giant suspended display, skybridges silhouetted against it, bonsai under amber uplights, low angular seating,
cool cyan ceiling fixtures, wet reflective floors and a rainy neon skyline behind a full-height curtain wall.
We match the mood of the references (a corporate atrium in a neon city), never their content: no game
assets, names, logos, typography or layouts are copied.

## Palette

| Role | Colour |
|---|---|
| Base | charcoal `#0d0f12`, graphite `#1a1d22`, navy `#0f1a2a`, brushed steel |
| Accents | cyan `#29e3ff`, magenta `#ff2bd6`, amber `#ffb02e`, acid yellow `#d7ff3a`, deep red `#e0202e` |

Cyan is architecture and data (ceiling lines, gates, guide strips, holo), amber is people and comfort
(lounge, reception, bonsai uplights), magenta is the city and the display edges, acid and red are warnings
(card-reader pads, camera tally lights, hazard bands).

## Lighting hierarchy

1. **Architectural, baked, cool:** sparse linear fixtures in deep ceiling coffers, so the 14 m volume keeps
   deep shadows between them.
2. **Screens and signage:** the display, monitors and holo panels are emissive and bake their bounce
   (`bake_emit`), so the cyan wash on the floor and the bridges comes from the screen itself.
3. **Accents:** neon strips (sofa under-glow, gate edges, floor inlays, stair nosings), point uplights in the
   bonsai planters.
4. **Exterior:** window atlases, ads, aviation lights, a glowing street grid 220 m below, traffic lanes.

At runtime, at most 4 dynamic lights per room; everything else is emissive plus lightmap.

## Materials

PBR only, no plastic gloss. Pinned CC0 Poly Haven maps (`assets/LICENSES.md`) plus textures generated in
`assets/blender/special3d/palette.py`:

| Surface | Source |
|---|---|
| Polished dark stone floor (atrium), sealed wet concrete (Command Center) | `granite_tile`, `hangar_concrete_floor` + a generated puddle roughness map (sparse soft-edged wet patches) |
| Concrete wall panels, painted steel, floor plate | `concrete_panels`, `metal_plate` |
| Polished stone counters, planters, benches | `marble_01`, darkened |
| Brushed metal | generated streak normal map |
| Carbon panels | generated 2×2 twill (base colour + normal) |
| Dark glass, rain glass (role `rain-glass`), frosted partitions | constant materials (the runtime swaps rain-glass for its rain shader) |
| Neon | procedural constant emissive |
| Screens, holo, ads | generated abstract placeholders (dashboard UI, gradient art; no text); the runtime draws live content over them |
| Skyline windows | generated window atlases per depth band (warm offices, cool labs, sparse residential), lit by whole floors |

## Brand

"Meridian Dynamics" is shown only as a geometric mark built from primitives: a ring cut by a horizontal
meridian with two upward chevrons. It appears above the elevator bank, large on the east wall, on the
wayfinding pylons and on the department signs. There is no text anywhere in the assets.
`tests/test_special.py` rejects text objects and third-party names in object, mesh, material and image names.

## Storytelling props

Security cameras with tally lights, card readers at the elevators and the corridor door, wall vents,
maintenance panels with hazard bands, conduits up the stair wall, equipment cases at the stair foot, cable
trays, server racks with status lights, chevron floor markings at the gates.

## Reviewing

`node assets/special3d/build.mjs --previews [--shots wide,display]` renders the set (every module placed,
the skyline outside) with Eevee into `assets/previews/special3d/`. The character lineup comes from
`character_cyber.py --preview <dir>`.
