"""Eevee preview renders of the character -> assets/previews/character-*.png

  Blender --background --factory-startup --python assets/blender/character/previews.py -- \
      [--blend assets/draft/character/character.blend] [--out assets/previews] [--only Walk,SitDown] \
      [--frames 6] [--no-sheets] [--no-turntable] [--no-lineup]

Without --blend the character is built in-process at draft quality.
Outputs: character-turntable.png (front / side / back / 3-4), character-lineup.png (6 tint and
hair variants), character-clip-<Clip>.png (contact sheet, >= 4 frames per clip; sit clips with a
0.47 m chair and a desk, LoungeSit with a 0.42 m sofa; Walk/turns over a 0.25 m floor grid).
"""
import argparse
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import char_common as C  # noqa: E402
from char_model import hex_rgba  # noqa: E402

PROP_OF = {'SitLaptop': 'laptop', 'PhoneCall': 'phone', 'DrinkCoffee': 'cup', 'PingPong': 'paddle',
           'SitRead': 'book', 'ShelfPick': 'book'}
SIT = {'SitDown', 'StandUp', 'SitIdle', 'SitType', 'SitThink', 'SitTalk', 'SitLaptop', 'SitRead'}


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', default=None)
    ap.add_argument('--out', default=os.path.join(REPO, 'assets', 'previews'))
    ap.add_argument('--only', default=None)
    ap.add_argument('--frames', type=int, default=6)
    ap.add_argument('--res', type=int, default=420)
    ap.add_argument('--no-sheets', action='store_true')
    ap.add_argument('--no-turntable', action='store_true')
    ap.add_argument('--no-lineup', action='store_true')
    return ap.parse_args(argv)


