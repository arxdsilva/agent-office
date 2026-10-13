"""Blender-side tests of the Night City set (run by `node assets/special3d/build.mjs --test`):

  Blender -b --factory-startup --python assets/blender/special3d/tests/test_special.py [-- --skip-character]

Builds every module (no bake) and checks: the §14 anchor grammar and required counts, nav connectivity, every
approach on its ap: node, ground nav edges clear of walls, triangle budgets, the runtime roles, `_WALLID` on
the wall geometry (ids within the plan), no text objects and no third-party names or marks anywhere
(objects, meshes, materials, images). Then builds the cyber character (draft) and checks its rig, the 22
clips, the material slots, the outfit toggles and the base budget.
"""
import math
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SPECIAL = os.path.dirname(HERE)
BLENDER_DIR = os.path.dirname(SPECIAL)
sys.path.insert(0, BLENDER_DIR)
sys.path.insert(0, SPECIAL)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
sys.argv = ['test_special']

import bpy  # noqa: E402

import build as SB  # noqa: E402  (special3d/build.py)
from lib import anchors as AN  # noqa: E402
from lib import geometry  # noqa: E402
from special3d import navkit  # noqa: E402

BUDGET = {'hq-atrium': 300e3, 'command': 260e3, 'skyline': 120e3}
NEEDS = {
    'hq-atrium': {'player:spawn': 1, 'interact:project-directory': 1, 'spot:elevator': 8, 'spot:reception': 4,
                  'seat:lounge': 12},
    'command': {'ws': 144, **{f'ws:{d}': 24 for d in range(6)}, 'meet:A': 6, 'meet:B': 6, 'booth': 4,
                'interact:command-display': 1, 'interact:provider-terminal': 6},
    'skyline': {},
}
ROLES = {
    'hq-atrium': {('holo', 'display'): 1, ('holo', 'project-directory'): 1, ('screen', 'display-ticker'): 1,
                  ('elevatorDoor', r'\d:[LR]'): 8},
    'command': {('holo', 'command-display'): 1, ('screen', r'ws:\d:\d:[0-3]'): 144, ('led', r'booth:\d'): 4,
                ('screen', r'provider:\d'): 6, ('screen', r'meet:[AB]'): 2},
    'skyline': {('ad', r'ad:\d'): 8, ('neon', r'neon:\d'): 6, ('traffic', r'lane-\d'): 4},
}
# Names that must never appear in an asset (third-party brands and the game the mood references).
BANNED = re.compile(r'arasaka|militech|kang.?tao|biotechnica|trauma.?team|kiroshi|zetatech|petrochem|cyberpunk|'
                    r'2077|cd.?projekt|cdpr|night.?city|samurai|logo|trademark', re.I)

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)


def components(nodes, edges):
    adj = {n: [] for n in nodes}
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    seen, parts = set(), 0
    for s in nodes:
        if s in seen:
            continue
        parts += 1
        stack = [s]
        seen.add(s)
        while stack:
            for m in adj[stack.pop()]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
    return parts


