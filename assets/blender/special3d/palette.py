"""Night City materials (docs/special-3d/art-direction.md): PBR surfaces + procedural emissive neon.

Palette: charcoal #0d0f12, graphite #1a1d22, navy #0f1a2a, brushed steel; accents cyan #29e3ff,
magenta #ff2bd6, amber #ffb02e, acid yellow #d7ff3a, deep red #e0202e.

Textures are either pinned CC0 Poly Haven maps (polyhaven.json) or generated here with numpy (brushed
streaks, carbon twill, puddle roughness, window atlases, hazard stripes): original work, no photos, no text.
Every generated image is packed into the .blend so the glTF exporter embeds it (then WebP in the build).
"""
import math

import bpy
import numpy as np

from lib import materials as M

CHARCOAL, GRAPHITE, NAVY = '#0d0f12', '#1a1d22', '#0f1a2a'
CYAN, MAGENTA, AMBER, ACID, RED = '#29e3ff', '#ff2bd6', '#ffb02e', '#d7ff3a', '#e0202e'
ACCENTS = {'cyan': CYAN, 'magenta': MAGENTA, 'amber': AMBER, 'acid': ACID, 'red': RED}

_imgs = {}


def reset():
    _imgs.clear()


# ------------------------------------------------------------------------------- generated images
def _image(name, rgba, color=True):
    """rgba: float (h, w, 4) in [0, 1], row 0 = top. Packed 8-bit image."""
    if name in _imgs:
        return _imgs[name]
    h, w, _ = rgba.shape
    img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], dtype=np.float32).ravel())
    img.pack()
    img.file_format = 'PNG'
    _imgs[name] = img
    return img


