"""Night City headless build (run by assets/special3d/build.mjs; contract §14):

  Blender -b --factory-startup --python assets/blender/special3d/build.py -- --out <workdir>
          --quality draft|final [--modules hq-atrium,command,skyline|all] [--previews <dir>] [--no-bake]
          [--hdri <file.hdr>]

Per module: build geometry → objects → lights → (bake lightmap) → export <kind>.glb, <kind>.lightmap.png,
<kind>.json (manifest fragment) and <kind>.stats.json, exactly like the classic build (shared lib/), but with
the `special` anchor grammar, the night world and the §14 roles (holo, ad, traffic, rain-glass, neon).
With --previews it renders stills of the whole set (every module placed, the skyline outside the glass).
"""
import argparse
import importlib
import json
import os
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
for p in (BLENDER_DIR,):
    if p not in sys.path:
        sys.path.insert(0, p)

import bpy  # noqa: E402

from lib import anchors, export, geometry, lighting, materials, scene, textures  # noqa: E402
from special3d import env, palette  # noqa: E402

ALL = ['hq-atrium', 'command', 'skyline']
MODULE = {'hq-atrium': 'hq_atrium', 'command': 'command', 'skyline': 'skyline'}
PREFIX = {'hq-atrium': 'h', 'command': 'c', 'skyline': 'k'}
# (lightmap px, samples) per quality (plan §5.3)
BAKE = {
    'final': {'hq-atrium': (4096, 384), 'command': (4096, 384), 'skyline': (1024, 64)},
    'draft': {'hq-atrium': (1024, 24), 'command': (1024, 24), 'skyline': (256, 8)},
}
ROLE_MATERIAL = {'rain-glass': 'rain-glass'}  # glass panes whose material carries a §14 role


def parse(argv):
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--out', default=None)
    p.add_argument('--quality', default='draft', choices=['draft', 'final'])
    p.add_argument('--modules', default='all')
    p.add_argument('--previews', default=None)
    p.add_argument('--shots', default=None, help='comma list of preview shot names to render')
    p.add_argument('--no-bake', action='store_true')
    p.add_argument('--hdri', default=None)
    a = p.parse_args(argv)
    a.modules = ALL if a.modules == 'all' else [m.strip() for m in a.modules.split(',') if m.strip()]
    for m in a.modules:
        if m not in ALL:
            raise SystemExit(f'unknown module {m}')
    return a


def _module(kind):
    return importlib.import_module(f'special3d.{MODULE[kind]}')


def _fresh():
    scene.reset_scene()
    materials.reset()
    textures.reset()
    bpy.context.scene.render.fps = 30
    return palette.build()


def make(kind, P=None):
    """Build one module into a fresh scene. Returns (geo, anchors, info, objs, P)."""
    P = P or _fresh()
    g = geometry.Geo()
    A = anchors.Anchors(g, PREFIX[kind], asset_set='special')
    rng = scene.rng(zlib.crc32(kind.encode()))
    t = time.time()
    info = _module(kind).build(g, A, P, rng)
    b = info['bounds']
    g.colliders = [(max(x0, b['minX']), min(x1, b['maxX']), max(z0, b['minZ']), min(z1, b['maxZ']), y0, y1)
                   for (x0, x1, z0, z1, y0, y1) in g.colliders]
    col = scene.new_collection(kind)
    objs = export.create_objects(g, col, kind)
    lighting.add_lights(g.lights, scene.new_collection('lights'))
    env.setup_world(**info.get('sky', {}))
    print(f'[asset] {kind}: built {sum(len(v) for v in objs.values())} objects in {time.time() - t:.1f} s', flush=True)
    return g, A, info, objs, P


def _tag_roles(objs, baked):
    for o in objs['glass'] + objs['roofglass']:
        mat = o.data.materials[0].name if o.data.materials else ''
        o['role'] = 'rain-glass' if mat == ROLE_MATERIAL['rain-glass'] else 'glass'
    for o in objs['roofglass']:
        o['ceiling'] = True
    for o in baked:  # skyline depth bands (the renderer animates each band's windows on its own)
        mat = o.data.materials[0].name if o.data.materials else ''
        if mat.startswith('sky-win-b'):
            o['band'] = int(mat[-1])


