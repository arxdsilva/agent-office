"""Blender-side asset tests (run by `node assets/build.mjs --test`):

  Blender -b --factory-startup --python assets/blender/tests/test_modules.py [-- --modules wing:terracotta,atrium]
                                                                            [--set classic|horizon]

Builds every module (no bake) and checks: anchor/port naming grammar and required counts, the root rule
for seats, desk/table clearance, runtime-node roles and refs, nav connectivity, approach points on nav
nodes, nav edges clear of colliders, no text objects, applied transforms and triangle budgets.
With `--set horizon` it checks the Horizon set (contract §14) the same way, and also that every module has
exactly the Classic anchors and nav graph (the same space).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
sys.argv = ['test_modules']

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import build  # noqa: E402
from lib import anchors as AN  # noqa: E402
from lib import export, geometry  # noqa: E402

# contract §9 caps are wing 190k / atrium 250k / others 60k; these tighter targets keep the visible scene fast
BUDGET = {'atrium': 250e3, 'wing': 120e3, 'street': 60e3, 'garden': 40e3, 'cap': 60e3}
NEEDS = {
    'wing': {'seat:desk': 24, 'seat:meeting:A': 6, 'seat:meeting:B': 6, 'spot:booth': 4, 'spot:kitchen': 6,
             'seat:lounge': 8, 'spot:station': 8, 'seat:reading': 4, 'spot:shelf': 2, 'port:desk': 24,
             'port:station': 8, 'port:book': 24, 'port:board': 6, 'port:notebook': 8},
    'atrium': {'spot:reception': 4, 'spot:elevator': 6, 'seat:cafe': 24, 'spot:pingpong': 4,
               'kiosk': 1, 'console:context': 6, 'spot:handoff': 2, 'port:archive': 12},
    'garden': {'spot:garden': 6},
    'street': {}, 'cap': {},
}
ROLE_REFS = {
    'wing': {('screen', r'desk:\d:\d'): 24, ('screen', r'meeting:[AB]'): 2, ('screen', 'adapters-core'): 1,
             ('station', r'\d'): 8, ('led', r'booth:\d'): 4, ('led', r'station:\d'): 8, ('book', r'\d+'): 24,
             ('board', r'\d'): 6, ('notebook', r'\d'): 8, ('sign', 'wing'): 1, ('sign', 'adapters'): 1,
             ('sign', 'library'): 1},
    'atrium': {('screen', 'ledwall'): 1, ('screen', r'arcade:\d'): 2, ('elevatorDoor', r'\d:[LR]'): 6,
               ('screen', r'context:\d'): 6, ('screen', 'context-core'): 1},
}
CONNECTORS = {
    'atrium': [(0, 0)], 'street': [(0, 0), (3, 9), (-3, 9), (0, 18)], 'wing': [(0, 0)], 'garden': [(0, 0)],
    'cap': [(0, 0)],
}

failures = []

# contract §11: the furniture kinds come from the renderer's contract (one source of truth)
_TYPES = os.path.join(HERE, '..', '..', '..', 'packages', 'web', 'src', 'app', 'pixel', 'types.ts')


def furniture_kinds():
    import re
    src = open(_TYPES).read()
    body = src[src.index('FURNITURE_KINDS = ['):]
    return set(re.findall(r"'([a-z-]+)'", body[:body.index(']')]))


def check(cond, msg):
    if not cond:
        failures.append(msg)


def seg_hits_box(a, b, box, shrink=0.06):
    """2D segment a→b vs AABB (x0, x1, z0, z1) shrunk by `shrink` (slab test)."""
    x0, x1, z0, z1 = box[0] + shrink, box[1] - shrink, box[2] + shrink, box[3] - shrink
    if x0 >= x1 or z0 >= z1:
        return False
    t0, t1 = 0.0, 1.0
    for p, d, lo, hi in ((a[0], b[0] - a[0], x0, x1), (a[1], b[1] - a[1], z0, z1)):
        if abs(d) < 1e-9:
            if p < lo or p > hi:
                return False
        else:
            ta, tb = (lo - p) / d, (hi - p) / d
            t0, t1 = max(t0, min(ta, tb)), min(t1, max(ta, tb))
            if t0 > t1:
                return False
    return True


ASSET_SET = argv[argv.index('--set') + 1] if '--set' in argv else 'classic'


def test(spec):
    kind = spec.partition(':')[0]
    _, _, theme, g, A, info, objs, P = build.make(spec, ASSET_SET)
    m = A.manifest()
    anchors, nodes, edges = m['anchors'], m['nav']['nodes'], m['nav']['edges']
    tag = spec
    # ---- grammar, poses, counts
    for aid, a in anchors.items():
        if aid.startswith('port:'):
            check(AN.PORT_RE.match(aid) is not None, f'{tag}: bad port id {aid}')
            check(a['y'] > 0.3 and 'heading' not in a and 'approach' not in a, f'{tag}: port {aid} shape')
        else:
            check(AN.ANCHOR_RE.match(aid) is not None, f'{tag}: bad anchor id {aid}')
            check(a['y'] == 0, f'{tag}: {aid} y != 0')
            want = 'stand' if aid.startswith(('spot:', 'kiosk:', 'console:')) else ('lounge' if aid.startswith('seat:lounge') else 'sit')
            check(a['pose'] == want, f'{tag}: {aid} pose {a["pose"]} != {want}')
    for prefix, n in NEEDS[kind].items():
        got = len([k for k in anchors if k.startswith(prefix + ':')])
        check(got == n, f'{tag}: {got} × {prefix}, expected {n}')
    # ---- root rule (contract §4)
    for aid, (cx, cz) in A.seat_centers.items():
        a = anchors[aid]
        off = AN.ROOT_OFFSET[a['pose']]
        ex, ez = cx + off * math.sin(a['heading']), cz + off * math.cos(a['heading'])
        check(math.hypot(ex - a['x'], ez - a['z']) < 2e-3, f'{tag}: {aid} root is not {off} m ahead of the seat')
    # desk/table edge ≈ 0.13 m in front of the root (desks, meeting and reading tables are AABB colliders)
    for aid, a in anchors.items():
        if not (aid.startswith('seat:desk') or aid.startswith('seat:meeting') or aid.startswith('seat:reading')):
            continue
        fx, fz = math.sin(a['heading']), math.cos(a['heading'])
        hit = None
        for d in [i * 0.01 for i in range(1, 60)]:
            px, pz = a['x'] + fx * d, a['z'] + fz * d
            if any(c[0] <= px <= c[1] and c[2] <= pz <= c[3] and c[5] < 1.3 for c in g.colliders):
                hit = d
                break
        check(hit is not None and 0.09 <= hit <= 0.18, f'{tag}: {aid} table edge at {hit} m in front of the root')
    # ---- runtime nodes
    import re
    dyn = [(o.get('role'), o.get('ref')) for o in objs['dynamic']]
    for (role, pat), n in ROLE_REFS.get(kind, {}).items():
        got = len([1 for r, ref in dyn if r == role and ref is not None and re.fullmatch(pat, str(ref))])
        check(got == n, f'{tag}: {got} nodes role={role} ref~{pat}, expected {n}')
    for o in objs['dynamic']:
        if o.get('role') in ('station', 'book', 'board', 'notebook', 'sign'):
            check('width' in o and 'height' in o, f'{tag}: {o.name} lacks width/height extras')
    # ---- nav
    adj = {k: set() for k in nodes}
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    start = next(iter(nodes))
    seen, stack = {start}, [start]
    while stack:
        for nb in adj[stack.pop()]:
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)
    check(len(seen) == len(nodes), f'{tag}: nav disconnected ({len(seen)}/{len(nodes)}): '
          f'{sorted(set(nodes) - seen)[:6]}')
    for (x, z) in CONNECTORS[kind]:
        check(any(math.hypot(n['x'] - x, n['z'] - z) <= 0.05 for n in nodes.values()),
              f'{tag}: no connector node at ({x}, {z})')
    for aid, a in anchors.items():
        if 'approach' not in a:
            continue
        ap = nodes.get(f'ap:{aid}')
        check(ap is not None and math.hypot(ap['x'] - a['approach']['x'], ap['z'] - a['approach']['z']) <= 0.05,
              f'{tag}: approach of {aid} is not on its ap: node')
        check(ap is not None and len(adj.get(f'ap:{aid}', ())) > 0, f'{tag}: ap:{aid} has no edges')
    boxes = [(c[0], c[1], c[2], c[3]) for c in g.colliders]
    for a, b in edges:
        pa, pb = (nodes[a]['x'], nodes[a]['z']), (nodes[b]['x'], nodes[b]['z'])
        for box in boxes:
            if seg_hits_box(pa, pb, box):
                failures.append(f'{tag}: nav edge {a}–{b} crosses collider {box}')
                break
    # ---- scene hygiene + budgets
    check(not [c for c in bpy.data.curves if c.type == 'FONT'], f'{tag}: text objects present')
    ship = objs['static'] + objs['ceiling'] + objs['glass'] + objs['roofglass'] + objs['dynamic'] + objs['collider']
    for o in ship:
        check(o.rotation_euler.to_quaternion().angle < 1e-6 and all(abs(s - 1) < 1e-6 for s in o.scale),
              f'{tag}: {o.name} has unapplied rotation/scale')
        if o not in objs['dynamic'] and o not in objs['collider']:
            check(o.location.length < 1e-6, f'{tag}: {o.name} has an unapplied location')
    b = info['bounds']
    bpy.context.view_layer.update()
    for o in ship:
        if o in objs['glass'] or o in objs['roofglass']:
            continue
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs, zs = [p.x for p in pts], [-p.y for p in pts]
        check(min(xs) >= b['minX'] - 0.005 and max(xs) <= b['maxX'] + 0.005 and min(zs) >= b['minZ'] - 0.005
              and max(zs) <= b['maxZ'] + 0.005, f'{tag}: {o.name} leaves the module bounds '
              f'(x {min(xs):.2f}..{max(xs):.2f}, z {min(zs):.2f}..{max(zs):.2f})')
    tris = sum(geometry.triangle_count(o) for o in ship if o not in objs['collider'])
    check(tris <= BUDGET[kind], f'{tag}: {tris} triangles > {BUDGET[kind]:.0f}')
    test_plan(tag, g.plan)
    test_plan_walls(tag, g.plan)
    test_wall_ids(tag, g.plan, objs['static'] + objs['ceiling'])
    test_mounted(tag, kind, objs['dynamic'])
    print(f'[test] {spec}: {len(anchors)} anchors, {len(nodes)} nav nodes, {tris} tris', flush=True)
    return m


def test_plan(tag, plan):
    """BL-py (contract §11): the floor plan is non-empty, kinds are in the enum, and there is no NaN."""
    kinds = furniture_kinds()
    check(len(plan['rooms']) > 0, f'{tag}: plan has no rooms')
    check(len(plan['walls']) + len(plan['furniture']) > 0, f'{tag}: plan has no walls or furniture')
    nums = []
    for r in plan['rooms']:
        nums += r['rect']
        check(r['rect'][0] < r['rect'][2] and r['rect'][1] < r['rect'][3], f'{tag}: room {r["id"]} rect is empty')
    for w in plan['walls']:
        nums += w['a'] + w['b'] + [t for o in w.get('openings', []) for t in o]
        check(w['kind'] in ('solid', 'glass', 'curtain'), f'{tag}: wall kind {w["kind"]}')
    for f in plan['furniture']:
        nums += [f['x'], f['z'], f['w'], f['d'], f['yaw']]
        check(f['kind'] in kinds, f'{tag}: furniture kind {f["kind"]} is not in FURNITURE_KINDS')
        check(f['w'] > 0 and f['d'] > 0, f'{tag}: {f["kind"]} has an empty footprint')
    check(all(isinstance(v, (int, float)) and math.isfinite(v) for v in nums), f'{tag}: plan has NaN/inf values')



def test_plan_walls(tag, plan):
    """BL-py (contract §11): every plan wall records the side its body extends to and its thickness."""
    for i, w in enumerate(plan['walls']):
        check(w.get('side') in (-1, 1), f'{tag}: walls[{i}] side {w.get("side")!r} is not -1 or 1')
        t = w.get('thick')
        check(isinstance(t, (int, float)) and math.isfinite(t) and t > 0, f'{tag}: walls[{i}] thick {t!r} is not > 0')


def _seg_dist(p, a, b):
    ax, az = a
    dx, dz = b[0] - ax, b[1] - az
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2))
    return math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz)


def test_wall_ids(tag, plan, meshes):
    """BL-py (contract §13): every baked/ceiling mesh carries the `_WALLID` point attribute; ids are integers
    in 0..len(walls), every plan wall has geometry, and a wall's vertices lie on its own plan segment."""
    walls = plan['walls']
    for i, w in enumerate(walls):
        check(w.get('id') == i + 1, f'{tag}: walls[{i}] id {w.get("id")!r} != {i + 1}')
        check(isinstance(w.get('h'), (int, float)) and w['h'] > 0, f'{tag}: walls[{i}] h {w.get("h")!r} is not > 0')
    seen = set()
    far = {}
    for o in meshes:
        attr = o.data.attributes.get(geometry.WALLID)
        if attr is None or attr.data_type != 'FLOAT' or attr.domain != 'POINT':
            failures.append(f'{tag}: {o.name} has no FLOAT POINT {geometry.WALLID} attribute')
            continue
        vals = [0.0] * len(o.data.vertices)
        attr.data.foreach_get('value', vals)
        for v, wid in zip(o.data.vertices, vals):
            k = int(round(wid))
            if abs(wid - k) > 1e-6 or k < 0 or k > len(walls):
                failures.append(f'{tag}: {o.name} has {geometry.WALLID} {wid} (not an integer in 0..{len(walls)})')
                break
            if k == 0:
                continue
            seen.add(k)
            w = walls[k - 1]
            # Blender (x, y, z) = glTF (x, −z, y)
            d = _seg_dist((v.co.x, -v.co.y), w['a'], w['b'])
            if d > w['thick'] + export.MOUNT_BAND + 0.1:  # walls, and pieces mounted on them
                far[k] = max(far.get(k, 0.0), d)
    missing = sorted(set(range(1, len(walls) + 1)) - seen)
    check(not missing, f'{tag}: plan walls without tagged geometry: {missing[:8]}')
    for k, d in sorted(far.items())[:8]:
        failures.append(f'{tag}: wall {k} has a vertex {d:.2f} m from its plan segment')


