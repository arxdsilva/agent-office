"""Builds the whole character scene: armature, skinned body, accessories, props, LOD1."""
import time
import bpy
import numpy as np
from mathutils import Vector, Matrix

import char_common as C
import char_sdf as S
import char_model as M
import char_rig as RG


def log(*a):
    print('[character]', *a, flush=True)


def reset_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.actions,
                 bpy.data.cameras, bpy.data.lights):
        for d in list(coll):
            coll.remove(d)
    sc = bpy.context.scene
    sc.render.fps = C.FPS
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0


def _mesh_object(name, V, F, mat, mats):
    ob = M._obj_from(V, F, name)
    ob.data.materials.append(mats[mat])
    ob.data.shade_smooth()
    return ob


def _multi_object(name, pieces, mats):
    ob, _ = M.assemble(name, [(V, F, m, m) for V, F, m in pieces], mats)
    return ob


def build_body(quality, mats):
    t0 = time.time()
    head_raw = M.sdf_head()
    head = M.head_space(head_raw)
    shirt = M.sdf_shirt()
    arm_l = M.sdf_arm_l()
    pants = M.sdf_pants()
    shoe_l = M.sdf_shoe_l()
    eyes, brows, mouth = (M.head_space(f) for f in M.sdf_face_details(head_raw))
    fine = 'final' == quality
    parts = [
        M.Part('head', head, (-0.15, -0.17, 1.30), (0.15, 0.17, 1.79), 1900, 'skin'),
        M.Part('shirt', shirt, (-0.42, -0.17, 0.93), (0.42, 0.19, 1.52), 1700, 'shirt'),
        M.Part('arm.L', arm_l, (0.18, -0.16, 0.86), (0.72, 0.08, 1.42), 800, 'skin', mirror=True,
               h=0.0032 if fine else 0.0045),
        M.Part('pants', pants, (-0.23, -0.13, 0.09), (0.23, 0.18, 1.07), 1250, 'pants'),
        M.Part('shoe.L', shoe_l, (0.03, -0.23, -0.01), (0.17, 0.11, 0.14), 260, 'shoes', mirror=True,
               h=0.0035 if fine else 0.005),
        M.Part('eyes', eyes, (-0.08, -0.15, 1.58), (0.08, -0.07, 1.66), 120, 'eyes', part='face', h=0.0012),
        M.Part('brows', brows, (-0.09, -0.15, 1.63), (0.09, -0.06, 1.69), 110, 'hair', part='face', h=0.0012),
        M.Part('mouth', mouth, (-0.04, -0.15, 1.51), (0.04, -0.08, 1.56), 40, 'eyes', part='face', h=0.001),
    ]
    pieces = []
    for p in parts:
        V, F = M.build_part(p, quality)
        log(f'part {p.name}: {len(V)} verts {M._tri_count(F)} tris')
        pieces.append((V, F, p.material, p.part))
        if p.mirror:
            Vm, Fm = M.mirror_mesh(V, F)
            pieces.append((Vm, Fm, p.material, p.part.replace('.L', '.R')))
    body, part_of = M.assemble('body', pieces, mats)
    log(f'body built in {time.time() - t0:.1f}s, {sum(len(p.vertices) - 2 for p in body.data.polygons)} tris')
    sdfs = {'head_raw': head_raw, 'head': head, 'shirt': shirt, 'pants': pants, 'shoe.L': shoe_l,
            'shoe.R': S.mirror_x(shoe_l), 'sleeve': M.sdf_sleeve_inner()}
    return body, part_of, sdfs


def hidden_overlaps(body, part_of, sdfs):
    """Inner-layer vertices covered by a garment copy that garment's nearest vertex weights."""
    co = [v.co.copy() for v in body.data.vertices]
    P = np.array(co, dtype=np.float32)
    parts = np.array(part_of)
    out = {}
    rules = [(('arm.L', 'arm.R'), 'shirt', sdfs['shirt'], 0.006),
             (('head',), 'shirt', sdfs['shirt'], 0.006),
             (('pants',), 'shirt', sdfs['shirt'], 0.006),
             (('pants',), 'shoe.L', sdfs['shoe.L'], 0.006),
             (('pants',), 'shoe.R', sdfs['shoe.R'], 0.006)]
    for inner, outer, f, margin in rules:
        src = np.where(parts == outer)[0]
        cand = np.where(np.isin(parts, inner))[0]
        d = f(P[cand])
        cov = cand[d < margin]
        if not len(cov) or not len(src):
            continue
        nm = RG.nearest_map([co[i] for i in src], [co[i] for i in cov])
        for dst, j in zip(cov, nm):
            out[int(dst)] = int(src[j])
    return out


