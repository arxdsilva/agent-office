"""Pose solver: world-space deltas, two-bone IK and conversion to Blender pose-bone channels.

A pose is a dict authored in the *character frame* (Blender axes, root un-rotated):
  yaw            root yaw in radians (+ = turn left; equals the glTF heading delta)
  hips_off       Vector offset of the hips bone head from its rest position
  hips           Quaternion: world-space rotation delta of the pelvis
  spine/chest/neck/head, shoulder.L/R   Quaternion deltas relative to the parent (rest axes)
  head_world     optional Quaternion: absolute world delta of the head (stabilised head)
  arm.L/R        {'wrist': Vector, 'pole': Vector, 'hand': Quaternion|None (world delta),
                  'hand_rel': Quaternion|None, 'twist': 0..1 share of wrist twist given to the forearm}
  leg.L/R        {'ankle': Vector, 'pole': Vector, 'foot': Quaternion, 'toe': Quaternion}
  prop           None | {'rot': Quaternion world delta, 'pos': Vector}
For a bone b with parent p and rest rotation R_b the pose-bone quaternion is
  B_b = R_b^-1 · D_p^-1 · D_b · R_b
where D are world-space deltas (posed rotation = D · R_rest).
"""
import math
from mathutils import Vector, Matrix, Quaternion

import char_common as C

I = Quaternion()


def q_euler(pitch=0.0, roll=0.0, yaw=0.0):
    """Degrees; pitch about +X (+ bends forward / toes down), roll about +Y, yaw about +Z (+ = left)."""
    qx = Quaternion((1, 0, 0), math.radians(pitch))
    qy = Quaternion((0, 1, 0), math.radians(roll))
    qz = Quaternion((0, 0, 1), math.radians(yaw))
    return qz @ qx @ qy


def q_mirror(q):
    return Quaternion((q.w, q.x, -q.y, -q.z))


def v_mirror(v):
    return Vector((-v[0], v[1], v[2]))


def _frame(a, b):
    a = a.normalized()
    b = (b - a * a.dot(b)).normalized()
    c = a.cross(b)
    return Matrix((a, b, c)).transposed()


