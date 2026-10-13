"""Night City HQ atrium (`hq-atrium`), x ∈ [−20, 20], z ∈ [−30, 0], 14 m tall (docs/special-3d/world-layout.md).

    z = 0   ┌──────── elevator core (4 cars) + gallery above at +6 m ────────┐
            │ display     player:spawn                         reception     │
            │ wall   ═══ security gates ═══            (east door → command) │
            │ (west,  ║bridges          Project Directory console        stair │
            │ 20×9 m) ║ +10 / +6                                          ↑ +6 │
            │         ║        bonsai lounge (3 planters, angular sofas)   │   │
    z = −30 └──── observation deck +6 ──── curtain wall (rain-glass) → city ┘

The display hangs off the west wall; the two skybridges cross in front of it, so they read as silhouettes
against the screen from the hall. The mezzanine (gallery, east walkway, bridge A, south deck) is on the nav
graph at y = 6 (nodes with `y`, contract §14); bridge B at +10 is visual.
"""
import math

from lib.geometry import curtain_wall, glass_partition, wall

from . import navkit
from . import props as X

PLACEMENT = {'x': 0.0, 'z': 0.0, 'yaw': 0.0}  # world placement (contract §1: translation + yaw)
H = 14.0
W0, W1, Z0, Z1 = -20.0, 20.0, -30.0, 0.0
DOOR_Z = -9.0  # east door to the Command Center corridor (connector at local (20, −9))
GATE_Z = -7.6
CORE_Z = -3.35  # elevator doors
GAL_Z = -4.6  # gallery edge (+6)
BR_A = (-12.6, -10.4)  # bridge A (+6), x range
BR_B = (-15.6, -13.6)  # bridge B (+10)
DECK_Z = -26.8
STAIR_X = (17.8, 19.8)
STAIR_Z = (-27.8, -16.2)
DISPLAY = dict(x=-17.4, z=-15.0, w=20.0, h=9.0, y=7.7)
LOUNGE = ((-1.0, -21.5), (7.0, -23.2), (13.6, -20.4))
CONSOLE = (3.0, -12.4)
SPAWN = (0.0, -5.2)


def build(g, A, P, rng):
    _shell(g, P)
    _ceiling(g, P)
    _elevators(g, A, P)
    _arrival(g, A, P)
    _display(g, P)
    _mezzanine(g, P)
    _lounge(g, A, P, rng)
    _details(g, P, rng)
    _surfaces(g, P, rng)
    cx, cz = CONSOLE  # floor inlay: a ring and the brand mark around the Project Directory console
    g.torus(P['neon_cyan'], 2.4, 0.02, (cx, 0.004, cz), segs=72, rsegs=4)
    g.torus(P['glow_cyan'], 2.2, 0.01, (cx, 0.004, cz), segs=72, rsegs=4)
    g.cyl(P['stone'], 2.38, 0.006, (cx, 0.0, cz), segs=48)
    with g.at(*CONSOLE):
        X.holo_pedestal(g, A, P, 'project-directory', 'interact:project-directory:0', 'hall', hubs=[])
    A.spot('player:spawn', SPAWN[0], SPAWN[1], math.pi, room='elevator', approach=0.0, hubs=[])
    _rooms(g)
    _nav(g, A)
    return dict(
        bounds={'minX': W0, 'maxX': W1, 'minZ': Z0, 'maxZ': Z1},
        extra={'placement': PLACEMENT, 'height': H,
               'connectors': {'command': {'x': W1, 'z': DOOR_Z}}},
        sky=dict(strength=1.0),
        previews=[
            ('wide', (17.6, 1.7, -11.5), (-10.0, 5.0, -21.0), 15, False),
            ('display', (10.0, 1.6, -13.0), (-17.0, 7.2, -15.5), 18, False),
            ('lounge', (-3.5, 1.5, -14.5), (9.0, 1.4, -28.5), 20, False),
            ('skyline', (-11.5, 7.6, -23.5), (0.0, -2.0, -120.0), 22, False),
            ('overview', (38.0, 32.0, 22.0), (0.0, 2.0, -15.0), 20, True),
        ],
    )


