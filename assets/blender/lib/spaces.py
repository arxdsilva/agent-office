"""Project spaces of the atrium (contract §4/§5, additive): Project Hub (Project Directory kiosk, Context Hub
core with a ring of wall consoles), Handoff Station and the Session Archive alcoves.

Original geometry, mood only: a control room with a glowing core, a lobby with a stepped dais, a library with
arched book alcoves. No text objects and no logos (the runtime labels the spaces). Every builder works in the
atrium's local frame (x → east, z → south of the street, floor at y = 0) and registers anchors, ports,
colliders and floor-plan furniture itself.
"""
import math

from lib import furniture as F
from lib import materials as M

TAU = 2 * math.pi

# Context Hub geometry (one place, shared by the builders and the nav in modules/atrium.py)
CORE = (-14.6, -20.6)
CONSOLE_R = 2.3  # pylon ring radius around the core
CONSOLE_STAND_R = 3.1  # where the visitor stands (outside the ring, facing the core)
CONSOLE_APPROACH_R = 3.7
CONSOLE_ANGLES = [math.radians(25 + 26 * i) for i in range(6)]
KIOSK = (-12.6, -15.6)
HANDOFF = (-6.0, -7.4)
ARCHIVE_X0, ARCHIVE_FRONT_Z, ARCHIVE_BAYS, ARCHIVE_BAY_W, ARCHIVE_H = -10.6, -22.55, 12, 0.85, 3.5


def materials(P, t=None):
    """Emissive accents that bake into the lightmap (cyan context glow, warm handoff glow); a theme's
    optional `emit_max` caps their strength (Horizon)."""
    cap = (t or {}).get('emit_max')
    k = (lambda s: s) if cap is None else (lambda s: min(s, cap))
    P['hubglow'] = M.pbr('hub-glow', base='#9fe8f0', emission='#66d9e8', strength=k(2.2), bake_emit=True).name
    P['hubwarm'] = M.pbr('hub-warm', base='#f6d7a0', emission='#f2b45a', strength=k(1.8), bake_emit=True).name


def console_pose(i):
    """(pylon x, z, pylon yaw, stand x, z, visitor heading, approach x, z) for console i."""
    a = CONSOLE_ANGLES[i]
    c, s = math.cos(a), math.sin(a)
    cx, cz = CORE
    return (cx + CONSOLE_R * c, cz + CONSOLE_R * s, math.atan2(c, s),
            cx + CONSOLE_STAND_R * c, cz + CONSOLE_STAND_R * s, math.atan2(-c, -s),
            cx + CONSOLE_APPROACH_R * c, cz + CONSOLE_APPROACH_R * s)


# ============================================================================== Project Hub
def project_hub(g, A, P, t, H):
    _context_core(g, P, H, t.get('hub_floor', '#1d2a33'))
    for i in range(6):
        _console(g, A, P, i)
    _kiosk(g, A, P)
    if t['decor'].get('kiosk_ring'):  # contract §14 (Horizon): a soft ring of light under the kiosk
        g.torus(P['line'], 1.45, 0.012, (KIOSK[0], 0.012, KIOSK[1] + 0.02), segs=64, rsegs=4)


