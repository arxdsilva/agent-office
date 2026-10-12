"""Parametric furniture kit (plan §2.3). Everything is authored around a local origin, facing +z
(a seated person faces +z), in glTF meters; place it with `with g.at(x, z, yaw): …`.

`P` is the palette from themes.palette(); vertex-colored materials ('paint', 'gloss', 'fabric', 'felt',
'leaf') take a per-piece `color`.
"""
import math

from .geometry import arc, rounded_rect

GREENS = ['#3F6B35', '#4E7D3A', '#2F5530', '#5E8C46', '#6B9A4A', '#37613A', '#557F3F']
TAU = math.tau


# ============================================================================== seating
def task_chair(g, P, color='#2b2b2b', frame='#1b1b1b'):
    """Office task chair; the seat center (anchor) is the local origin, seat top at 0.47 m."""
    for i in range(5):
        a = TAU * i / 5 + 0.3
        dx, dz = math.sin(a), math.cos(a)
        g.box(P['paint'], (0.045, 0.03, 0.30), (dx * 0.15, 0.085, dz * 0.15), yaw=a, color=frame, bevel=0.006)
        g.cyl(P['paint'], 0.025, 0.045, (dx * 0.29, 0.0, dz * 0.29), segs=8, pitch=math.pi / 2, color='#111111')
    g.cyl(P['steel'], 0.028, 0.30, (0, 0.09, 0), segs=10)
    g.cyl(P['paint'], 0.04, 0.06, (0, 0.36, 0), segs=10, color=frame)
    g.box(P['paint'], (0.40, 0.03, 0.36), (0, 0.405, 0), color=frame, bevel=0.01)
    g.box(P['fabric'], (0.50, 0.07, 0.48), (0, 0.44, 0.0), bevel=0.025, segs=2, color=color)
    # back: frame spine + cushioned back
    g.box(P['paint'], (0.06, 0.32, 0.03), (0, 0.55, -0.25), pitch=-0.12, color=frame, bevel=0.008)
    g.box(P['fabric'], (0.46, 0.50, 0.06), (0, 0.86, -0.29), pitch=-0.14, bevel=0.025, segs=2, color=color)
    for s in (-1, 1):
        g.box(P['paint'], (0.025, 0.20, 0.025), (s * 0.25, 0.53, -0.04), color=frame, bevel=0.006)
        g.box(P['paint'], (0.06, 0.025, 0.24), (s * 0.25, 0.64, -0.02), color='#1a1a1a', bevel=0.01, segs=2)


def meeting_chair(g, P, color, frame='metal'):
    """Upholstered sled-base chair; seat top 0.47 m."""
    fm = P[frame]
    for s in (-1, 1):
        g.box(fm, (0.02, 0.02, 0.50), (s * 0.22, 0.01, 0.0), bevel=0.005)
        g.box(fm, (0.02, 0.43, 0.02), (s * 0.22, 0.225, 0.23), bevel=0.005)
        g.box(fm, (0.02, 0.43, 0.02), (s * 0.22, 0.225, -0.23), bevel=0.005)
    g.box(P['fabric'], (0.50, 0.07, 0.50), (0, 0.44, 0.0), bevel=0.03, segs=2, color=color)
    g.box(P['fabric'], (0.50, 0.40, 0.07), (0, 0.70, -0.25), pitch=-0.1, bevel=0.03, segs=2, color=color)


def stool(g, P, h=0.75, color='#2b2b2b', seat='wood'):
    g.cyl(P[seat] if seat in P else P['paint'], 0.19, 0.045, (0, h - 0.045, 0), segs=20, bevel=0.01,
          color=color if seat not in P else None)
    for i in range(4):
        a = TAU * i / 4 + math.pi / 4
        g.cyl(P['metal'], 0.012, h - 0.04, (math.sin(a) * 0.14, 0, math.cos(a) * 0.14), segs=6,
              pitch=0.0)
    g.cyl(P['metal'], 0.15, 0.015, (0, 0.28, 0), r2=0.15, segs=16, caps=False)


def sofa(g, P, length=2.2, color='#888888', depth=0.92, leg='metal', cushions=None):
    """Lounge sofa, seat top 0.42 m; local origin = center of the seat front-back, back at −z."""
    n = cushions or max(2, round(length / 0.75))
    arm = 0.16
    inner = length - 2 * arm
    g.box(P['fabric'], (length, 0.22, depth), (0, 0.19, 0), bevel=0.03, segs=3, color=color)
    for s in (-1, 1):
        g.box(P['fabric'], (arm, 0.40, depth), (s * (length / 2 - arm / 2), 0.38, 0), bevel=0.05, segs=3, color=color)
    g.box(P['fabric'], (length - 0.02, 0.45, 0.20), (0, 0.52, -depth / 2 + 0.10), bevel=0.05, segs=3, color=color)
    w = inner / n
    for i in range(n):
        x = -inner / 2 + w * (i + 0.5)
        g.box(P['fabric'], (w - 0.015, 0.13, depth - 0.25), (x, 0.355, 0.11), bevel=0.04, segs=3, color=color)
        g.box(P['fabric'], (w - 0.03, 0.40, 0.16), (x, 0.62, -depth / 2 + 0.27), pitch=-0.18, bevel=0.06, segs=3,
              color=color)
    for sx in (-1, 1):
        for sz in (-1, 1):
            g.cyl(P[leg], 0.018, 0.09, (sx * (length / 2 - 0.08), 0, sz * (depth / 2 - 0.08)), segs=8)


def armchair(g, P, color, leather=False):
    mat = P['leather'] if leather else P['fabric']
    c = None if leather else color
    g.box(mat, (0.82, 0.20, 0.82), (0, 0.22, 0), bevel=0.04, segs=3, color=c)
    g.box(mat, (0.62, 0.12, 0.62), (0, 0.37, 0.06), bevel=0.04, segs=3, color=c)
    g.box(mat, (0.82, 0.42, 0.18), (0, 0.55, -0.32), pitch=-0.15, bevel=0.06, segs=3, color=c)
    for s in (-1, 1):
        g.box(mat, (0.12, 0.30, 0.74), (s * 0.35, 0.44, 0.02), bevel=0.05, segs=3, color=c)
    for sx in (-1, 1):
        for sz in (-1, 1):
            g.cyl(P['wood_dark'], 0.02, 0.13, (sx * 0.33, 0, sz * 0.33), r2=0.014, segs=8)


def bean_bag(g, P, color):
    g.sphere(P['fabric'], 0.42, (0, 0.2, 0), segs=14, rings=8, scale=(1.0, 0.55, 1.0), color=color)
    g.sphere(P['fabric'], 0.3, (0, 0.3, -0.22), segs=12, rings=6, scale=(1.05, 0.7, 0.6), color=color)


