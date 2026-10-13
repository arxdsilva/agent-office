"""Night City props (original, built from primitives). Authored around their own origin facing +z, placed
with `g.at(x, z, yaw)`, like the classic furniture kit. Each piece records its floor-plan footprint
(`g.furn`, contract §11) and, when it blocks walking, a collider.

Storytelling details (art direction): cameras, card readers, conduits, vents, equipment cases, floor
markings, maintenance panels. The fictional corporation "Meridian Dynamics" appears only as a geometric
mark (a ring cut by a horizontal meridian and two chevrons); there is no text anywhere.
"""
import math

from lib import geometry as G

TAU = 2 * math.pi


# ============================================================================== brand mark
def meridian_mark(g, P, r=1.0, mat=None, depth=0.04, ring_mat=None):
    """The Meridian Dynamics mark, facing +z, centred on the local origin (x right, y up)."""
    mat = mat or P['neon_amber']
    ring_mat = ring_mat or mat
    g.torus(ring_mat, r, 0.06 * r, (0, 0, 0), segs=48, rsegs=6, pitch=math.pi / 2)
    g.box(mat, (1.7 * r, 0.07 * r, depth), (0, 0, 0), bevel=0)  # the meridian
    for s in (-1, 1):  # two chevrons, pointing up, left and right of centre
        for k in (-1, 1):
            g.box(mat, (0.46 * r, 0.09 * r, depth), (s * 0.34 * r + k * 0.15 * r, 0.32 * r, 0),
                  roll=-k * math.radians(38), bevel=0)


# ============================================================================== seating
def cyber_chair(g, P, accent='cyan'):
    """Ergonomic task chair, low poly, facing +z; seat centre at the origin."""
    g.furn('chair', 0.62, 0.62)
    for k in range(5):
        a = TAU * k / 5
        g.box(P['graphite'], (0.05, 0.035, 0.32), (0.16 * math.sin(a), 0.05, 0.16 * math.cos(a)), yaw=a, bevel=0)
    g.cyl(P['brushed_dark'], 0.025, 0.36, (0, 0.06, 0), segs=8)
    g.box(P['fabric'], (0.5, 0.08, 0.48), (0, 0.45, 0.02), bevel=0.02)
    g.box(P['carbon'], (0.46, 0.6, 0.06), (0, 0.85, -0.25), pitch=-0.12, bevel=0.015)
    g.box(P[f'glow_{accent}'], (0.3, 0.015, 0.012), (0, 1.12, -0.29), pitch=-0.12, bevel=0)
    for s in (-1, 1):
        g.box(P['graphite'], (0.04, 0.2, 0.04), (s * 0.27, 0.56, 0.0), bevel=0)
        g.box(P['rubber'], (0.06, 0.03, 0.26), (s * 0.27, 0.67, 0.02), bevel=0)


def angular_sofa(g, P, length=2.6, accent='amber', back=True):
    """Low faceted lounge sofa with an amber under-glow, facing +z (seat front at z ≈ +0.45)."""
    g.furn('sofa', length, 0.95)
    h = length / 2
    base = [(-h, -0.45), (h, -0.45), (h - 0.12, 0.45), (-h + 0.12, 0.45)]
    g.prism(P['graphite'], base, 0.06, 0.3)
    g.prism(P['leather'], [(-h + 0.05, -0.3), (h - 0.05, -0.3), (h - 0.16, 0.44), (-h + 0.16, 0.44)], 0.3, 0.42,
            bevel=0.02)
    if back:
        g.box(P['leather'], (length - 0.1, 0.42, 0.18), (0, 0.6, -0.38), pitch=-0.25, bevel=0.03)
    for s in (-1, 1):
        g.prism(P['carbon'], [(s * h, -0.45), (s * (h - 0.16), -0.45), (s * (h - 0.24), 0.4), (s * h - s * 0.1, 0.4)],
                0.3, 0.58)
    g.box(P[f'neon_{accent}'], (length - 0.3, 0.012, 0.02), (0, 0.05, 0.43), bevel=0)
    g.box(P[f'neon_{accent}'], (length - 0.3, 0.012, 0.02), (0, 0.05, -0.43), bevel=0)