# ============================================================================== shell
def _shell(g, P):
    g.plane_y(P['floor'], W0, W1, Z0, Z1, 0.0)
    wall(g, P['concrete'], (W0, Z1), (W1, Z1), H, thick=0.3, side=-1)
    wall(g, P['concrete'], (W0, Z0), (W0, Z1), H, thick=0.3, side=-1)
    wall(g, P['concrete'], (W1, Z0), (W1, Z1), H, thick=0.3, side=1,
         openings=[(DOOR_Z - 1.5 - Z0, DOOR_Z + 1.5 - Z0, 0.0, 3.2)])
    RP = dict(P, glass=P['rainglass'])  # the curtain wall's panes use the rain shader (role rain-glass)
    curtain_wall(g, RP, (W0, Z0), (W1, Z0), H, spacing=2.0, transoms=(3.5, 6.0, 10.0), thick=0.22, side=1,
                 frame='brushed_dark')
    for x in range(-18, 19, 6):  # facade fins (deep, dark) for silhouette rhythm
        g.box_b(P['graphite'], x - 0.12, x + 0.12, 0, H, Z0 + 0.22, Z0 + 0.9, bevel=0.01)
    g.collider(W0, W1, Z1 - 0.3, Z1 + 0.1, 0, H)
    g.collider(W0 - 0.1, W0 + 0.3, Z0, Z1, 0, H)
    g.collider(W1 - 0.3, W1 + 0.1, Z0, DOOR_Z - 1.5, 0, H)
    g.collider(W1 - 0.3, W1 + 0.1, DOOR_Z + 1.5, Z1, 0, H)
    g.collider(W0, W1, Z0 - 0.1, Z0 + 0.22, 0, H)
    # door portal to the command corridor: brushed frame with a cyan threshold and a reader
    with g.at(W1 - 0.31, DOOR_Z, -math.pi / 2):
        X.wall_frame(g, P['brushed'], -1.6, 1.6, 0, 3.3, 0.0, t=0.12)
        g.box(P['neon_cyan'], (3.0, 0.02, 0.02), (0, 3.34, 0.05), bevel=0)
        X.card_reader(g, P, (1.9, 1.2, 0.02))
    X.floor_strip(g, P, (W1 - 0.4, DOOR_Z - 1.45), (W1 - 0.4, DOOR_Z + 1.45), P['neon_cyan'], w=0.05)
    # skirting light line along the north and west walls
    X.floor_strip(g, P, (W0 + 0.35, -29.6), (W0 + 0.35, -0.4), P['glow_cyan'], w=0.04)


def _ceiling(g, P):
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], W0, W1, Z0, Z1, H, up=False)
        # coffers: deep beams on a 4 m grid, cyan light lines along every other beam
        for x in range(-16, 17, 4):
            g.box_b(P['graphite'], x - 0.2, x + 0.2, H - 0.9, H, Z0, Z1, bevel=0.01)
        for z in range(-26, -1, 4):
            g.box_b(P['graphite'], W0, W1, H - 0.7, H, z - 0.15, z + 0.15, bevel=0.01)
        for x in range(-12, 13, 8):  # sparse cool linear fixtures (deep shadows between them)
            for z0 in range(-26, -2, 8):
                g.box_b(P['light_cool'], x - 0.04, x + 0.04, H - 0.95, H - 0.92, z0 + 0.6, z0 + 7.4, bevel=0)
    for x in range(-14, 15, 8):
        for z in (-6.0, -14.0, -22.0):
            g.light('panel', (x, H - 1.0, z), size=(0.4, 6.0), power=520, color=(0.62, 0.86, 1.0))