# ============================================================================== tables & desks
def desk(g, P, w=1.6, d=0.8, top='wood', frame='white'):
    """Desk centered at origin; user side is +z. Top surface at 0.74 m."""
    g.box(P[top], (w, 0.03, d), (0, 0.725, 0), bevel=0.004, segs=2)
    for s in (-1, 1):
        x = s * (w / 2 - 0.06)
        g.box(P[frame], (0.05, 0.69, 0.05), (x, 0.345, d / 2 - 0.12), bevel=0.004)
        g.box(P[frame], (0.05, 0.69, 0.05), (x, 0.345, -d / 2 + 0.12), bevel=0.004)
        g.box(P[frame], (0.06, 0.04, d - 0.1), (x, 0.69, 0), bevel=0.004)
        g.box(P[frame], (0.07, 0.025, d - 0.1), (x, 0.0125, 0), bevel=0.004)
    g.box(P[frame], (w - 0.2, 0.04, 0.04), (0, 0.66, -d / 2 + 0.15), bevel=0.004)
    g.box(P['metal'], (w * 0.6, 0.06, 0.16), (0, 0.6, -d / 2 + 0.2), bevel=0.003)  # cable tray


def monitor(g, P, ref, pos=(0, 0.74, -0.18), yaw=0.0):
    """27" monitor on a stand; screen surface is a runtime-driven node (role screen, ref `ref`)."""
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['paint'], (0.24, 0.012, 0.18), (0, 0.006, -0.02), color='#202224', bevel=0.004, segs=2)
        g.box(P['paint'], (0.05, 0.36, 0.025), (0, 0.19, -0.07), color='#202224', bevel=0.005)
        g.box(P['paint'], (0.62, 0.37, 0.035), (0, 0.33, -0.03), color='#161719', bevel=0.006, segs=2)
        d = g.dynamic(f'screen-{ref.replace(":", "-")}', 'screen', ref, P['screen'], pivot=(0, 0.335, -0.0115))
        with g.into(d):
            g.quad(P['screen'], 0.595, 0.335, (0, 0.335, -0.0115))


def keyboard(g, P, pos, yaw=0.0):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['paint'], (0.43, 0.018, 0.13), (0, 0.009, 0), color='#e6e6e6', bevel=0.004, segs=2)
        g.box(P['paint'], (0.06, 0.02, 0.10), (0.32, 0.01, 0.02), color='#e6e6e6', bevel=0.008, segs=2)


def mug(g, P, pos, color):
    x, y, z = pos
    g.cyl(P['gloss'], 0.04, 0.095, (x, y, z), segs=12, color=color)
    g.torus(P['gloss'], 0.028, 0.008, (x + 0.045, y + 0.05, z), segs=8, rsegs=4, pitch=math.pi / 2, color=color)


def laptop(g, P, pos, yaw=0.0, open_=True):
    x, y, z = pos
    with g.at(x, z, yaw, y=y):
        g.box(P['steel'], (0.32, 0.012, 0.22), (0, 0.006, 0), bevel=0.003, segs=2)
        if open_:
            g.box(P['steel'], (0.32, 0.21, 0.008), (0, 0.11, -0.12), pitch=-0.25, bevel=0.003)
            g.box(P['black'], (0.29, 0.18, 0.002), (0, 0.11, -0.114), pitch=-0.25, bevel=0)


def notebook(g, P, pos, yaw, color):
    x, y, z = pos
    g.box(P['paint'], (0.15, 0.015, 0.21), (x, y + 0.0075, z), yaw=yaw, color=color, bevel=0.002)


def pod(g, P, pod_index, rng, chair_color, mug_colors, divider_color='#8a8f94', top='wood'):
    """4-desk pod (2 × 2, back to back) centered at the origin, desks along x. Seats face the divider.
    Seat i: 0,1 on the +z side (heading π), 2,3 on the −z side (heading 0). Returns seat local positions."""
    seats = []
    for side in (1, -1):
        for k, x in enumerate((-0.8, 0.8)):
            i = (0 if side == 1 else 2) + k
            with g.at(x, side * 0.4, 0.0 if side == 1 else math.pi):
                desk(g, P, top=top)
                monitor(g, P, f'desk:{pod_index}:{i}')
                keyboard(g, P, (rng.uniform(-0.05, 0.05), 0.74, 0.12))
                if rng.random() < 0.8:
                    mug(g, P, (rng.choice((-0.55, 0.55)), 0.74, rng.uniform(0.0, 0.2)), rng.choice(mug_colors))
                if rng.random() < 0.5:
                    notebook(g, P, (rng.choice((-0.45, 0.5)), 0.74, -0.1), rng.uniform(-0.4, 0.4),
                             rng.choice(('#2f3e46', '#e07a5f', '#f2cc8f', '#3d5a80')))
                if rng.random() < 0.45:
                    pot_plant(g, P, (rng.choice((-0.62, 0.64)), 0.74, -0.25), 0.06, 0.09, 'succulent', rng)
                if rng.random() < 0.25:
                    laptop(g, P, (-0.45, 0.74, 0.08), yaw=0.3, open_=False)
            sz = side * 1.22
            with g.at(x + rng.uniform(-0.04, 0.04), sz, math.pi if side == 1 else 0.0):
                task_chair(g, P, color=chair_color)
            seats.append((i, x, sz, math.pi if side == 1 else 0.0))
    # privacy divider (felt) on the center line + cable spine
    g.box(P['felt'], (3.2, 0.42, 0.04), (0, 0.95, 0), bevel=0.01, segs=2, color=divider_color)
    g.box(P['metal'], (3.2, 0.02, 0.05), (0, 1.17, 0), bevel=0.004)
    return sorted(seats)


def meeting_table(g, P, w=2.4, d=1.1, top='wood'):
    g.prism(P[top], rounded_rect(w, d, 0.25, 5), 0.715, 0.745, bevel=0.004, segs=2)
    for s in (-1, 1):
        g.box(P['metal'], (0.08, 0.68, 0.5), (s * (w / 2 - 0.45), 0.36, 0), bevel=0.006)
        g.box(P['metal'], (0.1, 0.02, 0.8), (s * (w / 2 - 0.45), 0.01, 0), bevel=0.004)
    g.box(P['metal'], (w - 0.9, 0.06, 0.08), (0, 0.66, 0), bevel=0.004)


def tv(g, P, ref, w=1.6, h=0.92):
    """Wall TV centered at origin facing +z (mount at z=0)."""
    g.box(P['paint'], (0.4, 0.3, 0.04), (0, 0, 0.02), color='#222222')
    g.box(P['paint'], (w, h, 0.035), (0, 0, 0.06), color='#111214', bevel=0.004, segs=2)
    d = g.dynamic(f'screen-{ref.replace(":", "-")}', 'screen', ref, P['screen'], pivot=(0, 0, 0.0785))
    with g.into(d):
        g.quad(P['screen'], w - 0.03, h - 0.03, (0, 0, 0.0785))


