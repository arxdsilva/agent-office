"""Night City Project Command Center (`command`): a 4 m corridor (x ∈ [0, 4]) from the atrium's east door, then
the operations floor x ∈ [4, 44], z ∈ [−13, 13], 5.4 m tall (docs/special-3d/world-layout.md).

    z = 13  ┌ booths 0,1 ┬ dept 0 ──── dept 1 ──── dept 2 ┬ meeting A ┐
            │ terminals  │  6 pods of 4 (ws:<d>:<p>:<s>)    │ (glass)   │
    corr ═══╡ 0–2 / 3–5  │        ◎ holo pit (tiered)       ├ servers   │
            │            │                                  │           │
            │ booths 2,3 ┴ dept 3 ──── dept 4 ──── dept 5 ┴ meeting B ┘
    z = −13 └──────────── curtain wall (rain-glass) → city ────────────┘

Departments follow the providers' order in grouping.ts (the renderer maps provider → dept index). The
tiered operations floor is a sunken pit (two steps of 0.31 m) around the central holo display; every
anchor stays on the y = 0 floor.
"""
import math

from lib.geometry import curtain_wall, glass_partition, wall

from . import navkit
from . import props as X

PLACEMENT = {'x': 20.0, 'z': -9.0, 'yaw': 0.0}  # world placement (contract §1: translation + yaw)
H = 5.4
X0, X1, Z0, Z1 = 4.0, 44.0, -13.0, 13.0
CORR_W = 1.5  # corridor half-width
PIT = (23.5, 0.0)
PIT_R = (4.0, 3.3, 2.2)  # outer rim, tier 1, pit floor
BLOCKS = (9.0, 19.0, 29.0)  # department block west edges (x); each block is 3 pods of 3.0 m
ROWS = (6.0, 9.84)  # pod-row centres (|z|), inner then outer
DEPT_ACCENT = ('cyan', 'amber', 'magenta', 'acid', 'red', 'cyan')
MEET_X = 38.5


def build(g, A, P, rng):
    _shell(g, P)
    _corridor(g, P)
    _ceiling(g, P)
    _pit(g, A, P)
    _departments(g, A, P, rng)
    _west(g, A, P)
    _east(g, A, P, rng)
    _details(g, P, rng)
    _rooms(g)
    _nav(g, A)
    return dict(
        bounds={'minX': 0.0, 'maxX': X1, 'minZ': Z0, 'maxZ': Z1},
        extra={'placement': PLACEMENT, 'height': H,
               'connectors': {'hq-atrium': {'x': 0.0, 'z': 0.0}},
               'departments': {str(d): {'pods': 6, 'seats': 24, 'accent': DEPT_ACCENT[d]} for d in range(6)}},
        sky=dict(strength=1.0),
        previews=[
            ('wide', (6.0, 2.6, 0.5), (30.0, 0.6, -1.0), 18, False),
            ('pit', (17.0, 3.2, -9.0), (23.5, 1.2, 0.0), 20, False),
            ('workstations', (12.0, 1.6, 7.9), (20.0, 1.0, 5.0), 22, False),
            ('city', (28.0, 1.7, -4.4), (34.0, 2.0, -40.0), 22, False),
            ('overview', (60.0, 28.0, 30.0), (24.0, 0.0, 0.0), 22, True),
        ],
    )


# ============================================================================== shell
def _floor(g, P):
    px, pz = PIT
    R = PIT_R[0]
    m = P['floor_wet']
    g.plane_y(m, X0, X1, R, Z1, 0.0)
    g.plane_y(m, X0, X1, Z0, -R, 0.0)
    g.plane_y(m, X0, px - R, -R, R, 0.0)
    g.plane_y(m, px + R, X1, -R, R, 0.0)


def _shell(g, P):
    _floor(g, P)
    wall(g, P['concrete'], (X0, Z0), (X0, Z1), H, thick=0.25, side=1,
         openings=[(13.0 - CORR_W, 13.0 + CORR_W, 0.0, 3.2)])
    wall(g, P['concrete'], (X1, Z0), (X1, Z1), H, thick=0.25, side=-1)
    wall(g, P['concrete'], (X0, Z1), (X1, Z1), H, thick=0.25, side=1)
    RP = dict(P, glass=P['rainglass'])
    curtain_wall(g, RP, (X0, Z0), (X1, Z0), H, spacing=1.8, transoms=(0.9, 4.4), thick=0.18, side=-1,
                 frame='brushed_dark')
    g.collider(X0 - 0.25, X0, Z0, -CORR_W, 0, H)
    g.collider(X0 - 0.25, X0, CORR_W, Z1, 0, H)
    g.collider(X1, X1 + 0.25, Z0, Z1, 0, H)
    g.collider(X0, X1, Z1, Z1 + 0.25, 0, H)
    g.collider(X0, X1, Z0 - 0.18, Z0, 0, H)
    # carbon wainscot with a cyan seam on the solid walls
    g.box_b(P['carbon'], X0 + 0.0, X1, 0, 1.1, Z1 - 0.04, Z1, bevel=0)
    g.box_b(P['neon_cyan'], X0, X1, 1.1, 1.12, Z1 - 0.05, Z1 - 0.03, bevel=0)


