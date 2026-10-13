"""Office wing, 30 × 18 m (contract §2): door at local (0, 0) on the Main Street wall (x = 0), the wing
extends along +x to the window wall (x = 30), z ∈ [−9, 9].

    x: 0 ────────── 7 ───────────────────────── 18.6 ──────── 24 ─────────── 30 (windows)
       KITCHEN (z<0)  │ BOOTHS ×4 + corridor          │ MEETING A │ ADAPTERS (8 stations, core)
       ── door ═════ spine (z = 0) ═════════════════════ vestibule ║ (glass doors)
       LOUNGE (z>0)   │ PODS 1–3 (z<0) / 4–6 (z>0)     │ MEETING B │ LIBRARY (books, boards, notebooks)
                      │ living wall (z = +9)           │

All six themes run this same builder; only materials, accent lights and decor differ, so the anchors
and nav graph are identical (build.mjs checks it).
"""
import math

from lib import furniture as F
from lib.geometry import curtain_wall, glass_partition, rounded_rect, wall

H = 3.6
POD_X = (9.0, 12.6, 16.2)
POD_Z = (-4.6, 4.6)
BOOTH_X = (9.4, 11.0, 12.6, 14.2)
CORR_Z = 6.85
MEET_X0 = 18.6


def build(g, A, P, name, t, rng):
    d = t['decor']
    accent = t['accent']
    felt = t['felt']
    fabric = t['fabric']
    wood_top = 'white' if name == 'ocean' else 'wood'

    # ------------------------------------------------------------------ shell
    g.plane_y(P['floor'], 0, 30, -9, 9, 0.0)
    # street wall: solid kitchen side with the sign, door, glass storefront on the lounge side
    # (the street wall is inset 8 cm so the slats and sign stay inside the module bounds)
    wall(g, P['wall'], (0.08, -9), (0.08, 9), H, thick=0.15, side=-1,
         openings=[(7.8, 10.2, 0, 2.7), (10.2, 18.0, 0, 2.9)])
    glass_partition(g, P, (0.16, 1.35), (0.16, 8.85), h=2.9, spacing=1.25)
    for z in (-1.2, 1.2):  # black steel door portal
        g.box_b(P['metal'], 0.04, 0.27, 0, 2.78, z - 0.06 if z < 0 else z, z if z < 0 else z + 0.06, bevel=0.004)
    g.box_b(P['metal'], 0.04, 0.27, 2.7, 2.78, -1.26, 1.26, bevel=0.004)
    # street face: vertical wood slats + accent sign backing (the sign itself is drawn by the runtime)
    for k in range(int(7.6 / 0.1)):
        z = -8.95 + k * 0.1
        if -5.75 < z < -2.25:
            continue
        g.box(P['wood'], (0.03, H - 0.1, 0.045), (0.065, (H - 0.1) / 2 + 0.05, z + 0.02), bevel=0.004)
    g.box_b(P['accent'], 0.03, 0.08, 0.0, H, -5.7, -2.3, bevel=0.004)
    g.furn('sign', 3.4, 0.1, x=0.05, z=-4.0, yaw=-math.pi / 2)
    sign = g.dynamic('sign-wing', 'sign', 'wing', P['sign'], pivot=(0.018, 2.35, -4.0),
                     extras={'width': 3.0, 'height': 0.75})
    with g.into(sign):
        g.quad(P['sign'], 3.0, 0.75, (0.018, 2.35, -4.0), yaw=-math.pi / 2)
    g.box_b(P['metal'], 0.02, 0.03, 1.92, 2.78, -5.55, -2.45, bevel=0.002)
    g.light('wallwash', (-1.2, 3.4, -4.0), size=(3.2, 0.1), power=45, kelvin=3000, dir=(1, -0.8, 0))

    wall(g, P['wall'], (0, -9), (30, -9), H, thick=0.15, side=1)
    wall(g, P['wall'], (0, 9), (30, 9), H, thick=0.15, side=-1)
    curtain_wall(g, P, (30, -9), (30, 9), H, spacing=1.5, transoms=(2.95,), thick=0.14, side=1)
    for z in (-8.25, 8.25):  # window-side columns
        g.box_b(P['concrete'], 29.4, 29.86, 0, H, z - 0.3, z + 0.3, bevel=0.01, segs=2)
    g.collider(0.03, 0.23, -9, -1.25, 0, H)
    g.collider(0.03, 0.23, 1.25, 9, 0, H)
    g.collider(29.8, 30.2, -9, 9, 0, H)
    g.collider(0, 30, -9.1, -8.85, 0, H)
    g.collider(0, 30, 8.85, 9.1, 0, H)

    # accent wall behind the kitchen counter run (z = −8.85 face) and theme wall treatment
    g.box_b(P['accent'], 0.15, 7.0, 0.0, H, -8.85, -8.83, bevel=0)

    # ------------------------------------------------------------------ ceiling
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], 0, 30, -9, 9, H, up=False)
        # perimeter bulkhead + recessed spine light trough
        g.box_b(P['ceiling'], 0.15, 23.85, H - 0.25, H, -1.0, -0.8, bevel=0.003)
        g.box_b(P['ceiling'], 0.15, 23.85, H - 0.25, H, 0.8, 1.0, bevel=0.003)
        g.box_b(P['light'], 0.3, 23.6, H - 0.02, H - 0.01, -0.12, 0.12, bevel=0)
        # wood slat canopy along the spine, leaving the light trough open
        for k in range(4):
            for s_ in (-1, 1):
                z = s_ * (0.32 + k * 0.14)
                g.box_b(P['wood'], 0.4, 23.6, H - 0.24, H - 0.18, z - 0.03, z + 0.03, bevel=0.004)
    for x in (2.5, 6.0, 9.5, 13.0, 16.5, 20.0):
        g.light('panel', (x, H - 0.05, 0), size=(3.0, 0.3), power=70, kelvin=t['kelvin'])
    _baffles(g, P, felt, waves=d['waves'])
    for pz in POD_Z:
        for px in POD_X:
            for dz in (-0.45, 0.45):
                F.linear_pendant(g, P, (px, H, pz + dz), length=2.8, drop=0.95, kelvin=t['kelvin'], power=95,
                                 y_ceiling=H)

    # ------------------------------------------------------------------ nav spine
    A.node('w:door', 0, 0, 1.1)
    spine = [('w:door', 0.0), ('w:s1', 2.5), ('w:s2', 5.5), ('w:s3', 9.0), ('w:s4', 12.6), ('w:s5', 16.2),
             ('w:s6', 19.5), ('w:s7', 21.8)]
    for nid, x in spine[1:]:
        A.node(nid, x, 0, 1.2)
    A.chain(*[n for n, _ in spine])

    _kitchen(g, A, P, t, rng)
    _lounge(g, A, P, t, rng)
    _pods(g, A, P, t, rng, wood_top)
    _booths(g, A, P, t, rng)
    _meeting(g, A, P, t, rng, 'A', -1)
    _meeting(g, A, P, t, rng, 'B', 1)
    _front(g, A, P, t, rng)
    _adapters(g, A, P, t, rng)
    _library(g, A, P, t, rng)
    _decor(g, A, P, name, t, rng)
    _rooms(g)

    return dict(
        bounds={'minX': 0, 'maxX': 30, 'minZ': -9, 'maxZ': 9},
        extra={'capacity': {'desk': 24, 'meeting': 2, 'meetingSeats': 6, 'booth': 4, 'kitchen': 6, 'lounge': 8,
                            'stations': 8, 'books': 24, 'boards': 6, 'notebooks': 8, 'readingSeats': 4}},
        sky=dict(sun_dir=(0.78, 0.5, -0.38), sun_strength=3.2, sky_strength=0.4),
        previews=_previews(name),
    )


