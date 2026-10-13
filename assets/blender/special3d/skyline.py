"""Night City skyline (`skyline`): what the HQ sees through its curtain walls (world coordinates; the HQ floor
is y = 0, about 220 m above the streets).

Three depth bands of low-poly towers (band 0 near, z ∈ [−130, −55]; band 1 z ∈ [−260, −140]; band 2
z ∈ [−450, −270]), each with its own procedural window atlas material (`sky-win-b<band>`, so the renderer can
animate the bands separately), rooftop gear with aviation lights, 8 `ad` planes facing the HQ (the runtime
draws original ads on them), 6 `neon` signs with a flicker schedule, a glowing street grid far below, and
4 aerial `traffic` lanes (a faint light ribbon whose `extras.points` is the spline).
"""
import math

from . import props as X

PLACEMENT = {'x': 0.0, 'z': 0.0, 'yaw': 0.0}  # world placement (contract §1: translation + yaw)
BANDS = (
    dict(z=(-175.0, -85.0), x=(-200.0, 240.0), n=26, w=(14.0, 30.0), top=(-40.0, 90.0), fins=True),
    dict(z=(-330.0, -195.0), x=(-380.0, 420.0), n=40, w=(18.0, 40.0), top=(-20.0, 150.0), fins=False),
    dict(z=(-580.0, -350.0), x=(-640.0, 680.0), n=60, w=(22.0, 55.0), top=(0.0, 230.0), fins=False),
)
STREET_Y = -220.0
HQ = (-26.0, 70.0)  # keep-out x range (the HQ and its wing)


def build(g, A, P, rng):
    towers = []
    for b, band in enumerate(BANDS):
        towers += _band(g, P, rng, b, band)
    _ads(g, P, rng, towers)
    _neon(g, P, rng, towers)
    _streets(g, P, rng)
    _traffic(g, P)
    return dict(
        bounds={'minX': -640.0, 'maxX': 680.0, 'minZ': -580.0, 'maxZ': -85.0},
        extra={'placement': PLACEMENT, 'bands': len(BANDS), 'streetY': STREET_Y},
        sky=dict(strength=1.0),
        previews=[
            ('city', (0.0, 6.0, -30.0), (10.0, 10.0, -200.0), 24, False),
        ],
    )


def _band(g, P, rng, b, band):
    out = []
    (z0, z1), (x0, x1) = band['z'], band['x']
    win = P[f'win{b}']
    tries = 0
    while len(out) < band['n'] and tries < band['n'] * 30:
        tries += 1
        w = rng.uniform(*band['w'])
        d = w * rng.uniform(0.6, 1.2)
        x = rng.uniform(x0, x1)
        z = rng.uniform(z0, z1)
        if b == 0 and HQ[0] - 10 < x < HQ[1] + 10 and z > -105:
            continue  # leave a gap right in front of the glass
        if any(abs(x - t['x']) < (w + t['w']) / 2 + 6 and abs(z - t['z']) < (d + t['d']) / 2 + 6 for t in out):
            continue
        top = rng.uniform(*band['top'])
        h = top - STREET_Y
        t = dict(x=x, z=z, w=w, d=d, top=top, band=b)
        out.append(t)
        with g.at(x, z):
            if rng.random() < 0.35 and h > 120:  # setback tower
                h1 = h * rng.uniform(0.55, 0.75)
                g.box(win, (w, h1, d), (0, STREET_Y + h1 / 2, 0), bevel=0)
                g.box(P['roof'], (w + 0.6, 1.2, d + 0.6), (0, STREET_Y + h1 + 0.6, 0), bevel=0)
                w2, d2 = w * 0.65, d * 0.65
                g.box(win, (w2, h - h1, d2), (0, STREET_Y + h1 + (h - h1) / 2, 0), bevel=0)
                _roof(g, P, rng, w2, d2, top, b)
            else:
                g.box(win, (w, h, d), (0, STREET_Y + h / 2, 0), bevel=0)
                _roof(g, P, rng, w, d, top, b)
            if band['fins']:
                n = rng.randint(3, 6)
                for k in range(n):  # vertical fins on the HQ-facing side, a few with light lines
                    fx = -w / 2 + w * (k + 0.5) / n
                    g.box(P['tower'], (0.5, h - 4, 0.9), (fx, STREET_Y + (h - 4) / 2, d / 2 + 0.45), bevel=0)
                    if rng.random() < 0.3:
                        g.box(P[rng.choice(('neon_cyan', 'neon_magenta', 'neon_amber'))], (0.12, h * 0.4, 0.12),
                              (fx, top - h * 0.25, d / 2 + 0.92), bevel=0)
    return out


def _roof(g, P, rng, w, d, top, b):
    g.box(P['roof'], (w + 0.4, 1.0, d + 0.4), (0, top + 0.5, 0), bevel=0)
    if b == 2:
        return
    for _ in range(rng.randint(2, 5)):  # plant boxes
        bw, bd = rng.uniform(2, w * 0.3), rng.uniform(2, d * 0.3)
        g.box(P['roof'], (bw, rng.uniform(1.5, 4), bd), (rng.uniform(-w / 3, w / 3), top + 1.8, rng.uniform(-d / 3, d / 3)), bevel=0)
    if rng.random() < 0.6:  # antenna mast with aviation lights
        ah = rng.uniform(8, 26)
        ax, az = rng.uniform(-w / 4, w / 4), rng.uniform(-d / 4, d / 4)
        g.cyl(P['roof'], 0.35, ah, (ax, top + 1.0, az), segs=6, r2=0.12)
        g.sphere(P['neon_red'], 0.6, (ax, top + 1.0 + ah, az), segs=6, rings=4)
    for sx in (-1, 1):
        g.sphere(P['neon_red'], 0.4, (sx * w / 2, top + 1.2, d / 2), segs=6, rings=4)
    if rng.random() < 0.15:  # helipad ring
        g.torus(P['glow_acid'], min(w, d) * 0.3, 0.15, (0, top + 1.05, 0), segs=24, rsegs=4)