def build_accessories(quality, mats, head_sdf, shirt_sdf):
    res = {}
    fine = quality == 'final'
    for v in ('hairA', 'hairB', 'hairC', 'hairD'):
        f = M.head_space(M.sdf_hair(v))
        p = M.Part(v, f, (-0.18, -0.18, 1.44), (0.18, 0.2, 1.86), 1500 if v == 'hairC' else 1400, 'hair',
                   h=0.003 if fine else 0.0038)
        V, F = M.build_part(p, quality)
        res[v] = _mesh_object(v, V, F, 'hair', mats)
        log(f'{v}: {M._tri_count(F)} tris')
    g = M.head_space(M.sdf_glasses(head_sdf))
    V, F = M.build_part(M.Part('glasses', g, (-0.14, -0.17, 1.55), (0.14, 0.07, 1.68), 700, 'plastic', h=0.0011), quality)
    res['glasses'] = _mesh_object('glasses', V, F, 'plastic', mats)
    hs = M.head_space(M.sdf_headset())
    V, F = M.build_part(M.Part('headset', hs, (-0.18, -0.15, 1.46), (0.18, 0.08, 1.80), 800, 'plastic', h=0.002), quality)
    res['headset'] = _mesh_object('headset', V, F, 'plastic', mats)
    holder, face = M.sdf_badge(shirt_sdf)
    V1, F1 = M.build_part(M.Part('badge', holder, (-0.1, -0.15, 1.12), (0.1, 0.1, 1.47), 500, 'badge', h=0.0012), quality)
    V2, F2 = face
    res['badge'] = _multi_object('badge', [(V1, F1, 'badge'), (V2, F2, 'white')], mats)
    return res


def build_props(quality, mats):
    o, X, Y, Z = M.prop_frame()
    res = {}

    def make(name, items, lo, hi, h):
        pieces = []
        for loc_sdf, mat, tris in items:
            if isinstance(loc_sdf, tuple):  # (V, F) decal
                V, F = loc_sdf
            else:
                V, F = M.build_part(M.Part(name, loc_sdf, lo, hi, tris, mat, h=h), quality)
            pieces.append((V, F, mat))
        ob = _multi_object(name, pieces, mats)
        return ob

    # Each prop is modelled in a local frame then placed relative to the prop.R socket.
    def placed(loc_sdf, origin, Xa, Ya, Za):
        return M.sdf_in_frame(loc_sdf, origin, Xa, Ya, Za)

    def decal(origin, Xa, Ya, Za, c, ex, ey, w, h, circle=0):
        Mx = np.stack([Xa, Ya, Za], axis=1)
        V, F = M.plate(origin + Mx @ np.asarray(c), Mx @ np.asarray(ex), Mx @ np.asarray(ey), w, h, circle)
        return (V, F)

    # cup: mug axis along the thumb, body pressed into the curled fingers
    cup_o = o + Z * 0.012
    cupX, cupY, cupZ = -Z, np.cross(X, -Z), X
    cup = make('cup', [(placed(M.sdf_cup_local(), cup_o, cupX, cupY, cupZ), 'white', 700),
                       (decal(cup_o, cupX, cupY, cupZ, (0, 0, 0.039), (1, 0, 0), (0, 1, 0), 0.0336, 0, 20), 'wood', 0)],
               cup_o - 0.1, cup_o + 0.1, 0.0016)
    res['cup'] = cup
    # phone: held in the palm, screen facing away from the palm
    ph_o = o + X * 0.022 - Y * 0.01 - Z * 0.007
    # long axis along the thumb: at the ear it runs from the ear toward the mouth
    phone = make('phone', [(placed(M.sdf_phone_local(), ph_o, Y, X, -Z), 'plastic', 220),
                           (decal(ph_o, Y, X, -Z, (0, 0, -0.0047), (1, 0, 0), (0, -1, 0), 0.064, 0.136), 'screen', 0)],
                 ph_o - 0.1, ph_o + 0.1, 0.0012)
    res['phone'] = phone
    # paddle: handle in the fist, blade continuing along the fingers' perpendicular (thumb side)
    pd_o = o
    pdY = 0.85 * X + 0.53 * Y  # handle runs diagonally across the palm toward the thumb web
    pdY = pdY / np.linalg.norm(pdY)
    pdZ = -Z  # blade face parallel to the palm
    pdX = np.cross(pdY, pdZ)
    paddle = make('paddle', [(placed(M.sdf_paddle_local(), pd_o - pdY * 0.02, pdX, pdY, pdZ), 'rubber', 320),
                             (placed(M.sdf_paddle_handle_local(), pd_o - pdY * 0.02, pdX, pdY, pdZ), 'wood', 220)],
                  pd_o - 0.24, pd_o + 0.24, 0.0018)
    res['paddle'] = paddle
    # laptop: canonical frame = the socket frame (x width, y depth, z up). Animated onto the lap.
    lt = make('laptop', [(placed(M.sdf_laptop_local(), o, X, Y, Z), 'metal', 300),
                         (decal(o, X, Y, Z, *M.laptop_screen_decal()), 'screen', 0),
                         (decal(o, X, Y, Z, (0, -0.015, 0.0172), (1, 0, 0), (0, 1, 0), 0.26, 0.1), 'plastic', 0)],
              o - 0.32, o + 0.32, 0.0025)
    res['laptop'] = lt
    # book: an open hardcover in the socket frame (x across the spread, y up the page, z toward
    # the reader, origin at the spine). Two-hand holds animate the socket (SitRead, ShelfPick).
    pieces = []
    for sgn in (-1.0, 1.0):
        for c, size, mat in (((sgn * 0.077, 0.0, -0.009), (0.154, 0.228, 0.004), 'cover'),
                             ((sgn * 0.073, 0.0, -0.0005), (0.142, 0.212, 0.013), 'white')):
            V, F = M.box(c, size, ('y', -sgn * 9.0))
            Mx = np.stack([X, Y, Z], axis=1)
            pieces.append((o + V @ Mx.T, F, mat))
    V, F = M.box((0, 0, -0.009), (0.012, 0.228, 0.006), None)
    pieces.append((o + V @ np.stack([X, Y, Z], axis=1).T, F, 'cover'))
    book = _multi_object('book', pieces, mats)
    book.data.shade_flat()
    res['book'] = book
    return res