def _corridor(g, P):
    wall(g, P['carbon'], (0.0, CORR_W), (X0, CORR_W), 3.2, thick=0.2, side=1)
    wall(g, P['carbon'], (0.0, -CORR_W), (X0, -CORR_W), 3.2, thick=0.2, side=-1)
    g.plane_y(P['grate'], 0.0, X0, -CORR_W, CORR_W, 0.0)
    for s in (-1, 1):
        X.floor_strip(g, P, (0.1, s * (CORR_W - 0.1)), (X0, s * (CORR_W - 0.1)), P['neon_cyan'], w=0.04)
        for x in (0.8, 2.0, 3.2):  # light ribs
            g.box(P['neon_cyan'], (0.04, 2.6, 0.02), (x, 1.5, s * (CORR_W - 0.01)), bevel=0)
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], 0.0, X0, -CORR_W, CORR_W, 3.2, up=False)
        g.box_b(P['light_cool'], 0.2, X0 - 0.2, 3.17, 3.19, -0.04, 0.04, bevel=0)
    g.light('panel', (2.0, 3.1, 0.0), size=(3.6, 0.3), power=70, color=(0.7, 0.9, 1.0))
    g.collider(0.0, X0, CORR_W, CORR_W + 0.2, 0, 3.2)
    g.collider(0.0, X0, -CORR_W - 0.2, -CORR_W, 0, 3.2)


def _ceiling(g, P):
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], X0, X1, Z0, Z1, H, up=False)
        for z in (-11.7, -7.92, -4.25, 4.25, 7.92, 11.7):
            g.box_b(P['graphite'], X0, MEET_X, H - 0.3, H, z - 0.18, z + 0.18, bevel=0.005)
            g.box_b(P['light_cool'], X0 + 0.5, MEET_X - 0.5, H - 0.32, H - 0.3, z - 0.05, z + 0.05, bevel=0)
    for z in (-11.7, -7.92, -4.25, 4.25, 7.92, 11.7):
        for x in (13.5, 23.5, 33.5):
            g.light('panel', (x, H - 0.35, z), size=(9.0, 0.25), power=170, color=(0.66, 0.88, 1.0))
    # ring light over the pit
    px, pz = PIT
    g.torus(P['neon_cyan'], 4.2, 0.05, (px, H - 0.5, pz), segs=64, rsegs=6)
    for k in range(8):
        a = math.tau * k / 8
        g.cyl(P['brushed'], 0.012, 0.5, (px + 4.2 * math.cos(a), H - 0.5, pz + 4.2 * math.sin(a)), segs=6)


# ============================================================================== holo pit
def _ring(g, mat, cx, cz, ro, ri, y0, y1, n=40):
    for k in range(n):
        a0, a1 = math.tau * k / n, math.tau * (k + 1) / n
        poly = [(cx + ro * math.cos(a0), cz + ro * math.sin(a0)), (cx + ro * math.cos(a1), cz + ro * math.sin(a1)),
                (cx + ri * math.cos(a1), cz + ri * math.sin(a1)), (cx + ri * math.cos(a0), cz + ri * math.sin(a0))]
        g.prism(mat, poly, y0, y1, bottom=False)


