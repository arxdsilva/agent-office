"""Night City character (contract §14): the classic rig and all 22 clips unchanged (modules/character.py), with
new outfit meshes and an `accent` material slot.

Usage (headless):
  Blender --background --factory-startup --python assets/blender/special3d/character_cyber.py -- \
      --out <dir> --quality draft|final
Writes <dir>/character-cyber.glb and <dir>/character-cyber.json.

Outfit toggles (`extras.accessory`, all hidden by default except hairA and techJacket):
  hairA–hairF  six original hair styles (undercut sweep, crest, buzz, asymmetric bob, top knot, long fall)
  techJacket   long-sleeved jacket with a high collar and accent shoulder strips (skinned)
  utilityVest  sleeveless vest with chest pockets (skinned)
  longCoat     long coat open at the front, back and side panels to the knee (skinned)
  visor        a wrap-around emissive visor (head)
  arGlasses    a single-bar AR lens with temples (head)
  headset      one ear cup with a light ring and a mic boom (head)
  wristDisplay a bracelet with a glowing screen on the left forearm (forearm.L)
  collarLight  a light ring around the collar (chest)
Garments use the `shirt` (agent tint) and `pants` slots; lights and lenses use `accent` (emissive, tinted per
agent by the runtime). All shapes are original signed-distance models; no logos or text.
"""
import argparse
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(BLENDER_DIR, 'character'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import char_build as B  # noqa: E402
import char_common as C  # noqa: E402
import char_model as M  # noqa: E402
import char_rig as RG  # noqa: E402
import char_sdf as S  # noqa: E402

_spec = importlib.util.spec_from_file_location('character_module', os.path.join(BLENDER_DIR, 'modules', 'character.py'))
CM = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CM)

ACCESSORIES = ['hairA', 'hairB', 'hairC', 'hairD', 'hairE', 'hairF', 'techJacket', 'utilityVest', 'longCoat',
               'visor', 'arGlasses', 'headset', 'wristDisplay', 'collarLight']
DEFAULT_ON = {'hairA', 'techJacket'}
ACCENT = '#29e3ff'

SH, EL, WR = M.SH, M.EL, M.WR
D1, D2 = M.D1, M.D2
V3 = lambda *a: np.array(a, dtype=np.float32)  # noqa: E731


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--quality', choices=('draft', 'final'), default='draft')
    ap.add_argument('--preview', default=None, help='also render a variant lineup PNG into this dir')
    return ap.parse_args(argv)


# ── materials ─────────────────────────────────────────────────────────────────────────────────
def accent_material():
    m = bpy.data.materials.get('accent') or bpy.data.materials.new('accent')
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = M.hex_rgba('#0b1a20')
    p.inputs['Roughness'].default_value = 0.3
    p.inputs['Emission Color'].default_value = M.hex_rgba(ACCENT)
    p.inputs['Emission Strength'].default_value = 2.5
    return m


# ── outfit SDFs (Blender coordinates: Z up, the character faces −Y, its left is +X) ──────────────
def _torso(t):
    chest = S.ellipsoid((0, 0.014, 1.262), (0.17 + t, 0.124 + t, 0.195 + t))
    belly = S.ellipsoid((0, 0.0, 1.10), (0.162 + t, 0.112 + t, 0.17 + t))
    yoke = S.sym_x(S.capsule((0.04, 0.014, 1.398), (0.158, 0.012, 1.383), 0.054 + t))
    return S.union(S.union(chest, belly, k=0.06), yoke, k=0.06)


def _sleeve(t, wrist=0.02):
    upper = S.round_cone(SH - D1 * 0.03, EL, 0.058 + t, 0.05 + t)
    fore = S.round_cone(EL, WR - D2 * wrist, 0.05 + t, 0.041 + t)
    return S.sym_x(S.union(upper, fore, k=0.02))


