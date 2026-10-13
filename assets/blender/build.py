"""Headless environment build (run by assets/build.mjs):

  Blender -b --factory-startup --python assets/blender/build.py -- --out <workdir> --quality draft|final
          [--modules atrium,street,garden,cap,wing:terracotta,…|all] [--previews <dir>] [--no-bake] [--plan-only]

For every module: build geometry → objects → lights → (bake lightmap) → export <slug>.glb and
<slug>.lightmap.png, plus <slug>.json (its manifest fragment) and <slug>.stats.json.
With --previews it renders Eevee stills instead of baking/exporting. With --plan-only it only runs the
module builder and writes <slug>.plan.json ({"plan": …}, contract §11): no objects, bake or export.
"""
import argparse
import importlib
import json
import os
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

import themes  # noqa: E402
from lib import anchors, export, geometry, lighting, materials, scene, textures  # noqa: E402

ALL = ['atrium', 'street', 'garden', 'cap'] + [f'wing:{t}' for t in themes.ORDER]
PREFIX = {'atrium': 'a', 'street': 's', 'garden': 'g', 'cap': 'c', 'wing': 'w'}
# (lightmap px, samples) per quality
BAKE = {
    'final': {'atrium': (4096, 384), 'wing': (2048, 512), 'garden': (2048, 384), 'street': (1024, 512),
              'cap': (512, 256)},
    'draft': {'atrium': (2048, 32), 'wing': (1024, 32), 'garden': (1024, 32), 'street': (512, 32), 'cap': (256, 16)},
}


def parse(argv):
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--out', default=None)
    p.add_argument('--quality', default='draft', choices=['draft', 'final'])
    p.add_argument('--modules', default='all')
    p.add_argument('--previews', default=None)
    p.add_argument('--no-bake', action='store_true')
    p.add_argument('--plan-only', action='store_true')
    a = p.parse_args(argv)
    a.modules = ALL if a.modules == 'all' else [m.strip() for m in a.modules.split(',') if m.strip()]
    for m in a.modules:
        if m not in ALL:
            raise SystemExit(f'unknown module {m}')
    return a


def slug(spec):
    return spec.replace(':', '-')


def make(spec):
    """Build a module into a fresh scene. Returns (kind, theme_name, theme, geo, anchors, info, objs)."""
    scene.reset_scene()
    materials.reset()
    textures.reset()
    kind, _, theme_name = spec.partition(':')
    theme = themes.theme_for(kind, theme_name)
    P = themes.palette(theme)
    g = geometry.Geo()
    A = anchors.Anchors(g, PREFIX[kind])
    mod = importlib.import_module(f'modules.{kind}')
    rng = scene.rng(zlib.crc32(spec.encode()))
    t = time.time()
    info = mod.build(g, A, P, theme_name, theme, rng)
    b = info['bounds']  # colliders never leave the module footprint (contract §2)
    g.colliders = [(max(x0, b['minX']), min(x1, b['maxX']), max(z0, b['minZ']), min(z1, b['maxZ']), y0, y1)
                   for (x0, x1, z0, z1, y0, y1) in g.colliders]
    # foliage never pokes through the perimeter walls (it would show from the next module)
    inset = info.get('foliage_inset', 0.17)
    for (group, mat), batch in g.batches.items():
        if mat != P['leaf']:
            continue
        for v in batch.bm.verts:
            v.co.x = min(max(v.co.x, b['minX'] + inset), b['maxX'] - inset)
            v.co.y = min(max(v.co.y, -(b['maxZ'] - inset)), -(b['minZ'] + inset))
    col = scene.new_collection(slug(spec))
    objs = export.create_objects(g, col, slug(spec))
    lcol = scene.new_collection('lights')
    lighting.add_lights(g.lights, lcol)
    lighting.setup_world(**info.get('sky', {}))
    objs['context'] = []
    if hasattr(mod, 'context'):
        cg = geometry.Geo()
        mod.context(cg, P)
        ccol = scene.new_collection('bake-context')
        c = export.create_objects(cg, ccol, 'context')
        objs['context'] = c['static'] + c['ceiling'] + c['glass'] + c['roofglass']
        lighting.add_lights(cg.lights, lcol)
    print(f'[asset] {spec}: built {sum(len(v) for v in objs.values())} objects in {time.time() - t:.1f} s', flush=True)
    return kind, theme_name, theme, g, A, info, objs, P