class Rig:
    def __init__(self, arm_obj):
        self.obj = arm_obj
        self.R, self.h, self.t, self.parent = {}, {}, {}, {}
        for b in arm_obj.data.bones:
            self.R[b.name] = b.matrix_local.to_3x3().normalized()
            self.h[b.name] = b.head_local.copy()
            self.t[b.name] = b.tail_local.copy()
            self.parent[b.name] = b.parent.name if b.parent else None
        self.limb = {}
        for side in 'LR':
            for kind, (a, b, c) in (('arm', ('upperarm', 'forearm', 'hand')), ('leg', ('thigh', 'shin', 'foot'))):
                A, B, Cc = self.h[f'{a}.{side}'], self.h[f'{b}.{side}'], self.h[f'{c}.{side}']
                r1, r2 = (B - A), (Cc - B)
                L1, L2 = r1.length, r2.length
                r1n, r2n = r1.normalized(), r2.normalized()
                n = r1n.cross(r2n).normalized()
                self.limb[(kind, side)] = (L1, L2, r1n, r2n, n)
        self.last_reach = {}

    # ── helpers ───────────────────────────────────────────────────────────────────────────────
    def rest_offset(self, b):
        p = self.parent[b]
        return self.h[b] - (self.h[p] if p else Vector())

    def two_bone(self, kind, side, S, T, pole):
        L1, L2, r1, r2, n_rest = self.limb[(kind, side)]
        d = T - S
        dist = d.length
        dirn = d / max(dist, 1e-9)
        self.last_reach[(kind, side)] = dist / (L1 + L2)
        dist = min(max(dist, abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995)
        a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
        hgt = math.sqrt(max(L1 * L1 - a * a, 0.0))
        pp = pole - dirn * pole.dot(dirn)
        pp.normalize()
        E = S + dirn * a + pp * hgt
        Tc = S + dirn * dist
        u1 = (E - S).normalized()
        u2 = (Tc - E).normalized()
        n = pp.cross(dirn).normalized()
        D1 = (_frame(u1, n) @ _frame(r1, n_rest).transposed()).to_quaternion()
        D2 = (_frame(u2, n) @ _frame(r2, n_rest).transposed()).to_quaternion()
        return D1, D2, E, Tc

    # ── main ──────────────────────────────────────────────────────────────────────────────────
    def solve(self, pose):
        """Returns (D: world deltas per bone, H: posed head positions in the character frame)."""
        D, H = {'root': I.copy()}, {'root': Vector()}
        D['hips'] = pose.get('hips', I)
        H['hips'] = self.h['hips'] + pose.get('hips_off', Vector())

        def fk(b, delta):
            p = self.parent[b]
            H[b] = H[p] + D[p] @ self.rest_offset(b)
            D[b] = D[p] @ delta

        for b in ('spine', 'chest', 'neck', 'head'):
            fk(b, pose.get(b, I))
        if 'head_world' in pose:
            D['head'] = pose['head_world']
        for side in 'LR':
            fk(f'shoulder.{side}', pose.get(f'shoulder.{side}', I))
            a = pose[f'arm.{side}']
            ua = f'upperarm.{side}'
            H[ua] = H[f'shoulder.{side}'] + D[f'shoulder.{side}'] @ self.rest_offset(ua)
            spaces = {'chest': (H[ua], D['chest']), 'head': (H['head'], D['head']), 'char': (Vector(), I)}
            wrist = Vector()
            qs = Quaternion((0, 0, 0, 0))
            tot = 0.0
            for sp, wgt, off in a['targets']:
                if wgt <= 0:
                    continue
                base, Rs = spaces[sp]
                wrist += (base + Rs @ Vector(off)) * wgt
                q = Rs.copy()
                if q.dot(D['chest']) < 0:
                    q.negate()
                qs = Quaternion((qs.w + q.w * wgt, qs.x + q.x * wgt, qs.y + q.y * wgt, qs.z + q.z * wgt))
                tot += wgt
            wrist /= tot
            qs.normalize()
            D1, D2, E, W = self.two_bone('arm', side, H[ua], wrist, D['chest'] @ Vector(a['pole']))
            D[ua], D[f'forearm.{side}'] = D1, D2
            H[f'forearm.{side}'], H[f'hand.{side}'] = E, W
            h_rel = D2 @ a.get('hand_rel', I)
            hw = a.get('hand_w', 0.0)
            if hw > 0:
                h_dir = qs @ a['hand_dir']
                hand = h_rel.slerp(h_dir, min(hw, 1.0))
            else:
                hand = h_rel
            D[f'hand.{side}'] = hand
            share = a.get('twist', 0.5)
            if share:
                r2 = self.limb[('arm', side)][3]
                rel = D2.inverted() @ hand
                proj = Vector((rel.x, rel.y, rel.z)).dot(r2)
                ang = 2 * math.atan2(proj, rel.w)
                if ang > math.pi:
                    ang -= 2 * math.pi
                elif ang < -math.pi:
                    ang += 2 * math.pi
                D[f'forearm.{side}'] = D2 @ Quaternion(r2, ang * share)
            lg = pose[f'leg.{side}']
            th = f'thigh.{side}'
            H[th] = H['hips'] + D['hips'] @ self.rest_offset(th)
            D1, D2, K, A = self.two_bone('leg', side, H[th], lg['ankle'], lg['pole'])
            D[th], D[f'shin.{side}'] = D1, D2
            H[f'shin.{side}'], H[f'foot.{side}'] = K, A
            D[f'foot.{side}'] = lg.get('foot', I)
            H[f'toe.{side}'] = A + D[f'foot.{side}'] @ self.rest_offset(f'toe.{side}')
            D[f'toe.{side}'] = lg.get('toe', D[f'foot.{side}'])
        H['prop.R'] = H['hand.R'] + D['hand.R'] @ self.rest_offset('prop.R')
        pr = pose.get('prop')
        if pr:
            D['prop.R'] = pr['rot']
            H['prop.R'] = pr['pos']
        else:
            D['prop.R'] = D['hand.R']
        return D, H

    def channels(self, pose):
        """Pose-bone (location, rotation_quaternion) for every bone."""
        D, H = self.solve(pose)
        out = {}
        yaw = Quaternion((0, 0, 1), pose.get('yaw', 0.0))
        for b in self.R:
            Rb = self.R[b]
            p = self.parent[b]
            if b == 'root':
                q = (Rb.transposed() @ yaw.to_matrix() @ Rb).to_quaternion()
                out[b] = (Vector(), q)
                continue
            rel = D[p].inverted() @ D[b]
            q = (Rb.transposed() @ rel.to_matrix() @ Rb).to_quaternion()
            loc = Vector()
            if b == 'hips':
                loc = Rb.transposed() @ pose.get('hips_off', Vector())
            elif b == 'prop.R' and pose.get('prop'):
                expect = H[p] + D[p] @ self.rest_offset(b)
                loc = Rb.transposed() @ (D[p].inverted() @ (H[b] - expect))
            out[b] = (loc, q)
        return out, D, H

    def world_point(self, D, H, bone, rest_point, yaw=0.0):
        """A rest-pose point rigidly attached to `bone`, in the yawed world frame."""
        p = H[bone] + D[bone] @ (Vector(rest_point) - self.h[bone])
        return Quaternion((0, 0, 1), yaw) @ p


# ── feet ─────────────────────────────────────────────────────────────────────────────────────
ANKLE = Vector(C.ANKLE_J)
BALL = Vector(C.BALL_J)
HEEL = Vector(C.HEEL_GROUND)


def foot_pose(side, anchor, yaw_deg=0.0, pitch_deg=0.0, pivot='flat', toe_flex=0.0, pole=None):
    """Leg target for a foot.

    anchor: for 'flat' the ankle's ground projection (x, y); for 'ball' the ball joint position;
            for 'heel' the heel ground contact point. All in the character frame.
    pitch_deg > 0 lifts the heel (rotation about the ball), < 0 lifts the toes (about the heel).
    """
    m = -1.0 if side == 'R' else 1.0
    ank_r = Vector((ANKLE.x * m, ANKLE.y, ANKLE.z))
    ball_r = Vector((BALL.x * m, BALL.y, BALL.z))
    heel_r = Vector((HEEL.x * m, HEEL.y, HEEL.z))
    qy = Quaternion((0, 0, 1), math.radians(yaw_deg))
    Df = qy @ Quaternion((1, 0, 0), math.radians(pitch_deg))
    a = Vector(anchor)
    if pivot == 'flat':
        ankle = Vector((a.x, a.y, ank_r.z))
    elif pivot == 'ball':
        ankle = a - Df @ (ball_r - ank_r)
    elif pivot == 'heel':
        ankle = a - Df @ (heel_r - ank_r)
    else:
        ankle = a
    if pivot == 'ball':
        Dt = qy @ Quaternion((1, 0, 0), math.radians(toe_flex))
    else:
        Dt = Df @ Quaternion((1, 0, 0), math.radians(toe_flex))
    return {'ankle': ankle, 'foot': Df, 'toe': Dt, 'pole': pole or Vector((0.12 * m, -1.0, 0.0))}


def stand_foot(side, x=0.106, y=0.03, yaw=6.0):
    m = -1.0 if side == 'R' else 1.0
    return foot_pose(side, (x * m, y), yaw_deg=yaw * m)
