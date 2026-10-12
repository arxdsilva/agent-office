"""Armature creation and skin-weight cleanup."""
import bpy
import numpy as np
from mathutils import Vector, Matrix, kdtree

import char_common as C


def build_armature(name='Armature'):
    arm = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    for bname, (head, tail, parent, deform, zhint) in C.BONES.items():
        b = eb.new(bname)
        b.head, b.tail = Vector(head), Vector(tail)
        b.align_roll(Vector(zhint))
        b.use_deform = deform
    for bname, (head, tail, parent, deform, zhint) in C.BONES.items():
        if parent:
            b = eb[bname]
            b.parent = eb[parent]
            b.use_connect = (Vector(eb[parent].tail) - Vector(head)).length < 1e-6
    # prop socket: grip point inside the curled right hand; Y along the fingers, Z out of the palm
    h = eb['hand.R']
    th, u, palm = hand_frame('R')
    grip = h.head + u * 0.072 + palm * 0.03
    p = eb.new('prop.R')
    p.head, p.tail = grip, grip + u * 0.08
    p.align_roll(palm)
    p.parent = h
    p.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in obj.pose.bones:
        b.rotation_mode = 'QUATERNION'
    obj.show_in_front = True
    return obj


def hand_frame(side):
    """(thumb, fingers, palm) unit vectors of a hand in the rest pose."""
    m = -1.0 if side == 'R' else 1.0
    w, t = Vector(C.WRIST_J), Vector(C.HAND_TIP)
    w.x *= m
    t.x *= m
    u = (t - w).normalized()
    p = Vector((C.PALM_REST_L[0] * m, C.PALM_REST_L[1], C.PALM_REST_L[2]))
    p = (p - u * p.dot(u)).normalized()
    th = p.cross(u).normalized() if side == 'L' else u.cross(p).normalized()
    return th, u, p


# ── skin weights ──────────────────────────────────────────────────────────────────────────────
PART_BONES = {
    'head': {'head', 'neck', 'chest'},
    'face': {'head'},
    'shirt': {'hips', 'spine', 'chest', 'neck', 'shoulder.L', 'shoulder.R', 'upperarm.L', 'upperarm.R'},
    'arm.L': {'chest', 'shoulder.L', 'upperarm.L', 'forearm.L', 'hand.L'},
    'arm.R': {'chest', 'shoulder.R', 'upperarm.R', 'forearm.R', 'hand.R'},
    'pants': {'hips', 'spine', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R'},
    'shoe.L': {'foot.L', 'toe.L', 'shin.L'},
    'shoe.R': {'foot.R', 'toe.R', 'shin.R'},
}


def _segment_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def _distance_weights(P, bones, arm):
    """Fallback weights from distance to bone segments (smooth inverse power)."""
    names = sorted(bones)
    D = np.stack([_segment_dist(P, np.array(arm.data.bones[n].head_local), np.array(arm.data.bones[n].tail_local))
                  for n in names], axis=1)
    W = 1.0 / np.maximum(D, 1e-3) ** 4
    return names, W / W.sum(axis=1, keepdims=True)


def cleanup_weights(obj, arm, part_of_vertex, hidden_map=None, smooth_iters=3, max_influences=4):
    """Mask weights per body part, fill gaps, smooth, limit to 4 influences, normalise.

    part_of_vertex: list of part names (PART_BONES keys) per vertex.
    hidden_map: {vertex index: source vertex index} - hidden overlap vertices copy the weights of
                the garment vertex covering them so the layers deform together.
    """
    me = obj.data
    nv = len(me.vertices)
    names = [g.name for g in obj.vertex_groups]
    bone_names = list(C.DEFORM_BONES)
    for b in bone_names:
        if b not in names:
            obj.vertex_groups.new(name=b)
    gidx = {g.name: g.index for g in obj.vertex_groups}
    W = np.zeros((nv, len(bone_names)), dtype=np.float64)
    col = {b: i for i, b in enumerate(bone_names)}
    for v in me.vertices:
        for g in v.groups:
            n = obj.vertex_groups[g.group].name
            if n in col:
                W[v.index, col[n]] = g.weight
    # 1. mask by part
    mask = np.zeros_like(W, dtype=bool)
    parts = np.array(part_of_vertex)
    for part, allowed in PART_BONES.items():
        sel = parts == part
        for b in allowed:
            mask[sel, col[b]] = True
    W *= mask
    # 2. fill vertices without weights from bone-segment distance
    P = np.array([v.co for v in me.vertices])
    empty = W.sum(axis=1) < 1e-4
    for part, allowed in PART_BONES.items():
        sel = np.where(empty & (parts == part))[0]
        if len(sel):
            nm, DW = _distance_weights(P[sel], allowed, arm)
            for j, b in enumerate(nm):
                W[sel, col[b]] = DW[:, j]
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    # 3. smooth over edges within a part (Laplacian), keeping the part mask
    E = np.array([e.vertices[:] for e in me.edges])
    same = parts[E[:, 0]] == parts[E[:, 1]]
    E = E[same]
    for _ in range(smooth_iters):
        acc = np.zeros_like(W)
        cnt = np.zeros(nv)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        np.add.at(cnt, E[:, 0], 1)
        np.add.at(cnt, E[:, 1], 1)
        nb = acc / np.maximum(cnt, 1)[:, None]
        W = np.where(cnt[:, None] > 0, 0.5 * W + 0.5 * nb, W) * mask
        W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    # 4. hidden overlaps copy the covering garment's weights
    if hidden_map:
        for dst, src in hidden_map.items():
            W[dst] = W[src]
    # 5. limit + normalise
    order = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, dtype=bool)
    rows = np.arange(nv)[:, None]
    keep[rows, order[:, :max_influences]] = True
    W = np.where(keep & (W > 0.01), W, 0.0)
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    # write back
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    groups = {b: obj.vertex_groups.new(name=b) for b in bone_names}
    for j, b in enumerate(bone_names):
        idx = np.nonzero(W[:, j])[0]
        g = groups[b]
        for i in idx:
            g.add([int(i)], float(W[i, j]), 'REPLACE')
    return W


def auto_weights(obj, arm):
    """Blender bone-heat automatic weights (parent with ARMATURE_AUTO)."""
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o is not None:
            o.select_set(False)
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    with bpy.context.temp_override(active_object=arm, object=arm, selected_objects=[obj, arm],
                                   selected_editable_objects=[obj, arm]):
        bpy.ops.object.parent_set(type='ARMATURE_AUTO', keep_transform=True)
    obj.select_set(False)
    arm.select_set(False)


def rigid_bind(obj, arm, bone):
    """Parent an object rigidly to a bone (armature must be in its rest pose), keeping its world
    transform."""
    mw = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    obj.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()
    obj.matrix_world = mw
    bpy.context.view_layer.update()


def nearest_map(src_points, dst_points):
    """Index of the nearest src point for every dst point."""
    kd = kdtree.KDTree(len(src_points))
    for i, p in enumerate(src_points):
        kd.insert(p, i)
    kd.balance()
    return [kd.find(p)[1] for p in dst_points]