def _facing_hq(t):
    """A point on tower t's HQ-facing (+z) face and the face yaw (quads face +z)."""
    return t['x'], t['z'] + t['d'] / 2 + 0.6, 0.0


def _ads(g, P, rng, towers):
    cands = [t for t in towers if t['band'] < 2 and t['top'] > 10]
    cands.sort(key=lambda t: (t['band'], abs(t['x'] - 20)))
    picks = cands[:8]
    for i, t in enumerate(picks):
        x, z, yaw = _facing_hq(t)
        w = min(t['w'] * 0.85, rng.uniform(16, 30))
        h = w * rng.choice((9 / 16, 0.45, 1.6)) if t['band'] == 0 else w * 9 / 16
        y = t['top'] - h / 2 - rng.uniform(4, 18)
        with g.at(x, z, yaw):
            X.wall_frame(g, P['tower'], -w / 2 - 0.5, w / 2 + 0.5, y - h / 2 - 0.5, y + h / 2 + 0.5, -0.2, t=0.5)
            mat = P[('ad', 'ad1', 'ad2')[i % 3]]
            d = g.dynamic(f'ad-{i}', 'ad', f'ad:{i}', mat, pivot=(0, y, 0.0),
                          extras={'width': round(w, 2), 'height': round(h, 2), 'band': t['band']})
            with g.into(d):
                g.quad(mat, w, h, (0, y, 0.0))


def _neon(g, P, rng, towers):
    cands = [t for t in towers if t['band'] == 0][8:14]
    cols = ('neon_cyan', 'neon_magenta', 'neon_amber', 'neon_acid', 'neon_red', 'neon_magenta')
    for i, t in enumerate(cands):
        x, z, yaw = _facing_hq(t)
        c = cols[i % len(cols)]
        y = t['top'] - 12
        # flicker schedule: [seconds on, seconds off, …] looped; a phase per sign
        sched = [round(rng.uniform(2.0, 9.0), 2), round(rng.uniform(0.05, 0.25), 2), round(rng.uniform(0.3, 2.0), 2),
                 round(rng.uniform(0.05, 0.15), 2)]
        d = g.dynamic(f'neon-{i}', 'neon', f'neon:{i}', P[c], pivot=(x, y, z),
                      extras={'flicker': sched, 'phase': round(rng.uniform(0, 5), 2), 'color': c.split('_')[1]})
        with g.into(d), g.at(x, z, yaw):
            kind = i % 3
            if kind == 0:  # vertical bar sign
                g.box(P[c], (1.6, 18, 0.4), (0, y - 9, 0.3), bevel=0)
            elif kind == 1:  # ring
                g.torus(P[c], 5.0, 0.35, (0, y - 6, 0.4), segs=32, rsegs=4, pitch=math.pi / 2)
            else:  # stacked chevrons
                for k in range(3):
                    for s in (-1, 1):
                        g.box(P[c], (4.0, 0.6, 0.4), (s * 1.4, y - 4 - k * 2.4, 0.3), roll=s * 0.6, bevel=0)


def _streets(g, P, rng):
    g.plane_y(P['charcoal'], -660, 700, -600, -60, STREET_Y)
    for x in range(-640, 681, 40):  # avenues (z) and streets (x), a glowing grid
        g.box(P['cityglow'], (2.0, 0.2, 540), (x + rng.uniform(-6, 6), STREET_Y + 0.2, -330), bevel=0)
    for z in range(-580, -60, 36):
        g.box(P['cityglow'], (1340, 0.2, 1.6), (20, STREET_Y + 0.2, z + rng.uniform(-5, 5)), bevel=0)


def _traffic(g, P):
    """Aerial traffic lanes: closed splines (module coords) carried in extras.points (x, y, z triplets)."""
    lanes = [
        ('lane-0', 18.0, [(-300, -70), (-100, -76), (60, -66), (260, -80), (420, -100)], 22.0),
        ('lane-1', 42.0, [(380, -150), (150, -138), (-40, -160), (-260, -150), (-420, -170)], 28.0),
        ('lane-2', -6.0, [(-360, -105), (-120, -118), (120, -104), (360, -120)], 18.0),
        ('lane-3', 70.0, [(-200, -300), (0, -230), (220, -260), (420, -320)], 34.0),
    ]
    for i, (name, y, pts, speed) in enumerate(lanes):
        flat = []
        for x, z in pts:
            flat += [float(x), float(y), float(z)]
        d = g.dynamic(f'traffic-{i}', 'traffic', name, P['traffic'], pivot=(pts[0][0], y, pts[0][1]),
                      extras={'points': flat, 'stride': 3, 'closed': False, 'speed': speed, 'lanes': 2})
        with g.into(d):
            for (ax, az), (bx, bz) in zip(pts, pts[1:]):
                L = math.hypot(bx - ax, bz - az)
                yaw = math.atan2(bx - ax, bz - az)
                for off in (-1.2, 1.2):
                    ox, oz = off * math.cos(yaw), -off * math.sin(yaw)
                    g.box(P['traffic'], (0.06, 0.03, L), ((ax + bx) / 2 + ox, y, (az + bz) / 2 + oz), yaw=yaw, bevel=0)