def _pit(g, A, P):
    px, pz = PIT
    R0, R1, R2 = PIT_R
    g.furn('context-core', 2 * R0, 2 * R0, x=px, z=pz)
    # square-to-circle corners at floor level
    for (sx, sz) in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        a0 = math.atan2(sz, sx) - math.pi / 4
        arc = [(px + R0 * math.cos(a0 + (math.pi / 2) * i / 8), pz + R0 * math.sin(a0 + (math.pi / 2) * i / 8)) for i in range(9)]
        g.prism(P['floor_wet'], [(px + sx * R0, pz + sz * R0)] + arc, -0.62, 0.0, bottom=False)
    _ring(g, P['steel_plate'], px, pz, R0, R1, -0.62, 0.0)
    _ring(g, P['steel_plate'], px, pz, R1, R2, -0.62, -0.31)
    g.cyl(P['grate'], R2, 0.04, (px, -0.66, pz), segs=48)
    g.torus(P['neon_cyan'], R1 + 0.02, 0.02, (px, 0.005, pz), segs=72, rsegs=4)
    g.torus(P['neon_magenta'], R2 + 0.02, 0.02, (px, -0.305, pz), segs=64, rsegs=4)
    g.torus(P['neon_cyan'], 1.4, 0.02, (px, -0.615, pz), segs=48, rsegs=4)
    # the projector column and the holo display (four outward panels, one runtime node)
    g.cyl(P['brushed_dark'], 0.9, 0.9, (px, -0.62, pz), segs=24, r2=0.7)
    g.cyl(P['black'], 0.72, 0.05, (px, 0.28, pz), segs=24)
    g.torus(P['neon_cyan'], 0.72, 0.025, (px, 0.31, pz), segs=40, rsegs=4)
    d = g.dynamic('command-display', 'holo', 'command-display', P['holo'], pivot=(px, 2.4, pz),
                  extras={'width': 3.2, 'height': 1.8, 'faces': 4})
    with g.into(d):
        for k in range(4):
            yaw = k * math.pi / 2
            with g.at(px, pz, yaw):
                g.quad(P['holo'], 3.2, 1.8, (0, 2.4, 1.6))
    g.light('point', (px, 2.4, pz), radius=0.5, power=160, color=(0.4, 0.9, 1.0))
    g.collider(px - R0, px + R0, pz - R0, pz + R0, -0.62, 0.35)
    A.spot('interact:command-display:0', px, pz - 3.75, 0.0, room='ops', approach=-0.5, hubs=[])


# ============================================================================== departments
def _departments(g, A, P, rng):
    for row_sign, depts in ((1, (0, 1, 2)), (-1, (3, 4, 5))):
        for b, dept in enumerate(depts):
            x0 = BLOCKS[b]
            acc = DEPT_ACCENT[dept]
            room = f'dept-{dept}'
            for r, zc in enumerate(ROWS):
                for c in range(3):
                    pod = r * 3 + c
                    x = x0 + 1.5 + c * 3.0
                    yaw = 0.0 if row_sign > 0 else math.pi
                    with g.at(x, row_sign * zc, yaw):
                        X.workstation_pod(g, A, P, dept, pod, acc, rng, room, hubs=[])
            # department floor marking (accent line along the block's aisle-side edge) and a hanging sign blank
            zline = row_sign * (ROWS[0] - 1.95)
            X.floor_strip(g, P, (x0 + 0.1, zline), (x0 + 8.9, zline), P[f'neon_{acc}'], w=0.05)
            with g.at(x0 + 4.5, row_sign * (ROWS[1] + 2.9), math.pi if row_sign > 0 else 0.0, y=3.6):
                g.box(P['black'], (3.0, 0.5, 0.06), (0, 0, 0), bevel=0.01)
                g.box(P[f'neon_{acc}'], (3.0, 0.03, 0.065), (0, -0.25, 0), bevel=0)
                X.meridian_mark(g, P, r=0.18, mat=P[f'glow_{acc}'])


# ============================================================================== west zone
def _west(g, A, P):
    for i, z in enumerate((2.4, 3.6, 4.8, -2.4, -3.6, -4.8)):
        with g.at(X0 + 0.25, z, math.pi / 2):
            X.provider_terminal(g, A, P, i, 'comms', DEPT_ACCENT[i], hubs=[])
    for n, (x, z, yaw) in enumerate(((5.25, 11.95, math.pi), (7.15, 11.95, math.pi),
                                     (5.25, -11.95, 0.0), (7.15, -11.95, 0.0))):
        with g.at(x, z, yaw):
            X.comm_booth(g, A, P, n, 'comms', hubs=[])
    X.chevrons(g, P, 5.0, 0.0, math.pi / 2, n=3, mat=P['glow_cyan'])