def low_table(g, P, w=1.4, d=0.7):
    g.furn('cafe-table', w, d)
    g.prism(P['stone'], [(-w / 2, -d / 2 + 0.1), (w / 2 - 0.1, -d / 2), (w / 2, d / 2 - 0.1), (-w / 2 + 0.1, d / 2)],
            0.3, 0.36, bevel=0.01)
    g.box(P['brushed_dark'], (w * 0.6, 0.3, 0.08), (0, 0.15, 0), bevel=0)


# ============================================================================== workstations
def monitor_cluster(g, P, ref, n=2, z=-0.25, width=0.62, height=0.36, curve=0.32):
    """`n` monitors on one boom, facing −z (towards a person at negative z); one runtime screen node."""
    g.cyl(P['brushed_dark'], 0.03, 0.45, (0, 0.74, z), segs=8)
    g.box(P['brushed_dark'], (0.16, 0.012, 0.12), (0, 0.746, z), bevel=0)
    xs = [(i - (n - 1) / 2) * (width + 0.02) for i in range(n)]
    yaws = [math.pi + (-curve if x < -0.01 else curve if x > 0.01 else 0) for x in xs]
    for x, yw in zip(xs, yaws):
        g.box(P['black'], (width + 0.03, height + 0.03, 0.025), (x, 1.12, z + 0.015), yaw=yw, bevel=0)
    d = g.dynamic(f'ws-{ref.replace(":", "-")}', 'screen', ref, P['screen'], pivot=(0, 1.12, z - 0.005),
                  extras={'width': round(n * width, 3), 'height': height, 'count': n})
    with g.into(d):
        for x, yw in zip(xs, yaws):
            g.quad(P['screen'], width, height, (x, 1.12, z - 0.005), yaw=yw)
    return d


def workstation_pod(g, A, P, dept, pod, accent, rng, room, hubs=None):
    """Four seats around a carbon spine (two face +z on the south side, two face −z on the north side).
    Anchors ws:<dept>:<pod>:<seat> (sit, the root rule of contract §4) with their screen refs."""
    W, D = 2.8, 1.44  # desk block footprint (two desks per side)
    g.furn('desk', W, D)
    g.collider(-W / 2, W / 2, -D / 2, D / 2, 0, 1.3)
    # spine: a carbon divider with a cable tray and a light line, and two legs per side
    g.box(P['carbon'], (W, 0.5, 0.05), (0, 0.99, 0), bevel=0.005)
    g.box(P[f'neon_{accent}'], (W - 0.1, 0.012, 0.02), (0, 1.245, 0), bevel=0)
    g.box(P['steel_plate'], (W - 0.2, 0.06, 0.18), (0, 0.62, 0), bevel=0)  # under-desk cable tray
    seat = 0
    for side, sgn in (('S', -1), ('N', 1)):
        g.box(P['carbon'], (W, 0.035, 0.7), (0, 0.725, sgn * 0.36), bevel=0.006)
        g.box(P[f'glow_{accent}'], (W - 0.08, 0.008, 0.01), (0, 0.705, sgn * 0.71), bevel=0)
        for lx in (-W / 2 + 0.06, 0, W / 2 - 0.06):
            g.box(P['brushed_dark'], (0.05, 0.7, 0.6), (lx, 0.35, sgn * 0.38), bevel=0)
        for i, x in enumerate((-0.7, 0.7)):
            ref = f'ws:{dept}:{pod}:{seat}'
            yaw = 0.0 if sgn < 0 else math.pi
            with g.at(x, 0, yaw):
                monitor_cluster(g, P, ref, n=2 if (dept + pod + seat) % 3 else 3, width=0.42 if (dept + pod + seat) % 3 == 0 else 0.56)
                g.box(P['black'], (0.44, 0.02, 0.15), (0, 0.752, -0.52), bevel=0)  # keyboard
                g.box(P['black'], (0.07, 0.02, 0.1), (0.32, 0.752, -0.52), bevel=0)
                if rng.random() < 0.4:
                    g.cyl(P['paint'], 0.04, 0.1, (-0.42, 0.743, -0.45), segs=8, color=rng.choice(('#d7ff3a', '#e0202e', '#d8dde3')))
                if rng.random() < 0.25:  # a small equipment case on the desk
                    g.box(P['steel_plate'], (0.3, 0.1, 0.2), (0.45, 0.79, -0.25), bevel=0.01)
                with g.at(0, -1.12):
                    cyber_chair(g, P, accent)
            A.seat(ref, x, sgn * 1.12, 0.0 if sgn < 0 else math.pi, pose='sit', room=room, approach=-0.6,
                   hubs=hubs, screen=ref)
            seat += 1