# ── scene ─────────────────────────────────────────────────────────────────────────────────────
def mat(name, hexc, rough=0.7, checker=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    if checker:
        ch = nt.nodes.new('ShaderNodeTexChecker')
        ch.inputs['Scale'].default_value = checker
        ch.inputs['Color1'].default_value = hex_rgba(hexc)
        ch.inputs['Color2'].default_value = hex_rgba('#C9CDD3')
        tc = nt.nodes.new('ShaderNodeTexCoord')
        nt.links.new(tc.outputs['Object'], ch.inputs['Vector'])
        nt.links.new(ch.outputs['Color'], b.inputs['Base Color'])
    else:
        b.inputs['Base Color'].default_value = hex_rgba(hexc)
    return m


def box(name, center, size, material, coll):
    me = bpy.data.meshes.new(name)
    hx, hy, hz = (s / 2 for s in size)
    v = [(x * hx, y * hy, z * hz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    ob.location = center
    coll.objects.link(ob)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width = min(0.012, min(size) * 0.3)
    bev.segments = 2
    return ob


def setup_stage():
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    try:
        sc.eevee.taa_render_samples = 24
    except AttributeError:
        pass
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    w = bpy.data.worlds.new('preview-world')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = hex_rgba('#DCE3EA')
    bg.inputs[1].default_value = 0.65
    for name, rot, e, col in (('key', (52, 0, -38), 3.2, '#FFF3E6'), ('fill', (64, 0, 128), 1.0, '#DDE8FF'),
                              ('rim', (68, 0, 196), 2.2, '#FFFFFF')):
        ld = bpy.data.lights.new('pv-' + name, 'SUN')
        ld.energy = e
        ld.color = hex_rgba(col)[:3]
        ld.angle = math.radians(8)
        lo = bpy.data.objects.new('pv-' + name, ld)
        sc.collection.objects.link(lo)
        lo.rotation_euler = [math.radians(a) for a in rot]
    coll = bpy.data.collections.new('stage')
    sc.collection.children.link(coll)
    floor_m = mat('pv-floor', '#B9BFC7', 0.8, checker=4.0)  # 0.25 m squares
    me = bpy.data.meshes.new('pv-floor')
    s = 6.0
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(floor_m)
    fl = bpy.data.objects.new('pv-floor', me)
    coll.objects.link(fl)
    cam = bpy.data.objects.new('pv-cam', bpy.data.cameras.new('pv-cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 50
    return cam, coll


def furniture():
    """Chair + desk (sit clips) and sofa (lounge), in the clips' character frame."""
    wood = mat('pv-wood', '#C8A27A', 0.55)
    grey = mat('pv-grey', '#5B6370', 0.6)
    fabric = mat('pv-fabric', '#7E95A8', 0.9)
    chair = bpy.data.collections.new('pv-chair')
    bpy.context.scene.collection.children.link(chair)
    cy, sh = C.SEAT_CENTER_Y, C.SEAT_HEIGHT
    box('pv-seat', (0, cy, sh - 0.03), (0.46, 0.46, 0.06), grey, chair)
    box('pv-back', (0, cy + 0.25, sh + 0.33), (0.44, 0.05, 0.5), grey, chair)
    box('pv-post', (0, cy, (sh - 0.06) / 2), (0.05, 0.05, sh - 0.06), grey, chair)
    box('pv-base', (0, cy, 0.03), (0.5, 0.5, 0.04), grey, chair)
    dz = C.DESK_HEIGHT
    desk = bpy.data.collections.new('pv-desk')
    bpy.context.scene.collection.children.link(desk)
    chair_only = chair
    chair = desk
    box('pv-desk', (0, C.DESK_EDGE_Y - C.DESK_DEPTH / 2, dz - 0.015), (1.4, C.DESK_DEPTH, 0.03), wood, chair)
    for x in (-0.66, 0.66):
        for y in (C.DESK_EDGE_Y - 0.05, C.DESK_EDGE_Y - C.DESK_DEPTH + 0.05):
            box('pv-leg', (x, y, (dz - 0.03) / 2), (0.04, 0.04, dz - 0.03), grey, chair)
    box('pv-kb', (0, C.DESK_EDGE_Y - 0.12, dz + 0.008), (0.42, 0.14, 0.016), grey, chair)
    box('pv-mon', (0, C.DESK_EDGE_Y - 0.5, dz + 0.3), (0.6, 0.03, 0.36), grey, chair)
    chair = chair_only
    sofa = bpy.data.collections.new('pv-sofa')
    bpy.context.scene.collection.children.link(sofa)
    ly, lh = C.LOUNGE_CENTER_Y, C.LOUNGE_SEAT_HEIGHT
    box('pv-sofa-seat', (0, ly, lh / 2), (1.8, 0.56, lh), fabric, sofa)
    box('pv-sofa-back', (0, ly + 0.36, 0.48), (1.8, 0.2, 0.96), fabric, sofa)
    box('pv-sofa-arm', (-0.98, ly + 0.05, 0.3), (0.18, 0.76, 0.6), fabric, sofa)
    box('pv-sofa-arm', (0.98, ly + 0.05, 0.3), (0.18, 0.76, 0.6), fabric, sofa)
    # tall touch screen (StandInteract) and a bookshelf (ShelfPick)
    screen = bpy.data.collections.new('pv-screen')
    bpy.context.scene.collection.children.link(screen)
    sx, sy, sz = C.SCREEN_CENTER
    box('pv-screen', (sx, sy - 0.03, sz), (1.0, 0.04, 0.62), mat('pv-glass', '#1B2433', 0.2), screen)
    box('pv-stand', (sx, sy - 0.05, (sz - 0.31) / 2), (0.12, 0.06, sz - 0.31), grey, screen)
    shelf = bpy.data.collections.new('pv-shelf')
    bpy.context.scene.collection.children.link(shelf)
    bx, by, bz = C.SHELF_BOOK
    back = by - 0.17
    for z in (0.4, 0.9, bz - 0.12, 1.95):
        box('pv-board', (0, back + 0.15, z - 0.012), (1.0, 0.3, 0.024), wood, shelf)
    box('pv-shelf-back', (0, back, 1.0), (1.0, 0.02, 2.0), wood, shelf)
    for i, x in enumerate((-0.4, -0.33, -0.26, 0.1, 0.17, 0.24, 0.31, 0.38)):
        h = 0.2 + 0.03 * (i % 3)
        box('pv-shelfbook', (x, back + 0.13, bz - 0.108 + h / 2), (0.05, 0.2, h),
            mat(f'pv-b{i}', ('#C0504D', '#4F81BD', '#9BBB59', '#8064A2')[i % 4], 0.6), shelf)
    return chair, desk, sofa, screen, shelf


def look_at(cam, eye, target):
    cam.location = eye
    d = Vector(target) - Vector(eye)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


# ── images ────────────────────────────────────────────────────────────────────────────────────
def render_to(path, w, h):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    os.remove(path)
    return px.reshape(h, w, 4)


def save_grid(tiles, cols, path, pad=6):
    h, w = tiles[0].shape[:2]
    rows = math.ceil(len(tiles) / cols)
    W, H = cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad
    out = np.ones((H, W, 4), dtype=np.float32)
    out[..., :3] = 0.18
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        y0 = H - (r + 1) * (h + pad)  # image rows are bottom-up
        x0 = pad + c * (w + pad)
        out[y0:y0 + h, x0:x0 + w] = t
    img = bpy.data.images.new(os.path.basename(path), W, H, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    print('[previews] wrote', path)


# ── character controls ────────────────────────────────────────────────────────────────────────
def char_objects():
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    acc = {o['accessory']: o for o in bpy.data.objects if 'accessory' in o}
    props = {o['prop']: o for o in bpy.data.objects if 'prop' in o}
    lod = [o for o in bpy.data.objects if 'lod' in o]
    return arm, acc, props, lod


def show(acc, props, hair='hairA', extra=(), prop=None):
    for k, o in acc.items():
        o.hide_render = not (k == hair or k in extra)
    for k, o in props.items():
        o.hide_render = k != prop


def tint(shirt=None, pants=None, skin=None, hair=None, badge=None):
    for name, c in (('shirt', shirt), ('pants', pants), ('skin', skin), ('hair', hair), ('badge', badge)):
        if c:
            m = bpy.data.materials[name]
            m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = hex_rgba(c)


def set_clip(arm, name, frame):
    arm.animation_data.action = bpy.data.actions[name]
    sl = arm.animation_data.action.slots
    if sl and arm.animation_data.action_slot is None:
        arm.animation_data.action_slot = sl[0]
    bpy.context.scene.frame_set(int(frame))


def main():
    a = args()
    os.makedirs(a.out, exist_ok=True)
    if a.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.blend))
    else:
        sys.path.insert(0, os.path.join(HERE, '..', 'modules'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('character_module', os.path.join(HERE, '..', 'modules', 'character.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.build_scene('draft')
    cam, stage = setup_stage()
    chair, desk, sofa, screen, shelf = furniture()
    arm, acc, props, lod = char_objects()
    for o in lod:
        o.hide_render = True
    tmp = os.path.join(a.out, '_tmp.png')
    R = a.res

    def furniture_for(clip):
        chair.hide_render = clip not in SIT
        desk.hide_render = clip not in SIT or clip in ('SitLaptop', 'SitRead')
        screen.hide_render = clip != 'StandInteract'
        shelf.hide_render = clip != 'ShelfPick'
        sofa.hide_render = clip != 'LoungeSit'

    if not a.no_turntable:
        furniture_for(None)
        show(acc, props)
        set_clip(arm, 'Idle', 0)
        tiles = []
        for ang in (0, 90, 180, 35):
            r = 3.0
            eye = (r * math.sin(math.radians(ang)), -r * math.cos(math.radians(ang)), 1.05)
            look_at(cam, eye, (0, 0, 0.9))
            tiles.append(render_to(tmp, R, int(R * 1.45)))
        save_grid(tiles, 4, os.path.join(a.out, 'character-turntable.png'))

    if not a.no_lineup:
        furniture_for(None)
        variants = [
            ('hairA', (), '#4F7FD8', '#2F3747', '#E9B48F', '#3B2A22', None),
            ('hairB', ('glasses',), '#D9775B', '#3C3F46', '#C68A63', '#1F1A17', None),
            ('hairC', ('headset',), '#3F9B76', '#4A4036', '#8D5A3B', '#141010', None),
            ('hairD', ('badge',), '#F2C14E', '#2A3550', '#F1CBB0', '#8A4B2A', '#4F7FD8'),
            ('hairA', ('glasses', 'badge'), '#8E6CCF', '#5B5F66', '#5E3B28', '#0E0B0A', '#D9775B'),
            ('hairB', ('headset',), '#E2E4E8', '#3A6B8C', '#FAD7BD', '#C99B5B', None),
        ]
        tiles = []
        set_clip(arm, 'Idle', 0)
        look_at(cam, (1.15, -2.55, 1.25), (0, 0, 0.93))
        for hair, extra, shirt, pants, skin, hc, badge in variants:
            show(acc, props, hair, extra)
            tint(shirt, pants, skin, hc, badge)
            tiles.append(render_to(tmp, R, int(R * 1.7)))
        save_grid(tiles, 6, os.path.join(a.out, 'character-lineup.png'))
        tint('#4F7FD8', '#2F3747', '#E9B48F', '#3B2A22', '#D97757')

    if not a.no_sheets:
        names = [c[0] for c in C.CLIPS]
        if a.only:
            names = [n for n in names if n in a.only.split(',')]
        for name in names:
            n = dict((c[0], c[1]) for c in C.CLIPS)[name]
            furniture_for(name)
            show(acc, props, 'hairA', (), PROP_OF.get(name))
            k = max(4, a.frames)
            frames = [round(i * n / k) for i in range(k)] + ([n] if name not in ('Walk',) else [])
            if name == 'Walk':
                frames = [0, 4, 8, 12, 16, 20, 24, 28]
            tiles = []
            for f in frames:
                set_clip(arm, name, f)
                if name in ('Walk', 'PingPong'):
                    look_at(cam, (3.4, -0.5, 1.0), (0, 0, 0.88))
                elif name in SIT or name == 'LoungeSit':
                    look_at(cam, (3.1, -1.3, 1.45), (0, 0.08, 0.72))
                elif name in ('StandInteract', 'ShelfPick'):
                    look_at(cam, (2.4, -0.2, 1.45), (0, -0.25, 1.05))
                elif name in ('TurnL90', 'TurnR90', 'ElevatorIn'):
                    look_at(cam, (2.2, -3.3, 2.3), (0, 0, 0.75))
                else:
                    look_at(cam, (2.2, -3.4, 1.35), (0, 0, 0.95))
                tiles.append(render_to(tmp, R, int(R * 1.3)))
            save_grid(tiles, len(tiles), os.path.join(a.out, f'character-clip-{name}.png'))


if __name__ == '__main__':
    main()