def build_one(kind, quality, out, bake=True):
    t0 = time.time()
    g, A, info, objs, P = make(kind)
    glb, png = f'{kind}.glb', f'{kind}.lightmap.png'
    stats = {'module': kind}
    if bake:
        res, samples = BAKE[quality][kind]
        baked, binfo, tris = export.bake_and_split(objs, res, samples, os.path.join(out, png), out, kind,
                                                   hide=objs['glass'] + objs['roofglass'] + objs['collider'])
        stats.update(bake_seconds=binfo['bake_seconds'], lightmap=res, samples=samples)
        intensity = binfo['intensity']
    else:
        export.tag_unbaked(objs)
        baked = objs['static'] + objs['ceiling']
        intensity = 1.0
    _tag_roles(objs, baked)
    ship = baked + objs['glass'] + objs['roofglass'] + objs['dynamic'] + objs['collider']
    stats['triangles'] = export.count_triangles([o for o in ship if o.get('role') != 'collider'])
    stats['draw_calls'] = len([o for o in ship if o.get('role') != 'collider'])
    stats['objects'] = {}
    for o in ship:
        r = o.get('role', 'none')
        stats['objects'][r] = stats['objects'].get(r, 0) + 1
    export.export_glb(ship, os.path.join(out, glb))
    nav = A.manifest()
    module = {'file': glb, 'lightmap': {'file': png, 'intensity': intensity}, 'bounds': info['bounds'],
              **info.get('extra', {}), **nav, 'plan': g.plan}
    with open(os.path.join(out, f'{kind}.json'), 'w') as f:
        json.dump({'module': module}, f, indent=1)
    stats['seconds'] = round(time.time() - t0, 1)
    with open(os.path.join(out, f'{kind}.stats.json'), 'w') as f:
        json.dump(stats, f, indent=1)
    print(f'[asset] {kind}: {stats["triangles"]} tris, {stats["draw_calls"]} draws, {stats["seconds"]} s', flush=True)


# ------------------------------------------------------------------------------------------- previews
def previews(kinds, quality, out, shots=None):
    """Every module placed into one scene (the set as the renderer assembles it), then each module's shots."""
    P = _fresh()
    g = geometry.Geo()
    infos = {}
    for kind in ALL:
        mod = _module(kind)
        pl = mod.PLACEMENT
        with g.at(pl['x'], pl['z'], pl['yaw']):
            A = anchors.Anchors(g, PREFIX[kind], asset_set='special')
            infos[kind] = mod.build(g, A, P, scene.rng(zlib.crc32(kind.encode())))
        infos[kind]['placement'] = pl
    col = scene.new_collection('set')
    objs = export.create_objects(g, col, 'set')
    export.tag_unbaked(objs)
    for o in objs['collider']:
        o.hide_render = True
    lighting.add_lights(g.lights, scene.new_collection('lights'))
    env.setup_world(strength=1.0, fog=0.0025)
    for kind in kinds:
        pl = infos[kind]['placement']
        tr = lambda p: (p[0] + pl['x'], p[1], p[2] + pl['z'])  # noqa: E731 (all placements have yaw 0)
        for (name, pos, target, lens, hide) in infos[kind]['previews']:
            if shots and name not in shots and f'{kind}-{name}' not in shots:
                continue
            lighting.render_previews(kind, [(name, tr(pos), tr(target), lens, hide)], objs, out, quality)


def main():
    a = parse(sys.argv)
    if a.hdri:
        os.makedirs(os.path.dirname(a.hdri), exist_ok=True)
        env.write_hdr(a.hdri, env.night_sky(1024, 512))
        print(f'[asset] night HDRI → {a.hdri}', flush=True)
    if a.previews:
        os.makedirs(a.previews, exist_ok=True)
        previews(a.modules, a.quality, a.previews, shots=a.shots.split(',') if a.shots else None)
        return
    if not a.out:
        return
    os.makedirs(a.out, exist_ok=True)
    for kind in a.modules:
        build_one(kind, a.quality, a.out, bake=not a.no_bake)


if __name__ == '__main__':
    main()