# ============================================================================== atrium kit
def elevator_bank(g, P, n=4, pitch=3.6, door_w=1.3, door_h=2.7, depth=3.2, H=6.0, accent='cyan'):
    """Elevator core, doors on its +z face (z = 0). Door leaves are runtime nodes (elevatorDoor `<i>:L|R`)."""
    W = n * pitch + 1.0
    g.furn('elevator', W, depth, z=-depth / 2)
    g.box_b(P['concrete'], -W / 2, W / 2, 0, H, -depth, -0.3, bevel=0.01)
    for i in range(n):
        x = (i - (n - 1) / 2) * pitch
        # dark stone cladding with a recessed portal and light seams
        g.box_b(P['stone'], x - pitch / 2, x - door_w / 2 - 0.25, 0, H - 0.3, -0.3, 0.0, bevel=0.004)
        g.box_b(P['stone'], x + door_w / 2 + 0.25, x + pitch / 2, 0, H - 0.3, -0.3, 0.0, bevel=0.004)
        g.box_b(P['stone'], x - door_w / 2 - 0.25, x + door_w / 2 + 0.25, door_h + 0.35, H - 0.3, -0.3, 0.0, bevel=0.004)
        for s in (-1, 1):
            g.box_b(P['brushed'], x + s * (door_w / 2 + 0.25) - 0.25 * (s > 0), x + s * (door_w / 2) + 0.0 * s,
                    0, door_h + 0.35, -0.32, 0.02, bevel=0.003)
            g.box(P[f'neon_{accent}'], (0.025, door_h + 0.3, 0.012), (x + s * (door_w / 2 + 0.27), (door_h + 0.3) / 2, 0.015), bevel=0)
        g.box_b(P['brushed'], x - door_w / 2, x + door_w / 2, door_h, door_h + 0.35, -0.32, 0.02, bevel=0.003)
        g.box(P[f'neon_{accent}'], (door_w + 0.5, 0.025, 0.012), (x, door_h + 0.37, 0.015), bevel=0)
        # floor indicator (dark glass with a lit chevron) and the call panel with a card reader
        g.box(P['black'], (0.5, 0.14, 0.012), (x, door_h + 0.6, 0.006), bevel=0)
        g.box(P['glow_amber'], (0.12, 0.03, 0.004), (x - 0.05, door_h + 0.62, 0.014), roll=0.6, bevel=0)
        g.box(P['glow_amber'], (0.12, 0.03, 0.004), (x + 0.05, door_h + 0.62, 0.014), roll=-0.6, bevel=0)
        card_reader(g, P, (x + door_w / 2 + 0.5, 1.15, 0.01))
        # car interior (visible when open)
        g.box_b(P['brushed_dark'], x - door_w / 2 - 0.35, x + door_w / 2 + 0.35, 0, door_h + 0.1, -2.1, -2.05, bevel=0)
        g.box_b(P['grate'], x - door_w / 2 - 0.35, x + door_w / 2 + 0.35, 0.0, 0.02, -2.1, -0.3, bevel=0)
        g.box_b(P['light_cool'], x - door_w / 2, x + door_w / 2, door_h + 0.05, door_h + 0.06, -1.9, -0.5, bevel=0)
        for s in (-1, 1):
            g.box_b(P['brushed_dark'], x + s * (door_w / 2 + 0.35) - 0.05 * (s > 0), x + s * (door_w / 2 + 0.35) + 0.05 * (s < 0),
                    0, door_h + 0.1, -2.1, -0.3, bevel=0)
        g.light('panel', (x, door_h + 0.03, -1.2), size=(door_w, 1.2), power=30, kelvin=7500)
        for sx in (-1, 1):
            cx = x + sx * door_w / 4
            side = 'L' if g.world(cx, 0, 0)[0] < g.world(x, 0, 0)[0] else 'R'
            d = g.dynamic(f'elevator-door-{i}-{side}', 'elevatorDoor', f'{i}:{side}', P['door'],
                          pivot=(cx, door_h / 2, -0.14))
            with g.into(d):
                g.box(P['door'], (door_w / 2 - 0.004, door_h, 0.03), (cx, door_h / 2, -0.14), bevel=0.002)
    # brand mark above the bank
    with g.at(0, 0.02, 0, y=H - 1.1):
        meridian_mark(g, P, r=0.55, mat=P['neon_amber'], ring_mat=P['neon_cyan'])


