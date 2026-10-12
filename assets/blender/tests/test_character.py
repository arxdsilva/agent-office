"""Blender-side tests for the character (runs inside Blender's Python).

  Blender --background --factory-startup --python-exit-code 1 \
      --python assets/blender/tests/test_character.py -- [--glb <dir with character.glb/json>]

Builds the character in-process (draft quality) and checks the scene, then the exported glb and
json (an existing build when --glb is given, otherwise a fresh export to a temp dir).
"""
import json
import math
import os
import struct
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(ROOT, 'character'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

import importlib.util  # noqa: E402

import char_common as C  # noqa: E402

spec = importlib.util.spec_from_file_location('character_module', os.path.join(ROOT, 'modules', 'character.py'))
CM = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CM)

FAILS = []
REQUIRED_MATERIALS = ['skin', 'shirt', 'pants', 'hair', 'shoes', 'eyes', 'badge']
ACCESSORIES = ['hairA', 'hairB', 'hairC', 'hairD', 'glasses', 'headset', 'badge']
PROPS = ['laptop', 'cup', 'phone', 'paddle', 'book']
SIT_FAMILY = ['SitIdle', 'SitType', 'SitThink', 'SitTalk', 'SitLaptop', 'SitRead']


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)
    if not cond:
        FAILS.append(name)


# ── helpers ───────────────────────────────────────────────────────────────────────────────────
def channels(act):
    from bpy_extras import anim_utils
    bag = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
    return list(bag.fcurves)


def pose_at(act, frame):
    """{bone: (loc Vector, rot Quaternion)} evaluated from the fcurves."""
    out = {}
    for fc in channels(act):
        b = fc.data_path.split('"')[1]
        prop = fc.data_path.rsplit('.', 1)[1]
        d = out.setdefault(b, {'location': [0.0] * 3, 'rotation_quaternion': [1.0, 0, 0, 0]})
        d[prop][fc.array_index] = fc.evaluate(frame)
    return {b: (Vector(v['location']), Quaternion(v['rotation_quaternion'])) for b, v in out.items()}


def pose_delta(pa, pb):
    worst = 0.0
    for b in pa:
        la, qa = pa[b]
        lb, qb = pb[b]
        dq = min((Vector(qa) - Vector(qb)).length, (Vector(qa) + Vector(qb)).length)
        worst = max(worst, dq, (la - lb).length)
    return worst


