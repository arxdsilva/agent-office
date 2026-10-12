"""Atrium, x ∈ [−33, 33], z ∈ [−24, 0], double height (7.2 m). Main Street opens at local (0, 0).

    z = 0  ┌ elevator core ┐        [street portal]     cafe bar + LED wall (12 × 4)
           │  ▼ ▼ ▼        │                                                   game area:
           reception (curved)        hub                cafe 6 × 4 seats       ping-pong × 2
           living wall (x = −27)     planters + benches                        arcades × 2
           waiting lounge
    z = −24 ─────────────── glass facade (floor-to-ceiling, black mullions) ───────────────
"""
import math

from lib import furniture as F
from lib.geometry import curtain_wall, wall

H = 7.2
SKY = ((-14.0, -4.0, -17.0, -7.0), (4.0, 14.0, -17.0, -7.0))


def build(g, A, P, name, t, rng):
    _shell(g, A, P, t, rng)
    _ceiling(g, P, t)
    _elevators_reception(g, A, P, t, rng)
    _cafe(g, A, P, t, rng)
    _game(g, A, P, t, rng)
    _plaza(g, A, P, t, rng)
    _murals(g, A, P, t, rng)
    _nav(g, A)
    _rooms(g)
    return dict(
        bounds={'minX': -33, 'maxX': 33, 'minZ': -24, 'maxZ': 0},
        sky=dict(sun_dir=(0.35, 0.72, -0.6), sun_strength=3.4, sky_strength=0.45),
        previews=[
            ('overview', (-40.0, 30.0, -46.0), (0.0, 0.0, -11.0), 24, True),
            ('entrance', (0.5, 1.7, -1.2), (-4.0, 2.4, -20.0), 16, False),
            ('lobby', (-8.0, 1.7, -14.0), (-19.0, 1.8, -4.0), 18, False),
            ('cafe', (6.0, 1.7, -17.5), (10.0, 2.6, -1.0), 18, False),
            ('game', (21.0, 1.8, -21.5), (28.0, 0.9, -9.0), 18, False),
        ],
    )


# ============================================================================== shell
def _shell(g, A, P, t, rng):
    g.plane_y(P['floor'], -33, 33, -24, 0, 0.0)
    wall(g, P['wall'], (-33, 0), (33, 0), H, thick=0.15, side=-1, openings=[(30.0, 36.0, 0, 3.6)])
    wall(g, P['wall'], (-33, -24), (-33, 0), H, thick=0.15, side=-1)
    wall(g, P['wall'], (33, -24), (33, 0), H, thick=0.15, side=1)
    curtain_wall(g, P, (-33, -24), (33, -24), H, spacing=1.8, transoms=(3.55,), thick=0.16, side=1)
    for x in (-27, -18, -9, 0, 9, 18, 27):  # facade piers
        g.box_b(P['concrete'], x - 0.3, x + 0.3, 0, H, -23.84, -23.3, bevel=0.012, segs=2)
    # street portal: timber-lined frame
    for s in (-1, 1):
        g.box_b(P['wood'], s * 3.0 - 0.35 * (s > 0), s * 3.0 + 0.35 * (s < 0), 0, 3.95, -0.75, 0, bevel=0.008, segs=2)
    g.box_b(P['wood'], -3.35, 3.35, 3.6, 3.95, -0.75, 0, bevel=0.008, segs=2)
    g.collider(-33, -3, -0.15, 0.2, 0, H)
    g.collider(3, 33, -0.15, 0.2, 0, H)
    g.collider(-33.2, -32.85, -24, 0, 0, H)
    g.collider(32.85, 33.2, -24, 0, 0, H)
    g.collider(-33, 33, -24.2, -23.84, 0, H)
    # living wall on the west wall
    with g.at(-32.85, -5.2, math.pi / 2):
        F.living_wall(g, P, 17.0, 5.6, rng, y0=0.7, density=0.55)
    with g.at(-32.4, -13.7, math.pi / 2):
        F.planter(g, P, 17.0, 0.8, 0.55, rng, kind='fern', color='#2f2f2f', density=0.7)
    g.collider(-32.85, -31.95, -22.3, -5.1, 0, 3)