def card_reader(g, P, pos):
    x, y, z = pos
    g.box(P['graphite'], (0.08, 0.14, 0.03), (x, y, z), bevel=0.004)
    g.box(P['glow_cyan'], (0.05, 0.012, 0.004), (x, y + 0.045, z + 0.016), bevel=0)
    g.box(P['black'], (0.06, 0.05, 0.004), (x, y - 0.02, z + 0.016), bevel=0)


def security_camera(g, P, pos, yaw=0.0, pitch=-0.5):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['graphite'], (0.1, 0.06, 0.1), (0, 0.04, 0), bevel=0)
        g.box(P['charcoal'], (0.11, 0.1, 0.24), (0, -0.05, 0.12), pitch=pitch, bevel=0.01)
        g.cyl(P['black'], 0.035, 0.02, (0, -0.1, 0.24), pitch=math.pi / 2 + pitch, segs=10)
        g.box(P['neon_red'], (0.012, 0.012, 0.01), (0.04, -0.02, 0.22), bevel=0)


def security_gate(g, P, x0, x1, n, z):
    """A row of n turnstile lanes between pedestals (glass flaps). Returns lane centres (x)."""
    g.furn('console', x1 - x0, 0.9, x=(x0 + x1) / 2, z=z)
    lane = (x1 - x0) / n
    centres = []
    for i in range(n + 1):
        x = x0 + i * lane
        g.box(P['brushed_dark'], (0.22, 1.02, 0.9), (x, 0.51, z), bevel=0.02)
        g.box(P['black'], (0.18, 0.02, 0.5), (x, 1.03, z), bevel=0)
        for sx in (-1, 1):  # thin light lines on the lane sides (top edge and the leading edge)
            g.box(P['neon_cyan'], (0.012, 0.02, 0.86), (x + sx * 0.112, 0.98, z), bevel=0)
            g.box(P['neon_cyan'], (0.012, 0.9, 0.02), (x + sx * 0.112, 0.5, z + 0.43), bevel=0)
        g.box(P['glow_acid'], (0.08, 0.012, 0.08), (x, 1.04, z - 0.3), bevel=0)  # reader pad
        g.collider(x - 0.11, x + 0.11, z - 0.45, z + 0.45, 0, 1.05)
        if i < n:
            centres.append(x + lane / 2)
            with g.in_group('glass'):
                for s in (-1, 1):
                    g.box(P['frosted'], (lane / 2 - 0.2, 0.55, 0.012), (x + lane / 2 + s * (lane / 4 - 0.02), 0.85, z), bevel=0)
    return centres


def reception_counter(g, P, w=6.0, accent='amber'):
    """Angular reception counter: a faceted polished-stone front, staff side at −z, visitors at +z."""
    g.furn('reception-desk', w, 1.2)
    h = w / 2
    g.prism(P['stone'], [(-h, -0.5), (h, -0.5), (h - 0.3, 0.55), (-h + 0.3, 0.55)], 0.0, 1.08, bevel=0.01)
    g.prism(P['carbon'], [(-h - 0.05, -0.55), (h + 0.05, -0.55), (h - 0.25, 0.6), (-h + 0.25, 0.6)], 1.08, 1.13)
    g.box(P[f'neon_{accent}'], (w - 0.7, 0.02, 0.02), (0, 0.08, 0.6), bevel=0)
    g.box(P[f'neon_{accent}'], (w - 0.7, 0.02, 0.02), (0, 1.0, 0.57), bevel=0)
    for x in (-1.6, 0.0, 1.6):  # staff monitors (static)
        g.box(P['black'], (0.6, 0.38, 0.03), (x, 1.36, -0.25), pitch=-0.15, bevel=0)
        g.box(P['glow_cyan'], (0.56, 0.34, 0.004), (x, 1.36, -0.233), pitch=-0.15, bevel=0)
    g.collider(-h, h, -0.55, 0.6, 0, 1.15)