def whiteboard(g, P, w=1.5, h=1.0):
    g.box(P['white'], (w, h, 0.02), (0, 1.35, 0), bevel=0.006, segs=2)
    g.box(P['steel'], (w + 0.02, 0.02, 0.025), (0, 1.35 + h / 2, 0), bevel=0.003)
    g.box(P['steel'], (w + 0.02, 0.03, 0.06), (0, 1.35 - h / 2, 0.02), bevel=0.003)
    for s in (-1, 1):
        g.box(P['steel'], (0.03, 1.85, 0.03), (s * (w / 2 + 0.02), 0.925, 0), bevel=0.004)
        g.box(P['steel'], (0.04, 0.03, 0.5), (s * (w / 2 + 0.02), 0.03, 0), bevel=0.004)
    for i, c in enumerate(('#d62828', '#1d3557', '#2a9d8f')):
        g.box(P['paint'], (0.12, 0.016, 0.016), (-0.4 + i * 0.15, 1.35 - h / 2 + 0.025, 0.035), color=c, bevel=0.003)


# ============================================================================== rooms
def phone_booth(g, P, index, felt_color):
    """1.4 × 1.4 × 2.3 booth, door (glass) facing +z, centered at origin. LED ring = runtime node."""
    W, D, H = 1.4, 1.4, 2.3
    # shell
    g.box_b(P['wood'], -W / 2, W / 2, 0, 0.06, -D / 2, D / 2, bevel=0.006)
    g.box_b(P['wood'], -W / 2, W / 2, H - 0.08, H, -D / 2, D / 2, bevel=0.01, segs=2)
    g.box_b(P['wood'], -W / 2, W / 2, 0.06, H - 0.08, -D / 2, -D / 2 + 0.06, bevel=0.006)
    for s in (-1, 1):
        g.box_b(P['wood'], s * W / 2 - 0.06 * (s > 0), s * W / 2 + 0.06 * (s < 0), 0.06, H - 0.08,
                -D / 2, D / 2, bevel=0.006)
        g.box_b(P['felt'], s * (W / 2 - 0.06) - 0.03 * (s > 0), s * (W / 2 - 0.06) + 0.03 * (s < 0), 0.6, 2.0,
                -D / 2 + 0.12, D / 2 - 0.12, bevel=0.01, segs=2, color=felt_color)
    g.box_b(P['felt'], -W / 2 + 0.1, W / 2 - 0.1, 0.6, 2.0, -D / 2 + 0.06, -D / 2 + 0.09, bevel=0.01, segs=2,
            color=felt_color)
    # front frame + glass door
    g.box_b(P['metal'], -W / 2 + 0.06, W / 2 - 0.06, 0.06, 0.1, D / 2 - 0.05, D / 2, bevel=0.003)
    g.box_b(P['metal'], -W / 2 + 0.06, W / 2 - 0.06, H - 0.14, H - 0.08, D / 2 - 0.05, D / 2, bevel=0.003)
    g.box_b(P['metal'], 0.35, 0.39, 0.1, H - 0.14, D / 2 - 0.05, D / 2, bevel=0.003)
    with g.in_group('glass'):
        g.box_b(P['glass'], -W / 2 + 0.06, W / 2 - 0.06, 0.1, H - 0.14, D / 2 - 0.035, D / 2 - 0.023, bevel=0)
    g.cyl(P['steel'], 0.012, 0.6, (0.3, 0.8, D / 2 + 0.03), segs=8)
    # small standing shelf + stool
    g.box_b(P['wood'], -W / 2 + 0.06, W / 2 - 0.06, 1.02, 1.05, -D / 2 + 0.06, -D / 2 + 0.38, bevel=0.004, segs=2)
    with g.at(-0.35, -0.15):
        stool(g, P, h=0.62)
    # ceiling light (baked) and the LED ring (runtime)
    g.box_b(P['light'], -0.3, 0.3, H - 0.1, H - 0.08, -0.3, 0.3, bevel=0)
    g.light('panel', (0, H - 0.11, 0), size=(0.6, 0.6), power=60, kelvin=3500)
    d = g.dynamic(f'led-booth-{index}', 'led', f'booth:{index}', P['led'], pivot=(0, H - 0.04, D / 2 + 0.005))
    with g.into(d):
        g.box((P['led']), (W - 0.2, 0.025, 0.01), (0, H - 0.04, D / 2 + 0.005), bevel=0)


def counter_run(g, P, length, depth=0.65, h=0.92, top='stone', front='white', handles=True):
    """Base cabinets with door gaps along local x from 0 to length, back against z = −depth."""
    n = max(1, round(length / 0.6))
    w = length / n
    g.box_b(P['metal'], 0, length, 0, 0.1, -depth + 0.05, -0.06, bevel=0.002)
    for i in range(n):
        x0 = i * w
        g.box_b(P[front], x0 + 0.002, x0 + w - 0.002, 0.1, h - 0.04, -depth, -0.02, bevel=0.004, segs=2)
        if handles:
            g.box(P['metal'], (w * 0.5, 0.012, 0.02), (x0 + w / 2, h - 0.12, -0.005), bevel=0.003)
    g.box_b(P[top], -0.01, length + 0.01, h - 0.04, h, -depth - 0.01, 0.02, bevel=0.004, segs=2)


def coffee_machine(g, P, pos):
    x, y, z = pos
    with g.at(x, z, y=y):
        g.box(P['steel'], (0.38, 0.42, 0.4), (0, 0.21, 0), bevel=0.01, segs=2)
        g.box(P['black'], (0.30, 0.12, 0.02), (0, 0.32, 0.2), bevel=0.004)
        g.box(P['steel'], (0.18, 0.04, 0.12), (0, 0.08, 0.2), bevel=0.004)
        g.cyl(P['steel'], 0.012, 0.06, (-0.05, 0.14, 0.22), segs=8)
        g.cyl(P['steel'], 0.012, 0.06, (0.05, 0.14, 0.22), segs=8)
        g.cyl(P['gloss'], 0.07, 0.12, (0.1, 0.42, -0.05), segs=12, color='#2b2b2b')