# ====================================================================== zones
def _baffles(g, P, felt, waves=False):
    """Acoustic felt baffles over the pod rows (wave profile for the ocean theme)."""
    with g.in_group('ceiling'):
        for pz in POD_Z:
            n = 27
            for i in range(n):
                x = 7.5 + i * 0.39
                if waves:
                    h = 0.28 + 0.22 * (0.5 + 0.5 * math.sin(i * 0.45 + (0 if pz < 0 else 1.6)))
                else:
                    h = 0.32
                c = felt[i % 2]
                g.box_b(P['felt'], x - 0.02, x + 0.02, H - 0.12 - h, H - 0.12, pz - 1.9, pz + 1.9, bevel=0.006, color=c)
            g.box_b(P['metal'], 7.4, 17.9, H - 0.13, H - 0.11, pz - 1.6, pz - 1.57, bevel=0)
            g.box_b(P['metal'], 7.4, 17.9, H - 0.13, H - 0.11, pz + 1.57, pz + 1.6, bevel=0)


def _kitchen(g, A, P, t, rng):
    accent = t['accent']
    with g.at(0.9, -8.85):
        F.kitchen(g, P, rng, length=4.4, accent=accent, kelvin=t['accent_kelvin'], island=False)
    # standing-height island (bar) – spots stand on its street-facing side
    cx, cz = 3.1, -6.45
    g.furn('island', 2.64, 1.05, x=cx, z=cz + 0.025)
    with g.at(cx, cz):
        g.box_b(P['white'], -1.2, 1.2, 0.1, 1.0, -0.4, 0.4, bevel=0.006, segs=2)
        g.box_b(P['metal'], -1.18, 1.18, 0, 0.1, -0.38, 0.38, bevel=0.002)
        g.box_b(P['wood'], -1.32, 1.32, 1.0, 1.04, -0.5, 0.55, bevel=0.005, segs=2)
        F.fruit_bowl(g, P, (0.75, 1.04, 0.0), rng)
        F.pot_plant(g, P, (-0.75, 1.04, -0.1), 0.07, 0.12, 'bush', rng)
        F.mug(g, P, (0.1, 1.04, 0.2), accent)
        F.mug(g, P, (-0.2, 1.04, 0.25), '#f4f1ea')
    g.collider(cx - 1.32, cx + 1.32, cz - 0.5, cz + 0.55, 0, 1.04)
    g.collider(0.9, 6.8, -8.85, -8.15, 0, 2.0)
    for xx in (cx - 0.9, cx, cx + 0.9):
        F.dome_pendant(g, P, (xx, H, cz), drop=1.35, color=accent if not t['decor']['brass'] else '#C8A45D',
                       kelvin=t['accent_kelvin'], power=30, mat='brass' if t['decor']['brass'] else 'paint')
    g.light('panel', (3.0, H - 0.05, -7.6), size=(4.0, 0.4), power=110, kelvin=t['kelvin'])
    # snack wall: open shelving on the street wall
    with g.at(0.23, -7.6, -math.pi / 2):
        F.bookshelf(g, P, w=3.2, h=2.1, d=0.38, rng=None, frame='wood')
        jars = ('#f2cc8f', '#e07a5f', '#81b29a', '#f4f1de', '#3d405b', '#e9c46a')
        for row in range(5):
            y = row * 2.07 / 5 + 0.03
            for k in range(13):
                xx = 0.15 + k * 0.23
                if rng.random() < 0.75:
                    c = rng.choice(jars)
                    g.cyl(P['gloss'], 0.07, rng.uniform(0.16, 0.3), (xx, y, -0.19), segs=10, color=c)
    g.collider(0.23, 0.61, -7.6, -4.4, 0, 2.1)
    # nav: back aisle (counter side) and front row (island side), linked around the island ends
    A.node('w:k:aw', 1.25, -7.45, 0.5)
    A.node('w:k:ae', 4.95, -7.45, 0.5)
    A.node('w:k:fw', 1.25, -4.95, 0.7)
    A.node('w:k:fe', 4.95, -4.95, 0.7)
    A.edge('w:k:aw', 'w:k:fw')
    A.edge('w:k:ae', 'w:k:fe')
    A.edge('w:k:fw', 'w:s1')
    A.edge('w:k:fe', 'w:s2')
    A.edge('w:k:fe', 'w:s1')
    back = []
    for i, x in enumerate((1.85, 3.1, 4.35)):
        aid = A.spot(f'spot:kitchen:{i}', x, -7.8, math.pi, room='kitchen', approach=-0.35, hubs=[])
        back.append(f'ap:{aid}')
    A.chain('w:k:aw', *back, 'w:k:ae')
    front = []
    for i, x in enumerate((2.3, 3.1, 3.9)):
        aid = A.spot(f'spot:kitchen:{i + 3}', x, -5.55, math.pi, room='kitchen', approach=-0.6, hubs=[])
        front.append(f'ap:{aid}')
    A.chain('w:k:fw', *front, 'w:k:fe')