def sdf_jacket():
    j = S.union(_torso(0.016), _sleeve(0.012), k=0.03)
    collar = S.round_cone((0, 0.018, 1.395), (0, 0.016, 1.475), 0.083, 0.07)
    collar = S.subtract(collar, S.round_cone((0, 0.018, 1.36), (0, 0.016, 1.52), 0.06, 0.052), k=0.004)
    collar = S.subtract(collar, S.round_box((0, -0.09, 1.47), (0.028, 0.04, 0.05), 0.01), k=0.006)  # front opening
    j = S.union(j, collar, k=0.012)
    return S.intersect(j, S.plane((0, 0, -1), (0, 0, 0.93)), k=0.01)


def sdf_vest():
    v = _torso(0.026)
    arm = S.sym_x(S.round_cone(SH - D1 * 0.06, SH + D1 * 0.2, 0.085, 0.08))
    v = S.subtract(v, arm, k=0.01)  # armholes
    v = S.subtract(v, S.round_box((0, -0.15, 1.42), (0.05, 0.08, 0.06), 0.02), k=0.02)  # V neck
    pockets = S.sym_x(S.round_box((0.075, -0.138, 1.19), (0.042, 0.018, 0.045), 0.008))
    v = S.union(v, pockets, k=0.006)
    return S.intersect(v, S.plane((0, 0, -1), (0, 0, 0.98)), k=0.01)


def sdf_coat():
    top = S.union(_torso(0.02), _sleeve(0.016, wrist=0.0), k=0.03)
    skirt = S.round_cone((0, 0.016, 1.0), (0, 0.03, 0.5), 0.185, 0.235)
    skirt = S.shell(skirt, 0.012)
    skirt = S.intersect(skirt, S.plane((0, -1, 0), (0, -0.035, 0)), k=0.01)  # open at the front
    skirt = S.intersect(skirt, S.plane((0, 0, 1), (0, 0, 1.02)), k=0.01)
    lapels = S.sym_x(S.round_box((0.06, -0.135, 1.33), (0.03, 0.012, 0.08), 0.006, S.rot('y', -18)))
    c = S.union(top, skirt, k=0.04)
    c = S.union(c, lapels, k=0.01)
    return S.intersect(c, S.plane((0, 0, -1), (0, 0, 0.5)), k=0.01)


def sdf_visor():
    band = S.shell(S.ellipsoid((0, 0.004, 1.612), (0.122, 0.13, 0.066)), 0.0035)
    band = S.intersect(band, S.plane((0, 1, 0), (0, 0.02, 0)), k=0.01)  # front half only
    band = S.intersect(band, S.plane((0, 0, 1), (0, 0, 1.64)), k=0.005)
    return S.intersect(band, S.plane((0, 0, -1), (0, 0, 1.585)), k=0.005)


def sdf_ar_glasses(head):
    lc, _ = M._face_point(head, 0.04, 1.612, 0.018)
    rc = lc * V3(-1, 1, 1)
    mid = (lc + rc) / 2
    lens = S.round_box(mid, (0.072, 0.0035, 0.012), 0.003)
    temples = []
    for sx in (1, -1):
        a = V3(sx * 0.074, mid[1] + 0.004, mid[2] + 0.004)
        b = V3(sx * 0.108, 0.02, 1.614)
        temples.append(S.capsule(a, b, 0.0024))
        temples.append(S.capsule(b, b + V3(0, 0.02, -0.018), 0.0024))
    return lens, S.union(*temples, k=0.002)


def sdf_headset_cyber():
    cup = S.round_cylinder((-0.114, 0.012, 1.598), 0.032, 0.014, 0.008, S.frame((1, 0, 0), (0, 0, 1)))
    hook = S.polyline([(-0.11, 0.03, 1.63), (-0.11, 0.04, 1.665), (-0.1, 0.02, 1.69)], [0.005, 0.005, 0.004])
    boom = S.polyline([(-0.114, -0.015, 1.585), (-0.1, -0.07, 1.56), (-0.05, -0.108, 1.538)], [0.004, 0.0035, 0.003])
    mic = S.ellipsoid((-0.044, -0.11, 1.537), (0.009, 0.008, 0.007))
    ring = S.torus((-0.13, 0.012, 1.598), 0.022, 0.0035, S.rot('y', 90))
    return S.union(S.union(cup, hook, k=0.006), boom, mic, k=0.004), ring