# ============================================================================== arrival
def _elevators(g, A, P):
    with g.at(0, CORE_Z, math.pi):
        X.elevator_bank(g, P, n=4, pitch=3.6, door_w=1.3, door_h=2.7, depth=3.2, H=6.0)
        k = 0
        for i in range(4):
            cx = (i - 1.5) * 3.6
            for dx in (-0.4, 0.4):
                A.spot(f'spot:elevator:{k}', cx + dx, 0.6, math.pi, room='elevator', approach=-0.6, hubs=[])
                k += 1
    g.collider(-7.7, 7.7, CORE_Z, 0, 0, 6.0)
    # core flanks: dark carbon cladding with vertical light seams up to the gallery
    for sx in (-1, 1):
        g.box_b(P['carbon'], sx * 7.7 - 0.3 * (sx > 0), sx * 7.7 + 0.3 * (sx < 0), 0, 6.0, CORE_Z, -0.15, bevel=0)


def _arrival(g, A, P):
    lanes = X.security_gate(g, P, -7.0, 7.0, 6, GATE_Z)
    for x in lanes:
        X.chevrons(g, P, x, GATE_Z - 1.4, math.pi, n=2, mat=P['glow_cyan'], s=0.3)
    # glass barriers either side of the gates (walls with ids: the cutaway can fade them)
    glass_partition(g, P, (W0 + 0.3, GATE_Z), (-7.12, GATE_Z), h=2.4, spacing=1.6, frame='brushed_dark')
    glass_partition(g, P, (7.12, GATE_Z), (W1 - 0.3, GATE_Z), h=2.4, spacing=1.6, frame='brushed_dark')
    g.collider(W0, -7.1, GATE_Z - 0.05, GATE_Z + 0.05, 0, 2.4)
    g.collider(7.1, W1, GATE_Z - 0.05, GATE_Z + 0.05, 0, 2.4)
    # reception (visitors on the north side), with a giant brand mark on the east wall above the door
    with g.at(13.0, -6.4):
        X.reception_counter(g, P, w=5.6)
        for k in range(4):
            A.spot(f'spot:reception:{k}', -1.8 + k * 1.2, 1.25, math.pi, room='reception', approach=-0.6, hubs=[])
    with g.at(W1 - 0.32, -11.5, -math.pi / 2, y=10.2):
        X.meridian_mark(g, P, r=2.0, mat=P['neon_amber'], ring_mat=P['neon_cyan'])
    g.light('point', (W1 - 2.0, 10.2, -11.5), radius=0.6, power=300, color=(1.0, 0.7, 0.35))
    g.light('panel', (13.0, 3.2, -6.4), size=(5.0, 1.0), power=120, color=(1.0, 0.78, 0.5))
    # cyan guide lines from the gates into the hall
    for x in (-3.5, 3.5):
        X.floor_strip(g, P, (x, GATE_Z - 0.6), (x, -15.0), P['neon_cyan'], w=0.05)
    X.floor_strip(g, P, (3.5, -9.0), (W1 - 0.5, DOOR_Z), P['neon_cyan'], w=0.05)


def _display(g, P):
    """The giant suspended display (holo `display`) with a ticker strip (screen `display-ticker`)."""
    D = DISPLAY
    with g.at(D['x'], D['z'], math.pi / 2):
        w, h, y = D['w'], D['h'], D['y']
        g.box_b(P['carbon'], -w / 2 - 0.3, w / 2 + 0.3, y - h / 2 - 0.3, y + h / 2 + 0.3, -0.45, -0.1, bevel=0.02)
        X.wall_frame(g, P['graphite'], -w / 2 - 0.25, w / 2 + 0.25, y - h / 2 - 0.25, y + h / 2 + 0.25, -0.05, t=0.2)
        g.box(P['neon_cyan'], (w + 0.5, 0.03, 0.03), (0, y + h / 2 + 0.27, 0.06), bevel=0)
        g.box(P['neon_magenta'], (w + 0.5, 0.03, 0.03), (0, y - h / 2 - 0.27, 0.06), bevel=0)
        d = g.dynamic('display', 'holo', 'display', P['holo'], pivot=(0, y, 0.0),
                      extras={'width': w, 'height': h})
        with g.into(d):
            g.quad(P['holo'], w, h, (0, y, 0.0))
        t = g.dynamic('display-ticker', 'screen', 'display-ticker', P['screen'], pivot=(0, y - h / 2 - 0.85, 0.0),
                      extras={'width': w, 'height': 0.7})
        with g.into(t):
            g.quad(P['screen'], w, 0.7, (0, y - h / 2 - 0.85, 0.0))
        g.box_b(P['graphite'], -w / 2, w / 2, y - h / 2 - 1.25, y - h / 2 - 0.45, -0.2, -0.05, bevel=0.01)
        for x in (-w / 2 + 1.0, -w / 4, w / 4, w / 2 - 1.0):  # suspension cables to the ceiling
            g.cyl(P['brushed'], 0.02, H - (y + h / 2 + 0.3), (x, y + h / 2 + 0.3, -0.25), segs=6)
        # cool spill on the wall behind (fake bounce in the bake)
    g.light('wallwash', (D['x'] + 1.0, D['y'], D['z']), size=(D['w'], D['h']), power=900, color=(0.35, 0.85, 1.0),
            dir=(1, 0, 0))