def _lounge(g, A, P, t, rng):
    fab = t['fabric']
    leather = t['decor']['brass']
    with g.at(3.6, 5.3):
        F.rug(g, P, 4.6, 3.3, t['rug'], r=0.25)
        F.coffee_table(g, P, r=0.5)
        F.pot_plant(g, P, (0.15, 0.4, 0.1), 0.07, 0.1, 'succulent', rng)
        g.box(P['paint'], (0.25, 0.04, 0.32), (-0.2, 0.42, -0.1), yaw=0.3, color='#e9e4d8', bevel=0.003)
    # sofa A (back to the side wall), sofa B (back to the spine)
    with g.at(3.6, 7.95, math.pi):
        F.sofa(g, P, length=2.4, color=fab[0], cushions=3)
    with g.at(3.6, 2.6, 0.0):
        F.sofa(g, P, length=2.4, color=fab[1], cushions=3)
    for sx, yaw in ((1.15, math.pi / 2), (5.95, -math.pi / 2)):
        with g.at(sx, 5.3, yaw):
            F.armchair(g, P, fab[2] if not leather else None, leather=leather)
    with g.at(0.85, 7.9):
        F.floor_lamp(g, P, kelvin=t['accent_kelvin'])
    with g.at(0.9, 3.0):
        F.bean_bag(g, P, fab[3])
    with g.at(6.1, 7.95):
        F.side_table(g, P, color=t['trim'])
        F.pot_plant(g, P, (0, 0.5, 0), 0.08, 0.13, 'bush', rng)
    F.pot_plant(g, P, (0.6, 0, 8.3), 0.24, 0.5, 'tree', rng, pot_color=t['pot'])
    g.light('panel', (3.6, H - 0.05, 5.3), size=(3.0, 0.4), power=90, kelvin=t['accent_kelvin'])
    for xx in (2.6, 4.6):
        F.dome_pendant(g, P, (xx, H, 5.3), drop=1.6, color=t['accent'] if not leather else '#C8A45D', kelvin=t['accent_kelvin'],
                       power=25, r=0.28, mat='brass' if leather else 'paint')
    # room divider shelf between lounge and pods
    with g.at(6.55, 3.0, -math.pi / 2):
        F.bookshelf(g, P, w=3.2, h=1.5, d=0.4, rng=rng, frame='wood')
    g.collider(6.55, 6.95, 3.0, 6.2, 0, 1.5)
    g.collider(2.4, 4.8, 7.5, 8.45, 0, 0.8)
    g.collider(2.4, 4.8, 2.14, 3.06, 0, 0.8)
    # nav loop around the coffee table
    A.node('w:l:sw', 1.75, 3.9, 0.6)
    A.node('w:l:se', 5.5, 3.9, 0.6)
    A.node('w:l:nw', 1.75, 6.75, 0.6)
    A.node('w:l:ne', 5.5, 6.75, 0.6)
    A.edge('w:l:sw', 'w:s1')
    A.edge('w:l:se', 'w:s2')
    seats = []
    for i, x in enumerate((-0.69, 0.0, 0.69)):  # sofa B, facing +z
        with g.at(3.6, 2.6):
            aid = A.seat(f'seat:lounge:{i}', x, 0.1, 0.0, pose='lounge', room='lounge', approach=0.62, hubs=[])
        seats.append(f'ap:{aid}')
    A.chain('w:l:sw', *seats, 'w:l:se')
    seats = []
    for i, x in enumerate((0.69, 0.0, -0.69)):  # sofa A, facing −z
        with g.at(3.6, 7.95, math.pi):
            aid = A.seat(f'seat:lounge:{i + 3}', x, 0.1, 0.0, pose='lounge', room='lounge', approach=0.62, hubs=[])
        seats.append(f'ap:{aid}')
    A.chain('w:l:nw', *seats, 'w:l:ne')
    with g.at(1.15, 5.3, math.pi / 2):
        A.seat('seat:lounge:6', 0, 0.06, 0.0, pose='lounge', room='lounge', approach=0.62,
               hubs=['w:l:sw', 'w:l:nw'])
    with g.at(5.95, 5.3, -math.pi / 2):
        A.seat('seat:lounge:7', 0, 0.06, 0.0, pose='lounge', room='lounge', approach=0.62,
               hubs=['w:l:se', 'w:l:ne'])
    A.edge('w:l:sw', 'w:l:nw')
    A.edge('w:l:se', 'w:l:ne')


def _pods(g, A, P, t, rng, wood_top):
    chair = t['fabric'][1] if t['fabric'][1] not in ('#E8DCCB', '#D4E3E3', '#E5E5F0', '#D9CDB4') else t['fabric'][0]
    mugs = (t['accent'], '#f4f1ea', '#2b2b2b', t['fabric'][3])
    for row, pz in enumerate(POD_Z):
        corr_z = CORR_Z if pz > 0 else -CORR_Z
        cnodes = []
        for x in (7.6, 9.0, 10.8, 12.6, 14.4, 16.2, 18.0):
            nid = f'w:c{row}:{x:g}'
            A.node(nid, x, corr_z, 0.6)
            cnodes.append(nid)
        A.chain(*cnodes)
        A.node(f'w:e{row}', 18.1, 2.2 if pz > 0 else -2.2, 0.4)
        A.chain(cnodes[-1], f'w:e{row}', 'w:s6')
        A.edge(cnodes[0], 'w:s2' if pz < 0 else 'w:l:ne')
        for col, px in enumerate(POD_X):
            pod = row * 3 + col + 1
            with g.at(px, pz):
                seats = F.pod(g, P, pod, rng, chair, mugs, divider_color=t['felt'][2], top=wood_top)
                for (i, sx, sz, h, port) in seats:
                    # +z-side seats face −z; in world, the side towards the spine depends on the row
                    toward_spine = (sz > 0) == (pz < 0)
                    hub = f'w:s{3 + col}' if toward_spine else f'w:c{row}:{px:g}'
                    A.seat(f'seat:desk:{pod}:{i}', sx, sz, h, pose='sit', room=f'pod-{pod}',
                           screen=f'desk:{pod}:{i}', approach=-0.6, hubs=[hub])
                    A.port(f'port:desk:{pod}:{i}', *port)
            g.collider(px - 1.6, px + 1.6, pz - 0.8, pz + 0.8, 0, 1.2)