def sdf_wrist():
    """A bracelet round the left forearm by the wrist, and its glowing top face."""
    c = WR - D2 * 0.055
    band = S.round_cylinder(tuple(c), 0.04, 0.022, 0.006, S.frame(tuple(D2), (0, 0, 1)))
    face = S.intersect(S.offset(band, 0.003), S.plane((0, 0, 1), tuple(c + V3(0, 0, 0.03))), k=0.004)
    return band, face


def sdf_collar():
    return S.torus((0, 0.018, 1.478), 0.074, 0.0065, S.rot('x', 8))


def sdf_hair_cyber(variant):
    scalp = M._scalp
    head = scalp(0.0)
    if variant == 'hairA':  # undercut: short sides, a long swept top falling to one side
        top = S.ellipsoid((0.01, -0.01, 1.715), (0.1, 0.12, 0.07))
        fringe = S.ellipsoid((0.045, -0.085, 1.69), (0.07, 0.05, 0.035), S.rot('y', 20))
        h = S.union(S.union(scalp(0.006), top, k=0.03), fringe, k=0.03)
        h = S.intersect(h, M._hairline_cut(1.668, 1.52, 1.64), k=0.012)
    elif variant == 'hairB':  # crest: a sharp mohawk ridge over shaved sides
        crest = S.round_box((0, 0.01, 1.765), (0.02, 0.125, 0.065), 0.014)
        crest = S.intersect(crest, S.offset(scalp(0.0), 0.085), k=0.01)
        h = S.union(scalp(0.003), crest, k=0.02)
        h = S.intersect(h, M._hairline_cut(1.66, 1.52, 1.66), k=0.01)
    elif variant == 'hairC':  # buzz cut with a faded line
        h = S.intersect(scalp(0.006), M._hairline_cut(1.672, 1.51, 1.615), k=0.008)
        h = S.subtract(h, S.capsule((0.06, -0.05, 1.7), (0.09, 0.04, 1.69), 0.003), k=0.002)
    elif variant == 'hairD':  # asymmetric bob, long on the right
        bob = S.ellipsoid((-0.015, 0.03, 1.6), (0.13, 0.118, 0.11))
        long = S.ellipsoid((-0.09, -0.02, 1.52), (0.05, 0.07, 0.09))
        h = S.union(S.union(scalp(0.018), bob, k=0.04), long, k=0.04)
        h = S.subtract(h, S.ellipsoid((0.0, -0.13, 1.56), (0.085, 0.1, 0.098)), k=0.02)
        h = S.intersect(h, S.plane((0, 0.25, -1), (0, 0, 1.46)), k=0.012)
    elif variant == 'hairE':  # top knot over a tight base
        knot = S.ellipsoid((0, 0.02, 1.775), (0.045, 0.045, 0.04))
        band = S.torus((0, 0.02, 1.748), 0.03, 0.007)
        h = S.union(S.union(scalp(0.012), knot, k=0.02), band, k=0.004)
        h = S.intersect(h, M._hairline_cut(1.668, 1.515, 1.62), k=0.012)
    else:  # hairF: long fall to the shoulders with blunt bangs
        fall = S.round_cone((0, 0.05, 1.66), (0, 0.07, 1.36), 0.125, 0.11)
        fall = S.intersect(fall, S.plane((0, 1, 0), (0, -0.02, 0)), k=0.02)  # behind the face
        sides = S.sym_x(S.round_cone((0.1, 0.0, 1.62), (0.11, 0.02, 1.4), 0.03, 0.025))
        bangs = S.intersect(S.ellipsoid((0, -0.06, 1.69), (0.1, 0.07, 0.04)), S.plane((0, 0, -1), (0, 0, 1.665)), k=0.004)
        h = S.union(S.union(S.union(scalp(0.016), fall, k=0.03), sides, k=0.02), bangs, k=0.02)
    h = S.subtract(h, M._ear_clear(), k=0.01) if variant not in ('hairD', 'hairF') else h
    return S.subtract(h, S.offset(head, -0.004), k=0.0)