# ============================================================================== mezzanine
def _slab(g, P, x0, x1, z0, z1, y, mat=None):
    g.box_b(mat or P['steel_plate'], x0, x1, y - 0.25, y, z0, z1, bevel=0.01)
    g.box_b(P['grate'], x0 + 0.02, x1 - 0.02, y, y + 0.01, z0 + 0.02, z1 - 0.02, bevel=0)


def _mezzanine(g, P):
    y = 6.0
    # gallery over the elevator core, full width
    _slab(g, P, W0 + 0.3, W1 - 0.3, GAL_Z, CORE_Z + 0.01, y)
    g.box_b(P['steel_plate'], W0 + 0.3, W1 - 0.3, y - 0.25, y, CORE_Z, -0.3, bevel=0)
    X.railing(g, P, (W0 + 0.3, GAL_Z), (BR_A[0], GAL_Z), y)
    X.railing(g, P, (BR_A[1], GAL_Z), (STAIR_X[0] - 0.2, GAL_Z), y)
    for x in (-16.0, -10.4 - 2.2, 10.0, 16.0):
        g.box_b(P['brushed_dark'], x - 0.18, x + 0.18, 0, y - 0.25, GAL_Z + 0.1, GAL_Z + 0.46, bevel=0.01)
        g.collider(x - 0.18, x + 0.18, GAL_Z + 0.1, GAL_Z + 0.46, 0, y)
    with g.in_group('static'):
        for x in range(-18, 19, 3):  # downlights under the gallery
            g.cyl(P['light_cool'], 0.12, 0.01, (x + 0.5, y - 0.26, GAL_Z + 0.7), segs=12)
    for x in (-15, -5, 5, 15):
        g.light('disk', (x, y - 0.3, GAL_Z + 0.7), size=0.3, power=60, color=(0.8, 0.93, 1.0))
    # east walkway (+6) from the stair top to the gallery
    _slab(g, P, STAIR_X[0] - 0.2, W1 - 0.3, STAIR_Z[1], GAL_Z, y)
    X.railing(g, P, (STAIR_X[0] - 0.2, STAIR_Z[1]), (STAIR_X[0] - 0.2, GAL_Z), y)
    X.stair(g, P, STAIR_X[0], STAIR_X[1], STAIR_Z[0], STAIR_Z[1], y)
    g.collider(STAIR_X[0] - 0.05, STAIR_X[1] + 0.05, STAIR_Z[0] + 0.6, STAIR_Z[1], 0, y)
    # bridge A (+6): gallery → south deck, hung from the ceiling
    x0, x1 = BR_A
    _slab(g, P, x0, x1, DECK_Z, GAL_Z, y, mat=P['carbon'])
    X.railing(g, P, (x0, DECK_Z), (x0, GAL_Z), y)
    X.railing(g, P, (x1, DECK_Z), (x1, GAL_Z), y)
    g.box_b(P['glow_cyan'], x1 - 0.12, x1 - 0.08, y - 0.27, y - 0.25, DECK_Z, GAL_Z, bevel=0)
    for z in range(-24, -5, 6):
        for x in (x0, x1):
            g.cyl(P['brushed'], 0.018, H - y, (x, y, z), segs=6)
    # south observation deck (+6) along the glass
    _slab(g, P, W0 + 0.3, -3.5, Z0 + 0.25, DECK_Z, y)
    X.railing(g, P, (W0 + 0.3, DECK_Z), (x0, DECK_Z), y)
    X.railing(g, P, (x1, DECK_Z), (-3.5, DECK_Z), y)
    X.railing(g, P, (-3.5, DECK_Z), (-3.5, Z0 + 0.25), y)
    for x in (-16.0, -8.0):
        g.box_b(P['brushed_dark'], x - 0.15, x + 0.15, 0, y - 0.25, DECK_Z - 0.4, DECK_Z - 0.1, bevel=0.01)
        g.collider(x - 0.15, x + 0.15, DECK_Z - 0.4, DECK_Z - 0.1, 0, y)
    # bridge B (+10): visual only, wall to glass, suspended
    x0, x1 = BR_B
    yb = 10.0
    g.box_b(P['steel_plate'], x0, x1, yb - 0.3, yb, Z0 + 0.25, Z1 - 0.3, bevel=0.01)
    X.railing(g, P, (x0, Z0 + 0.25), (x0, Z1 - 0.3), yb, glass=False)
    X.railing(g, P, (x1, Z0 + 0.25), (x1, Z1 - 0.3), yb, glass=False)
    g.box_b(P['glow_magenta'], x1 - 0.12, x1 - 0.08, yb - 0.32, yb - 0.3, Z0 + 0.3, Z1 - 0.4, bevel=0)
    for z in range(-27, -1, 5):
        for x in (x0, x1):
            g.cyl(P['brushed'], 0.018, H - yb, (x, yb, z), segs=6)


