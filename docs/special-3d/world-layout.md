# Night City (Special 3D): World layout

Status: **R1 built**. All coordinates are glTF (metres, y up); heading 0 faces +z; placement is translation + yaw
(contract §1), and every module's `manifest.modules.<kind>.placement` says where it goes.

| Module | Local footprint | World placement | Height |
|---|---|---|---|
| `hq-atrium` | x ∈ [−20, 20], z ∈ [−30, 0] | (0, 0), yaw 0 | 14 m |
| `command` | corridor x ∈ [0, 4], z ∈ [−1.5, 1.5]; room x ∈ [4, 44], z ∈ [−13, 13] | (20, −9), yaw 0 | 5.4 m (corridor 3.2) |
| `skyline` | world coordinates, x ∈ [−640, 680], z ∈ [−580, −85] | (0, 0), yaw 0 | towers to y ≈ 230; streets at y = −220 |

The HQ floor is y = 0, about 220 m above the streets. The city lies to the south (−z), seen through the
atrium's curtain wall (z = −30) and the Command Center's south glazing.

## HQ atrium

```
z = 0   ┌──────── elevator core (4 cars) · gallery above at +6 m ────────┐
        │ display    player:spawn                          reception     │
        │ wall  ═════ security gates (glass barriers) ═════               │
        │ (west, ║ bridges    Project Directory console        east door ─┼─→ command
        │ 20×9 m)║ +10 / +6                                         stair │
        │        ║      bonsai lounge (3 planters, 6 angular sofas)  ↑ +6 │
z = −30 └── observation deck +6 ─── curtain wall (rain-glass) → city ────┘
```

- **Arrival:** 4 elevators on the north wall (`elevatorDoor` `<i>:L|R`, `spot:elevator:0–7`), `player:spawn`
  at (0, −5.2) facing south, a reception counter (`spot:reception:0–3`), six turnstile lanes at z = −7.6
  between glass barriers (walls with ids, so the cutaway can fade them).
- **Giant display:** 20 × 9 m on the west wall (holo `display`) with a ticker strip (screen `display-ticker`),
  hung on cables. Bridge A (+6 m, x ∈ [−12.6, −10.4]) and bridge B (+10 m, visual only) cross in front of it.
- **Mezzanine (+6 m, on the nav graph):** a stair along the east wall (z −27.8 → −16.2), an east walkway, the
  gallery over the elevator core, bridge A and the south observation deck. Its nav nodes carry `y: 6`
  (contract §14); the edge `h:stair_ft`–`m:stair_top` is the stair. Anchors stay on the floor (y = 0).
- **Hall:** the Project Directory console (`interact:project-directory:0`, holo `project-directory`) inside a
  floor ring at (3, −12.4); wayfinding pylons; cyan guide strips from the gates.
- **Bonsai lounge:** three raised hexagonal planters with bonsai under amber uplights, two angular sofas each
  (`seat:lounge:0–11`, pose lounge), a suspended amber ring light, benches along the glass.
- **East door** at (20, −9), the connector to the Command Center corridor.

## Project Command Center

```
z = 13  ┌ booths 0,1 ┬ dept 0 ──── dept 1 ──── dept 2 ┬ meeting A ┐
        │ terminals  │  6 pods of 4 (ws:<d>:<p>:<s>)    │ (glass)   │
 corr ══╡ 0–2 / 3–5  │        ◎ holo pit (tiered)       ├ servers   │
        │            │                                  │           │
        │ booths 2,3 ┴ dept 3 ──── dept 4 ──── dept 5 ┴ meeting B ┘
z = −13 └──────────── curtain wall (rain-glass) → city ────────────┘
```

- **Departments:** six blocks (north row 0–2 west to east, south row 3–5), each 3 × 2 pods of 4 seats, so
  `ws:<dept>:<pod>:<seat>` covers 6 × 24 = 144 seats. Pods 0–2 are the inner row (next to the pit), 3–5 the
  outer. Seats 0–1 face the pod spine from the pit side (inner pods) and 2–3 from the other side. Every seat
  has a multi-monitor screen node with `ref` = its anchor id. `manifest.modules.command.departments` lists
  each department's accent colour. The renderer maps providers to departments in `grouping.ts` order.
- **Tiered operations floor:** a sunken pit (two 0.31 m steps) at (23.5, 0) under the central holo cube
  (holo `command-display`); `interact:command-display:0` stands on the south rim.
- **West zone:** six provider terminals flank the corridor (`interact:provider-terminal:0–5`, screen
  `provider:<i>`), and four secure comm booths (`booth:0–3`, led `booth:<n>`) sit in the corners.
- **East zone:** glass meeting rooms A (north) and B (south), each with six seats (`meet:A|B:0–5`) and a
  wall screen (`meet:A|B`), plus a server alcove between them. Cable trays run the length of the room.

## Skyline

Three depth bands of towers (band 0 at z −175 to −85 with facade fins and neon lines, band 1 at −330 to
−195, band 2 at −580 to −350), rooftop gear with red aviation lights, 8 ad planes facing the HQ
(`ad:<i>`), 6 neon signs (`neon:<i>`, flicker schedule in extras), a glowing street grid at y = −220, and
4 aerial traffic lanes (`traffic`, `extras.points` = flat `[x, y, z, …]`, `speed` m/s).

## Navigation

- Connector: atrium `h:door` at local (20, −9) and command `c:door` at local (0, 0) meet after placement
  (≤ 5 cm, contract §3). The validator merges the placed graphs (`checkSpecialSetNav`).
- Every anchor has an `ap:<id>` node linked to hubs by straight edges that cross no wall outside an opening
  and no collider (`special3d/navkit.py`).