def _booths(g, A, P, t, rng):
    for i, bx in enumerate(BOOTH_X):
        with g.at(bx, -8.15):
            F.phone_booth(g, P, i, t['felt'][0])
            A.spot(f'spot:booth:{i}', 0, 0.05, 0.0, room=f'booth-{i}', approach=(0, 1.2), led=f'booth:{i}',
                   hubs=[])
        ax = bx
        # approach (bx, −6.95) → the two nearest corridor nodes
        cand = [x for x in (7.6, 9.0, 10.8, 12.6, 14.4, 16.2, 18.0)]
        cand.sort(key=lambda x: abs(x - ax))
        for x in cand[:2]:
            A.edge(f'ap:spot:booth:{i}', f'w:c0:{x:g}')
    g.collider(BOOTH_X[0] - 0.7, BOOTH_X[-1] + 0.7, -8.85, -7.45, 0, 2.3)
    # storage + plants along the rest of the wall
    g.furn('kitchen-counter', 2.85, 0.5, x=17.025, z=-8.6)  # storage cabinets (no cabinet kind)
    with g.at(15.6, -8.85):
        for k in range(3):
            g.box_b(P['wood'], k * 0.95, k * 0.95 + 0.93, 0.05, 1.05, 0.0, 0.5, bevel=0.005, segs=2)
            g.box(P['metal'], (0.3, 0.015, 0.02), (k * 0.95 + 0.47, 0.95, 0.51), bevel=0.003)
        g.box_b(P['metal'], 0, 2.83, 0.0, 0.05, 0.02, 0.45, bevel=0.002)
        F.pot_plant(g, P, (0.4, 1.05, 0.25), 0.1, 0.18, 'snake', rng, pot_color=t['pot'])
        F.pot_plant(g, P, (1.5, 1.05, 0.25), 0.09, 0.14, 'bush', rng, pot_color=t['pot'])
        F.pot_plant(g, P, (2.4, 1.05, 0.25), 0.08, 0.12, 'succulent', rng, pot_color=t['pot'])
    g.collider(15.6, 18.45, -8.85, -8.35, 0, 1.05)


def _meeting(g, A, P, t, rng, room, s):
    """Glass meeting room at x ∈ [18.6, 23.85]; s = −1 (A, z < 0) or +1 (B, z > 0)."""
    z_in, z_out = 2.6 * s, 8.85 * s
    zc = 5.7 * s
    xc = 21.2
    glass_partition(g, P, (MEET_X0, z_in), (MEET_X0, z_out), h=2.9, spacing=1.25, top=H)
    if s < 0:
        glass_partition(g, P, (MEET_X0, z_in), (23.85, z_in), h=2.9, spacing=1.25, door=(0.45, 1.45), top=H)
    else:
        glass_partition(g, P, (23.85, z_in), (MEET_X0, z_in), h=2.9, spacing=1.25, door=(3.8, 4.8), top=H)
    g.collider(MEET_X0 - 0.05, MEET_X0 + 0.05, min(z_in, z_out), max(z_in, z_out), 0, H)
    if s < 0:
        g.collider(MEET_X0, 19.0, z_in - 0.05, z_in + 0.05, 0, H)
        g.collider(20.1, 23.85, z_in - 0.05, z_in + 0.05, 0, H)
    else:
        g.collider(MEET_X0, 19.0, z_in - 0.05, z_in + 0.05, 0, H)
        g.collider(20.1, 23.85, z_in - 0.05, z_in + 0.05, 0, H)
    with g.at(xc, zc, math.pi / 2):
        F.meeting_table(g, P, w=2.4, d=1.1)
    g.collider(xc - 0.55, xc + 0.55, zc - 1.2, zc + 1.2, 0, 0.75)
    with g.at(xc, zc):
        F.rug(g, P, 2.6, 4.0, t['rug'], r=0.1)
    # TV on the solid side wall, facing into the room
    with g.at(xc, z_out - 0.02 * s, 0.0 if s < 0 else math.pi, y=1.45):
        F.tv(g, P, f'meeting:{room}')
    with g.at(19.05, 7.6 * s, math.pi / 2):
        F.whiteboard(g, P, w=1.2, h=0.9)
    F.pot_plant(g, P, (23.4, 0, z_in + 0.45 * s), 0.18, 0.4, 'snake', rng, pot_color=t['pot'])
    for k in range(4):  # acoustic felt panels on the back wall
        zz = zc + (k - 1.5) * 1.25 * s
        g.box_b(P['felt'], 23.79, 23.85, 0.9, 2.5, zz - 0.55, zz + 0.55, bevel=0.01, segs=2, color=t['felt'][k % 2])
    F.linear_pendant(g, P, (xc, H, zc), length=2.2, yaw=math.pi / 2, drop=1.45, kelvin=t['accent_kelvin'],
                     power=110, y_ceiling=H)
    g.light('panel', (22.9, H - 0.05, zc), size=(0.3, 4.5), power=50, kelvin=t['kelvin'])
    chair = t['fabric'][0]
    # nav: outside → door → inner corridor (near the glass), down both long sides
    door_x = 19.5
    A.node(f'w:m{room}:out', door_x, 1.9 * s, 0.6)
    A.node(f'w:m{room}:in', door_x, 3.35 * s, 0.6)
    A.node(f'w:m{room}:far', 22.77, 3.35 * s, 0.5)
    A.edge(f'w:m{room}:out', 'w:s6')
    A.edge(f'w:m{room}:out', f'w:m{room}:in')
    A.edge(f'w:m{room}:in', f'w:m{room}:far')
    near, far = [], []
    idx = 0
    for side, sx, h in ((-1, xc - 0.97, math.pi / 2), (1, xc + 0.97, -math.pi / 2)):
        for dz in (-0.75, 0.0, 0.75):
            z = zc + dz * s
            with g.at(sx, z, h):
                F.meeting_chair(g, P, chair)
            aid = A.seat(f'seat:meeting:{room}:{idx}', sx, z, h, pose='sit', room=f'meeting-{room}',
                         approach=-0.6, hubs=[])
            (near if side < 0 else far).append((abs(z), f'ap:{aid}'))
            idx += 1
    near.sort()
    far.sort()
    A.chain(f'w:m{room}:in', *[n for _, n in near])
    A.chain(f'w:m{room}:far', *[n for _, n in far])