# ============================================================================== east zone
def _meeting(g, A, P, room, sgn):
    """Glass meeting room `room` (A north, B south): a table along z with 6 meet:<room>:<seat> seats."""
    z_in, z_out = sgn * 3.0, sgn * 13.0
    door = (0.6, 1.6)  # along the partition from its inner end
    zs = sorted((z_in, z_out))
    if sgn > 0:
        glass_partition(g, P, (MEET_X, z_in), (MEET_X, z_out), h=2.8, spacing=1.4, door=door, frame='brushed_dark',
                        top=H)
    else:
        glass_partition(g, P, (MEET_X, z_out), (MEET_X, z_in), h=2.8, spacing=1.4,
                        door=(10.0 - door[1], 10.0 - door[0]), frame='brushed_dark', top=H)
    glass_partition(g, P, (MEET_X, z_in), (X1, z_in), h=2.8, spacing=1.4, frame='brushed_dark', top=H)
    cx, cz = 41.25, sgn * 8.0
    with g.at(cx, cz):
        g.furn('meeting-table', 1.2, 3.2)
        g.prism(P['stone'], [(-0.6, -1.6), (0.6, -1.6), (0.5, 1.6), (-0.5, 1.6)], 0.7, 0.75, bevel=0.01)
        g.box(P['brushed_dark'], (0.5, 0.7, 2.4), (0, 0.35, 0), bevel=0)
        g.box(P['neon_amber'], (0.02, 0.015, 3.0), (0, 0.69, 0), bevel=0)
        s = 0
        for side in (-1, 1):
            for dz in (-1.1, 0.0, 1.1):
                h = math.pi / 2 if side < 0 else -math.pi / 2
                with g.at(side * 1.0, dz, h):
                    X.cyber_chair(g, P, 'amber')
                A.seat(f'meet:{room}:{s}', side * 1.0, dz, h, pose='sit', room=f'meeting-{room}', approach=-0.6,
                       hubs=[])
                s += 1
    g.collider(cx - 0.6, cx + 0.6, cz - 1.6, cz + 1.6, 0, 0.75)
    d = g.dynamic(f'meet-{room}', 'screen', f'meet:{room}', P['screen'], pivot=(X1 - 0.06, 1.7, cz),
                  extras={'width': 2.6, 'height': 1.4})
    with g.into(d):
        g.quad(P['screen'], 2.6, 1.4, (X1 - 0.06, 1.7, cz), yaw=-math.pi / 2)
    g.box_b(P['black'], X1 - 0.05, X1, 0.95, 2.45, cz - 1.35, cz + 1.35, bevel=0)
    g.light('panel', (cx, H - 0.4, cz), size=(1.2, 3.0), power=90, color=(1.0, 0.82, 0.6))
    g.collider(MEET_X - 0.05, MEET_X + 0.05, zs[0], zs[1], 0, H)  # partition (the door is the gap below)
    g.colliders.pop()
    lo, hi = (z_in + sgn * door[0], z_in + sgn * door[1])
    for (a, b) in ((zs[0], min(lo, hi)), (max(lo, hi), zs[1])):
        if b - a > 0.05:
            g.collider(MEET_X - 0.05, MEET_X + 0.05, a, b, 0, H)
    g.collider(MEET_X, X1, z_in - 0.05, z_in + 0.05, 0, H)


def _east(g, A, P, rng):
    _meeting(g, A, P, 'A', 1)
    _meeting(g, A, P, 'B', -1)
    for z in (-1.86, -0.62, 0.62, 1.86):  # server alcove
        with g.at(X1 - 0.7, z, -math.pi / 2):
            X.server_rack(g, P, rng, h=2.2)
    g.collider(X1 - 1.2, X1, -2.2, 2.2, 0, 2.2)
    g.box_b(P['hazard'], X1 - 2.0, X1 - 1.25, 0.0, 0.006, -2.4, 2.4, bevel=0)
    g.light('panel', (X1 - 1.8, 3.0, 0.0), size=(0.4, 4.0), power=50, color=(0.5, 0.9, 1.0))


def _details(g, P, rng):
    for z in (-2.2, 2.2, -12.3, 12.3):
        X.cable_tray(g, P, X0 + 0.5, X1 - 0.5, 4.6, z)
    for pos, yaw in (((X0 + 0.3, 4.4, 12.6), math.pi * 0.75), ((X1 - 0.3, 4.4, 12.6), -math.pi * 0.75),
                     ((X0 + 0.3, 4.4, -12.6), math.pi / 4)):
        X.security_camera(g, P, pos, yaw=yaw)
    for x in (12.0, 22.0, 32.0):
        X.vent(g, P, (x, 4.7, Z1 - 0.27), w=1.6, h=0.4, yaw=math.pi)
    X.maintenance_panel(g, P, (X1 - 0.28, 1.0, 2.7), yaw=-math.pi / 2)
    for k in range(3):
        z = Z1 - 0.35 - 0.09 * k
        X.conduit(g, P, (X0 + 0.5, 4.9, z), (X1 - 0.5, 4.9, z))