def _noise(shape, scale, seed, octaves=4):
    """Tileable value noise (sum of octaves of bilinear random grids), in [0, 1]."""
    r = np.random.default_rng(seed)
    h, w = shape
    out = np.zeros(shape, np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = max(2, int(scale * 2 ** o))
        g = r.random((n, n)).astype(np.float32)
        y = np.linspace(0, n, h, endpoint=False)
        x = np.linspace(0, n, w, endpoint=False)
        y0, x0 = np.floor(y).astype(int), np.floor(x).astype(int)
        fy, fx = (y - y0)[:, None], (x - x0)[None, :]
        fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
        a = g[y0 % n][:, x0 % n]
        b = g[y0 % n][:, (x0 + 1) % n]
        c = g[(y0 + 1) % n][:, x0 % n]
        d = g[(y0 + 1) % n][:, (x0 + 1) % n]
        out += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
        tot += amp
        amp *= 0.5
    return out / tot


def _normal_from_height(hgt, strength):
    gy, gx = np.gradient(hgt.astype(np.float32))
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(hgt)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5
    return np.concatenate([n, np.ones(hgt.shape + (1,), np.float32)], -1)


def brushed_normal(size=512, seed=3):
    r = np.random.default_rng(seed)
    rows = r.random(size).astype(np.float32)
    rows = np.convolve(np.tile(rows, 3), np.ones(3) / 3, 'same')[size:2 * size]
    hgt = np.repeat(rows[:, None], size, axis=1) + 0.15 * _noise((size, size), 8, seed + 1, 3)
    return _image('gen-brushed-nor', _normal_from_height(hgt, 2.5), color=False)


def carbon_maps(size=512, cells=16):
    """2×2 twill weave: base colour (dark with a sheen ramp per tow) and a normal map."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size * cells
    cx, cy = np.floor(x).astype(int), np.floor(y).astype(int)
    horiz = ((cx + cy) // 2) % 2 == 0
    fx, fy = x - cx, y - cy
    across = np.where(horiz, fy, fx)
    tow = np.sin(across * math.pi)  # rounded tow profile
    sheen = np.where(horiz, 0.75 + 0.25 * np.sin(fx * math.pi), 0.55 + 0.25 * np.sin(fy * math.pi))
    v = 0.035 + 0.06 * tow * sheen
    base = np.stack([v * 0.95, v, v * 1.08, np.ones_like(v)], -1)
    return (_image('gen-carbon-col', base), _image('gen-carbon-nor', _normal_from_height(tow, 1.4), color=False))


def puddle_arm(size=512, seed=11, dry=0.42, wet=0.08):
    """ARM (R occlusion, G roughness, B metal): broad wet patches and a fine grain."""
    n = _noise((size, size), 6, seed, 4)
    mask = np.clip((n - 0.62) / 0.1, 0, 1) * 0.6  # 1 = puddle (sparse, soft-edged, never mirror-black)
    grain = _noise((size, size), 48, seed + 5, 2)
    rough = dry * (0.8 + 0.4 * grain) * (1 - mask) + wet * mask
    one = np.ones_like(rough)
    return _image(f'gen-puddle-arm-{seed}', np.stack([one, np.clip(rough, 0.02, 1), 0 * one, one], -1), color=False)


def hazard_stripes(size=256):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    s = ((x + y) * 6) % 1.0 < 0.5
    col = np.where(s[..., None], np.array((0.86, 0.8, 0.08, 1), np.float32), np.array((0.03, 0.03, 0.035, 1), np.float32))
    return _image('gen-hazard', col)


def window_atlas(variant, size=1024, cols=32, rows=16, seed=0):
    """Tower facade atlas: rows × cols windows (one per floor and bay), emission and base colour.
    variant: 'warm' offices, 'cool' labs, 'sparse' residential at night."""
    r = np.random.default_rng(100 + seed)
    lit_p = {'warm': 0.34, 'cool': 0.3, 'sparse': 0.14}[variant]
    pal = {
        'warm': ((1.0, 0.74, 0.42), (1.0, 0.86, 0.62), (0.9, 0.95, 1.0)),
        'cool': ((0.55, 0.85, 1.0), (0.75, 0.95, 1.0), (1.0, 0.5, 0.95)),
        'sparse': ((1.0, 0.7, 0.4), (0.6, 0.85, 1.0), (1.0, 0.45, 0.3)),
    }[variant]
    emit = np.zeros((size, size, 4), np.float32)
    base = np.zeros((size, size, 4), np.float32)
    ch, cw = size // rows, size // cols
    base[..., :3] = (0.05, 0.055, 0.065)
    base[..., 3] = 1
    emit[..., 3] = 1
    for j in range(rows):
        for i in range(cols):
            y0, x0 = j * ch, i * cw
            # glass pane inside the bay, leaving a mullion/spandrel frame
            gy0, gy1, gx0, gx1 = y0 + int(ch * 0.22), y0 + int(ch * 0.84), x0 + int(cw * 0.14), x0 + int(cw * 0.86)
            base[gy0:gy1, gx0:gx1, :3] = (0.015, 0.02, 0.03)
            # lit windows cluster by floor (whole office floors on or off), with stray singles
            floor_on = (j * 7 + seed * 3) % 5 < 2
            if r.random() < (lit_p * (1.8 if floor_on else 0.45)):
                c = np.array(pal[r.choice(len(pal), p=(0.6, 0.3, 0.1))], np.float32) * r.uniform(0.35, 1.0)
                blind = r.random() < 0.3
                pane = emit[gy0:gy1, gx0:gx1, :3]
                pane[:] = c
                if blind:  # horizontal blinds
                    pane[::3] *= 0.25
                # a dim inner gradient (rooms are brighter near the ceiling)
                grad = np.linspace(1.0, 0.65, gy1 - gy0, dtype=np.float32)[:, None, None]
                emit[gy0:gy1, gx0:gx1, :3] = pane * grad
    return (_image(f'gen-win-{variant}-col', base), _image(f'gen-win-{variant}-emit', emit))


def _disc(img, cx, cy, r0, r1, col, a0=0.0, a1=math.tau):
    h, w, _ = img.shape
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.hypot(x - cx, y - cy)
    ang = (np.arctan2(y - cy, x - cx)) % math.tau
    m = (d >= r0) & (d <= r1) & (ang >= a0) & (ang <= a1)
    img[m, :3] = col


def _line(img, pts, col, t=1.5):
    h, w, _ = img.shape
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
        for k in range(n):
            x = x0 + (x1 - x0) * k / n
            y = y0 + (y1 - y0) * k / n
            img[int(max(0, y - t)):int(min(h, y + t)), int(max(0, x - t)):int(min(w, x + t)), :3] = col


def ui_atlas(size=1024, seed=5):
    """Abstract operations dashboard (no text): panels, bar charts, ring gauges, line graphs, a node map."""
    r = np.random.default_rng(seed)
    img = np.zeros((size // 2, size, 4), np.float32)
    img[..., :3] = (0.004, 0.012, 0.03)
    img[..., 3] = 1
    h, w = img.shape[:2]
    cy, mg, am, wh = (0.05, 0.75, 1.0), (1.0, 0.1, 0.75), (1.0, 0.6, 0.1), (0.75, 0.9, 1.0)
    img[::32, :, :3] += 0.02
    img[:, ::32, :3] += 0.02
    panels = [(16, 16, 330, 230), (346, 16, 330, 230), (676, 16, 332, 230), (16, 262, 500, 234), (532, 262, 476, 234)]
    for (x, y, pw, ph) in panels:
        img[y:y + ph, x:x + pw, :3] = img[y:y + ph, x:x + pw, :3] * 0.6 + np.array((0.01, 0.03, 0.06)) * 0.4
        img[y:y + 3, x:x + pw, :3] = cy
        img[y:y + ph, x:x + 2, :3] = (0.03, 0.25, 0.35)
    x, y = 36, 40  # bars
    for k in range(12):
        bh = int(r.uniform(30, 170))
        img[y + 180 - bh:y + 180, x + k * 24:x + k * 24 + 14, :3] = mg if k % 4 == 3 else cy
    _disc(img, 511, 131, 70, 82, (0.05, 0.12, 0.18))  # gauges
    _disc(img, 511, 131, 70, 82, cy, 0, math.tau * 0.72)
    _disc(img, 511, 131, 50, 58, am, 0, math.tau * 0.41)
    _disc(img, 511, 131, 6, 12, wh)
    for k in range(3):
        _disc(img, 730 + k * 95, 131, 30, 37, (0.05, 0.12, 0.18))
        _disc(img, 730 + k * 95, 131, 30, 37, (cy, mg, am)[k], 0, math.tau * r.uniform(0.3, 0.9))
    for col, amp in ((cy, 60), (mg, 40), (am, 25)):  # line graphs
        pts = [(36 + i * 9.4, 380 + amp * math.sin(i * 0.33 + amp) + r.uniform(-12, 12)) for i in range(50)]
        _line(img, pts, col, 1.6)
    nodes = [(r.uniform(560, 990), r.uniform(290, 480)) for _ in range(14)]  # node map
    for i, a in enumerate(nodes):
        b = nodes[(i * 5 + 3) % len(nodes)]
        _line(img, [a, b], (0.05, 0.35, 0.45), 0.8)
    for i, (nx, ny) in enumerate(nodes):
        _disc(img, nx, ny, 0, 7, (am if i % 5 == 0 else cy))
        _disc(img, nx, ny, 10, 12, (0.1, 0.4, 0.55))
    return _image('gen-ui-atlas', np.clip(img, 0, 1))


def ad_image(variant, size=512):
    """Original abstract advertisement art (no text, no marks): gradients, geometry, a glow."""
    y, x = np.mgrid[0:size // 2, 0:size].astype(np.float32)
    u, v = x / size, y / (size // 2)
    img = np.zeros((size // 2, size, 4), np.float32)
    img[..., 3] = 1
    if variant == 0:  # magenta → violet sunset with rings
        img[..., 0] = 0.9 - 0.5 * v
        img[..., 1] = 0.05 + 0.1 * u
        img[..., 2] = 0.5 + 0.4 * v
        d = np.hypot(u - 0.68, (v - 0.5) * 0.5)
        ring = (np.sin(d * 90) > 0.6) & (d < 0.3)
        img[ring, :3] = (1.0, 0.85, 0.95)
    elif variant == 1:  # amber product glow on charcoal with diagonal bands
        img[..., :3] = (0.05, 0.04, 0.04)
        band = ((u * 3 + v) % 1.0) < 0.12
        img[band, :3] = (1.0, 0.55, 0.1)
        g = np.exp(-((u - 0.3) ** 2 + (v - 0.5) ** 2 * 0.3) / 0.01)
        img[..., :3] += g[..., None] * np.array((1.0, 0.7, 0.3))
    else:  # cyan/acid split with triangles
        img[..., :3] = np.where((u > 0.5)[..., None], (0.02, 0.6, 0.75), (0.6, 0.85, 0.08))
        tri = (np.abs(u - 0.5) * 2 + v < 0.9) & (v > 0.2)
        img[tri, :3] = (0.02, 0.03, 0.05)
    return _image(f'gen-ad-{variant}', np.clip(img, 0, 1))


# ------------------------------------------------------------------------------------- node helpers
def _node_img(nt, img, loc):
    n = nt.nodes.new('ShaderNodeTexImage')
    n.image = img
    n.location = loc
    return n


def _attach(m, base=None, normal=None, normal_strength=1.0, arm=None, rough_scale=1.0, emission=None,
            emission_strength=None):
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    if base is not None:
        b = _node_img(nt, base, (-900, 300))
        nt.links.new(b.outputs['Color'], p.inputs['Base Color'])
    if normal is not None:
        old = [l for l in nt.links if l.to_socket == p.inputs['Normal']]
        for l in old:
            nt.links.remove(l)
        n = _node_img(nt, normal, (-900, -350))
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(n.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    if arm is not None:
        a = _node_img(nt, arm, (-1100, 0))
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(a.outputs['Color'], sep.inputs['Color'])
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = rough_scale
        nt.links.new(sep.outputs['Green'], mul.inputs[0])
        nt.links.new(mul.outputs['Value'], p.inputs['Roughness'])
    if emission is not None:
        e = _node_img(nt, emission, (-900, 0))
        nt.links.new(e.outputs['Color'], p.inputs['Emission Color'])
        if emission_strength is not None:
            p.inputs['Emission Strength'].default_value = emission_strength
    return m


def neon(name, color, strength=6.0, bake=True):
    """Procedural emissive (constant colour); `bake` lets its glow light the lightmap."""
    return M.pbr(name, base=color, rough=0.5, emission=color, strength=strength, bake_emit=bake).name


# -------------------------------------------------------------------------------------------- build
def build():
    """Create every Night City material; returns {key: material name} (the module code's P)."""
    reset()
    P = {}

    def add(key, name, **kw):
        P[key] = M.pbr(name, **kw).name
        return M.get(P[key])

    # floors: polished dark stone (atrium), wet sealed concrete (command), both with puddle roughness
    m = add('floor', 'nc-floor-stone', tex='granite_tile', base='#4a4e57', rough=0.2, tile=2.4, normal=0.5, spec=0.6)
    _attach(m, arm=puddle_arm(seed=11, dry=0.24, wet=0.1))
    m = add('floor_wet', 'nc-floor-wet-concrete', tex='hangar_concrete_floor', base='#575b63', rough=0.3, tile=3.0,
            normal=0.6)
    _attach(m, arm=puddle_arm(seed=23, dry=0.45, wet=0.16))
    add('concrete', 'nc-concrete-panels', tex='concrete_panels', base='#3d4047', rough=0.5, tile=4.0, normal=0.7,
        rough_tex=True)
    add('stone', 'nc-polished-stone', tex='marble_01', base='#2a2c33', rough=0.12, tile=1.6, normal=0.3, spec=0.7)
    add('steel_plate', 'nc-painted-steel', tex='metal_plate', base='#2b3038', rough=0.5, metal=0.6, tile=1.5,
        normal=0.8, rough_tex=True)
    add('grate', 'nc-floor-plate', tex='metal_plate', base='#3a3f47', rough=0.45, metal=0.8, tile=1.0, normal=1.0,
        rough_tex=True)
    m = add('brushed', 'nc-brushed-metal', base='#a9b0b8', rough=0.32, metal=1.0, tile=0.6)
    _attach(m, normal=brushed_normal(), normal_strength=0.35)
    m = add('brushed_dark', 'nc-brushed-dark', base='#4a5059', rough=0.3, metal=1.0, tile=0.6)
    _attach(m, normal=brushed_normal(), normal_strength=0.35)
    col, nor = carbon_maps()
    m = add('carbon', 'nc-carbon-panel', base='#ffffff', rough=0.28, tile=0.5, coat=0.4)
    _attach(m, base=col, normal=nor, normal_strength=0.5)
    m = add('hazard', 'nc-hazard-paint', base='#ffffff', rough=0.6, tile=0.8)
    _attach(m, base=hazard_stripes())
    add('graphite', 'nc-graphite', base=GRAPHITE, rough=0.55, metal=0.2)
    add('charcoal', 'nc-charcoal', base=CHARCOAL, rough=0.6)
    add('navy', 'nc-navy-paint', base=NAVY, rough=0.5)
    add('paint', 'nc-paint', base='#ffffff', rough=0.5, vcol=True)
    add('rubber', 'nc-rubber', base='#121315', rough=0.85)
    add('leather', 'nc-leather', tex='leather_white', base='#3a2a22', rough=0.42, tile=0.6, normal=0.5)
    add('fabric', 'nc-fabric', tex='cotton_jersey', base='#2a2d33', rough=0.9, tile=0.6, normal=0.6)
    add('ceiling', 'nc-ceiling', base='#16181d', rough=0.8)
    add('white', 'nc-manifestation', base='#8f9aa5', rough=0.5)
    # the shared kit (lib/geometry.glass_partition, curtain_wall) reads these keys
    P['metal'] = P['brushed_dark']
    P['wall'] = P['concrete']
    add('black', 'nc-black-glass', base='#06070a', rough=0.08, spec=0.8)
    add('wood', 'nc-bonsai-bark', tex='walnut_veneer', base='#5a4030', rough=0.7, tile=0.4, normal=0.8)
    add('soil', 'nc-gravel', base='#22201e', rough=1.0)
    add('leaf', 'nc-foliage', base='#ffffff', rough=0.6, vcol=True, double_sided=True, spec=0.3)
    # glass
    P['glass'] = M.pbr('nc-dark-glass', base='#0b1220', rough=0.04, alpha=0.3, spec=0.7).name
    P['rainglass'] = M.pbr('rain-glass', base='#9fb8d0', rough=0.03, alpha=0.1, spec=0.7).name
    P['frosted'] = M.pbr('nc-frosted', base='#c8d6e0', rough=0.55, alpha=0.5, spec=0.5).name
    # emissive accents (baked bounce) and fixtures (replaced by area lights in the bake)
    for k, c in ACCENTS.items():
        P[f'neon_{k}'] = neon(f'nc-neon-{k}', c, 6.0)
        P[f'glow_{k}'] = neon(f'nc-glow-{k}', c, 2.0)
    P['light_cool'] = M.pbr('nc-fixture-cool', base='#cfefff', emission='#8fe3ff', strength=1.4).name
    P['light_warm'] = M.pbr('nc-fixture-warm', base='#fff0d8', emission='#ffc070', strength=4.0).name
    # runtime-driven surfaces (cloned per node by the renderer)
    # runtime surfaces carry an abstract placeholder (the renderer draws the live content over it)
    ui = ui_atlas()
    m = M.pbr('screen', base='#06090f', rough=0.15, emission='#ffffff', strength=1.1, bake_emit=True)
    P['screen'] = _attach(m, emission=ui).name
    m = M.pbr('holo', base='#03141c', rough=0.2, emission='#ffffff', strength=2.6, bake_emit=True)
    P['holo'] = _attach(m, emission=ui).name
    for i, name in enumerate(('ad', 'ad-b', 'ad-c')):
        m = M.pbr(name, base='#05060a', rough=0.3, emission='#ffffff', strength=2.2)
        P['ad' if i == 0 else f'ad{i}'] = _attach(m, emission=ad_image(i)).name
    P['traffic'] = M.pbr('traffic', base='#000000', rough=1.0, emission='#ffd9a0', strength=0.5).name
    P['led'] = M.pbr('led', base='#101214', rough=0.4, emission='#29e3ff', strength=3.0).name
    P['door'] = M.pbr('elevator-door', base='#8d949c', rough=0.28, metal=1.0).name
    # skyline facades: one material per depth band (the renderer animates bands separately)
    for band, variant in enumerate(('warm', 'cool', 'sparse')):
        bcol, bemit = window_atlas(variant, seed=band)
        m = M.pbr(f'sky-win-b{band}', base='#ffffff', rough=0.35, metal=0.3, tile=56.0, emission='#ffffff',
                  strength=2.0 - 0.45 * band)
        _attach(m, base=bcol, emission=bemit)
        P[f'win{band}'] = m.name
    P['tower'] = M.pbr('sky-tower-shell', base='#0a0c10', rough=0.6, metal=0.4).name
    P['roof'] = M.pbr('sky-roof-gear', base='#15181d', rough=0.7, metal=0.5).name
    P['cityglow'] = M.pbr('sky-street-glow', base='#000000', emission='#ff8a3a', strength=1.6).name
    return P