def fridge(g, P, pos, w=0.7, h=1.9):
    x, y, z = pos
    with g.at(x, z, y=y):
        g.box(P['steel'], (w, h, 0.65), (0, h / 2, -0.32), bevel=0.01, segs=2)
        with g.in_group('glass'):
            g.box(P['glass'], (w - 0.1, h - 0.3, 0.01), (0, h / 2 + 0.05, 0.005), bevel=0)
        for i in range(4):
            yy = 0.35 + i * 0.36
            g.box(P['white'], (w - 0.12, 0.012, 0.5), (0, yy, -0.3), bevel=0)
            for k in range(6):
                c = ('#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#a8dadc', '#ffffff')[(i + k) % 6]
                g.cyl(P['gloss'], 0.032, 0.2, (-w / 2 + 0.1 + k * 0.095, yy + 0.012, -0.1), segs=8, color=c)
        g.box(P['metal'], (0.02, 0.8, 0.03), (w / 2 - 0.06, h / 2 + 0.1, 0.02), bevel=0.004)
        g.box_b(P['light'], -w / 2 + 0.06, w / 2 - 0.06, h - 0.2, h - 0.18, -0.6, -0.05, bevel=0)


def fruit_bowl(g, P, pos, rng):
    x, y, z = pos
    g.cyl(P['gloss'], 0.16, 0.07, (x, y, z), r2=0.2, segs=16, color='#f4f1ea')
    for i in range(7):
        a = rng.uniform(0, TAU)
        r = rng.uniform(0, 0.11)
        c = rng.choice(('#d62828', '#f77f00', '#fcbf49', '#7cb518', '#e63946'))
        g.sphere(P['gloss'], 0.04, (x + math.cos(a) * r, y + 0.08 + rng.uniform(0, 0.03), z + math.sin(a) * r),
                 segs=8, rings=5, color=c)


def dome_pendant(g, P, pos, drop=0.9, color='#1e1e1e', kelvin=2700, power=40, r=0.22, mat='paint'):
    """Dome pendant hanging from ceiling height `pos.y` with the shade bottom at pos.y − drop."""
    x, y, z = pos
    with g.in_group('ceiling'):
        g.cyl(P['metal'], 0.004, drop - 0.2, (x, y - drop + 0.2, z), segs=4, caps=False)
        g.cyl(P['metal'], 0.05, 0.02, (x, y - 0.02, z), segs=10)
        g.cyl(P[mat], r, 0.2, (x, y - drop, z), r2=0.05, segs=20, color=color, caps=False)
        g.cyl(P['light_warm'], r * 0.8, 0.005, (x, y - drop + 0.03, z), segs=16)
    g.light('disk', (x, y - drop + 0.02, z), size=r * 1.4, power=power, kelvin=kelvin)


def linear_pendant(g, P, pos, length=2.4, yaw=0.0, drop=0.8, kelvin=4000, power=180, y_ceiling=3.6):
    """Slim linear pendant (black body, opal diffuser), along local x after yaw."""
    x, y, z = pos
    with g.at(x, z, yaw):
        with g.in_group('ceiling'):
            yb = y_ceiling - drop
            g.box(P['metal'], (length, 0.06, 0.07), (0, yb + 0.03, 0), bevel=0.004, segs=2)
            g.box(P['light'], (length - 0.03, 0.006, 0.05), (0, yb - 0.003, 0), bevel=0)
            for s in (-1, 1):
                g.cyl(P['metal'], 0.003, drop - 0.06, (s * (length / 2 - 0.2), yb + 0.06, 0), segs=4, caps=False)
                g.cyl(P['metal'], 0.03, 0.012, (s * (length / 2 - 0.2), y_ceiling - 0.012, 0), segs=8)
        g.light('panel', (0, yb - 0.01, 0), size=(length - 0.05, 0.08), power=power, kelvin=kelvin)


def ring_pendant(g, P, pos, R=1.2, kelvin=3000, power=400, y_ceiling=7.2):
    x, y, z = pos
    with g.in_group('ceiling'):
        g.torus(P['metal'], R, 0.035, (x, y, z), segs=48, rsegs=6)
        g.torus(P['light_warm'], R, 0.022, (x, y - 0.02, z), segs=48, rsegs=6)
        for i in range(3):
            a = TAU * i / 3
            g.cyl(P['metal'], 0.004, y_ceiling - y, (x + math.cos(a) * R, y, z + math.sin(a) * R), segs=4, caps=False)
    for i in range(6):
        a = TAU * i / 6
        g.light('point', (x + math.cos(a) * R, y - 0.05, z + math.sin(a) * R), radius=0.08, power=power / 6,
                kelvin=kelvin)


def kitchen(g, P, rng, length=4.6, accent='#D97757', kelvin=2700, stool_color='#2b2b2b', island=True):
    """Micro-kitchen along the back wall (z = 0 is the wall face, counter towards +z), x from 0 to length.
    Island centered at (length/2, 2.25). Returns spot positions (local) for anchors."""
    with g.at(0, 0.65, 0):
        counter_run(g, P, length, depth=0.65, front='white')
    # backsplash + open shelves
    g.box_b(P['tile'], 0, length, 0.92, 1.5, 0.0, 0.02, bevel=0.002)
    for yy in (1.75, 2.15):
        g.box_b(P['wood'], 0.2, length - 1.0, yy, yy + 0.035, 0.0, 0.3, bevel=0.004, segs=2)
        for k in range(int((length - 1.4) / 0.18)):
            if rng.random() < 0.65:
                c = rng.choice(('#ffffff', '#f2e8cf', accent, '#264653', '#e9c46a'))
                xx = 0.3 + k * 0.18
                if rng.random() < 0.5:
                    g.cyl(P['gloss'], 0.05, rng.uniform(0.1, 0.18), (xx, yy + 0.035, 0.15), segs=10, color=c)
                else:
                    g.cyl(P['gloss'], 0.045, 0.09, (xx, yy + 0.035, 0.15), segs=10, color=c)
    # sink + faucet
    g.box_b(P['steel'], 1.2, 1.75, 0.89, 0.915, 0.1, 0.5, bevel=0.004)
    g.cyl(P['steel'], 0.014, 0.3, (1.47, 0.92, 0.1), segs=8)
    g.cyl(P['steel'], 0.012, 0.2, (1.47, 1.2, 0.1), segs=8, pitch=math.pi / 2)
    coffee_machine(g, P, (2.3, 0.92, 0.33))
    coffee_machine(g, P, (2.75, 0.92, 0.33))
    g.cyl(P['gloss'], 0.1, 0.12, (3.2, 0.92, 0.3), segs=12, color='#f4f1ea')
    fridge(g, P, (length + 0.38, 0, 0.66))
    fridge(g, P, (length + 1.1, 0, 0.66))
    fruit_bowl(g, P, (0.7, 0.92, 0.35), rng)
    spots = []
    if island:
        cx, cz = length / 2, 2.35
        with g.at(cx, cz):
            g.box_b(P['white'], -1.2, 1.2, 0.1, 0.88, -0.45, 0.45, bevel=0.006, segs=2)
            g.box_b(P['metal'], -1.18, 1.18, 0, 0.1, -0.43, 0.43, bevel=0.002)
            g.box_b(P['wood'], -1.3, 1.3, 0.88, 0.92, -0.55, 0.62, bevel=0.005, segs=2)
            fruit_bowl(g, P, (0.6, 0.92, 0), rng)
            g.cyl(P['gloss'], 0.05, 0.25, (-0.7, 0.92, 0.05), segs=10, color='#e9f5f2')
            pot_plant(g, P, (-0.2, 0.92, -0.1), 0.07, 0.12, 'bush', rng)
            for i, sx in enumerate((-0.8, 0.0, 0.8)):
                with g.at(sx, 0.95, math.pi):
                    stool(g, P, h=0.72, color=stool_color, seat='wood')
        for xx in (cx - 0.9, cx, cx + 0.9):
            dome_pendant(g, P, (xx, 3.6, cz), drop=1.25, color=accent, kelvin=kelvin, power=35)
        spots = [(cx - 0.9, 1.4, math.pi), (cx + 0.9, 1.4, math.pi)]
    return spots