# ============================================================================== lounge
def _lounge(g, A, P, rng):
    seat = 0
    for k, (cx, cz) in enumerate(LOUNGE):
        with g.at(cx, cz):
            X.bonsai_planter(g, A, P, rng, r=1.35, h=0.6, tree_h=(3.0, 3.6, 2.8)[k])
        # two sofas facing the bonsai (north side facing south, east side facing west), tables beside them
        for (sx, sz, yaw) in ((0.0, 2.45, math.pi), (2.45, 0.0, -math.pi / 2)):
            with g.at(cx + sx, cz + sz, yaw):
                X.angular_sofa(g, P, length=2.6, accent='amber')
                g.collider(-1.3, 1.3, -0.45, 0.45, 0, 0.6)
                for x in (-0.65, 0.65):
                    A.seat(f'seat:lounge:{seat}', x, 0.07, 0.0, pose='lounge', room='lounge', approach=0.82,
                           hubs=[])
                    seat += 1
        with g.at(cx - 2.0, cz + 2.45, math.pi / 4):
            X.low_table(g, P, w=0.7, d=0.7)
        g.collider(cx - 2.35, cx - 1.65, cz + 2.1, cz + 2.8, 0, 0.4)
    # amber light ring framing the lounge floor
    for a, b in (((-4.5, -17.6), (16.5, -17.6)), ((-4.5, -17.6), (-4.5, -28.6))):
        X.floor_strip(g, P, a, b, P['neon_amber'], w=0.05)