# ====================================================================== capability rooms (x ∈ [24, 30])
ROOM_X0, ROOM_X1 = 24.0, 29.86
STATION_Z = (-7.65, -5.8, -3.95, -2.1)


def _room_sign(g, P, ref, z):
    g.furn('sign', 1.64, 0.05, x=23.84, z=z, yaw=-math.pi / 2)
    g.box_b(P['metal'], 23.845, 23.855, 3.02, 3.48, z - 0.82, z + 0.82, bevel=0.002)
    d = g.dynamic(f'sign-{ref}', 'sign', ref, P['sign'], pivot=(23.838, 3.25, z), extras={'width': 1.5, 'height': 0.36})
    with g.into(d):
        g.quad(P['sign'], 1.5, 0.36, (23.838, 3.25, z), yaw=-math.pi / 2)


def _front(g, A, P, t, rng):
    """x = 24: solid behind the meeting rooms, glass front with two doors between them; z = 0 partition."""
    w_s = g.plan_wall((23.92, -9.0), (23.92, -2.6), side=1, thick=0.15, h=H)  # body x ∈ [23.85, 24]
    w_n = g.plan_wall((23.92, 2.6), (23.92, 9.0), side=1, thick=0.15, h=H)
    w_p = g.plan_wall((24.0, 0.0), (30.0, 0.0), side=1, thick=0.16, h=H)  # body z ∈ ±0.08
    with g.wall_tag(w_s):  # contract §13
        g.box_b(P['wall'], 23.85, 24.0, 0, H, -8.85, -2.6, bevel=0.003)
    with g.wall_tag(w_n):
        g.box_b(P['wall'], 23.85, 24.0, 0, H, 2.6, 8.85, bevel=0.003)
    glass_partition(g, P, (23.92, -2.6), (23.92, 0.0), h=2.9, spacing=1.3, door=(1.1, 2.2), top=H)
    glass_partition(g, P, (23.92, 0.0), (23.92, 2.6), h=2.9, spacing=1.3, door=(0.4, 1.5), top=H)
    with g.wall_tag(w_p):
        g.box_b(P['wall'], 24.0, ROOM_X1, 0, H, -0.08, 0.08, bevel=0.003)
    _room_sign(g, P, 'adapters', -0.95)
    _room_sign(g, P, 'library', 0.95)
    g.collider(23.85, 24.0, -8.85, -2.6, 0, H)
    g.collider(23.85, 24.0, 2.6, 8.85, 0, H)
    g.collider(23.86, 23.98, -2.6, -1.5, 0, H)
    g.collider(23.86, 23.98, -0.4, 0.4, 0, H)
    g.collider(23.86, 23.98, 1.5, 2.6, 0, H)
    g.collider(24.0, ROOM_X1, -0.08, 0.08, 0, H)
    A.node('w:ad:out', 23.2, -0.95, 0.5)
    A.node('w:lib:out', 23.2, 0.95, 0.5)
    A.edge('w:ad:out', 'w:s7')
    A.edge('w:lib:out', 'w:s7')
    F.pot_plant(g, P, (23.35, 0, -2.2), 0.2, 0.42, 'tree', rng, pot_color=t['pot'])
    F.pot_plant(g, P, (23.35, 0, 2.2), 0.2, 0.42, 'tree', rng, pot_color=t['pot'])