def _ceiling(g, P, t):
    (ax0, ax1, az0, az1), (bx0, bx1, bz0, bz1) = SKY
    with g.in_group('ceiling'):
        # slab with two skylight openings
        g.plane_y(P['ceiling'], -33, 33, -24, az0, H, up=False)
        g.plane_y(P['ceiling'], -33, 33, az1, 0, H, up=False)
        g.plane_y(P['ceiling'], -33, ax0, az0, az1, H, up=False)
        g.plane_y(P['ceiling'], ax1, bx0, az0, az1, H, up=False)
        g.plane_y(P['ceiling'], bx1, 33, az0, az1, H, up=False)
        for (x0, x1, z0, z1) in SKY:
            for (a, b, c, d) in ((x0, x1, z0 - 0.06, z0), (x0, x1, z1, z1 + 0.06), (x0 - 0.06, x0, z0, z1),
                                 (x1, x1 + 0.06, z0, z1)):
                g.box_b(P['ceiling'], a, b, H, H + 0.9, c, d, bevel=0)
            for k in range(1, 5):
                x = x0 + (x1 - x0) * k / 5
                g.box_b(P['metal'], x - 0.04, x + 0.04, H + 0.75, H + 0.9, z0, z1, bevel=0.003)
        # timber slat ceiling (gaps over the skylights)
        z = -23.7
        while z < -0.2:
            spans = [(-32.8, 32.8)]
            if az0 - 0.1 < z < az1 + 0.1:
                spans = [(-32.8, ax0 - 0.1), (ax1 + 0.1, bx0 - 0.1), (bx1 + 0.1, 32.8)]
            for x0, x1 in spans:
                g.box_b(P['wood'], x0, x1, H - 0.28, H - 0.2, z - 0.025, z + 0.025, bevel=0.004)
            z += 0.22
        for x in range(-30, 31, 6):  # slat carriers
            g.box_b(P['metal'], x - 0.02, x + 0.02, H - 0.2, H - 0.01, -23.8, -0.2, bevel=0)
    with g.in_group('roofglass'):
        for (x0, x1, z0, z1) in SKY:
            g.box_b(P['glass'], x0, x1, H + 0.9, H + 0.91, z0, z1, bevel=0)
    # downlights between the slats
    for x in range(-30, 31, 6):
        for z in (-21.0, -16.5, -12.0, -7.5, -3.0):
            if any(x0 - 1 < x < x1 + 1 and z0 - 1 < z < z1 + 1 for (x0, x1, z0, z1) in SKY):
                continue
            g.light('panel', (x, H - 0.32, z), size=(1.0, 1.0), power=210, kelvin=t['kelvin'])
            with g.in_group('ceiling'):
                g.box_b(P['light'], x - 0.5, x + 0.5, H - 0.3, H - 0.29, z - 0.03, z + 0.03, bevel=0)


# ============================================================================== elevators + reception
def _elevators_reception(g, A, P, t, rng):
    with g.at(-18.5, -3.25, math.pi):
        F.elevator_bank(g, P, n=3, pitch=3.2, door_w=1.1, door_h=2.4, H=H, depth=3.0)
        idx = 0
        for i in range(3):
            cx = (i - 1) * 3.2
            for dx in (-0.35, 0.35):
                A.spot(f'spot:elevator:{idx}', cx + dx, 0.6, math.pi, room='elevator', approach=-0.6, hubs=[])
                idx += 1
    g.collider(-23.7, -13.3, -3.27, 0, 0, H)
    # reception: curved desk, visitors on the elevator side
    with g.at(-18.5, -9.0):
        F.reception_desk(g, P, radius=2.6, span=math.radians(110), accent=t['accent'])
        for k, a in enumerate((70, 83, 97, 110)):
            ar = math.radians(a)
            x, z = 3.0 * math.cos(ar), -2.0 + 3.0 * math.sin(ar)
            h = math.atan2(-math.cos(ar), -math.sin(ar))
            A.spot(f'spot:reception:{k}', x, z, h, room='reception', approach=-0.6, hubs=[])
        with g.at(0, -0.75):
            F.task_chair(g, P, color='#2b2b2b')
    g.collider(-20.7, -16.3, -10.0, -8.35, 0, 1.1)
    # backdrop: timber slat screen + planter behind reception
    g.plan_wall((-22.7, -13.3), (-14.3, -13.3), side=1, thick=0.12)  # timber slat screen (a free-standing partition)
    with g.at(-18.5, -13.3):
        for k in range(60):
            x = -4.2 + k * 0.14
            g.box(P['wood'], (0.06, 3.4, 0.12), (x, 1.7, 0), bevel=0.004)
        g.box_b(P['metal'], -4.3, 4.3, 3.4, 3.46, -0.1, 0.1, bevel=0.003)
    with g.at(-18.5, -13.85):
        F.planter(g, P, 8.4, 0.7, 0.45, rng, kind='snake', color='#2b2b2b', density=1.0)
    g.collider(-22.75, -14.25, -14.25, -13.2, 0, 3.4)
    for x in (-23.3, -13.7):
        F.pot_plant(g, P, (x, 0, -6.2), 0.3, 0.55, 'tree', rng, pot_color=t['pot'])
    # waiting lounge by the facade
    with g.at(-23.0, -19.5):
        F.rug(g, P, 9.0, 5.0, t['rug'], r=0.3)
        with g.at(0, 1.6, math.pi):
            F.sofa(g, P, length=3.0, color=t['fabric'][1], cushions=3)
        with g.at(0, -1.6):
            F.sofa(g, P, length=3.0, color=t['fabric'][0], cushions=3)
        for sx, yaw in ((-2.6, math.pi / 2), (2.6, -math.pi / 2)):
            with g.at(sx, 0, yaw):
                F.armchair(g, P, t['fabric'][2])
        F.coffee_table(g, P, r=0.6)
        for x in (-4.2, 4.2):
            F.pot_plant(g, P, (x, 0, 1.9), 0.28, 0.55, 'tree', rng, pot_color=t['pot'])
        with g.at(3.8, -1.8):
            F.floor_lamp(g, P, kelvin=2700)
    g.collider(-26.0, -20.0, -21.6, -17.4, 0, 0.9)


