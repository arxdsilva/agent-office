"""Seat calibration, keyframe writing (Bezier), and clip metadata."""
import math
import bpy
import numpy as np
from mathutils import Vector, Quaternion

import char_common as C
import char_clips as K


def finalize_pose(rig, p):
    pose = K.to_pose(p)
    if 'prop_frame' in pose:
        Rt, pos = pose.pop('prop_frame')
        pose['prop'] = {'rot': (Rt @ rig.R['prop.R'].transposed()).to_quaternion(), 'pos': pos}
    return pose


def apply_pose(arm_obj, rig, p):
    ch, D, H = rig.channels(finalize_pose(rig, p))
    for b, (loc, q) in ch.items():
        pb = arm_obj.pose.bones[b]
        pb.location = loc
        pb.rotation_quaternion = q
    return D, H


def deformed_coords(obj):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(ev.matrix_world)
    return co @ M[:3, :3].T + M[:3, 3]


def calibrate_seat(arm_obj, rig, body, part_of, base_fn, store, seat_z, seat_front_y, iters=40):
    """Adjust the seated hips height until the lowest point of the body over the seat (behind its
    front edge) is exactly seat_z."""
    parts = np.array(part_of)
    rest = np.array([v.co for v in body.data.vertices])
    pants = (parts == 'pants') & (rest[:, 2] > 0.6)
    minz = None
    for _ in range(iters):
        apply_pose(arm_obj, rig, base_fn())
        co = deformed_coords(body)
        sel = pants & (co[:, 1] > seat_front_y)
        minz = float(co[sel, 2].min())
        if abs(seat_z - minz) < 1e-5:
            break
        store['hipz'] += seat_z - minz
    apply_pose(arm_obj, rig, base_fn())
    co = deformed_coords(body)
    sel = pants & (co[:, 1] > seat_front_y)
    minz = float(co[sel, 2].min())
    i = int(np.argmin(np.where(sel, co[:, 2], 9)))
    return minz, Vector(co[i])


def reset_pose(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)


def write_action(arm_obj, rig, name, frames, loop):
    n = len(frames) - 1
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm_obj.animation_data or arm_obj.animation_data_create()
    ad.action = act
    bones = list(rig.R.keys())
    locs = {b: [] for b in bones}
    rots = {b: [] for b in bones}
    for p in frames:
        ch, _, _ = rig.channels(finalize_pose(rig, p))
        for b in bones:
            loc, q = ch[b]
            prev = rots[b][-1] if rots[b] else None
            if prev is not None and prev.dot(q) < 0:
                q = -q
            rots[b].append(q)
            locs[b].append(loc)
    for b in bones:
        grp = b
        chans = [('rotation_quaternion', 4, [[q.w, q.x, q.y, q.z] for q in rots[b]])]
        if b in ('hips', 'prop.R'):
            chans.append(('location', 3, [list(v) for v in locs[b]]))
        for prop, dim, vals in chans:
            path = f'pose.bones["{b}"].{prop}'
            for i in range(dim):
                fc = act.fcurve_ensure_for_datablock(arm_obj, path, index=i, group_name=grp)
                kp = fc.keyframe_points
                kp.add(n + 1)
                co = np.empty((n + 1) * 2, dtype=np.float32)
                co[0::2] = np.arange(n + 1)
                co[1::2] = [v[i] for v in vals]
                kp.foreach_set('co', co)
                for k in kp:
                    k.interpolation = 'BEZIER'
                    k.handle_left_type = 'AUTO_CLAMPED'
                    k.handle_right_type = 'AUTO_CLAMPED'
                fc.update()
    act.use_frame_range = True
    act.frame_start, act.frame_end = 0, n
    act.use_cyclic = bool(loop)
    return act


def sample_action(arm_obj, act, frame):
    """Pose-bone (loc, quat) per bone evaluated from the action at `frame`."""
    out = {}
    from bpy_extras import anim_utils
    slot = arm_obj.animation_data.action_slot if arm_obj.animation_data.action == act else act.slots[0]
    bag = anim_utils.action_get_channelbag_for_slot(act, slot)
    for fc in bag.fcurves:
        b = fc.data_path.split('"')[1]
        prop = fc.data_path.rsplit('.', 1)[1]
        out.setdefault((b, prop), {})[fc.array_index] = fc.evaluate(frame)
    return out