def build_one(spec, quality, out, bake=True):
    t0 = time.time()
    kind, theme_name, theme, g, A, info, objs, P = make(spec)
    name = slug(spec)
    glb = f'{name}.glb'
    png = f'{name}.lightmap.png'
    stats = {'module': spec}
    if bake:
        res, samples = BAKE[quality][kind]
        baked, binfo, tris = export.bake_and_split(objs, res, samples, os.path.join(out, png), out, name,
                                                   hide=objs['glass'] + objs['roofglass'] + objs['collider'])
        stats.update(bake_seconds=binfo['bake_seconds'], lightmap=res, samples=samples)
        intensity = binfo['intensity']
    else:
        export.tag_unbaked(objs)
        baked = objs['static'] + objs['ceiling']
        intensity = 1.0
    for o in objs['glass'] + objs['roofglass']:
        o['role'] = 'glass'
    for o in objs['roofglass']:  # additive: glass above the cut height (skylights), hidden with ceilings
        o['ceiling'] = True
    for o in objs['context']:
        bpy.data.objects.remove(o)
    ship = baked + objs['glass'] + objs['roofglass'] + objs['dynamic'] + objs['collider']
    stats['triangles'] = export.count_triangles([o for o in ship if o.get('role') != 'collider'])
    stats['draw_calls'] = len([o for o in ship if o.get('role') != 'collider'])
    stats['objects'] = {r: len([o for o in ship if o.get('role') == r]) for r in
                        ('baked', 'ceiling', 'glass', 'screen', 'led', 'sign', 'elevatorDoor', 'collider')}
    export.export_glb(ship, os.path.join(out, glb))
    nav = A.manifest()
    module = {'bounds': info['bounds'], **info.get('extra', {}), **nav, 'plan': g.plan}
    if kind == 'wing':
        frag = {'theme': {'file': glb, 'lightmap': {'file': png, 'intensity': intensity},
                          'signColor': theme['sign'], 'accent': theme['accent']},
                'module': module}
    else:
        frag = {'module': {'file': glb, 'lightmap': {'file': png, 'intensity': intensity}, **module}}
    with open(os.path.join(out, f'{name}.json'), 'w') as f:
        json.dump(frag, f, indent=1, sort_keys=False)
    stats['seconds'] = round(time.time() - t0, 1)
    with open(os.path.join(out, f'{name}.stats.json'), 'w') as f:
        json.dump(stats, f, indent=1)
    print(f'[asset] {spec}: {stats["triangles"]} tris, {stats["draw_calls"]} draws, {stats["seconds"]} s', flush=True)


def plan_one(spec, out):
    """Run the module builder only and write its floor plan (contract §11)."""
    t0 = time.time()
    scene.reset_scene()
    materials.reset()
    textures.reset()
    kind, _, theme_name = spec.partition(':')
    theme = themes.theme_for(kind, theme_name)
    P = themes.palette(theme)
    g = geometry.Geo()
    A = anchors.Anchors(g, PREFIX[kind])
    mod = importlib.import_module(f'modules.{kind}')
    mod.build(g, A, P, theme_name, theme, scene.rng(zlib.crc32(spec.encode())))
    with open(os.path.join(out, f'{slug(spec)}.plan.json'), 'w') as f:
        json.dump({'plan': g.plan}, f, indent=1)
    n = {k: len(v) for k, v in g.plan.items()}
    print(f'[asset] {spec}: plan {n["rooms"]} rooms, {n["walls"]} walls, {n["furniture"]} furniture '
          f'in {time.time() - t0:.1f} s', flush=True)


def previews_one(spec, quality, out):
    kind, theme_name, theme, g, A, info, objs, P = make(spec)
    export.tag_unbaked(objs)
    for o in objs['collider']:
        o.hide_render = True
    lighting.render_previews(spec, info['previews'], objs, out, quality)


def main():
    a = parse(sys.argv)
    for spec in a.modules:
        if a.previews:
            os.makedirs(a.previews, exist_ok=True)
            previews_one(spec, a.quality, a.previews)
        elif a.plan_only:
            os.makedirs(a.out, exist_ok=True)
            plan_one(spec, a.out)
        else:
            os.makedirs(a.out, exist_ok=True)
            build_one(spec, a.quality, a.out, bake=not a.no_bake)


if __name__ == '__main__':
    main()