def _adapters(g, A, P, t, rng):
    """Adapters room, z ∈ [−9, 0]: stations 0–3 on the window wall (facing the door), 4–7 on the door wall,
    a server-rack core in the middle with glowing cable channels to every kiosk."""
    glow = P['glow_accent']
    g.box_b(P['paint'], ROOM_X0, ROOM_X1, 0, 0.006, -8.85, -0.08, bevel=0, color='#2a2d33')
    core = (26.85, -4.45)
    kiosks = []
    for row, (kx, yaw, sx_spot, ax) in enumerate(((29.25, -math.pi / 2, 28.65, 28.05), (24.45, math.pi / 2, 25.05, 25.65))):
        for k, z in enumerate(STATION_Z):
            i = row * 4 + k
            with g.at(kx, z, yaw):
                port = F.station_kiosk(g, P, i, glow)
                A.port(f'port:station:{i}', *port)
            h = math.pi / 2 if row == 0 else -math.pi / 2
            A.spot(f'spot:station:{i}', sx_spot, z, h, room='adapters', approach=-0.6, hubs=[], led=f'station:{i}')
            F.led_ring(g, P, f'station:{i}', (sx_spot, 0, z))
            kiosks.append((kx, z))
            g.collider(min(kx, kx + 0.2 * (1 if row == 0 else -1)) - 0.1, max(kx, kx + 0.2 * (1 if row == 0 else -1)) + 0.1,
                       z - 0.84, z + 0.84, 0, 2.6)
    # floor cable channels: kiosk base → core (grating + accent line)
    for (kx, z) in kiosks:
        dx, dz = core[0] - kx, core[1] - z
        L = math.hypot(dx, dz) - 0.5
        yaw = math.atan2(dx, dz)
        mx, mz = kx + dx / 2 * (L / (L + 0.5)), z + dz / 2 * (L / (L + 0.5))
        g.box(P['metal'], (0.14, 0.01, L), (mx, 0.011, mz), yaw=yaw, bevel=0)
        g.box(glow, (0.02, 0.004, L), (mx, 0.018, mz), yaw=yaw, bevel=0)
    with g.at(*core):
        F.core_column(g, P, glow, H=H, w=0.9)
    g.collider(core[0] - 0.5, core[0] + 0.5, core[1] - 0.5, core[1] + 0.5, 0, H)
    # acoustic wall panels (end wall + partition)
    for k in range(6):
        x = 24.55 + k * 0.88
        c = t['felt'][2] if k % 3 else t['felt'][0]
        g.box_b(P['felt'], x - 0.4, x + 0.4, 0.6, 3.0, -8.85, -8.8, bevel=0.01, segs=2, color='#30333a' if k % 2 else c)
        g.box_b(P['felt'], x - 0.4, x + 0.4, 2.65, 3.25, -0.13, -0.08, bevel=0.01, segs=2, color='#30333a')
    # light: cool ceiling slots + a halo ring over the core
    with g.in_group('ceiling'):
        g.torus(P['light'], 1.25, 0.03, (core[0], H - 0.35, core[1]), segs=48, rsegs=6)
        for a in range(3):
            ang = math.tau * a / 3
            g.cyl(P['metal'], 0.003, 0.33, (core[0] + math.cos(ang) * 1.25, H - 0.33, core[1] + math.sin(ang) * 1.25),
                  segs=3, caps=False)
        for x in (25.3, 28.4):
            g.box_b(P['light'], x - 0.05, x + 0.05, H - 0.012, H - 0.006, -8.2, -0.7, bevel=0)
    for x in (25.3, 28.4):
        g.light('panel', (x, H - 0.03, -4.45), size=(0.12, 7.2), power=55, kelvin=5000)
    for a in range(6):
        ang = math.tau * a / 6
        g.light('point', (core[0] + math.cos(ang) * 1.25, H - 0.4, core[1] + math.sin(ang) * 1.25), radius=0.05,
                 power=9, kelvin=5500)
    # nav through the door, along both station rows
    A.node('w:ad:in', 24.6, -0.95, 0.45)
    A.edge('w:ad:out', 'w:ad:in')
    for row, ax in ((0, 28.05), (1, 25.65)):
        A.node(f'w:ad:r{row}a', ax, -0.95, 0.45)
        A.node(f'w:ad:r{row}b', ax, -8.4, 0.4)
        ids = [f'ap:spot:station:{row * 4 + k}' for k in reversed(range(4))]
        A.chain(f'w:ad:r{row}a', *ids, f'w:ad:r{row}b')
    A.chain('w:ad:in', 'w:ad:r1a', 'w:ad:r0a')
    A.edge('w:ad:r1b', 'w:ad:r0b')