# ============================================================================== details
def _details(g, P, rng):
    for pos, yaw in (((W0 + 0.4, 5.6, -1.0), math.pi / 2 + 0.6), ((W1 - 0.4, 5.6, -1.0), -math.pi / 2 - 0.6),
                     ((W0 + 0.4, 5.5, -28.5), math.pi / 4), ((W1 - 0.4, 3.5, -12.0), -math.pi / 2)):
        X.security_camera(g, P, pos, yaw=yaw)
    for z in (-6.0, -12.0, -18.0, -24.0):
        X.vent(g, P, (W1 - 0.32, 12.5, z), w=1.6, h=0.5, yaw=-math.pi / 2)
    X.maintenance_panel(g, P, (W0 + 0.33, 1.0, -3.0), yaw=math.pi / 2)
    X.maintenance_panel(g, P, (W1 - 0.33, 1.0, -14.0), yaw=-math.pi / 2)
    for k in range(4):  # conduits up the east wall behind the stair
        x = W1 - 0.38 - 0.09 * k
        X.conduit(g, P, (x, 0.0, -29.4), (x, H - 1.0, -29.4))
    for (x, z, yaw, c) in ((16.6, -28.6, 0.2, '#1e2a35'), (16.9, -27.9, -0.1, '#2a1a1a'), (-19.0, -6.6, 1.2, '#1e2a35')):
        X.equipment_case(g, P, (x, 0.0, z), yaw=yaw, color=c)
    g.collider(16.2, 17.4, -29.0, -27.5, 0, 0.4)
    g.collider(-19.5, -18.5, -7.1, -6.1, 0, 0.4)
    # hazard band at the stair foot and the deck columns
    g.box_b(P['hazard'], STAIR_X[0], STAIR_X[1], 0.0, 0.006, STAIR_Z[0] - 0.3, STAIR_Z[0], bevel=0)


# ============================================================================== wall and ceiling detail
def _panel_grid(g, P, axis, fixed, a0, a1, y0, y1, w=2.0, seam='glow_cyan', mat='carbon', inward=1, skip=None):
    """Cladding panels on a wall plane (axis 'x': the wall runs along x at z=fixed; 'z': along z at x=fixed),
    separated by thin light seams. `inward` is the side the room is on; `skip(a, y)` leaves openings."""
    n = max(1, round((a1 - a0) / w))
    pw = (a1 - a0) / n
    rows = max(1, round((y1 - y0) / 3.5))
    ph = (y1 - y0) / rows
    for i in range(n):
        for j in range(rows):
            a, y = a0 + (i + 0.5) * pw, y0 + (j + 0.5) * ph
            if skip and skip(a, y):
                continue
            size = (pw - 0.05, ph - 0.05, 0.05) if axis == 'x' else (0.05, ph - 0.05, pw - 0.05)
            pos = (a, y, fixed + inward * 0.03) if axis == 'x' else (fixed + inward * 0.03, y, a)
            g.box(P[mat], size, pos, bevel=0)
        if i:
            x = a0 + i * pw
            size = (0.02, y1 - y0, 0.02) if axis == 'x' else (0.02, y1 - y0, 0.02)
            pos = (x, (y0 + y1) / 2, fixed + inward * 0.05) if axis == 'x' else (fixed + inward * 0.05, (y0 + y1) / 2, x)
            if (i % 3) == 0:
                g.box(P[seam], size, pos, bevel=0)