# ── skinning ──────────────────────────────────────────────────────────────────────────────────
def transfer_weights(body, part_of, ob, arm, parts, hips_low=None):
    """Skin `ob` like the nearest body vertex of `parts`; below `hips_low` (m) blend 55 % toward the hips."""
    idx = [i for i, p in enumerate(part_of) if p in parts]
    src = [body.data.vertices[i].co for i in idx]
    nm = RG.nearest_map(src, [v.co for v in ob.data.vertices])
    names = {g.index: g.name for g in body.vertex_groups}
    groups = {}
    for v, j in zip(ob.data.vertices, nm):
        bw = {names[g.group]: g.weight for g in body.data.vertices[idx[j]].groups if g.weight > 1e-4}
        if hips_low is not None and v.co.z < hips_low:
            bw = {k: w * 0.45 for k, w in bw.items()}
            bw['hips'] = bw.get('hips', 0.0) + 0.55
        top = sorted(bw.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top) or 1.0
        for name, w in top:
            groups.setdefault(name, []).append((v.index, w / tot))
    for name, items in groups.items():
        vg = ob.vertex_groups.get(name) or ob.vertex_groups.new(name=name)
        for i, w in items:
            vg.add([i], w, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm


def build_outfits(quality, mats, res):
    body, part_of, arm = res['body'], res['part_of'], res['armature']
    head_raw = M.sdf_head()
    fine = quality == 'final'
    out = {}

    def part(name, sdf, lo, hi, tris, mat, h=None):
        V, F = M.build_part(M.Part(name, sdf, lo, hi, tris, mat, h=h), quality)
        B.log(f'{name}: {M._tri_count(F)} tris')
        return V, F

    def multi(name, pieces):
        ob = B._multi_object(name, pieces, mats)
        return ob

    # garments (skinned)
    V, F = part('techJacket', sdf_jacket(), (-0.75, -0.21, 0.88), (0.75, 0.22, 1.53), 1800, 'shirt',
                h=0.0042 if fine else 0.0058)
    Vz, Fz = M.box((0.012, -0.138, 1.2), (0.012, 0.008, 0.42), ('x', -6.0))  # glowing zip line
    strips = [(Vz, Fz, 'accent')]
    out['techJacket'] = multi('techJacket', [(V, F, 'shirt')] + strips)
    V, F = part('utilityVest', sdf_vest(), (-0.24, -0.2, 0.94), (0.24, 0.2, 1.5), 1100, 'pants',
                h=0.004 if fine else 0.0055)
    Vs, Fs = M.box((0.0, -0.152, 1.3), (0.012, 0.004, 0.16), None)
    out['utilityVest'] = multi('utilityVest', [(V, F, 'pants'), (Vs, Fs, 'accent')])
    V, F = part('longCoat', sdf_coat(), (-0.75, -0.22, 0.46), (0.75, 0.3, 1.53), 2300, 'shirt',
                h=0.0045 if fine else 0.006)
    out['longCoat'] = multi('longCoat', [(V, F, 'shirt')])
    # head pieces (rigid to the head bone), modelled at real scale then scaled like the head
    V, F = part('visor', M.head_space(sdf_visor()), (-0.16, -0.18, 1.55), (0.16, 0.06, 1.68), 500, 'accent', h=0.0016)
    out['visor'] = multi('visor', [(V, F, 'accent')])
    lens, temples = sdf_ar_glasses(head_raw)
    V1, F1 = part('arGlasses-lens', M.head_space(lens), (-0.11, -0.18, 1.57), (0.11, -0.09, 1.66), 220, 'accent', h=0.0011)
    V2, F2 = part('arGlasses-frame', M.head_space(temples), (-0.14, -0.15, 1.55), (0.14, 0.07, 1.67), 360, 'plastic', h=0.0011)
    out['arGlasses'] = multi('arGlasses', [(V1, F1, 'accent'), (V2, F2, 'plastic')])
    hs, ring = sdf_headset_cyber()
    V1, F1 = part('headset', M.head_space(hs), (-0.17, -0.14, 1.5), (-0.03, 0.07, 1.72), 560, 'plastic', h=0.0016)
    V2, F2 = part('headset-ring', M.head_space(ring), (-0.17, -0.03, 1.55), (-0.11, 0.05, 1.65), 120, 'accent', h=0.0012)
    out['headset'] = multi('headset', [(V1, F1, 'plastic'), (V2, F2, 'accent')])
    band, face = sdf_wrist()
    lo, hi = tuple(WR - 0.12), tuple(WR + 0.12)
    V1, F1 = part('wristDisplay', band, lo, hi, 260, 'metal', h=0.0016)
    V2, F2 = part('wristDisplay-face', face, lo, hi, 120, 'accent', h=0.0014)
    out['wristDisplay'] = multi('wristDisplay', [(V1, F1, 'metal'), (V2, F2, 'accent')])
    V, F = part('collarLight', sdf_collar(), (-0.1, -0.08, 1.44), (0.1, 0.11, 1.52), 220, 'accent', h=0.0014)
    out['collarLight'] = multi('collarLight', [(V, F, 'accent')])
    for v in ('hairA', 'hairB', 'hairC', 'hairD', 'hairE', 'hairF'):
        f = M.head_space(sdf_hair_cyber(v))
        V, F = part(v, f, (-0.18, -0.19, 1.3), (0.18, 0.22, 1.88), 1500 if v in ('hairD', 'hairF') else 1300, 'hair',
                    h=0.003 if fine else 0.0038)
        out[v] = B._mesh_object(v, V, F, 'hair', mats)
    # bind: garments skinned from the body, the rest rigid to a bone (rest pose)
    arm.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    torso = ('shirt', 'arm.L', 'arm.R')
    transfer_weights(body, part_of, out['techJacket'], arm, torso)
    transfer_weights(body, part_of, out['utilityVest'], arm, ('shirt',))
    transfer_weights(body, part_of, out['longCoat'], arm, torso + ('pants',), hips_low=0.93)
    for name in ('visor', 'arGlasses', 'headset') + tuple(f'hair{v}' for v in 'ABCDEF'):
        RG.rigid_bind(out[name], arm, 'head')
    RG.rigid_bind(out['wristDisplay'], arm, 'forearm.L')
    RG.rigid_bind(out['collarLight'], arm, 'chest')
    arm.data.pose_position = 'POSE'
    for name, ob in out.items():
        ob['accessory'] = name
        ob.hide_render = name not in DEFAULT_ON
    return out


# ── preview lineup (review only; not shipped) ─────────────────────────────────────────────────────
LINEUP = [
    ('hairA', ('techJacket', 'collarLight', 'wristDisplay'), '#2b3a55', '#29e3ff', 'Idle', 40),
    ('hairB', ('utilityVest', 'visor'), '#3a2a2a', '#ffb02e', 'Walk', 8),
    ('hairF', ('longCoat', 'arGlasses'), '#1d1f26', '#ff2bd6', 'StandTalk', 50),
    ('hairC', ('techJacket', 'headset'), '#5a1e24', '#d7ff3a', 'PhoneCall', 60),
    ('hairD', ('longCoat', 'visor', 'collarLight'), '#2a3b36', '#29e3ff', 'Walk', 24),
    ('hairE', ('utilityVest', 'arGlasses', 'wristDisplay'), '#3b3f48', '#e0202e', 'Wave', 20),
]


def render_lineup(res, outfits, out_dir):
    sc = bpy.context.scene
    arm = res['armature']
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type != 'CPU'
        sc.cycles.device = 'GPU'
    except Exception:  # noqa: BLE001
        pass
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX'
    sc.render.resolution_x, sc.render.resolution_y = 420, 760
    world = bpy.data.worlds.new('pv')
    sc.world = world
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.004, 0.006, 0.012, 1)
    floor = bpy.data.meshes.new('pvfloor')
    floor.from_pydata([(-3, -3, 0), (3, -3, 0), (3, 3, 0), (-3, 3, 0)], [], [(0, 1, 2, 3)])
    fo = bpy.data.objects.new('pvfloor', floor)
    sc.collection.objects.link(fo)
    fm = bpy.data.materials.new('pvfloor')
    fm.use_nodes = True
    fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.02, 0.022, 0.026, 1)
    fm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.15
    floor.materials.append(fm)
    from mathutils import Vector
    for name, loc, col, energy, size in (('key', (1.6, -2.2, 2.6), (1.0, 0.72, 0.42), 260, 1.2),
                                          ('rim', (-1.4, 1.8, 2.2), (0.3, 0.85, 1.0), 420, 0.8),
                                          ('fill', (-2.0, -1.5, 1.2), (0.6, 0.4, 1.0), 60, 1.5)):
        L = bpy.data.lights.new(name, 'AREA')
        L.energy, L.color, L.size = energy, col, size
        o = bpy.data.objects.new(name, L)
        sc.collection.objects.link(o)
        o.location = loc
        o.rotation_euler = (-Vector(loc) + Vector((0, 0, 1.0))).to_track_quat('-Z', 'Y').to_euler()
    cam = bpy.data.objects.new('pvcam', bpy.data.cameras.new('pvcam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.lens = 60
    cam.location = (0.9, -3.6, 1.15)
    cam.rotation_euler = (Vector((0, 0, 0.95)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    for o in res['props'].values():
        o.hide_render = True
    lod = res.get('lod1')
    if lod is not None:
        lod.hide_render = True
    tiles = []
    for i, (hair, wear, shirt, accent, clip, frame) in enumerate(LINEUP):
        for nm, ob in outfits.items():
            ob.hide_render = not (nm == hair or nm in wear)
        res['materials']['shirt'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = M.hex_rgba(shirt)
        p = res['materials']['accent'].node_tree.nodes['Principled BSDF']
        p.inputs['Emission Color'].default_value = M.hex_rgba(accent)
        arm.animation_data.action = res['actions'][clip]
        sc.frame_set(frame)
        path = os.path.join(out_dir, f'_tile{i}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path)
        w, h = img.size
        tiles.append(np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4))
        bpy.data.images.remove(img)
        os.remove(path)
    h, w, _ = tiles[0].shape
    grid = np.concatenate(tiles, axis=1)
    out = bpy.data.images.new('lineup', grid.shape[1], h, alpha=True)
    out.pixels.foreach_set(grid.ravel())
    out.filepath_raw = os.path.join(out_dir, 'character-cyber-lineup.png')
    out.file_format = 'PNG'
    out.save()
    B.log(f'lineup → {out.filepath_raw}')


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    res = CM.build_scene(args.quality)
    # the classic accessories make way for the outfit set (rig, body, props, LOD and clips stay as they are)
    for name, ob in list(res['accessories'].items()):
        bpy.data.objects.remove(ob, do_unlink=True)
    mats = res['materials']
    mats['accent'] = accent_material()
    sh = mats['shoes'].node_tree.nodes.get('Principled BSDF')  # dark tactical boots instead of white sneakers
    sh.inputs['Base Color'].default_value = M.hex_rgba('#1b1d22')
    sh.inputs['Roughness'].default_value = 0.45
    outfits = build_outfits(args.quality, mats, res)
    res['accessories'] = outfits
    glb = os.path.join(args.out, 'character-cyber.glb')
    CM.export_glb(glb)
    meta = CM.character_json(res)
    meta['accessories'] = {a: a in DEFAULT_ON for a in ACCESSORIES}
    meta['set'] = 'special'
    meta['materials'] = {'tint': ['skin', 'shirt', 'pants', 'hair', 'accent'], 'emissive': ['accent']}
    with open(os.path.join(args.out, 'character-cyber.json'), 'w') as fh:
        json.dump(meta, fh, indent=2)
        fh.write('\n')
    B.log(f'wrote {glb} ({os.path.getsize(glb) / 1e6:.2f} MB)')
    if args.preview:
        os.makedirs(args.preview, exist_ok=True)
        render_lineup(res, outfits, args.preview)


if __name__ == '__main__':
    main()