# ============================================================================== lounge
def rug(g, P, w, d, color, r=0.08):
    g.prism(P['felt'], rounded_rect(w, d, r, 4), 0.0, 0.012, color=color)


def coffee_table(g, P, r=0.5, top='wood'):
    g.cyl(P[top], r, 0.04, (0, 0.36, 0), segs=28, bevel=0.006, bsegs=2)
    g.cyl(P['metal'], 0.04, 0.36, (0, 0, 0), segs=10)
    g.cyl(P['metal'], 0.22, 0.02, (0, 0, 0), segs=18)


def side_table(g, P, color='#2b2b2b'):
    g.cyl(P['paint'], 0.22, 0.5, (0, 0, 0), segs=18, color=color)


def floor_lamp(g, P, kelvin=2700):
    g.cyl(P['metal'], 0.16, 0.025, (0, 0, 0), segs=16)
    g.cyl(P['metal'], 0.012, 1.45, (0, 0.025, 0), segs=6)
    g.cyl(P['fabric'], 0.2, 0.28, (0, 1.38, 0), r2=0.16, segs=18, caps=False, color='#efe6d8')
    g.light('point', (0, 1.5, 0), radius=0.1, power=25, kelvin=kelvin)


def bookshelf(g, P, w=1.8, h=2.0, d=0.35, rng=None, frame='wood'):
    n = 5
    for i in range(n + 1):
        y = i * (h - 0.03) / n
        g.box_b(P[frame], 0, w, y, y + 0.03, -d, 0, bevel=0.003)
    for x in (0, w / 2 - 0.015, w - 0.03):
        g.box_b(P[frame], x, x + 0.03, 0, h, -d, 0, bevel=0.003)
    if rng is None:
        return
    cols = ('#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#f1faee', '#a8dadc', '#457b9d', '#3d405b')
    for i in range(n):
        y = i * (h - 0.03) / n + 0.03
        x = 0.05
        while x < w - 0.1:
            if rng.random() < 0.2:
                x += rng.uniform(0.08, 0.25)
                if rng.random() < 0.3 and x < w - 0.25:
                    pot_plant(g, P, (x + 0.06, y, -d / 2), 0.05, 0.09, rng.choice(('succulent', 'bush')), rng)
                    x += 0.16
                continue
            bw = rng.uniform(0.025, 0.05)
            bh = rng.uniform(0.18, 0.3)
            g.box(P['paint'], (bw, bh, rng.uniform(0.18, 0.24)), (x + bw / 2, y + bh / 2, -d / 2), color=rng.choice(cols),
                  bevel=0.002)
            x += bw + 0.004


# ============================================================================== plants
def leaf(g, P, base, yaw, pitch, length, width, droop=0.3, color='#4E7D3A', segs=4, fold=0.15):
    """A curved, pointed leaf blade as a ribbon (6 tris at segs=4). pitch: elevation of the start."""
    bx, by, bz = base
    cy, sy = math.cos(yaw), math.sin(yaw)
    L, R = [], []
    for i in range(segs + 1):
        t = i / segs
        el = pitch - droop * t * t * 2.0
        r = length * t
        hx = math.cos(el) * r
        x = bx + sy * hx
        z = bz + cy * hx
        y = by + math.sin(pitch) * r - droop * length * t * t
        w = width * (math.sin(math.pi * min(1.0, t * 1.05)) ** 0.7) / 2
        fy = fold * w
        L.append((x - cy * w, y + fy, z + sy * w))
        R.append((x + cy * w, y + fy, z - sy * w))
    g.ribbon(P['leaf'], L, R, color=color)


def bush(g, P, pos, radius, height, rng, n=None, palette=GREENS, leaf_len=None, leaf_w=None):
    x0, y0, z0 = pos
    n = n or int(30 + 120 * radius)
    ll = leaf_len or max(0.08, radius * 0.6)
    lw = leaf_w or ll * 0.35
    for i in range(n):
        a = rng.uniform(0, TAU)
        r = rng.uniform(0, radius * 0.5)
        h = rng.uniform(0.15, 1.0) * height
        base = (x0 + math.sin(a) * r * 0.6, y0 + h * 0.6, z0 + math.cos(a) * r * 0.6)
        leaf(g, P, base, a + rng.uniform(-0.4, 0.4), rng.uniform(0.2, 1.1), ll * rng.uniform(0.75, 1.2),
             lw * rng.uniform(0.8, 1.2), droop=rng.uniform(0.15, 0.4), color=rng.choice(palette))


def snake_plant(g, P, pos, height, rng, n=10):
    x0, y0, z0 = pos
    for i in range(n):
        a = rng.uniform(0, TAU)
        r = rng.uniform(0, 0.06)
        leaf(g, P, (x0 + math.sin(a) * r, y0, z0 + math.cos(a) * r), a, math.radians(rng.uniform(75, 88)),
             height * rng.uniform(0.6, 1.0), 0.07, droop=0.02, color=rng.choice(('#3d5a3a', '#4a6b3a', '#2f4f2f')),
             segs=3, fold=0.3)