def _surfaces(g, P, rng):
    walls = g.plan['walls']  # cladding belongs to its wall for the cutaway: ids 1–3 are north, west, east
    assert (walls[0]['a'], walls[1]['a'], walls[2]['b']) == ([W0, Z1], [W0, Z0], [W1, Z1]), 'wall order changed'
    # north wall above the gallery: tall carbon panels with cyan seams
    with g.wall_tag(1):
        _panel_grid(g, P, 'x', Z1 - 0.3, W0 + 0.3, W1 - 0.3, 6.2, H - 0.9, w=2.0, inward=-1)
    # west wall: painted-steel cladding (the display hangs in front of it), magenta seams
    with g.wall_tag(2):
        _panel_grid(g, P, 'z', W0 + 0.3, Z0 + 0.3, Z1 - 0.3, 0.0, H - 0.9, w=2.4, seam='glow_magenta',
                    mat='steel_plate', inward=1)
    # east wall: carbon cladding around the door and the brand mark
    with g.wall_tag(3):
        _panel_grid(g, P, 'z', W1 - 0.3, Z0 + 0.3, Z1 - 0.3, 6.2, H - 0.9, w=2.0, inward=-1,
                    skip=lambda a, y: abs(a + 11.5) < 2.6 and abs(y - 10.2) < 2.6)
    # wayfinding pylons beyond the gates (blank: the runtime never needs text here), chevrons pointing in
    for x, yaw in ((-6.2, 0.4), (9.4, -0.5)):
        with g.at(x, -10.2, yaw):
            g.box(P['graphite'], (0.5, 2.8, 0.16), (0, 1.4, 0), bevel=0.01)
            g.box(P['black'], (0.4, 1.6, 0.02), (0, 1.75, 0.085), bevel=0)
            g.box(P['neon_cyan'], (0.02, 2.7, 0.02), (-0.25, 1.4, 0.085), bevel=0)
            for k in range(3):
                for s in (-1, 1):
                    g.box(P['glow_cyan'], (0.12, 0.02, 0.004), (s * 0.05, 1.3 + k * 0.18, 0.096), roll=s * 0.7, bevel=0)
            with g.at(0, 0.09, 0, y=2.35):
                X.meridian_mark(g, P, r=0.12, mat=P['glow_amber'])
        g.collider(x - 0.3, x + 0.3, -10.4, -10.0, 0, 2.8)
    # suspended ring light over the middle bonsai, and cable trays under the coffers
    cx, cz = LOUNGE[1]
    g.torus(P['neon_amber'], 3.0, 0.05, (cx, 8.5, cz), segs=72, rsegs=6)
    g.torus(P['brushed_dark'], 3.0, 0.09, (cx, 8.56, cz), segs=48, rsegs=6)
    for k in range(6):
        a = math.tau * k / 6
        g.cyl(P['brushed'], 0.012, H - 8.56, (cx + 3.0 * math.cos(a), 8.56, cz + 3.0 * math.sin(a)), segs=6)
    g.light('disk', (cx, 8.4, cz), size=2.0, power=180, color=(1.0, 0.68, 0.32))
    for z in (-8.6, -19.4):
        X.cable_tray(g, P, -8.0, W1 - 0.5, H - 1.6, z, w=0.5)
    # low angular benches along the glass
    for x in (-1.0, 5.0, 11.0):
        with g.at(x, Z0 + 0.95, 0.0):
            g.prism(P['stone'], [(-1.4, -0.25), (1.4, -0.25), (1.25, 0.25), (-1.25, 0.25)], 0.0, 0.42, bevel=0.01)
            g.box(P['neon_cyan'], (2.5, 0.012, 0.02), (0, 0.04, 0.26), bevel=0)
        g.collider(x - 1.4, x + 1.4, Z0 + 0.7, Z0 + 1.2, 0, 0.45)


# ============================================================================== plan + nav
def _rooms(g):
    r = g.room
    r('elevator', 'Elevator lobby', W0, GATE_Z, 9.0, Z1, floor='tile')
    r('reception', 'Reception', 9.0, GATE_Z, W1, Z1, floor='tile')
    r('display', 'Display plaza', W0, Z0, -5.0, GATE_Z, floor='tile')
    r('hall', 'Hall', -5.0, -16.0, W1, GATE_Z, floor='tile')
    r('lounge', 'Bonsai lounge', -5.0, Z0, STAIR_X[0] - 0.2, -16.0, floor='tile')
    r('stair', 'Stair', STAIR_X[0] - 0.2, Z0, W1, -16.0, floor='concrete')


