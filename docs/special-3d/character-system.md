# Night City (Special 3D): Character system

Status: **R1 built**: `packages/web/public/special3d/character-cyber.glb` + `character-cyber.json`.

## Same rig, same clips

`assets/blender/special3d/character_cyber.py` runs the classic character build (`modules/character.py`):
the same body, armature (22 deform bones + `prop.R`), props and **all 22 clips**, unchanged. The director's
plans and timings therefore apply as they are, and `character-cyber.json` has the classic clip table
(durations, `Walk.speed`, `footPlants`, seat offsets). It then replaces the classic accessories with the
outfit set below. Shoes are dark.

## Outfit toggles (`extras.accessory`)

| Toggle | What | Binding |
|---|---|---|
| `hairA`–`hairF` | undercut sweep, crest, buzz, asymmetric bob, top knot, long fall | rigid, `head` |
| `techJacket` | long sleeves, high collar, a glowing zip line | skinned (weights from the nearest shirt or arm vertex) |
| `utilityVest` | sleeveless, V neck, chest pockets, an accent line | skinned (shirt) |
| `longCoat` | to the knee, open at the front (legs stay clear when walking), lapels | skinned; the skirt blends 55 % toward `hips` |
| `visor` | wrap-around emissive band | rigid, `head` |
| `arGlasses` | single-bar lens with temples | rigid, `head` |
| `headset` | one ear cup with a light ring, mic boom | rigid, `head` |
| `wristDisplay` | bracelet with a glowing face, left forearm | rigid, `forearm.L` |
| `collarLight` | light ring on the collar rim | rigid, `chest` |

Every toggle is hidden by default except `hairA` and `techJacket`; `character-cyber.json.accessories` lists
the defaults. Show one hair and any compatible outfit pieces per agent (for example jacket or vest or coat,
plus up to two head or wrist pieces).

## Materials

The tinted slots are `skin`, `shirt` (garments), `pants` (trousers and the vest), `hair` and `accent`.
`accent` is emissive (lights, lenses, visor, zip line): the renderer tints its colour per agent hash and may
pulse its strength. The other slots (`shoes`, `eyes`, `plastic`, `metal`, `screen`, …) are fixed.
`character-cyber.json.materials` lists `tint` and `emissive`.

## Budgets

- The base body is about 7k triangles (budget ≤ 9k with accessories, props and LOD hidden).
- The glb is about 0.8 MB after the optimizer (budget ≤ 1.8 MB).

Both are checked by `assets/validate.ts` (special profile) and `assets/blender/special3d/tests`.

## Review

`character_cyber.py --out <dir> --quality draft --preview assets/previews/special3d` renders
`character-cyber-lineup.png`: six variants (hair, outfit, tint, clip) on a dark stage with an amber key and
a cyan rim.