# Runtime nodes that hang on a wall and must fade with it (contract §13): role → ref pattern.
MOUNTED = {'wing': [('sign', r'wing|adapters|library')], 'atrium': [('screen', 'ledwall')]}


def test_mounted(tag, kind, dynamics):
    """BL-py (contract §13): wall-mounted runtime nodes (signs, the LED wall) carry their wall's id."""
    import re
    for role, pat in MOUNTED.get(kind, []):
        nodes = [o for o in dynamics if o.get('role') == role and re.fullmatch(pat, str(o.get('ref')))]
        check(nodes, f'{tag}: no {role} node matching {pat}')
        for o in nodes:
            attr = o.data.attributes.get(geometry.WALLID)
            vals = [0.0] * len(o.data.vertices)
            if attr is not None:
                attr.data.foreach_get('value', vals)
            check(vals and min(vals) > 0.5, f'{tag}: wall-mounted {o.name} has no wall id')


def main():
    specs = build.ALL
    if '--modules' in argv:
        specs = argv[argv.index('--modules') + 1].split(',')
    wing_nav = None
    for spec in specs:
        m = test(spec)
        if ASSET_SET != 'classic':  # the same space: anchors and nav equal the Classic build of the module
            _, _, _, _, A0, _, _, _ = build.make(spec, 'classic')
            check(A0.manifest() == m, f'{spec}: {ASSET_SET} anchors/nav differ from Classic')
        if spec.startswith('wing:'):
            if wing_nav is None:
                wing_nav = m
            else:
                check(m == wing_nav, f'{spec}: anchors/nav differ from the first wing theme')
    if failures:
        for f in failures:
            print(f'[test] FAIL {f}', flush=True)
        print(f'[test] {len(failures)} failure(s)', flush=True)
        sys.exit(1)
    print('[test] all module checks passed', flush=True)


main()