def _nav(g, A):
    n = A.node
    n('h:spawn', *SPAWN, 1.4)
    n('h:lobby_w', -10.5, -5.6, 1.2)
    n('h:lobby_e', 9.0, -4.4, 1.0)
    n('h:rec', 13.0, -4.2, 1.0)
    for i, x in enumerate((-3.5, -1.17, 1.17, 3.5)):
        n(f'h:gate{i}', x, GATE_Z, 0.5)
    n('h:hall_w', -3.5, -10.5, 1.2)
    n('h:hall_c', 3.0, -10.4, 1.2)
    n('h:hall_e', 12.0, -10.0, 1.2)
    n('h:door_in', 18.8, DOOR_Z, 1.0)
    n('h:door', W1, DOOR_Z, 1.4)
    n('h:disp_n', -12.0, -12.0, 1.4)
    n('h:disp_s', -12.0, -23.0, 1.4)
    n('h:lounge_n', 5.0, -16.6, 1.2)
    n('h:lounge_w', -4.2, -19.5, 1.0)
    n('h:lounge_c', 3.8, -19.6, 0.8)
    n('h:lounge_e', 10.4, -18.2, 0.8)
    n('h:lounge_se', 11.0, -26.0, 0.8)
    n('h:lounge_s', 2.5, -27.6, 1.0)
    n('h:stair_ft', 18.8, -28.6, 0.9)
    n('h:stair_w', 16.4, -26.4, 0.9)
    A.chain('h:lobby_w', 'h:spawn', 'h:lobby_e', 'h:rec')
    for i in range(4):
        A.edge('h:spawn', f'h:gate{i}')
    A.edge('h:gate0', 'h:hall_w')
    A.edge('h:gate1', 'h:hall_w')
    A.edge('h:gate2', 'h:hall_c')
    A.edge('h:gate3', 'h:hall_c')
    A.chain('h:hall_w', 'h:hall_c', 'h:hall_e', 'h:door_in', 'h:door')
    A.chain('h:hall_w', 'h:disp_n', 'h:disp_s')
    A.chain('h:hall_c', 'h:lounge_n', 'h:lounge_c')
    A.chain('h:hall_w', 'h:lounge_w', 'h:lounge_s')
    A.chain('h:lounge_n', 'h:lounge_e', 'h:lounge_se', 'h:stair_w', 'h:stair_ft')
    A.chain('h:lounge_s', 'h:lounge_se')
    A.edge('h:disp_s', 'h:lounge_w')
    # mezzanine (+6): stair → walkway → gallery → bridge A → south deck
    n('m:stair_top', 18.8, STAIR_Z[1] + 0.3, 0.9, y=6.0)
    n('m:walk', 18.8, -6.0, 0.9, y=6.0)
    n('m:gal_e', 12.0, -4.0, 0.6, y=6.0)
    n('m:gal_c', 0.0, -4.0, 0.6, y=6.0)
    n('m:gal_w', -11.5, -4.0, 0.6, y=6.0)
    n('m:bridge', -11.5, -15.0, 0.9, y=6.0)
    n('m:deck', -11.5, -28.3, 1.0, y=6.0)
    n('m:deck_w', -17.5, -28.3, 1.0, y=6.0)
    n('m:deck_e', -5.0, -28.3, 1.0, y=6.0)
    A.chain('h:stair_ft', 'm:stair_top', 'm:walk', 'm:gal_e', 'm:gal_c', 'm:gal_w', 'm:bridge', 'm:deck')
    A.chain('m:deck_w', 'm:deck', 'm:deck_e')
    # each lounge cluster: an inner hub between its two sofas and the planter, and its way out (diagonal)
    for k, (cx, cz) in enumerate(LOUNGE):
        n(f'h:lc{k}', cx + 1.55, cz + 1.55, 0.25)
        n(f'h:lo{k}', cx + 3.0, cz + 3.0, 0.5)
        A.edge(f'h:lc{k}', f'h:lo{k}')
    A.chain('h:lounge_w', 'h:lo0', 'h:lounge_c')
    A.chain('h:lounge_e', 'h:lo1')
    A.chain('h:lounge_e', 'h:lo2', 'h:stair_w')
    lounge = lambda aid, h: not aid.startswith('seat:lounge:') or h.startswith('h:lc')  # noqa: E731
    navkit.link_anchors(g, A, k=1, prefer=lounge)
    bad = navkit.check_edges(g, A)
    if bad:
        raise ValueError(f'hq-atrium nav edges cross walls: {bad}')