def tree(g, P, pos, height, rng, crown=0.7, leaf_size=0.2, n=None):
    """Indoor tree (fiddle-leaf / olive style): trunk + a few branches with leaf clusters."""
    x0, y0, z0 = pos
    g.cyl(P['wood_dark'], 0.03, height * 0.65, (x0, y0, z0), r2=0.02, segs=6)
    n = n or int(170 * crown)
    tips = []
    for b in range(5):
        a = TAU * b / 5 + rng.uniform(-0.3, 0.3)
        h0 = height * rng.uniform(0.45, 0.65)
        L = crown * rng.uniform(0.5, 0.9)
        el = rng.uniform(0.6, 1.0)
        g.cyl(P['wood_dark'], 0.015, L, (x0, y0 + h0, z0), r2=0.008, segs=4, yaw=a, pitch=(math.pi / 2 - el))
        tips.append((x0 + math.sin(a) * math.cos(el) * L, y0 + h0 + math.sin(el) * L, z0 + math.cos(a) * math.cos(el) * L))
    tips.append((x0, y0 + height * 0.9, z0))
    for i in range(n):
        tx, ty, tz = tips[i % len(tips)]
        a = rng.uniform(0, TAU)
        r = rng.uniform(0, crown * 0.4)
        base = (tx + math.sin(a) * r, ty + rng.uniform(-0.25, 0.2) * crown, tz + math.cos(a) * r)
        leaf(g, P, base, a, rng.uniform(-0.2, 0.7), leaf_size * rng.uniform(0.8, 1.2), leaf_size * 0.55,
             droop=0.2, color=rng.choice(GREENS))


def pot_plant(g, P, pos, r, h, kind, rng, pot_color='#efe9df'):
    """Pot (gloss ceramic) + plant. pos is the pot base center."""
    x, y, z = pos
    g.cyl(P['gloss'], r, h, (x, y, z), r2=r * 1.12, segs=14, color=pot_color)
    g.cyl(P['soil'], r * 1.05, 0.005, (x, y + h - 0.02, z), segs=12)
    top = (x, y + h - 0.02, z)
    if kind == 'succulent':
        for i in range(9):
            a = TAU * i / 9 + rng.uniform(-0.2, 0.2)
            leaf(g, P, top, a, rng.uniform(0.4, 1.1), r * 1.3, r * 0.6, droop=0.05, color=rng.choice(GREENS), segs=3)
    elif kind == 'snake':
        snake_plant(g, P, top, h * 4.5, rng, n=9)
    elif kind == 'tree':
        tree(g, P, top, h * 5.5, rng, crown=r * 3.4, leaf_size=0.2)
    else:
        bush(g, P, top, r * 2.6, r * 3.0, rng)


def planter(g, P, w, d, h, rng, kind='mixed', color='#3a3a3a', mat='paint', density=1.0, rim='wood'):
    """Rectangular planter centered at origin, soil at height h − 0.05, filled with plants."""
    g.box_b(P[mat] if mat in P else P['paint'], -w / 2, w / 2, 0, h, -d / 2, d / 2, bevel=0.01, segs=2,
            color=color if mat in ('paint', 'gloss') else None)
    if rim:
        g.box_b(P[rim], -w / 2 - 0.02, w / 2 + 0.02, h, h + 0.04, -d / 2 - 0.02, d / 2 + 0.02, bevel=0.006, segs=2)
    g.box_b(P['soil'], -w / 2 + 0.03, w / 2 - 0.03, h - 0.06, h - 0.02, -d / 2 + 0.03, d / 2 - 0.03, bevel=0)
    area = w * d
    n = max(1, int(area * 3 * density))
    for i in range(n):
        px = rng.uniform(-w / 2 + 0.12, w / 2 - 0.12)
        pz = rng.uniform(-d / 2 + 0.12, d / 2 - 0.12)
        k = kind if kind != 'mixed' else rng.choice(('bush', 'bush', 'snake', 'fern'))
        top = (px, h - 0.02, pz)
        if k == 'snake':
            snake_plant(g, P, top, rng.uniform(0.5, 0.9), rng, n=8)
        elif k == 'fern':
            bush(g, P, top, 0.35, 0.25, rng, n=22, leaf_len=0.32, leaf_w=0.07)
        elif k == 'tree':
            tree(g, P, top, rng.uniform(1.8, 2.4), rng, crown=0.8, leaf_size=0.2)
        else:
            bush(g, P, top, rng.uniform(0.25, 0.4), rng.uniform(0.3, 0.5), rng)


def living_wall(g, P, w, h, rng, y0=0.3, density=1.0, frame='wood'):
    """Vertical garden on the plane z = 0 (facing +z), x from 0 to w."""
    g.box_b(P[frame], -0.04, w + 0.04, y0 - 0.04, y0 + h + 0.04, -0.02, 0.06, bevel=0.006, segs=2)
    g.box_b(P['paint'], 0, w, y0, y0 + h, 0.06, 0.08, bevel=0, color='#1d3320')
    n = int(w * h * 115 * density)
    pal = GREENS + ['#7FA35A', '#8DB360', '#2C4A2A', '#9BBF63']
    for i in range(n):
        x = rng.uniform(0.04, w - 0.04)
        y = y0 + rng.uniform(0.05, h - 0.02)
        a = rng.uniform(-1.3, 1.3)
        leaf(g, P, (x, y, 0.08), a, rng.uniform(-0.2, 0.7), rng.uniform(0.17, 0.3), rng.uniform(0.07, 0.13),
             droop=rng.uniform(0.15, 0.4), color=rng.choice(pal), segs=3)
    g.light('wallwash', (w / 2, y0 + h + 0.2, 0.5), size=(w, 0.1), power=60 * w, kelvin=3500, dir=(0, -0.6, -0.4))


def hanging_plant(g, P, pos, rng, length=0.9):
    x, y, z = pos
    g.cyl(P['gloss'], 0.12, 0.12, (x, y - 0.12, z), r2=0.14, segs=12, color='#efe9df')
    g.cyl(P['metal'], 0.003, 0.5, (x, y, z), segs=3, caps=False)
    for i in range(14):
        a = rng.uniform(0, TAU)
        L = length * rng.uniform(0.5, 1.0)
        for k in range(5):
            t = k / 5
            leaf(g, P, (x + math.sin(a) * (0.12 + 0.05 * t), y - 0.06 - L * t, z + math.cos(a) * (0.12 + 0.05 * t)),
                 a + rng.uniform(-1, 1), rng.uniform(-0.6, 0.2), 0.07, 0.05, droop=0.1, color=rng.choice(GREENS),
                 segs=2)