# ============================================================================== cafe + LED wall
def _cafe(g, A, P, t, rng):
    # back bar + front counter along the back wall
    with g.at(5.0, -0.15):
        F.counter_run(g, P, 11.0, depth=0.6, h=0.92, top='stone', front='wood', kind='cafe-bar')
    g.box_b(P['tile'], 5.0, 16.0, 0.92, 2.2, -0.17, -0.15, bevel=0)
    for yy in (1.45, 1.95):
        g.box_b(P['wood'], 5.3, 15.7, yy, yy + 0.04, -0.47, -0.15, bevel=0.004, segs=2)
        for k in range(36):
            if rng.random() < 0.7:
                g.cyl(P['gloss'], 0.045, rng.uniform(0.09, 0.2), (5.5 + k * 0.28, yy + 0.04, -0.31), segs=10,
                      color=rng.choice(('#f4f1ea', '#2b2b2b', t['accent'], '#81b29a', '#f2cc8f')))
    with g.at(16.0, -2.4, math.pi):
        F.counter_run(g, P, 11.0, depth=0.7, h=1.05, top='stone', front='wood', kind='cafe-bar')
    # pastry case + espresso machines on the front counter
    with g.in_group('glass'):
        g.box_b(P['glass'], 6.0, 8.6, 1.05, 1.45, -2.25, -1.85, bevel=0)
    g.box_b(P['white'], 6.0, 8.6, 1.05, 1.07, -2.25, -1.85, bevel=0)
    for k in range(9):
        g.cyl(P['gloss'], 0.07, 0.05, (6.25 + k * 0.27, 1.07, -2.05), segs=10, color=('#c68b59', '#e9c46a', '#8d5524')[k % 3])
    F.coffee_machine(g, P, (11.0, 1.05, -1.95))
    F.coffee_machine(g, P, (11.6, 1.05, -1.95))
    F.coffee_machine(g, P, (12.2, 1.05, -1.95))
    for x in (9.4, 13.8):
        F.pot_plant(g, P, (x, 1.05, -2.05), 0.08, 0.14, 'bush', rng)
    g.collider(5.0, 16.0, -3.15, -0.15, 0, 1.05)
    for x in (6.5, 10.5, 14.5):
        F.dome_pendant(g, P, (x, H, -2.0), drop=4.4, color=t['accent'], kelvin=2700, power=45, r=0.32)
    # LED stats wall (runtime CanvasTexture), framed, above the bar
    g.furn('led-wall', 12.2, 0.1, x=10.5, z=-0.2, yaw=math.pi)
    g.box_b(P['metal'], 4.4, 16.6, 2.5, 6.7, -0.25, -0.15, bevel=0.008, segs=2)
    d = g.dynamic('ledwall', 'screen', 'ledwall', P['screen'], pivot=(10.5, 4.6, -0.26),
                  extras={'width': 12.0, 'height': 4.0})
    with g.into(d):
        g.quad(P['screen'], 12.0, 4.0, (10.5, 4.6, -0.26), yaw=math.pi)
    # 6 tables × 4 seats
    idx = 0
    for cz in (-6.5, -11.0):
        for cx in (5.5, 10.0, 14.5):
            with g.at(cx, cz):
                F.round_table(g, P, r=0.45)
                F.pot_plant(g, P, (0.0, 0.74, 0.0), 0.04, 0.07, 'succulent', rng)
                for k in range(4):
                    phi = k * math.pi / 2 + math.pi / 4
                    sx, sz = 0.87 * math.sin(phi), 0.87 * math.cos(phi)  # root lands 0.13 m off the edge
                    with g.at(sx, sz, phi + math.pi):
                        F.cafe_chair(g, P, color=t['fabric'][k % len(t['fabric'])])
                    A.seat(f'seat:cafe:{idx}', sx, sz, phi + math.pi, pose='sit', room='cafe', approach=-0.6, hubs=[])
                    idx += 1
            g.collider(cx - 0.45, cx + 0.45, cz - 0.45, cz + 0.45, 0, 0.75)
            F.dome_pendant(g, P, (cx, H, cz), drop=4.6, color='#1e1e1e', kelvin=2700, power=40, r=0.26)
    # cafe floor: timber inlay under the seating
    g.box_b(P['wood'], 3.0, 17.0, 0.0, 0.01, -13.6, -3.6, bevel=0.002)