def _context_core(g, P, H, floor='#1d2a33'):
    cx, cz = CORE
    # floor inlay: dark disc with two glowing rings
    g.cyl(P['paint'], 3.25, 0.012, (cx, 0, cz), segs=64, color=floor)
    g.torus(P['hubglow'], 3.05, 0.014, (cx, 0.018, cz), segs=72, rsegs=4)
    g.torus(P['hubglow'], 1.55, 0.014, (cx, 0.018, cz), segs=56, rsegs=4)
    # plinth, collars
    g.cyl(P['metal'], 1.05, 0.26, (cx, 0.012, cz), segs=40, r2=0.95)
    g.torus(P['hubglow'], 0.98, 0.018, (cx, 0.27, cz), segs=48, rsegs=4)
    g.cyl(P['metal'], 0.62, 0.12, (cx, 0.27, cz), segs=32)
    g.cyl(P['metal'], 0.62, 0.12, (cx, 3.5, cz), segs=32)
    g.torus(P['hubglow'], 0.6, 0.02, (cx, 3.5, cz), segs=40, rsegs=4)
    # glass sleeve around the glowing core
    with g.in_group('glass'):
        g.cyl(P['glass'], 0.52, 3.1, (cx, 0.39, cz), segs=32, caps=False)
    # floating gyro rings
    for k, (y, R, pitch, yaw) in enumerate(((1.15, 0.8, 0.32, 0.0), (2.0, 0.9, -0.3, 1.2), (2.85, 0.78, 0.28, 2.3))):
        g.torus(P['steel'], R, 0.016, (cx, y, cz), segs=48, rsegs=6, pitch=pitch, yaw=yaw)
    # the core itself: one runtime node (role screen), emissive strength follows context retrievals
    d = g.dynamic('context-core', 'screen', 'context-core', P['screen'], pivot=(cx, 2.0, cz),
                  extras={'width': 0.6, 'height': 3.0})
    with g.into(d):
        g.cyl(P['screen'], 0.3, 3.0, (cx, 0.45, cz), segs=28)
    g.light('point', (cx, 2.0, cz), radius=0.2, power=90, kelvin=7000)
    F.ring_pendant(g, P, (cx, 5.2, cz), R=1.2, kelvin=5000, power=200, y_ceiling=H)
    g.furn('context-core', 2.1, 2.1, x=cx, z=cz)
    g.collider(cx - 1.05, cx + 1.05, cz - 1.05, cz + 1.05, 0, 3.7)


def _console(g, A, P, i):
    px, pz, yaw, sx, sz, heading, ax, az = console_pose(i)
    with g.at(px, pz, yaw):
        g.furn('console', 0.72, 0.4)
        g.box(P['metal'], (0.62, 0.9, 0.34), (0, 0.45, 0), bevel=0.01, segs=2)
        g.box(P['hubglow'], (0.56, 0.018, 0.012), (0, 0.07, 0.172), bevel=0)
        g.box(P['metal'], (0.72, 0.5, 0.05), (0, 1.18, -0.02), pitch=-0.35, bevel=0.008, segs=2)
        g.box(P['black'], (0.5, 0.03, 0.14), (0, 0.93, 0.13), bevel=0.004)
        for k in range(5):
            g.box(P['hubglow' if k % 2 == 0 else 'hubwarm'], (0.05, 0.012, 0.04), (-0.18 + k * 0.09, 0.948, 0.13), bevel=0)
        d = g.dynamic(f'context-{i}', 'screen', f'context:{i}', P['screen'], pivot=(0, 1.2, 0.03),
                      extras={'width': 0.64, 'height': 0.42})
        with g.into(d):
            g.quad(P['screen'], 0.64, 0.42, (0, 1.2, 0.03), pitch=-0.35)
    g.collider(px - 0.4, px + 0.4, pz - 0.4, pz + 0.4, 0, 1.5)
    A.spot(f'console:context:{i}', sx, sz, heading, room='hub', approach=(ax, az), hubs=[])


def _kiosk(g, A, P):
    kx, kz = KIOSK
    with g.at(kx, kz):
        g.furn('kiosk', 2.0, 1.5, z=0.02)
        # the central staircase: three stepped tiers with a lit nosing, facing +z
        for k, (hw, y0, y1, z0, z1) in enumerate(((1.0, 0, 0.12, -0.7, 0.75), (0.82, 0.12, 0.24, -0.7, 0.6),
                                                  (0.64, 0.24, 0.36, -0.7, 0.45))):
            g.box_b(P['stone'], -hw, hw, y0, y1, z0, z1, bevel=0.006, segs=2)
            g.box_b(P['hubglow'], -hw + 0.04, hw - 0.04, y1 - 0.012, y1, z1 - 0.012, z1 + 0.002, bevel=0)
        # pylon with a wide directory screen (static: tiles for projects, no text)
        g.box(P['metal'], (0.16, 2.5, 0.12), (0, 1.61, -0.3), bevel=0.006, segs=2)
        g.box(P['metal'], (1.6, 1.06, 0.06), (0, 1.9, -0.18), bevel=0.008, segs=2)
        g.box(P['screen'], (1.5, 0.96, 0.01), (0, 1.9, -0.145), bevel=0)
        cols = ('hubglow', 'hubwarm', 'light', 'hubglow', 'light', 'hubwarm')
        for r in range(2):
            for c in range(3):
                g.box(P[cols[r * 3 + c]], (0.42, 0.26, 0.006), (-0.5 + c * 0.5, 2.1 - r * 0.38, -0.137), bevel=0)
        g.box(P['hubglow'], (1.4, 0.03, 0.006), (0, 1.58, -0.137), bevel=0)
        g.box(P['hubglow'], (1.5, 0.012, 0.012), (0, 2.4, -0.14), bevel=0)
        g.light('panel', (0, 3.0, 0.5), size=(1.6, 0.4), power=50, kelvin=5500)
    g.collider(kx - 1.0, kx + 1.0, kz - 0.7, kz + 0.75, 0, 2.7)
    A.spot('kiosk:project-directory', kx, kz + 1.1, math.pi, room='hub', approach=-0.6, hubs=[])