def bonsai(g, P, rng, h=2.6, spread=1.6, seed_pads=7):
    """A stylised bonsai: a twisting trunk of tapered segments and cloud pads of leaves (vertex colour)."""
    pts = [(0.0, 0.0, 0.0)]
    x = z = 0.0
    for k in range(5):
        x += rng.uniform(-0.18, 0.18)
        z += rng.uniform(-0.12, 0.12)
        pts.append((x, h * 0.55 * (k + 1) / 5, z))
    for a, b in zip(pts, pts[1:]):
        r0 = 0.16 * (1 - a[1] / h) + 0.04
        r1 = 0.16 * (1 - b[1] / h) + 0.035
        L = math.dist(a, b)
        dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        pitch = math.atan2(math.hypot(dx, dz), dy)
        yaw = math.atan2(dx, dz)
        g.cyl(P['wood'], r0, L + 0.03, a, segs=9, r2=r1, yaw=yaw, pitch=pitch)
    top = pts[-1]
    greens = ('#2f5a3a', '#3d6b3f', '#4a7a44', '#2a4a33')
    for k in range(seed_pads):
        a = TAU * k / seed_pads + rng.uniform(-0.3, 0.3)
        rr = spread * rng.uniform(0.3, 0.55)
        y = h * rng.uniform(0.55, 0.95)
        c = (top[0] + rr * math.cos(a), y, top[2] + rr * math.sin(a))
        # branch to the pad
        dx, dy, dz = c[0] - top[0], c[1] - top[1] * 0.92, c[2] - top[2]
        L = math.sqrt(dx * dx + dy * dy + dz * dz)
        g.cyl(P['wood'], 0.04, L, (top[0], top[1] * 0.92, top[2]), segs=6, r2=0.02, yaw=math.atan2(dx, dz),
              pitch=math.atan2(math.hypot(dx, dz), dy))
        for j in range(7):  # a cloud pad: a domed cluster of small leaf puffs
            a2, r2 = rng.uniform(0, TAU), rng.uniform(0, 0.28)
            sz = rng.uniform(0.12, 0.2)
            g.sphere(P['leaf'], 1.0, (c[0] + r2 * math.cos(a2), c[1] + rng.uniform(0.0, 0.1) * (1 - r2 / 0.3),
                                      c[2] + r2 * math.sin(a2)), segs=7, rings=4,
                     scale=(sz * 1.3, sz * 0.7, sz * 1.2), color=rng.choice(greens))
    g.sphere(P['leaf'], 1.0, (top[0], h * 1.0, top[2]), segs=8, rings=5, scale=(0.5, 0.16, 0.42), color=greens[1])


def bonsai_planter(g, A, P, rng, r=1.5, h=0.62, tree_h=2.8):
    """Raised hexagonal planter with gravel, a bonsai and amber uplights (two point lights)."""
    g.furn('planter', 2 * r, 2 * r)
    hexa = [(r * math.cos(TAU * k / 6 + math.pi / 6), r * math.sin(TAU * k / 6 + math.pi / 6)) for k in range(6)]
    inner = [(0.9 * x, 0.9 * z) for x, z in hexa]
    g.prism(P['stone'], hexa, 0.0, h, bevel=0.01)
    g.prism(P['soil'], inner, h - 0.06, h - 0.02, bottom=False)
    for k in range(6):  # amber light ring under the lip
        a0, a1 = hexa[k], hexa[(k + 1) % 6]
        mx, mz = (a0[0] + a1[0]) / 2 * 1.005, (a0[1] + a1[1]) / 2 * 1.005
        L = math.dist(a0, a1)
        g.box(P['neon_amber'], (L * 0.9, 0.018, 0.02), (mx, 0.05, mz), yaw=math.atan2(a1[0] - a0[0], a1[1] - a0[1]) - math.pi / 2, bevel=0)
    for k in range(5):  # stones
        a = rng.uniform(0, TAU)
        rr = rng.uniform(0.3, 0.9) * r * 0.8
        g.sphere(P['stone'], 1.0, (rr * math.cos(a), h - 0.03, rr * math.sin(a)), segs=7, rings=4,
                 scale=(rng.uniform(0.08, 0.18), rng.uniform(0.05, 0.1), rng.uniform(0.08, 0.16)))
    with g.at(0, 0, 0, y=h - 0.04):
        bonsai(g, P, rng, h=tree_h, spread=tree_h * 0.62)
    for a in (0.6, 0.6 + math.pi):  # uplight fixtures in the gravel
        x, z = 0.55 * math.cos(a), 0.55 * math.sin(a)
        g.cyl(P['brushed_dark'], 0.06, 0.08, (x, h - 0.04, z), segs=10)
        g.cyl(P['neon_amber'], 0.045, 0.005, (x, h + 0.04, z), segs=10)
        g.light('point', (x, h + 0.25, z), radius=0.05, power=60, color=(1.0, 0.62, 0.22))
    g.collider(-r, r, -r, r, 0, h)