# ============================================================================== plan + nav
def _rooms(g):
    r = g.room
    r('corridor', 'Corridor', 0.0, -CORR_W, X0, CORR_W, floor='concrete')
    r('comms', 'Comms', X0, Z0, BLOCKS[0], Z1, floor='concrete')
    for b in range(3):
        xa = BLOCKS[b] if b == 0 else BLOCKS[b] - 0.5
        xb = BLOCKS[b] + 9.5 if b < 2 else MEET_X
        r(f'dept-{b}', f'Department {b + 1}', xa, 4.15, xb, Z1, floor='concrete')
        r(f'dept-{b + 3}', f'Department {b + 4}', xa, Z0, xb, -4.15, floor='concrete')
    r('ops', 'Operations', BLOCKS[0], -4.15, MEET_X, 4.15, floor='concrete')
    r('meeting-A', 'Meeting A', MEET_X, 3.0, X1, Z1, floor='carpet')
    r('servers', 'Servers', MEET_X, -3.0, X1, 3.0, floor='concrete')
    r('meeting-B', 'Meeting B', MEET_X, Z0, X1, -3.0, floor='carpet')


def _nav(g, A):
    n = A.node
    n('c:door', 0.0, 0.0, 1.2)
    n('c:corr', 2.0, 0.0, 1.2)
    n('c:entry', 5.6, 0.0, 1.4)
    n('c:spine_w', 18.6, 0.0, 0.5)
    n('c:spine_e', 28.4, 0.0, 0.5)
    n('c:servers', 38.0, 0.0, 1.0)
    n('c:comms_n', 6.4, 8.8, 1.0)
    n('c:comms_s', 6.4, -8.8, 1.0)
    A.chain('c:door', 'c:corr', 'c:entry', 'c:spine_w')
    A.chain('c:spine_e', 'c:servers')
    A.chain('c:entry', 'c:comms_n')
    A.chain('c:entry', 'c:comms_s')
    xs = (8.4, 10.5, 13.5, 16.5, 18.5, 20.5, 23.5, 26.5, 28.5, 30.5, 33.5, 36.5, 38.0)
    for sgn, tag in ((1, 'n'), (-1, 's')):
        for k, z in enumerate((4.25, 7.92, 11.7)):
            prev = None
            for i, x in enumerate(xs):
                nid = f'c:{tag}{k}_{i}'
                n(nid, x, sgn * z, 0.3 if k == 0 else 0.35)
                if prev:
                    A.edge(prev, nid)
                prev = nid
        for i, x in enumerate(xs):
            if x in (8.4, 18.5, 28.5, 38.0):  # cross aisles between the blocks
                A.chain(f'c:{tag}0_{i}', f'c:{tag}1_{i}', f'c:{tag}2_{i}')
        A.edge(f'c:{tag}0_0', 'c:entry')
        A.edge(f'c:{tag}1_0', f'c:comms_{tag}')
        A.edge(f'c:{tag}0_{xs.index(18.5)}', 'c:spine_w')
        A.edge(f'c:{tag}0_{xs.index(28.5)}', 'c:spine_e')
        A.edge(f'c:{tag}0_{len(xs) - 1}', 'c:servers')
        # meeting room door and inner hubs
        n(f'c:m{tag}_door', 39.2, sgn * 4.1, 0.4)
        n(f'c:m{tag}_w', 39.65, sgn * 8.0, 0.4)
        n(f'c:m{tag}_e', 42.85, sgn * 8.0, 0.4)
        n(f'c:m{tag}_in', 41.25, sgn * 4.6, 0.6)
        n(f'c:m{tag}_far', 41.25, sgn * 11.4, 0.6)
        A.edge(f'c:{tag}0_{len(xs) - 1}', f'c:m{tag}_door')
        A.chain(f'c:m{tag}_door', f'c:m{tag}_in', f'c:m{tag}_w', f'c:m{tag}_far', f'c:m{tag}_e', f'c:m{tag}_in')
    meet = lambda aid, h: (not aid.startswith('meet:')) or h.startswith('c:mn_' if ':A:' in aid else 'c:ms_')  # noqa: E731
    navkit.link_anchors(g, A, k=2, prefer=meet)
    bad = navkit.check_edges(g, A)
    if bad:
        raise ValueError(f'command nav edges cross walls: {bad}')