# ============================================================================== game area
def _game(g, A, P, t, rng):
    g.box_b(P['paint'], 23.8, 32.7, 0.0, 0.012, -21.5, -4.0, bevel=0.002, color='#2f4b6e')
    g.box_b(P['paint'], 23.8, 32.7, 0.012, 0.014, -12.85, -12.65, bevel=0, color='#f4f1ea')
    for ti, cz in enumerate((-8.5, -15.5)):
        with g.at(27.5, cz, math.pi / 2):
            F.ping_pong(g, P, top_color='#1d4e89' if ti == 0 else '#2a6f4f')
        g.collider(26.7, 28.3, cz - 1.4, cz + 1.4, 0, 0.8)
        A.spot(f'spot:pingpong:{ti}:A', 27.5, cz + 1.87, math.pi, room=f'pingpong-{ti}', approach=-0.6, hubs=[])
        A.spot(f'spot:pingpong:{ti}:B', 27.5, cz - 1.87, 0.0, room=f'pingpong-{ti}', approach=-0.6, hubs=[])
        g.light('panel', (27.5, H - 0.35, cz), size=(1.2, 3.0), power=160, kelvin=5000)
    for k, z in enumerate((-19.6, -20.5)):
        with g.at(32.4, z, -math.pi / 2):
            F.arcade(g, P, f'arcade:{k}', body='#1b1b2f', accent=t['accent'] if k == 0 else '#7F5AF0')
    g.collider(32.0, 32.85, -20.9, -19.2, 0, 1.9)
    for z in (-17.8, -18.8):
        with g.at(31.8, z):
            F.bean_bag(g, P, rng.choice(t['fabric']))
    F.pot_plant(g, P, (32.2, 0, -4.8), 0.3, 0.55, 'tree', rng, pot_color=t['pot'])
    F.pot_plant(g, P, (24.2, 0, -21.6), 0.3, 0.55, 'tree', rng, pot_color=t['pot'])


# ============================================================================== central plaza
def _murals(g, A, P, t, rng):
    cols = t['felt'] + [t['fabric'][2], '#2f2f2f']
    with g.at(-4.0, -0.16, math.pi, y=1.2):  # back wall between the elevator core and the street portal
        F.mural(g, P, 8.0, 4.6, rng, cols)
    with g.at(32.84, -17.5, -math.pi / 2, y=1.6):  # game-area wall
        F.mural(g, P, 11.0, 4.2, rng, [t['felt'][1], t['felt'][2], '#E07A5F', '#81B29A', '#2f2f2f'])
    # game-area bleachers against the back wall
    with g.at(32.4, -2.85, math.pi):
        F.bleachers(g, P, 7.6, steps=3, rise=0.42, run=0.9, rng=rng)
    g.collider(24.8, 32.4, -2.85, -0.15, 0, 1.3)