# ============================================================================== games
def ping_pong(g, P, top_color='#1d4e89'):
    L, W, H = 2.74, 1.525, 0.76
    g.box_b(P['paint'], -L / 2, L / 2, H - 0.025, H, -W / 2, W / 2, bevel=0.004, color=top_color)
    for x0, x1, z0, z1 in ((-L / 2, L / 2, W / 2 - 0.02, W / 2), (-L / 2, L / 2, -W / 2, -W / 2 + 0.02),
                           (-L / 2, -L / 2 + 0.02, -W / 2, W / 2), (L / 2 - 0.02, L / 2, -W / 2, W / 2),
                           (-L / 2, L / 2, -0.002, 0.002)):
        g.box_b(P['paint'], x0, x1, H, H + 0.001, z0, z1, bevel=0, color='#ffffff')
    g.box_b(P['paint'], -0.006, 0.006, H, H + 0.1525, -W / 2 - 0.15, W / 2 + 0.15, bevel=0, color='#151515')
    g.box_b(P['paint'], -0.008, 0.008, H + 0.14, H + 0.155, -W / 2 - 0.15, W / 2 + 0.15, bevel=0, color='#f5f5f5')
    for sx in (-1, 1):
        g.box(P['metal'], (0.05, H - 0.05, 0.05), (sx * (L / 2 - 0.3), (H - 0.05) / 2, 0), bevel=0.004)
        g.box(P['metal'], (0.06, 0.04, W - 0.2), (sx * (L / 2 - 0.3), 0.02, 0), bevel=0.004)
        g.box(P['metal'], (0.05, 0.04, W - 0.4), (sx * (L / 2 - 0.3), H - 0.07, 0), bevel=0.004)
        with g.at(sx * (L / 2 - 0.35), 0.3, 0.4):
            g.cyl(P['paint'], 0.075, 0.012, (0, H, 0), segs=14, color='#c1121f')
            g.box(P['wood'], (0.03, 0.022, 0.1), (0, H + 0.011, 0.11), bevel=0.003)


def arcade(g, P, ref, body='#1b1b2f', accent='#7F5AF0'):
    """Arcade cabinet facing +z; its screen is a runtime node (role screen, ref `ref`)."""
    W, D = 0.7, 0.8
    g.box_b(P['paint'], -W / 2 + 0.02, W / 2 - 0.02, 0, 0.95, -D / 2, D / 2 - 0.05, bevel=0.006, color=body)
    g.box_b(P['paint'], -W / 2 + 0.02, W / 2 - 0.02, 0.95, 1.9, -D / 2, -0.1, bevel=0.006, color=body)
    g.box(P['paint'], (W - 0.04, 0.06, 0.32), (0, 1.0, 0.2), pitch=0.35, bevel=0.006, color='#111111')
    for i, c in enumerate(('#e63946', '#ffb703', '#219ebc', '#8ac926')):
        g.cyl(P['gloss'], 0.022, 0.02, (-0.12 + i * 0.08, 1.04, 0.22 - i * 0.0), segs=10, color=c, pitch=0.35)
    g.cyl(P['gloss'], 0.012, 0.08, (-0.22, 1.04, 0.2), segs=6, color='#111111', pitch=0.35)
    g.box(P['paint'], (W - 0.04, 0.16, 0.06), (0, 1.84, 0.0), color=accent, bevel=0.006)
    g.box(P['light'], (W - 0.1, 0.1, 0.005), (0, 1.84, 0.033), bevel=0)
    g.box(P['black'], (W - 0.06, 0.62, 0.03), (0, 1.38, -0.1), pitch=-0.18, bevel=0.004)
    if ref is None:  # decor cabinet: static glowing screen
        g.quad(P['light'], W - 0.14, 0.5, (0, 1.38, -0.081), pitch=-0.18)
        return
    d = g.dynamic(f'screen-{ref.replace(":", "-")}', 'screen', ref, P['screen'], pivot=(0, 1.38, -0.08))
    with g.into(d):
        g.quad(P['screen'], W - 0.14, 0.5, (0, 1.38, -0.081), pitch=-0.18)


# ============================================================================== atrium pieces
def reception_desk(g, P, radius=2.6, span=math.radians(110), accent='#E07A5F'):
    """Curved desk; the convex (visitor) side faces +z. Center of curvature at (0, −radius + 0.6)."""
    cz = -radius + 0.6
    a0, a1 = math.pi / 2 - span / 2, math.pi / 2 + span / 2
    outer = arc(0, cz, radius, a0, a1, 24)
    inner = arc(0, cz, radius - 0.12, a1, a0, 24)
    g.prism(P['white'], outer + inner, 0.08, 1.05, bevel=0.006, segs=2)
    for a in (a0, a1):  # end panels
        g.box(P['white'], (0.05, 0.97, 0.9), (math.cos(a) * (radius - 0.45), 0.565, cz + math.sin(a) * (radius - 0.45)),
              yaw=-(a - math.pi / 2) + math.pi / 2, bevel=0.004)
    top_o = arc(0, cz, radius + 0.04, a0 - 0.01, a1 + 0.01, 24)
    top_i = arc(0, cz, radius - 0.35, a1 + 0.01, a0 - 0.01, 24)
    g.prism(P['stone'], top_o + top_i, 1.05, 1.09, bevel=0.004, segs=2)
    work_o = arc(0, cz, radius - 0.12, a0, a1, 24)
    work_i = arc(0, cz, radius - 0.85, a1, a0, 24)
    g.prism(P['wood'], work_o + work_i, 0.72, 0.75, bevel=0.004, segs=2)
    base_o = arc(0, cz, radius - 0.02, a0, a1, 24)
    base_i = arc(0, cz, radius - 0.1, a1, a0, 24)
    g.prism(P['metal'], base_o + base_i, 0.0, 0.08)
    # vertical wood slats on the visitor face
    n = 40
    for i in range(n):
        a = a0 + (a1 - a0) * (i + 0.5) / n
        x, z = math.cos(a) * (radius + 0.015), cz + math.sin(a) * (radius + 0.015)
        g.box(P['wood'], (0.035, 0.9, 0.03), (x, 0.55, z), yaw=-(a - math.pi / 2), bevel=0.004)
    gl = arc(0, cz, radius + 0.03, a0, a1, 24)
    gi = arc(0, cz, radius - 0.02, a1, a0, 24)
    g.prism(P['light_warm'], gl + gi, 0.075, 0.085)
    g.light('point', (0, 0.4, 0.9), radius=0.3, power=40, kelvin=3000)
    for s in (-1, 1):  # receptionist monitors (static, facing the inside of the curve)
        with g.at(s * 0.7, 0.15, math.pi, y=0.75):
            g.box(P['paint'], (0.2, 0.012, 0.16), (0, 0.006, 0), color='#202224', bevel=0.004)
            g.box(P['paint'], (0.04, 0.3, 0.02), (0, 0.16, -0.05), color='#202224', bevel=0.004)
            g.box(P['black'], (0.56, 0.34, 0.03), (0, 0.32, -0.02), bevel=0.005)