def build_lod1(body, target=2000):
    lod = body.copy()
    lod.data = body.data.copy()
    lod.name = 'body-lod1'
    lod.data.name = 'body-lod1'
    bpy.context.scene.collection.objects.link(lod)
    lod.modifiers.clear()
    tris = sum(len(p.vertices) - 2 for p in lod.data.polygons)
    dec = lod.modifiers.new('dec', 'DECIMATE')
    dec.ratio = target / tris
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(lod.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    lod.modifiers.clear()
    old = lod.data
    lod.data = me
    bpy.data.meshes.remove(old)
    me.name = 'body-lod1'
    me.shade_smooth()
    return lod


def build(quality='draft'):
    reset_scene()
    mats = M.make_materials()
    arm = RG.build_armature()
    body, part_of, sdfs = build_body(quality, mats)
    t0 = time.time()
    RG.auto_weights(body, arm)
    hid = hidden_overlaps(body, part_of, sdfs)
    RG.cleanup_weights(body, arm, part_of, hid)
    log(f'weights in {time.time() - t0:.1f}s ({len(hid)} hidden-overlap vertices)')
    acc = build_accessories(quality, mats, sdfs['head_raw'], sdfs['shirt'])
    for name, ob in acc.items():
        RG.rigid_bind(ob, arm, 'chest' if name == 'badge' else 'head')
        ob['accessory'] = name
        ob.hide_render = name != 'hairA'
    props = build_props(quality, mats)
    for name, ob in props.items():
        RG.rigid_bind(ob, arm, 'prop.R')
        ob['prop'] = name
        ob.hide_render = True
    lod = build_lod1(body)
    lod.parent = arm
    am = lod.modifiers.new('Armature', 'ARMATURE')
    am.object = arm
    RG.cleanup_weights(lod, arm, _lod_parts(lod, body, part_of), None, smooth_iters=0)
    lod['lod'] = 1
    lod.hide_render = True
    return {'armature': arm, 'body': body, 'accessories': acc, 'props': props, 'lod1': lod,
            'materials': mats, 'part_of': part_of, 'sdfs': sdfs}


def _lod_parts(lod, body, part_of):
    nm = RG.nearest_map([v.co for v in body.data.vertices], [v.co for v in lod.data.vertices])
    return [part_of[i] for i in nm]