def tris(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def world_pose(arm, act, frame):
    arm.animation_data.action = act
    if arm.animation_data.action_slot is None and act.slots:
        arm.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    return arm


def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, ver, length = struct.unpack_from('<III', data, 0)
    clen, ctype = struct.unpack_from('<II', data, 12)
    assert magic == 0x46546C67 and ctype == 0x4E4F534A
    return json.loads(data[20:20 + clen]), len(data)


# ── tests ─────────────────────────────────────────────────────────────────────────────────────
def test_scene(res):
    arm = res['armature']
    names = [b.name for b in arm.data.bones]
    check('bones: exact contract names', sorted(names) == sorted(C.ALL_BONES), str(sorted(set(names) ^ set(C.ALL_BONES))))
    deform = [b.name for b in arm.data.bones if b.use_deform]
    check('bones: 22 deform bones', len(deform) == 22 and 'prop.R' not in deform, str(len(deform)))
    check('bones: prop.R is a child of hand.R', arm.data.bones['prop.R'].parent.name == 'hand.R')

    mats = set(bpy.data.materials.keys())
    check('materials: required names present', all(m in mats for m in REQUIRED_MATERIALS),
          str([m for m in REQUIRED_MATERIALS if m not in mats]))
    body = res['body']
    bm = {m.name for m in body.data.materials}
    check('materials: body uses skin/shirt/pants/hair/shoes/eyes',
          {'skin', 'shirt', 'pants', 'hair', 'shoes', 'eyes'} <= bm, str(bm))
    check('materials: badge accessory uses badge', 'badge' in {m.name for m in res['accessories']['badge'].data.materials})

    t = tris(body.data)
    check('budget: base body <= 8000 triangles', t <= 8000, str(t))
    tl = tris(res['lod1'].data)
    check('budget: LOD1 ~2k triangles', tl <= 2600, str(tl))

    for ob in (body, res['lod1']):
        nv = len(ob.data.vertices)
        counts = np.zeros(nv, dtype=int)
        sums = np.zeros(nv)
        for v in ob.data.vertices:
            ws = [g.weight for g in v.groups if g.weight > 0]
            counts[v.index] = len(ws)
            sums[v.index] = sum(ws)
        check(f'weights: {ob.name} <= 4 influences per vertex', counts.max() <= 4, f'max {counts.max()}')
        check(f'weights: {ob.name} every vertex weighted and normalised', counts.min() >= 1 and np.abs(sums - 1).max() < 1e-3,
              f'min count {counts.min()}, max |sum-1| {np.abs(sums - 1).max():.2e}')

    for name in ACCESSORIES:
        ob = res['accessories'].get(name)
        check(f'accessory {name}: exists with extras.accessory', ob is not None and ob.get('accessory') == name)
    for name in PROPS:
        ob = res['props'].get(name)
        ok = ob is not None and ob.get('prop') == name and ob.parent == arm and ob.parent_type == 'BONE' \
            and ob.parent_bone == 'prop.R'
        check(f'prop {name}: parented to bone prop.R with extras.prop', ok)
    check('lod1: extras.lod = 1', res['lod1'].get('lod') == 1)

    acts = res['actions']
    check('clips: all 19 present with exact names', sorted(acts) == sorted(C.CLIP_NAMES),
          str(set(C.CLIP_NAMES) ^ set(acts)))
    for name, n, loop in C.CLIPS:
        act = acts[name]
        fcs = channels(act)
        rng = (int(act.frame_range[0]), int(act.frame_range[1]))
        check(f'{name}: frame range 0..{n} at {C.FPS} fps', rng == (0, n), str(rng))
        interp = {k.interpolation for fc in fcs for k in fc.keyframe_points}
        check(f'{name}: Bezier keys only', interp == {'BEZIER'}, str(interp))
        root_loc = [fc for fc in fcs if fc.data_path == 'pose.bones["root"].location']
        moved = max((abs(k.co[1]) for fc in root_loc for k in fc.keyframe_points), default=0.0)
        check(f'{name}: root has no translation', moved < 1e-6, f'{moved:.2e}')
        if loop:
            d = pose_delta(pose_at(act, 0), pose_at(act, n))
            check(f'{name}: loop first == last frame (delta < 1e-3)', d < 1e-3, f'{d:.2e}')

    # shared seated base, sit/stand transitions
    sit0 = pose_at(acts['SitIdle'], 0)
    legs = [b for b in sit0 if b.startswith(('thigh', 'shin', 'foot', 'toe')) or b in ('hips', 'root')]
    for name in SIT_FAMILY[1:]:
        p = pose_at(acts[name], 0)
        d = max(pose_delta({b: sit0[b]}, {b: p[b]}) for b in legs)
        check(f'{name}: same seated hips/legs as SitIdle', d < 1e-3, f'{d:.2e}')
    d = pose_delta(pose_at(acts['SitDown'], 36), sit0)
    check('SitDown: ends exactly on the SitIdle pose', d < 1e-3, f'{d:.2e}')
    d = pose_delta(pose_at(acts['StandUp'], 0), sit0)
    check('StandUp: starts exactly on the SitIdle pose', d < 1e-3, f'{d:.2e}')
    idle0 = pose_at(acts['Idle'], 0)
    for name, f in (('SitDown', 0), ('StandUp', 30), ('Wave', 0), ('Wave', 40)):
        d = pose_delta(pose_at(acts[name], f), idle0)
        check(f'{name}: frame {f} matches Idle frame 0', d < 1e-3, f'{d:.2e}')
    for name, f, yaw in (('TurnL90', 20, 90), ('TurnR90', 20, -90), ('ElevatorIn', 40, 180)):
        p = pose_at(acts[name], f)
        q = p['root'][1]
        R = arm.data.bones['root'].matrix_local.to_3x3()
        world = (R @ q.to_matrix() @ R.transposed()).to_quaternion()
        ang = math.degrees(world.to_euler().z)
        rest = {b: v for b, v in p.items() if b != 'root'}
        d = pose_delta(rest, {b: idle0[b] for b in rest})
        check(f'{name}: ends turned {yaw} deg in the Idle pose', abs((ang - yaw + 180) % 360 - 180) < 0.5 and d < 1e-3,
              f'yaw {ang:.2f}, pose delta {d:.2e}')

    # ShelfPick: one-shot that settles into a holdable pose (book at the chest, both hands on it)
    d = pose_delta(pose_at(acts['ShelfPick'], 52), pose_at(acts['ShelfPick'], 60))
    check('ShelfPick: ends in a stationary hold pose (frames 52..60)', d < 1e-3, f'{d:.2e}')
    world_pose(arm, acts['ShelfPick'], 60)
    pb = arm.pose.bones
    book = (arm.matrix_world @ pb['prop.R'].head)
    hl, hr = arm.matrix_world @ pb['hand.L'].head, arm.matrix_world @ pb['hand.R'].head
    check('ShelfPick: book held at chest height between both hands',
          1.0 < book.z < 1.3 and (hl - book).length < 0.25 and (hr - book).length < 0.25,
          f'book z {book.z:.2f}, hands {((hl - book).length):.2f}/{((hr - book).length):.2f} m')
    world_pose(arm, acts['ShelfPick'], 0)
    on_shelf = arm.matrix_world @ pb['prop.R'].head
    check('ShelfPick: book starts on the shelf (~1.5 m, ~0.45 m ahead)',
          abs(on_shelf.z - C.SHELF_BOOK[2]) < 0.03 and abs(on_shelf.y - C.SHELF_BOOK[1]) < 0.03, str(tuple(on_shelf)))
    for f in (0, 40, 75, 120):
        world_pose(arm, acts['SitRead'], f)
        hl, hr = arm.matrix_world @ pb['hand.L'].head, arm.matrix_world @ pb['hand.R'].head
        bk = arm.matrix_world @ pb['prop.R'].head
        if f in (0, 75):
            check(f'SitRead frame {f}: both hands hold the book', (hl - bk).length < 0.25 and (hr - bk).length < 0.25)

    # contacts: seat height and walking foot lock
    from char_anim import deformed_coords
    parts = np.array(res['part_of'])
    rest = np.array([v.co for v in body.data.vertices])
    pel = (parts == 'pants') & (rest[:, 2] > 0.6)
    for clip, h, front in (('SitIdle', C.SEAT_HEIGHT, C.SEAT_CENTER_Y - 0.23),
                           ('LoungeSit', C.LOUNGE_SEAT_HEIGHT, C.LOUNGE_CENTER_Y - 0.27)):
        world_pose(arm, acts[clip], 0)
        co = deformed_coords(body)
        sel = pel & (co[:, 1] > front)
        z = float(co[sel, 2].min())
        check(f'{clip}: pelvis rests on the {h} m seat', abs(z - h) < 0.003, f'{z:.4f}')
    S = C.WALK_SPEED * 32 / C.FPS
    v = S / 32
    ys, zs = [], []
    for f in range(4, 10):  # left foot flat on the ground (phase 0.08..0.30)
        world_pose(arm, acts['Walk'], f)
        p = arm.matrix_world @ arm.pose.bones['toe.L'].head
        ys.append(p.y - (f - 4) * v)
        zs.append(p.z)
    slide = max(ys) - min(ys)
    check('Walk: planted foot moves with the ground (slide < 3 mm)', slide < 0.003, f'{slide * 1000:.2f} mm')
    check('Walk: planted foot stays on the floor', max(zs) - min(zs) < 0.002, f'{(max(zs) - min(zs)) * 1000:.2f} mm')
    sl = []
    for f in range(10, 18):  # ball pivot (heel off): the ball joint stays planted
        world_pose(arm, acts['Walk'], f)
        p = arm.matrix_world @ arm.pose.bones['toe.L'].head
        sl.append((p.y - (f - 10) * v, p.z))
    dy = max(a for a, _ in sl) - min(a for a, _ in sl)
    check('Walk: ball of the foot locked during heel-off (< 3 mm)', dy < 0.003, f'{dy * 1000:.2f} mm')


def test_export(gdir):
    glb = os.path.join(gdir, 'character.glb')
    js, size = read_glb(glb)
    check('glb: <= 1.5 MB', size <= 1.5e6, f'{size / 1e6:.3f} MB')
    anims = [a['name'] for a in js.get('animations', [])]
    check('glb: one animation per clip, exact names', sorted(anims) == sorted(C.CLIP_NAMES), str(set(anims) ^ set(C.CLIP_NAMES)))
    check('glb: no cameras or lights', not js.get('cameras') and 'KHR_lights_punctual' not in js.get('extensionsUsed', []))
    nodes = js['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    props = {n['extras']['prop']: nodes[parent[i]]['name'] for i, n in enumerate(nodes) if 'prop' in n.get('extras', {})}
    check('glb: props parented to the prop.R node', props == {p: 'prop.R' for p in PROPS}, str(props))
    accs = sorted(n['extras']['accessory'] for n in nodes if 'accessory' in n.get('extras', {}))
    check('glb: accessories tagged', accs == sorted(ACCESSORIES), str(accs))
    mats = [m['name'] for m in js['materials']]
    check('glb: contract material names', all(m in mats for m in REQUIRED_MATERIALS), str(mats))
    with open(os.path.join(gdir, 'character.json')) as fh:
        meta = json.load(fh)
    check('json: all clips with duration/loop', all(c in meta['clips'] and meta['clips'][c]['duration'] > 0
                                                    for c in C.CLIP_NAMES))
    w = meta['clips']['Walk']
    check('json: Walk speed/footPlants', w['speed'] == 1.4 and w['footPlants'] == [0, 0.5] and abs(w['duration'] - 1.0667) < 1e-3)
    check('json: book clips', meta['clips']['SitRead'].get('prop') == 'book' and meta['clips']['ShelfPick'].get('prop') == 'book'
          and meta['clips']['SitRead'].get('pose') == 'sit')
    check('json: seat heights', meta['seatHeight'] == 0.47 and meta['loungeSeatHeight'] == 0.42 and meta['height'] == 1.75)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    gdir = argv[argv.index('--glb') + 1] if '--glb' in argv else None
    try:
        res = CM.build_scene('draft')
        test_scene(res)
        if gdir is None:
            gdir = tempfile.mkdtemp(prefix='character-test-')
            CM.export_glb(os.path.join(gdir, 'character.glb'))
            with open(os.path.join(gdir, 'character.json'), 'w') as fh:
                json.dump(CM.character_json(res), fh)
        test_export(gdir)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        FAILS.append('exception')
    print(f'\n{len(FAILS)} failure(s)' + (': ' + ', '.join(FAILS) if FAILS else ''), flush=True)
    if FAILS:
        sys.exit(1)


main()