def test_module(kind):
    g, A, info, objs, P = SB.make(kind)
    # anchors
    for aid, a in A.anchors.items():
        check(AN.valid_id(aid, 'special'), f'{kind}: anchor {aid} breaks the special grammar')
        if 'approach' in a:
            ap = f'ap:{aid}'
            n = A.nodes.get(ap)
            check(n is not None and math.hypot(n['x'] - a['approach']['x'], n['z'] - a['approach']['z']) < 0.05,
                  f'{kind}: {aid} has no ap: node on its approach')
            check(abs(a['y']) < 1e-9, f'{kind}: {aid} is off the floor')
    for prefix, n in NEEDS[kind].items():
        got = len([k for k in A.anchors if k == prefix or k.startswith(prefix + ':')])
        check(got == n, f'{kind}: {got} anchors {prefix}*, expected {n}')
    # nav
    if A.nodes:
        check(components(list(A.nodes), list(A.edges)) == 1, f'{kind}: nav graph is not connected')
        bad = navkit.check_edges(g, A)
        check(not bad, f'{kind}: nav edges cross walls {bad[:3]}')
    # roles
    dyn = [(d.role, str(d.ref)) for d in g.dynamics]
    for (role, ref), n in ROLES[kind].items():
        got = len([1 for r, f in dyn if r == role and re.fullmatch(ref, f)])
        check(got == n, f'{kind}: {got} nodes role {role} ref /{ref}/, expected {n}')
    # wall ids (contract §13) on the batch meshes: walls tagged, ids within the plan
    if kind != 'skyline':
        walls = len(g.plan['walls'])
        ids = set()
        for o in objs['static'] + objs['ceiling']:
            a = o.data.attributes.get(geometry.WALLID)
            check(a is not None and a.domain == 'POINT', f'{kind}: {o.name} has no {geometry.WALLID} point attribute')
            if a is not None:
                vals = [0.0] * len(o.data.vertices)
                a.data.foreach_get('value', vals)
                ids |= {int(v) for v in vals}
                check(all(v == int(v) and v >= 0 for v in vals), f'{kind}: {o.name} has non-integer wall ids')
        check(max(ids) >= 1, f'{kind}: no geometry carries a wall id')
        check(max(ids) <= walls, f'{kind}: wall id {max(ids)} > {walls} walls in the plan')
        check(all(w.get('id') == i + 1 and w.get('h', 0) > 0 for i, w in enumerate(g.plan['walls'])),
              f'{kind}: plan walls need id (1-based) and h')
    # budgets, text, names
    shown = [o for k in ('static', 'ceiling', 'glass', 'roofglass', 'dynamic') for o in objs[k]]
    tris = sum(geometry.triangle_count(o) for o in shown)
    check(tris <= BUDGET[kind], f'{kind}: {tris} triangles > budget {BUDGET[kind]:.0f}')
    print(f'[test] {kind}: {len(A.anchors)} anchors, {len(A.nodes)} nav nodes, {tris} tris', flush=True)
    check_names(kind)


def check_names(label):
    check(not [o for o in bpy.data.objects if o.type == 'FONT'], f'{label}: text objects in the scene')
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for d in coll:
            check(not BANNED.search(d.name), f'{label}: banned name "{d.name}"')


def test_character():
    import importlib.util
    spec = importlib.util.spec_from_file_location('character_cyber', os.path.join(SPECIAL, 'character_cyber.py'))
    CC = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(CC)
    out = tempfile.mkdtemp(prefix='ao-cyber-')
    sys.argv = ['character_cyber', '--', '--out', out, '--quality', 'draft']
    CC.main()
    import json
    meta = json.load(open(os.path.join(out, 'character-cyber.json')))
    import char_common as C
    check(list(meta['clips']) == C.CLIP_NAMES and len(C.CLIP_NAMES) == 22, 'character: the 22 clips, in order')
    check(set(meta['accessories']) == set(CC.ACCESSORIES), 'character: accessory toggles')
    for m in ('skin', 'shirt', 'pants', 'hair', 'accent'):
        check(m in bpy.data.materials, f'character: material slot {m}')
    accs = {o.get('accessory') for o in bpy.data.objects if o.get('accessory')}
    check(accs == set(CC.ACCESSORIES), f'character: accessory meshes {sorted(accs)}')
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    check(len([b for b in arm.data.bones if b.use_deform]) == 22, 'character: 22 deform bones')
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.parent == arm and o.parent_type == 'OBJECT':
            check(any(m.type == 'ARMATURE' for m in o.modifiers), f'character: {o.name} is not skinned')
    base = sum(geometry.triangle_count(o) for o in bpy.data.objects if o.type == 'MESH' and not o.get('accessory')
               and not o.get('prop') and not o.get('lod'))
    check(base <= 9000, f'character: base {base} tris > 9000')
    size = os.path.getsize(os.path.join(out, 'character-cyber.glb'))
    check(size <= 2.6e6, f'character: raw glb {size / 1e6:.2f} MB (≤ 1.8 MB after the optimizer)')
    print(f'[test] character-cyber: base {base} tris, raw {size / 1e6:.2f} MB', flush=True)
    check_names('character')


def main():
    for kind in SB.ALL:
        test_module(kind)
    if '--skip-character' not in argv:
        test_character()
    for f in failures:
        print(f'[test] FAIL {f}', flush=True)
    if failures:
        raise SystemExit(f'{len(failures)} failure(s)')
    print('[test] special: all checks passed', flush=True)


main()