# ============================================================================== Handoff Station
def handoff(g, A, P, H, t=None):
    hx, hz = HANDOFF
    floor = (t or {}).get('handoff_floor', '#2b3440')
    g.furn('rug', 3.7, 3.7, x=hx, z=hz)
    g.cyl(P['paint'], 1.85, 0.012, (hx, 0, hz), segs=56, color=floor)
    g.torus(P['hubwarm'], 1.77, 0.014, (hx, 0.018, hz), segs=64, rsegs=4)
    for sgn in (-1, 1):  # docking pads under each person, with a chevron toward the middle
        g.torus(P['hubwarm'], 0.34, 0.012, (hx + sgn * 1.5, 0.018, hz), segs=28, rsegs=4)
        g.cyl(P['paint'], 0.36, 0.012, (hx + sgn * 1.5, 0.0, hz), segs=24, color=floor)
        for k in range(3):
            g.box(P['hubwarm'], (0.07, 0.008, 0.28), (hx + sgn * (0.72 - k * 0.14), 0.018, hz), bevel=0)
    # the pedestal that carries the handoff "package"
    g.furn('handoff-pad', 0.8, 0.8, x=hx, z=hz)
    g.cyl(P['stone'], 0.3, 0.9, (hx, 0.012, hz), segs=28, r2=0.24)
    g.cyl(P['brass'], 0.38, 0.04, (hx, 0.9, hz), segs=28)
    g.box(P['hubwarm'], (0.2, 0.07, 0.3), (hx, 0.97, hz), bevel=0.01, segs=2)
    g.box(P['white'], (0.22, 0.012, 0.12), (hx, 1.015, hz), bevel=0)
    g.torus(P['hubwarm'], 0.3, 0.012, (hx, 0.9, hz), segs=28, rsegs=4)
    g.light('point', (hx, 1.3, hz), radius=0.1, power=25, kelvin=2700)
    g.collider(hx - 0.42, hx + 0.42, hz - 0.42, hz + 0.42, 0, 1.05)
    A.spot('spot:handoff:0', hx - 1.5, hz, math.pi / 2, room='plaza', approach=-0.6, hubs=[])
    A.spot('spot:handoff:1', hx + 1.5, hz, -math.pi / 2, room='plaza', approach=-0.6, hubs=[])