def _plaza(g, A, P, t, rng):
    for (x, z, r, th) in ((-6.5, -14.5, 1.5, 4.6), (2.0, -19.5, 1.3, 4.0), (20.5, -17.5, 1.3, 4.2)):
        with g.at(x, z):
            F.round_planter(g, P, rng, r=r, tree_h=th)
        g.collider(x - r - 0.5, x + r + 0.5, z - r - 0.5, z + r + 0.5, 0, 0.6)
    for x in (-6.0, 0.0):
        F.ring_pendant(g, P, (x, 5.2, -9.5), R=1.3, kelvin=3000, power=300, y_ceiling=H)


# ============================================================================== navigation
def _nav(g, A):
    n = A.node
    n('a:street', 0, 0, 1.6)
    n('a:portal', 0, -2.2, 1.6)
    n('a:hub', 0, -5.2, 1.6)
    n('a:lobby_e', -13.0, -5.6, 1.2)
    n('a:lobby_c', -18.5, -5.6, 1.2)
    n('a:lobby_w', -22.8, -5.6, 1.0)
    n('a:west', -11.0, -10.0, 1.2)
    n('a:center', -1.5, -11.0, 1.4)
    n('a:south', -3.2, -21.0, 1.2)
    n('a:lounge', -11.8, -16.5, 1.0)
    A.chain('a:street', 'a:portal', 'a:hub', 'a:lobby_e', 'a:lobby_c', 'a:lobby_w')
    A.chain('a:hub', 'a:center', 'a:west', 'a:lobby_e')
    A.chain('a:center', 'a:south', 'a:lounge', 'a:west')
    # cafe grid
    rows = (-4.0, -8.75, -13.25)
    cols = (3.25, 7.75, 12.25, 16.75)
    for r, z in enumerate(rows):
        for c, x in enumerate(cols):
            n(f'a:c{r}{c}', x, z, 0.8)
            if c:
                A.edge(f'a:c{r}{c - 1}', f'a:c{r}{c}')
            if r:
                A.edge(f'a:c{r - 1}{c}', f'a:c{r}{c}')
    A.edge('a:hub', 'a:c00')
    A.edge('a:center', 'a:c20')
    A.edge('a:center', 'a:c10')
    A.edge('a:south', 'a:c20')
    # game area corridor
    n('a:g1', 24.6, -5.0, 0.9)
    n('a:g2', 24.6, -12.0, 0.9)
    n('a:g3', 24.6, -18.8, 0.9)
    A.chain('a:g1', 'a:g2', 'a:g3')
    A.edge('a:c03', 'a:g1')
    A.edge('a:c13', 'a:g2')
    A.edge('a:c23', 'a:g2')
    # anchors → hubs
    for aid, a in A.anchors.items():
        ap = f'ap:{aid}'
        ax, az = a['approach']['x'], a['approach']['z']
        if aid.startswith('spot:elevator') or aid.startswith('spot:reception'):
            A.edge(ap, _nearest(A, ax, az, ('a:lobby_e', 'a:lobby_c', 'a:lobby_w')))
        elif aid.startswith('seat:cafe'):
            for hub in _nearest_k(A, ax, az, [k for k in A.nodes if k.startswith('a:c')], 2):
                A.edge(ap, hub)
        elif aid.startswith('spot:pingpong'):
            A.edge(ap, _nearest(A, ax, az, ('a:g1', 'a:g2', 'a:g3')))


def _rooms(g):
    """Floor-plan rooms (contract §11); ids match the anchors' extras.room. They tile the atrium."""
    r = g.room
    r('elevator', 'Elevators', -33, -4.8, -11, 0, floor='tile')
    r('reception', 'Reception', -33, -13.4, -11, -4.8, floor='tile')
    r('waiting', 'Waiting lounge', -33, -24, -11, -13.4, floor='tile')
    r('plaza', 'Plaza', -11, -24, 3, 0, floor='tile')
    r('cafe', 'Cafe', 3, -14, 23.5, 0, floor='wood')
    r('court', 'Courtyard', 3, -24, 23.5, -14, floor='tile')
    r('pingpong-0', 'Game area', 23.5, -12.75, 33, 0, floor='concrete')
    r('pingpong-1', 'Game area', 23.5, -24, 33, -12.75, floor='concrete')


def _nearest(A, x, z, ids):
    return min(ids, key=lambda k: math.hypot(A.nodes[k]['x'] - x, A.nodes[k]['z'] - z))


def _nearest_k(A, x, z, ids, k):
    return sorted(ids, key=lambda i: math.hypot(A.nodes[i]['x'] - x, A.nodes[i]['z'] - z))[:k]