def _library(g, A, P, t, rng):
    """Library, z ∈ [0, 9]: shelf A (books 0–11) on the partition, shelf B (12–23) on the end wall, six
    rule boards on the door wall, an 8-notebook display under the window, a reading table for four."""
    g.box_b(P['wood_dark'], ROOM_X0, ROOM_X1, 0, 0.006, 0.08, 8.85, bevel=0)
    d, w, sh = 0.42, 5.0, 3.5
    feat_x = (1.3, 1.45, 1.6, 3.4, 3.55, 3.7)
    with g.at(24.55, 0.08 + d):
        spines = F.library_shelf(g, P, w, sh, d, rng, [(i, feat_x[i % 6]) for i in range(12)])
        for ref, pos in spines.items():
            A.port(f'port:book:{ref}', *pos)
        F.ladder(g, P, 3.9, 4.95, sh, 0.55, at=4.45)
    with g.at(29.55, 8.85 - d, math.pi):
        spines = F.library_shelf(g, P, w, sh, d, rng, [(12 + i, feat_x[i % 6]) for i in range(12)])
        for ref, pos in spines.items():
            A.port(f'port:book:{ref}', *pos)
    g.collider(24.55, 29.55, 0.08, 0.08 + d, 0, sh)
    g.collider(28.7, 29.25, 0.08 + d, 0.08 + d + 0.62, 0, sh)
    g.collider(24.55, 29.55, 8.85 - d, 8.85, 0, sh)
    for k in range(6):  # rule boards on the door wall
        z = 3.2 + k * 0.98
        with g.at(24.0, z, math.pi / 2, y=1.55):
            port = F.rule_board(g, P, k)
            A.port(f'port:board:{k}', *port)
    g.light('wallwash', (25.4, H - 0.15, 5.65), size=(0.15, 5.8), power=70, kelvin=2700, dir=(-0.7, -0.7, 0))
    # notebook display under the window
    g.furn('notebook-rack', 0.66, 2.96, x=29.45, z=4.5)
    g.box_b(P['wood_dark'], 29.15, 29.75, 0, 0.74, 3.05, 5.95, bevel=0.006, segs=2)
    g.box_b(P['brass'], 29.12, 29.78, 0.74, 0.76, 3.02, 5.98, bevel=0.003)
    cols = ('#7a1f2b', '#1f3a4d', '#2f4a36', '#6b4f2a', '#3a2f4a', '#c9b48a', '#2b2b2b', '#8a5a3b')
    for k in range(8):
        z = 3.32 + k * 0.335
        with g.at(29.5, z, -math.pi / 2, y=0.76):
            port = F.memory_notebook(g, P, k, cols[k])
            A.port(f'port:notebook:{k}', *port)
    g.collider(29.12, 29.86, 3.0, 6.0, 0, 1.0)
    # reading table + 4 chairs (sit root rule: table edge 0.13 m in front of the root)
    tx, tz = 27.0, 4.6
    with g.at(tx, tz):
        F.rug(g, P, 3.6, 3.4, t['rug'], r=0.2)
    g.furn('reading-table', 2.0, 1.0, x=tx, z=tz)
    g.box_b(P['wood_dark'], tx - 1.0, tx + 1.0, 0.72, 0.76, tz - 0.5, tz + 0.5, bevel=0.006, segs=2)
    for sx in (-0.75, 0.75):
        g.box_b(P['brass'], tx + sx - 0.03, tx + sx + 0.03, 0, 0.72, tz - 0.38, tz + 0.38, bevel=0.004)
        g.box_b(P['brass'], tx + sx - 0.05, tx + sx + 0.05, 0, 0.02, tz - 0.42, tz + 0.42, bevel=0.003)
    for sx in (-0.5, 0.5):
        F.bankers_lamp(g, P, (tx + sx, 0.76, tz), kelvin=2700)
    g.collider(tx - 1.0, tx + 1.0, tz - 0.5, tz + 0.5, 0, 0.76)
    F.dome_pendant(g, P, (tx, H, tz), drop=1.5, color='#C8A45D', kelvin=2700, power=40, r=0.3, mat='brass')
    idx = 0
    near, far = [], []
    for side, cz, h in ((-1, tz - 0.92, 0.0), (1, tz + 0.92, math.pi)):
        for sx in (-0.5, 0.5):
            with g.at(tx + sx, cz, h):
                F.meeting_chair(g, P, t['leather'])
            aid = A.seat(f'seat:reading:{idx}', tx + sx, cz, h, pose='sit', room='library', approach=-0.6, hubs=[])
            (near if side < 0 else far).append(f'ap:{aid}')
            idx += 1
    # armchair corner + floor lamp by the window
    with g.at(28.95, 1.75, -2.4):
        F.armchair(g, P, None, leather=True)
    with g.at(29.45, 1.0):
        F.floor_lamp(g, P, kelvin=2700)
    g.collider(28.45, 29.45, 1.25, 2.25, 0, 0.8)
    F.pot_plant(g, P, (29.4, 0, 7.55), 0.22, 0.45, 'tree', rng, pot_color=t['pot'])
    g.light('panel', (27.0, H - 0.05, 4.6), size=(2.4, 1.2), power=60, kelvin=3000)
    with g.in_group('ceiling'):  # warm timber slat ceiling
        for k in range(29):
            x = 24.25 + k * 0.19
            g.box_b(P['wood'], x - 0.03, x + 0.03, H - 0.2, H - 0.12, 0.2, 8.75, bevel=0.003)
    g.light('wallwash', (27.0, H - 0.2, 1.4), size=(4.6, 0.12), power=55, kelvin=2700, dir=(0, -0.7, -0.7))
    g.light('wallwash', (27.0, H - 0.2, 7.55), size=(4.6, 0.12), power=55, kelvin=2700, dir=(0, -0.7, 0.7))
    # shelf spots (people may share a spot with a 0.6 m lateral offset)
    A.spot('spot:shelf:0', 27.0, 1.1, math.pi, room='library', approach=-0.6, hubs=[])
    A.spot('spot:shelf:1', 27.0, 7.85, 0.0, room='library', approach=-0.6, hubs=[])
    # nav through the door
    A.node('w:lib:in', 24.6, 0.95, 0.45)
    A.node('w:lib:h', 25.4, 1.9, 0.5)
    A.node('w:lib:sw', 25.55, 3.08, 0.45)
    A.node('w:lib:se', 28.45, 3.08, 0.45)
    A.node('w:lib:nw', 25.55, 6.12, 0.45)
    A.node('w:lib:ne', 28.45, 6.12, 0.45)
    A.chain('w:lib:out', 'w:lib:in', 'w:lib:h', 'w:lib:sw')
    A.chain('w:lib:sw', *near, 'w:lib:se')
    A.chain('w:lib:nw', *far, 'w:lib:ne')
    A.edge('w:lib:sw', 'w:lib:nw')
    A.edge('w:lib:se', 'w:lib:ne')
    A.edge('ap:spot:shelf:0', 'w:lib:h')
    A.edge('ap:spot:shelf:0', 'w:lib:se')
    A.edge('ap:spot:shelf:1', 'w:lib:nw')
    A.edge('ap:spot:shelf:1', 'w:lib:ne')