# ============================================================================== Session Archive
def archive(g, A, P, rng):
    """Twelve arched book alcoves in one arcade on the facade side of the plaza, facing +z. Each alcove is
    one archive volume (port:archive:<i>, left to right)."""
    n, bw, h = ARCHIVE_BAYS, ARCHIVE_BAY_W, ARCHIVE_H
    w, d = n * bw, 0.7
    cols = ('#5b2a1f', '#1f3a4d', '#2f4a36', '#6b4f2a', '#3a2f4a', '#7a1f2b', '#2b2b2b', '#c9b48a', '#8a5a3b')
    with g.at(ARCHIVE_X0, ARCHIVE_FRONT_Z):
        g.furn('archive-alcove', w, d + 0.02, x=w / 2, z=-(d + 0.02) / 2)
        g.box_b(P['wood_dark'], 0, w, 0, h, -d, -d + 0.04, bevel=0)  # back panel
        g.box_b(P['wood_dark'], 0, w, 0, 0.28, -d, 0.02, bevel=0.004)  # plinth
        g.box_b(P['wood_dark'], -0.04, w + 0.04, 2.95, h, -d, 0.02, bevel=0.005, segs=2)  # frieze
        g.box_b(P['brass'], -0.07, w + 0.07, h, h + 0.06, -d - 0.04, 0.07, bevel=0.004)  # cornice
        for k in range(n + 1):  # pilasters
            g.box_b(P['wood_dark'], k * bw - 0.05, k * bw + 0.05, 0.28, 2.95, -d, 0.02, bevel=0.004)
        spring, r_in, thick = 2.45, bw / 2 - 0.05, 0.1
        for i in range(n):
            cx = (i + 0.5) * bw
            # arch ring (voussoirs that also form the vault), then the stone keystone
            segs = 9
            r_mid = r_in + thick / 2
            tangent = 2 * (r_in + thick) * math.tan(math.pi / (2 * segs)) * 1.04
            for s in range(segs):
                phi = math.pi * (s + 0.5) / segs
                g.box(P['stone'], (tangent, thick, d - 0.04),
                      (cx + r_mid * math.cos(phi), spring + r_mid * math.sin(phi), -d / 2 + 0.01),
                      roll=phi - math.pi / 2, bevel=0)
            # alcove shelves: floor + one mid shelf, each with a row of books
            for y in (0.28, 1.3):
                g.box_b(P['wood_dark'], cx - r_in, cx + r_in, y, y + 0.03, -d + 0.04, 0, bevel=0.003)
            for y in (0.31, 1.33):
                x = cx - r_in + 0.03
                while x < cx + r_in - 0.08:
                    bw_ = rng.uniform(0.04, 0.075)
                    bh = rng.uniform(0.28, 0.5) if y > 1 else rng.uniform(0.3, 0.7)
                    g.box(P['paint'], (bw_, bh, rng.uniform(0.2, 0.3)), (x + bw_ / 2, y + bh / 2, -0.3),
                          color=rng.choice(cols), bevel=0)
                    x += bw_ + 0.004
            # the volume: a tall binder in the middle with a lit spine band = the archive port
            g.box(P['paint'], (0.12, 0.62, 0.3), (cx, 1.3 + 0.03 + 0.31 + 0.0, -0.2), color='#2a2724', bevel=0.004)
            g.box(P['hubwarm'], (0.09, 0.05, 0.006), (cx, 1.33 + 0.4, -0.048), bevel=0)
            A.port(f'port:archive:{i}', cx, 1.33 + 0.31, -0.04)
            g.box(P['light_warm'], (0.12, 0.012, 0.1), (cx, spring + r_in - 0.02, -0.15), bevel=0)
        g.light('wallwash', (w / 2, 4.2, 0.9), size=(w, 0.12), power=80, kelvin=2700, dir=(0, -0.7, -0.7))
    g.collider(ARCHIVE_X0, ARCHIVE_X0 + w, ARCHIVE_FRONT_Z - 0.72, ARCHIVE_FRONT_Z + 0.02, 0, h)
    # two reading lecterns in front of the arcade
    for lx in (ARCHIVE_X0 + 2.55, ARCHIVE_X0 + 7.65):
        _lectern(g, P, lx, ARCHIVE_FRONT_Z + 1.05)


def _lectern(g, P, x, z):
    with g.at(x, z):
        g.furn('lectern', 0.6, 0.5)
        g.box(P['wood_dark'], (0.34, 0.9, 0.3), (0, 0.45, 0), bevel=0.006, segs=2)
        g.box(P['wood_dark'], (0.56, 0.04, 0.42), (0, 1.0, 0.0), pitch=-0.45, bevel=0.005)
        g.box(P['brass'], (0.56, 0.02, 0.03), (0, 0.9, 0.2), bevel=0.003)
        g.box(P['paint'], (0.4, 0.04, 0.3), (0, 1.045, 0.0), pitch=-0.45, color='#efe7d6', bevel=0)
        g.box(P['light_warm'], (0.3, 0.012, 0.02), (0, 1.2, -0.12), bevel=0)
    g.collider(x - 0.32, x + 0.32, z - 0.27, z + 0.27, 0, 1.2)