def holo_pedestal(g, A, P, ref, aid, room, w=1.1, h=0.62, approach=0.9, hubs=None):
    """Interaction console: an angled pedestal with a holo panel (role holo `ref`) above, facing +z.
    The visitor anchor stands `approach` m in front, facing the console."""
    g.furn('kiosk', 1.3, 0.9)
    g.prism(P['brushed_dark'], [(-0.45, -0.35), (0.45, -0.35), (0.35, 0.3), (-0.35, 0.3)], 0.0, 1.0, bevel=0.01)
    g.box(P['black'], (0.8, 0.03, 0.45), (0, 1.02, 0.0), pitch=0.35, bevel=0.004)
    g.box(P['neon_cyan'], (0.82, 0.015, 0.02), (0, 0.04, 0.32), bevel=0)
    g.cyl(P['neon_cyan'], 0.32, 0.01, (0, 1.0, -0.05), segs=24)
    d = g.dynamic(f'holo-{ref.replace(":", "-")}', 'holo', ref, P['holo'], pivot=(0, 1.75, -0.05),
                  extras={'width': w, 'height': h})
    with g.into(d):
        g.quad(P['holo'], w, h, (0, 1.75, -0.05))
        g.quad(P['holo'], w, h, (0, 1.75, -0.052), yaw=math.pi)
    g.collider(-0.48, 0.48, -0.38, 0.33, 0, 1.1)
    if aid:
        A.spot(aid, 0, approach, math.pi, room=room, approach=-0.6, hubs=hubs)


def provider_terminal(g, A, P, i, room, accent, hubs=None):
    """A tall wall terminal (screen `provider:<i>`), facing +z; visitor anchor interact:provider-terminal:<i>."""
    g.furn('station', 1.1, 0.5)
    g.box(P['steel_plate'], (1.0, 2.4, 0.3), (0, 1.2, -0.1), bevel=0.01)
    g.box(P['black'], (0.86, 1.3, 0.02), (0, 1.5, 0.055), bevel=0)
    g.box(P[f'neon_{accent}'], (0.9, 0.015, 0.02), (0, 2.25, 0.06), bevel=0)
    g.box(P['graphite'], (0.7, 0.05, 0.3), (0, 0.95, 0.15), pitch=0.3, bevel=0.01)
    for k in range(4):
        g.box(P[f'glow_{accent}' if k % 2 else 'glow_cyan'], (0.1, 0.01, 0.06), (-0.24 + k * 0.16, 0.985, 0.17), pitch=0.3, bevel=0)
    d = g.dynamic(f'provider-{i}', 'screen', f'provider:{i}', P['screen'], pivot=(0, 1.5, 0.068),
                  extras={'width': 0.82, 'height': 1.26})
    with g.into(d):
        g.quad(P['screen'], 0.82, 1.26, (0, 1.5, 0.068))
    g.collider(-0.5, 0.5, -0.25, 0.3, 0, 2.4)
    A.spot(f'interact:provider-terminal:{i}', 0, 0.85, math.pi, room=room, approach=-0.6, hubs=hubs)


def comm_booth(g, A, P, n, room, hubs=None):
    """A secure comm booth (1.6 × 1.6 m, frosted glass, door at +z), its indicator ring (led `booth:<n>`)
    and the waiting-agent anchor booth:<n> facing the booth's back wall terminal."""
    g.furn('booth', 1.7, 1.7)
    s = 0.8
    g.box_b(P['steel_plate'], -s, s, 0, 0.06, -s, s, bevel=0)
    g.box_b(P['steel_plate'], -s, s, 2.45, 2.55, -s, s, bevel=0.005)
    for x in (-s, s):
        g.box_b(P['brushed_dark'], x - 0.04, x + 0.04, 0, 2.5, -s, s, bevel=0)
    g.box_b(P['carbon'], -s, s, 0, 2.5, -s - 0.04, -s + 0.04, bevel=0)
    with g.in_group('glass'):
        for x in (-s, s):
            g.box(P['frosted'], (0.012, 2.3, 2 * s - 0.1), (x, 1.25, 0), bevel=0)
        g.box(P['frosted'], (0.5, 2.3, 0.012), (-s + 0.3, 1.25, s), bevel=0)
    g.box(P['black'], (0.7, 0.45, 0.02), (0, 1.5, -s + 0.05), bevel=0)  # wall terminal
    g.box(P['glow_cyan'], (0.66, 0.41, 0.004), (0, 1.5, -s + 0.062), bevel=0)
    g.box(P['graphite'], (0.6, 0.04, 0.3), (0, 1.0, -s + 0.2), bevel=0)
    d = g.dynamic(f'booth-led-{n}', 'led', f'booth:{n}', P['led'], pivot=(0, 2.56, 0))
    with g.into(d):
        g.torus(P['led'], 0.45, 0.02, (0, 2.57, 0), segs=28, rsegs=4)
    g.light('panel', (0, 2.4, 0), size=(1.0, 1.0), power=14, kelvin=8000)
    g.collider(-s - 0.05, -s + 0.05, -s, s, 0, 2.5)
    g.collider(s - 0.05, s + 0.05, -s, s, 0, 2.5)
    g.collider(-s, s, -s - 0.05, -s + 0.1, 0, 2.5)
    A.spot(f'booth:{n}', 0.15, -0.05, math.pi, room=room, approach=(0.15, s + 0.55), hubs=hubs, led=f'booth:{n}')