def elevator_bank(g, P, n=3, pitch=3.2, door_w=1.1, door_h=2.4, H=7.2, depth=3.0):
    """Elevator core block, doors on its +z face (z = 0), x centered. Door leaves are runtime nodes
    sliding along local x (role elevatorDoor, ref '<i>:L' / '<i>:R')."""
    W = n * pitch + 0.8
    g.box_b(P['concrete'], -W / 2, W / 2, 0, H, -depth, -0.25, bevel=0.01, segs=2)
    for i in range(n):
        x = (i - (n - 1) / 2) * pitch
        x0, x1 = -W / 2 + i * pitch + 0.4, -W / 2 + (i + 1) * pitch + 0.4
        # stone cladding between openings
        g.box_b(P['stone'], x0, x - door_w / 2 - 0.12, 0, H * 0.48, -0.25, 0.0, bevel=0.006, segs=2)
        g.box_b(P['stone'], x + door_w / 2 + 0.12, x1, 0, H * 0.48, -0.25, 0.0, bevel=0.006, segs=2)
        g.box_b(P['stone'], x - door_w / 2 - 0.12, x + door_w / 2 + 0.12, door_h + 0.12, H * 0.48, -0.25, 0.0,
                bevel=0.006, segs=2)
        # steel portal
        g.box_b(P['steel'], x - door_w / 2 - 0.12, x - door_w / 2, 0, door_h + 0.12, -0.25, 0.02, bevel=0.004)
        g.box_b(P['steel'], x + door_w / 2, x + door_w / 2 + 0.12, 0, door_h + 0.12, -0.25, 0.02, bevel=0.004)
        g.box_b(P['steel'], x - door_w / 2, x + door_w / 2, door_h, door_h + 0.12, -0.25, 0.02, bevel=0.004)
        # car interior visible when open
        g.box_b(P['wood'], x - door_w / 2 - 0.3, x + door_w / 2 + 0.3, 0, door_h + 0.1, -1.9, -1.85, bevel=0)
        g.box_b(P['stone'], x - door_w / 2 - 0.3, x + door_w / 2 + 0.3, 0.0, 0.02, -1.9, -0.25, bevel=0)
        g.box_b(P['light'], x - door_w / 2, x + door_w / 2, door_h + 0.05, door_h + 0.06, -1.8, -0.4, bevel=0)
        for s in (-1, 1):
            g.box_b(P['wood'], x + s * (door_w / 2 + 0.3) - 0.05 * (s > 0), x + s * (door_w / 2 + 0.3) + 0.05 * (s < 0),
                    0, door_h + 0.1, -1.9, -0.25, bevel=0)
        # floor indicator + call button
        g.box(P['black'], (0.4, 0.08, 0.01), (x, door_h + 0.3, 0.005), bevel=0)
        g.box(P['light_warm'], (0.2, 0.03, 0.004), (x, door_h + 0.3, 0.011), bevel=0)
        g.box(P['steel'], (0.08, 0.16, 0.012), (x + door_w / 2 + 0.3, 1.15, 0.006), bevel=0.003)
        g.cyl(P['light_warm'], 0.012, 0.006, (x + door_w / 2 + 0.3, 1.18, 0.012), segs=10, pitch=math.pi / 2)
        g.light('panel', (x, door_h + 0.04, -1.0), size=(door_w, 1.2), power=40, kelvin=3500)
        for sx in (-1, 1):
            cx = x + sx * door_w / 4
            # name leaves by module-space x so 'L' always opens towards −x after any yaw
            side = 'L' if g.world(cx, 0, 0)[0] < g.world(x, 0, 0)[0] else 'R'
            d = g.dynamic(f'elevator-door-{i}-{side}', 'elevatorDoor', f'{i}:{side}', P['door'],
                          pivot=(cx, door_h / 2, -0.12))
            with g.into(d):
                g.box((P['door']), (door_w / 2 - 0.004, door_h, 0.03), (cx, door_h / 2, -0.12), bevel=0.002)
    # upper band: wood slat feature above the stone
    g.box_b(P['wood'], -W / 2, W / 2, H * 0.48, H, -0.25, -0.2, bevel=0.004)
    for k in range(int(W / 0.12)):
        xx = -W / 2 + 0.06 + k * 0.12
        g.box(P['wood'], (0.05, H * 0.52, 0.05), (xx, H * 0.74, -0.175), bevel=0.004)


def cafe_chair(g, P, color='#2b2b2b'):
    """Bent-wood cafe chair, seat top 0.47 m, facing +z."""
    for sx in (-1, 1):
        for sz in (-1, 1):
            g.cyl(P['metal'], 0.012, 0.45, (sx * 0.19, 0, sz * 0.19), segs=6)
    g.box(P['wood'], (0.44, 0.03, 0.44), (0, 0.455, 0), bevel=0.01, segs=2)
    g.box(P['wood'], (0.42, 0.22, 0.02), (0, 0.72, -0.22), pitch=-0.1, bevel=0.008, segs=2)
    for sx in (-1, 1):
        g.cyl(P['metal'], 0.01, 0.35, (sx * 0.19, 0.46, -0.2), segs=6, pitch=-0.1)
    g.box(P['fabric'], (0.40, 0.03, 0.40), (0, 0.485, 0.0), bevel=0.012, segs=2, color=color)


def round_table(g, P, r=0.45, h=0.74, top='wood'):
    g.cyl(P[top], r, 0.03, (0, h - 0.03, 0), segs=28, bevel=0.005, bsegs=2)
    g.cyl(P['metal'], 0.035, h - 0.03, (0, 0, 0), segs=10)
    g.cyl(P['metal'], 0.24, 0.02, (0, 0, 0), r2=0.2, segs=18)


def round_planter(g, P, rng, r=1.4, h=0.55, tree_h=4.2, bench=True):
    """Big round concrete planter with a tree and an encircling timber bench."""
    g.cyl(P['concrete'], r, h, (0, 0, 0), segs=40, bevel=0.01, bsegs=2)
    g.cyl(P['soil'], r - 0.06, 0.01, (0, h - 0.04, 0), segs=32)
    tree(g, P, (0, h - 0.04, 0), tree_h, rng, crown=1.7, leaf_size=0.3, n=320)
    for i in range(12):
        a = TAU * i / 12
        bush(g, P, (math.cos(a) * (r - 0.4), h - 0.04, math.sin(a) * (r - 0.4)), 0.35, 0.35, rng, n=16)
    if bench:
        for k in range(24):  # bench as radial timber slats on a ring
            a0, a1 = TAU * k / 24, TAU * (k + 1) / 24
            pts = arc(0, 0, r + 0.5, a0, a1, 2) + list(reversed(arc(0, 0, r + 0.05, a0, a1, 2)))
            g.prism(P['wood'], pts, 0.42, 0.47, bevel=0.003)
        for k in range(8):
            a = TAU * k / 8
            g.box(P['metal'], (0.05, 0.42, 0.3), (math.cos(a) * (r + 0.28), 0.21, math.sin(a) * (r + 0.28)),
                  yaw=-a + math.pi / 2, bevel=0.003)