def _decor(g, A, P, name, t, rng):
    d = t['decor']
    # living wall along the z = +9 wall above a planter
    with g.at(17.8, 8.85, math.pi):
        F.living_wall(g, P, 10.0, 2.45, rng, y0=0.55, density=0.55)
    with g.at(12.8, 8.62):
        F.planter(g, P, 10.2, 0.42, 0.45, rng, kind='fern', color=t['trim'], density=0.5)
    g.collider(7.7, 17.9, 8.4, 8.85, 0, 3.0)
    if d['living_walls'] > 1:  # second living wall above the storage run
        with g.at(15.6, -8.85):
            F.living_wall(g, P, 2.85, 2.0, rng, y0=1.25, density=0.6)
    F.pot_plant(g, P, (6.9, 0, -2.3), 0.22, 0.5, 'tree', rng, pot_color=t['pot'])
    for x in (10.8, 14.4):
        for z in (-1.95, 1.95):
            F.pot_plant(g, P, (x, 0, z), 0.2, 0.42, 'snake' if (x + z) > 12 else 'bush', rng, pot_color=t['pot'])
    # abstract art (no text/logos): framed color-field canvases
    if not (d['waves'] or name == 'nordic' or d['neon']):
        cols = [t['accent'], t['felt'][1], t['fabric'][2]]
        for k, x in enumerate((2.55, 3.6, 4.65)):
            g.box_b(P['metal'], x - 0.46, x + 0.46, 1.25, 2.35, 8.8, 8.84, bevel=0.003)
            g.box_b(P['paint'], x - 0.43, x + 0.43, 1.28, 2.32, 8.78, 8.8, bevel=0, color=cols[k])
            g.box_b(P['paint'], x - 0.43, x + 0.43, 1.28 + 0.35 * ((k + 1) % 3), 1.28 + 0.35 * ((k + 1) % 3) + 0.3,
                    8.775, 8.78, bevel=0, color='#f4efe6')
    F.pot_plant(g, P, (6.9, 0, 2.3), 0.2, 0.42, 'snake', rng, pot_color=t['pot'])
    if d['hanging']:
        for x in (8.2, 11.8, 15.4):
            for z in (-2.2, 2.2):
                F.hanging_plant(g, P, (x + 0.6, H - 0.15, z), rng, length=0.9)
    if d['neon']:
        glows = [P['glow0'], P['glow1']]
        with g.in_group('ceiling'):
            for i, pz in enumerate(POD_Z):
                for zz in (pz - 2.0, pz + 2.0):
                    g.box_b(glows[i], 7.4, 17.9, H - 0.16, H - 0.13, zz - 0.02, zz + 0.02, bevel=0)
        for k, x in enumerate((2.0, 4.0, 6.0)):
            g.box_b(glows[k % 2], x - 0.025, x + 0.025, 0.3, 3.3, -8.84, -8.8, bevel=0)
        g.box_b(glows[0], 0.3, 6.8, 0.1, 0.14, 8.8, 8.84, bevel=0)
        with g.at(5.2, 8.45, math.pi):
            F.arcade(g, P, None, body='#1b1b2f', accent='#7F5AF0')
        g.collider(4.85, 5.55, 8.0, 8.85, 0, 1.9)
    if d['brass']:
        # dark walnut slat paneling on the kitchen accent wall
        for k in range(int(6.6 / 0.09)):
            x = 0.3 + k * 0.09
            g.box(P['wood_dark'], (0.045, H - 0.3, 0.03), (x, (H - 0.3) / 2 + 0.15, -8.82), bevel=0.003)
    if d['waves']:
        # wave-profile felt wall panels on the lounge wall
        for k in range(18):
            x = 0.4 + k * 0.36
            hgt = 1.2 + 0.6 * math.sin(k * 0.5)
            g.box_b(P['felt'], x - 0.15, x + 0.15, 0.9, 0.9 + hgt, 8.78, 8.83, bevel=0.01, segs=2,
                    color=t['felt'][k % 2])
    if d['shelves'] and name == 'nordic':
        for k in range(4):
            for j in range(3):
                g.box_b(P['felt'], 0.6 + k * 1.5, 1.9 + k * 1.5, 0.9 + j * 0.85, 1.65 + j * 0.85, 8.79, 8.83,
                        bevel=0.008, segs=2, color=t['felt'][(k + j) % 3])
    if name == 'terracotta':
        for x in (2.0, 4.6):
            F.pot_plant(g, P, (x, 0, 8.45), 0.2, 0.42, 'bush', rng, pot_color='#C26A48')


def _rooms(g):
    """Floor-plan rooms (contract §11); ids match the anchors' extras.room. They tile the wing."""
    r = g.room
    r('kitchen', 'Kitchen', 0, -9, 7, -1.2, floor='tile')
    r('hall', 'Hall', 0, -1.2, 18.6, 1.2, floor='wood')
    r('lounge', 'Lounge', 0, 1.2, 7, 9, floor='wood')
    edges = (7.0, 10.2, 11.8, 13.4, 15.0)
    for i in range(4):
        r(f'booth-{i}', f'Phone booth {i + 1}', edges[i], -9, edges[i + 1], -7.45, floor='carpet')
    r('storage', 'Storage', 15.0, -9, 18.6, -7.45, floor='carpet')
    r('pods-south', 'Pod corridor', 7.0, -7.45, 18.6, -6.25, floor='carpet')
    r('pods-north', 'Pod corridor', 7.0, 6.25, 18.6, 9, floor='carpet')
    px = (7.0, 10.8, 14.4, 18.6)
    for row, (z0, z1) in enumerate(((-6.25, -1.2), (1.2, 6.25))):
        for col in range(3):
            pod = row * 3 + col + 1
            r(f'pod-{pod}', f'Pod {pod}', px[col], z0, px[col + 1], z1, floor='carpet')
    r('meeting-A', 'Meeting room A', MEET_X0, -9, 24.0, -2.6, floor='carpet')
    r('vestibule', 'Vestibule', MEET_X0, -2.6, 24.0, 2.6, floor='wood')
    r('meeting-B', 'Meeting room B', MEET_X0, 2.6, 24.0, 9, floor='carpet')
    r('adapters', 'Adapters', 24.0, -9, 30, 0, floor='concrete')
    r('library', 'Library', 24.0, 0, 30, 9, floor='wood')


def context(g, P):
    """Bake/preview context (not exported): the street in front of the door, the opposite wing's wall,
    and the ground outside the windows."""
    g.box_b(P['floor'], -6, 0, -0.1, 0, -9, 9, bevel=0)
    g.box_b(P['ceiling'], -6, 0, H, H + 0.1, -9, 9, bevel=0)
    g.box_b(P['wall'], -6.15, -6, 0, H, -9, 9, bevel=0)
    for z in (-6.0, 0.0, 6.0):
        g.light('panel', (-3, H - 0.05, z), size=(1.2, 3.0), power=80, kelvin=4000)
    g.box_b(P['paint'], 30.2, 90, -0.6, -0.5, -40, 40, bevel=0, color='#7d8466')


def _previews(name):
    """(slug, camera glTF pos, look-at glTF pos, lens mm, hide ceiling)."""
    return [
        ('overview', (-7.5, 20.0, -18.0), (14.5, 0.0, 0.5), 22, True),
        ('rooms', (21.0, 9.5, -6.5), (27.0, 0.0, 0.5), 20, True),
        ('adapters', (24.6, 1.75, -0.9), (27.6, 1.5, -6.5), 16, False),
        ('library', (24.7, 1.7, 1.0), (28.2, 1.3, 6.8), 16, False),
        ('interior', (1.2, 1.65, -0.6), (14.0, 1.2, 1.8), 18, False),
        ('meeting', (19.6, 2.1, -3.0), (22.0, 0.7, -6.6), 16, False),
        ('booth', (13.2, 1.6, -4.3), (11.0, 1.1, -8.2), 20, False),
        ('lounge', (6.3, 1.7, 2.2), (2.6, 0.6, 6.4), 18, False),
        ('kitchen', (5.6, 1.7, -3.2), (2.2, 1.0, -8.0), 18, False),
    ]