def server_rack(g, P, rng, h=2.1, accent='cyan'):
    """A 0.6 × 1.0 m rack facing +z, perforated door with blinking status lights (static emissive)."""
    g.furn('core-rack', 0.62, 1.0)
    g.box(P['charcoal'], (0.6, h, 1.0), (0, h / 2, 0), bevel=0.008)
    g.box(P['grate'], (0.52, h - 0.2, 0.02), (0, h / 2, 0.505), bevel=0)
    for k in range(int((h - 0.3) / 0.09)):
        y = 0.2 + k * 0.09
        if rng.random() < 0.7:
            g.box(P['black'], (0.48, 0.07, 0.01), (0, y, 0.518), bevel=0)
            for j in range(rng.randint(1, 4)):
                c = rng.choice((f'neon_{accent}', 'neon_acid', 'neon_cyan', 'neon_red' if rng.random() < 0.1 else 'neon_cyan'))
                g.box(P[c], (0.012, 0.012, 0.004), (-0.2 + j * 0.03, y, 0.525), bevel=0)
    g.box(P[f'neon_{accent}'], (0.012, h - 0.1, 0.012), (-0.29, h / 2, 0.51), bevel=0)


def cable_tray(g, P, x0, x1, y, z, w=0.4):
    g.box_b(P['grate'], x0, x1, y, y + 0.012, z - w / 2, z + w / 2, bevel=0)
    for s in (-1, 1):
        g.box_b(P['brushed_dark'], x0, x1, y, y + 0.08, z + s * w / 2 - 0.01, z + s * w / 2 + 0.01, bevel=0)
    rng_cols = ('#16181b', '#1e2a35', '#2a1a1a')
    for k in range(4):
        g.box_b(P['paint'], x0, x1, y + 0.012, y + 0.04 + 0.01 * (k % 2), z - w / 2 + 0.06 + k * 0.08,
                z - w / 2 + 0.11 + k * 0.08, bevel=0, color=rng_cols[k % 3])
    n = max(1, int((x1 - x0) / 1.8))
    for i in range(n + 1):  # hangers
        x = x0 + (x1 - x0) * i / n
        g.box(P['brushed_dark'], (0.02, 0.6, 0.02), (x, y + 0.36, z), bevel=0)


def vent(g, P, pos, w=1.2, h=0.4, yaw=0.0):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['graphite'], (w, h, 0.04), (0, 0, 0), bevel=0.005)
        for k in range(int(h / 0.05)):
            g.box(P['charcoal'], (w - 0.06, 0.015, 0.03), (0, -h / 2 + 0.04 + k * 0.05, 0.02), pitch=0.5, bevel=0)


def maintenance_panel(g, P, pos, yaw=0.0):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['steel_plate'], (0.7, 1.0, 0.05), (0, 0, 0), bevel=0.006)
        g.box(P['hazard'], (0.7, 0.08, 0.052), (0, 0.46, 0), bevel=0)
        g.box(P['graphite'], (0.08, 0.16, 0.03), (0.26, 0, 0.03), bevel=0)
        g.box(P['glow_red'], (0.02, 0.02, 0.01), (0.26, 0.1, 0.045), bevel=0)


def conduit(g, P, a, b, r=0.035, mat=None):
    """Straight pipe from a to b (local 3D)."""
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    g.cyl(mat or P['brushed_dark'], r, L, a, segs=8, yaw=math.atan2(dx, dz), pitch=math.atan2(math.hypot(dx, dz), dy),
          caps=False)


def equipment_case(g, P, pos, yaw=0.0, color='#1e2a35'):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['paint'], (0.7, 0.32, 0.45), (0, 0.16, 0), bevel=0.02, color=color)
        g.box(P['brushed'], (0.72, 0.03, 0.47), (0, 0.18, 0), bevel=0)
        g.box(P['hazard'], (0.2, 0.06, 0.004), (0.18, 0.16, 0.227), bevel=0)


def floor_strip(g, P, a, b, mat, w=0.06):
    """A light strip inlaid in the floor from a to b (local XZ)."""
    L = math.dist(a, b)
    yaw = math.atan2(b[0] - a[0], b[1] - a[1])
    g.box(mat, (w, 0.006, L), ((a[0] + b[0]) / 2, 0.003, (a[1] + b[1]) / 2), yaw=yaw, bevel=0)


def chevrons(g, P, x, z, yaw, n=3, mat=None, s=0.35):
    """Floor-marking chevrons pointing along yaw (+z of the frame)."""
    mat = mat or P['glow_acid']
    with g.at(x, z, yaw):
        for k in range(n):
            for sx in (-1, 1):
                g.box(mat, (0.06, 0.005, s), (sx * s * 0.32, 0.003, k * 0.5), yaw=sx * 0.7, bevel=0)


def wall_frame(g, mat, x0, x1, y0, y1, z, t=0.06):
    g.box_b(mat, x0, x1, y0, y0 + t, z - t / 2, z + t / 2, bevel=0)
    g.box_b(mat, x0, x1, y1 - t, y1, z - t / 2, z + t / 2, bevel=0)
    g.box_b(mat, x0, x0 + t, y0, y1, z - t / 2, z + t / 2, bevel=0)
    g.box_b(mat, x1 - t, x1, y0, y1, z - t / 2, z + t / 2, bevel=0)


def stair(g, P, x0, x1, z_bottom, z_top, y_top, n=None, mat=None, side_mat=None):
    """A straight stair (local), rising from (z_bottom, y=0) to (z_top, y_top) between x0 and x1."""
    n = n or max(2, round(y_top / 0.175))
    mat, side_mat = mat or P['grate'], side_mat or P['steel_plate']
    run = (z_top - z_bottom) / n
    rise = y_top / n
    for i in range(n):
        za, zb = z_bottom + i * run, z_bottom + (i + 1) * run
        g.box_b(mat, x0, x1, (i + 1) * rise - 0.04, (i + 1) * rise, min(za, zb), max(za, zb), bevel=0)
        g.box(P['glow_cyan'], (x1 - x0 - 0.1, 0.008, 0.02), ((x0 + x1) / 2, (i + 1) * rise + 0.004, zb - math.copysign(0.03, run)), bevel=0)
    L = math.hypot(z_top - z_bottom, y_top)
    pitch = math.atan2(y_top, z_top - z_bottom)
    for x in (x0, x1):  # stringers + handrail
        g.box(side_mat, (0.05, 0.3, L), (x, y_top / 2, (z_bottom + z_top) / 2), pitch=-pitch, bevel=0)
        g.box(P['brushed'], (0.04, 0.04, L), (x, y_top / 2 + 1.0, (z_bottom + z_top) / 2), pitch=-pitch, bevel=0)
        g.box(P['neon_cyan'], (0.012, 0.012, L), (x, y_top / 2 + 0.97, (z_bottom + z_top) / 2), pitch=-pitch, bevel=0)


def railing(g, P, a, b, y, h=1.05, glass=True):
    """Balustrade along a→b (local XZ) at height y: a steel cap rail and a glass panel."""
    L = math.dist(a, b)
    yaw = math.atan2(b[0] - a[0], b[1] - a[1])
    cx, cz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    with g.at(cx, cz, yaw, y=y):
        g.box(P['brushed'], (0.05, 0.05, L), (0, h, 0), bevel=0)
        g.box(P['neon_cyan'], (0.012, 0.012, L), (0, h - 0.04, 0), bevel=0)
        if glass:
            with g.in_group('glass'):
                g.box(P['glass'], (0.012, h - 0.1, L - 0.05), (0, h / 2, 0), bevel=0)
