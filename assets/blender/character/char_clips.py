"""The 19 clips, authored procedurally as per-frame parameter sets.

Parameters are plain nested dicts of numbers so key poses can be splined (Catmull-Rom, eased
ends) and layered with periodic secondary motion. Right-side limb values are authored mirrored
(+x = outward) and mirrored back in `to_pose`. Character frame = Blender axes: +X left,
-Y forward, +Z up.
"""
import copy
import math
import numpy as np
from mathutils import Vector, Quaternion, Matrix

import char_common as C
import char_pose as CP
from char_rig import hand_frame

TAU = 2 * math.pi
ANK_Z = C.ANKLE_J[2]


# ── curves ────────────────────────────────────────────────────────────────────────────────────
def sm(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def smr(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * t * (t * (6 * t - 15) + 10)


def bump(t):
    """0 -> 1 -> 0 over t in [0, 1], zero slope at both ends."""
    t = min(max(t, 0.0), 1.0)
    return math.sin(math.pi * t) ** 2


def wave(f, period, phase=0.0):
    return math.sin(TAU * (f / period + phase))


def _flatten(p, out):
    if isinstance(p, dict):
        for k in sorted(p):
            _flatten(p[k], out)
    elif isinstance(p, (list, tuple)):
        for v in p:
            _flatten(v, out)
    else:
        out.append(float(p))
    return out


def _rebuild(p, it):
    if isinstance(p, dict):
        return {k: _rebuild(p[k], it) for k in sorted(p)}
    if isinstance(p, (list, tuple)):
        return tuple(_rebuild(v, it) for v in p)
    return next(it)


def spline(keys, t, period=None):
    """Catmull-Rom through (time, params) keys. Non-periodic: zero slope at the ends (ease).
    Periodic: keys span [0, period) and wrap."""
    ts = [k[0] for k in keys]
    vs = [np.array(_flatten(k[1], [])) for k in keys]
    n = len(keys)
    if n == 1:
        return copy.deepcopy(keys[0][1])
    if period:
        t = t % period
        ext_t = [ts[-1] - period] + ts + [ts[0] + period, ts[1] + period if n > 1 else ts[0] + 2 * period]
        ext_v = [vs[-1]] + vs + [vs[0], vs[1 % n]]
        i = max(j for j in range(len(ext_t) - 1) if ext_t[j] <= t)
        i = min(i, len(ext_t) - 3)
        t0, t1 = ext_t[i], ext_t[i + 1]
        p0, p1 = ext_v[i], ext_v[i + 1]
        tm = ext_t[i - 1] if i > 0 else t0 - (t1 - t0)
        vm = ext_v[i - 1] if i > 0 else p0
        tp = ext_t[i + 2]
        vp = ext_v[i + 2]
        m0 = (p1 - vm) / (t1 - tm)
        m1 = (vp - p0) / (tp - t0)
    else:
        if t <= ts[0]:
            return copy.deepcopy(keys[0][1])
        if t >= ts[-1]:
            return copy.deepcopy(keys[-1][1])
        i = max(j for j in range(n - 1) if ts[j] <= t)
        t0, t1 = ts[i], ts[i + 1]
        p0, p1 = vs[i], vs[i + 1]
        m0 = np.zeros_like(p0) if i == 0 else (p1 - vs[i - 1]) / (t1 - ts[i - 1])
        m1 = np.zeros_like(p0) if i + 1 == n - 1 else (vs[i + 2] - p0) / (ts[i + 2] - t0)
    h = t1 - t0
    s = (t - t0) / h
    h00 = 2 * s ** 3 - 3 * s ** 2 + 1
    h10 = s ** 3 - 2 * s ** 2 + s
    h01 = -2 * s ** 3 + 3 * s ** 2
    h11 = s ** 3 - s ** 2
    v = h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1
    return _rebuild(keys[0][1], iter(v.tolist()))


def lerp_p(a, b, t):
    va, vb = np.array(_flatten(a, [])), np.array(_flatten(b, []))
    return _rebuild(a, iter((va + (vb - va) * t).tolist()))


def add(p, key, d, sub=None):
    """In-place add of a tuple delta to p[key] (or p[key][sub])."""
    if sub is None:
        p[key] = tuple(x + y for x, y in zip(p[key], d))
    else:
        p[key][sub] = tuple(x + y for x, y in zip(p[key][sub], d))


# ── parameter sets ────────────────────────────────────────────────────────────────────────────
HANG = (0.05, -0.012, -0.505)


def arm(chest=HANG, char=(0.2, 0.0, 0.9), head=(0.1, -0.05, -0.1), sw=(1, 0, 0), pole=(0.4, 1.0, -0.15),
        rel=(0, 0, 0), f=(0, -1, 0), pa=(0, 0, -1), hw=0.0, twist=0.5):
    return {'chest': tuple(chest), 'char': tuple(char), 'head': tuple(head), 'sw': tuple(sw), 'pole': tuple(pole),
            'rel': tuple(rel), 'f': tuple(f), 'pa': tuple(pa), 'hw': hw, 'twist': twist}


def leg(ankle=(0.106, 0.03, ANK_Z), yaw=6.0, pitch=0.0, toe=0.0, pole=(0.12, -1.0, 0.0)):
    return {'ankle': tuple(ankle), 'yaw': yaw, 'pitch': pitch, 'toe': toe, 'pole': tuple(pole)}


def neutral():
    return {
        'yaw': 0.0, 'hip': (0.0, 0.0, -0.004), 'hrot': (0.0, 0.0, 0.0),
        'spine': (0.5, 0.0, 0.0), 'chest': (-3.5, 0.0, 0.0), 'neck': (-1.0, 0.0, 0.0), 'head': (0.5, 0.0, 0.0),
        'clavL': (0.0, 0.0, 0.0), 'clavR': (0.0, 0.0, 0.0),
        'armL': arm(), 'armR': arm(),
        'legL': leg(), 'legR': leg(),
        'prop': {'on': 0.0, 'pos': (0.0, 0.0, 0.0), 'x': (1, 0, 0), 'y': (0, 1, 0)},
    }


def _hand_q(side, f, pa):
    _, u_r, p_r = hand_frame(side)
    F = CP._frame(Vector(f), Vector(pa))
    Fr = CP._frame(u_r, p_r)
    return (F @ Fr.transposed()).to_quaternion()


def _mv(v, side):
    return Vector(v) if side == 'L' else Vector((-v[0], v[1], v[2]))


def _mq(q, side):
    return q if side == 'L' else CP.q_mirror(q)


def to_pose(p):
    pose = {
        'yaw': math.radians(p['yaw']),
        'hips_off': Vector(p['hip']),
        'hips': CP.q_euler(*p['hrot']),
    }
    for b in ('spine', 'chest', 'neck', 'head'):
        pose[b] = CP.q_euler(*p[b])
    if 'head_w' in p:
        pose['head_world'] = CP.q_euler(*p['head_w'])
    for side in 'LR':
        pose[f'shoulder.{side}'] = _mq(CP.q_euler(*p['clav' + side]), side)
        a = p['arm' + side]
        sw = a['sw']
        pose[f'arm.{side}'] = {
            'targets': [('chest', sw[0], _mv(a['chest'], side)), ('char', sw[1], _mv(a['char'], side)),
                        ('head', sw[2], _mv(a['head'], side))],
            'pole': _mv(a['pole'], side),
            'hand_rel': _mq(CP.q_euler(*a['rel']), side),
            'hand_dir': _hand_q(side, _mv(a['f'], side), _mv(a['pa'], side)),
            'hand_w': a['hw'],
            'twist': a['twist'],
        }
        lg = p['leg' + side]
        yaw = lg['yaw'] if side == 'L' else -lg['yaw']
        qy = Quaternion((0, 0, 1), math.radians(yaw))
        Df = qy @ Quaternion((1, 0, 0), math.radians(lg['pitch']))
        Dt = qy @ Quaternion((1, 0, 0), math.radians(lg['pitch'] + lg['toe']))
        pose[f'leg.{side}'] = {'ankle': _mv(lg['ankle'], side), 'foot': Df, 'toe': Dt, 'pole': _mv(lg['pole'], side)}
    pr = p['prop']
    if pr['on'] > 0.5:
        X = Vector(pr['x']).normalized()
        Y = Vector(pr['y'])
        Y = (Y - X * X.dot(Y)).normalized()
        Z = X.cross(Y)
        pose['prop_frame'] = (Matrix((X, Y, Z)).transposed(), Vector(pr['pos']))
    return pose


# ── feet ──────────────────────────────────────────────────────────────────────────────────────
ANK = Vector(C.ANKLE_J)
BALL = Vector(C.BALL_J)
HEEL = Vector(C.HEEL_GROUND)


def ankle_from(pivot, point, yaw, pitch):
    """Ankle position (left-side convention) for a foot pivoting on its heel/ball/flat."""
    Df = Quaternion((0, 0, 1), math.radians(yaw)) @ Quaternion((1, 0, 0), math.radians(pitch))
    pt = Vector(point)
    if pivot == 'heel':
        return pt - Df @ (HEEL - ANK)
    if pivot == 'ball':
        return pt - Df @ (BALL - ANK)
    return Vector((pt.x, pt.y, ANK.z))


def flat(x, y, yaw=6.0, pole=(0.12, -1.0, 0.0)):
    return leg((x, y, ANK_Z), yaw=yaw, pole=pole)


def step_between(a, b, s, lift=0.06, heel=18.0):
    """Leg params moving from flat placement a to flat placement b (s in 0..1), with an arc."""
    e = smr(s)
    out = lerp_p(a, b, e)
    x, y, z = out['ankle']
    out['ankle'] = (x, y, z + lift * bump(s))
    out['pitch'] = out['pitch'] + heel * math.sin(math.pi * min(max(s, 0), 1)) * (1 - s)
    out['toe'] = -out['pitch'] * 0.5 * bump(min(s * 2, 1))
    return out


# ── clip helpers ──────────────────────────────────────────────────────────────────────────────
def breathe(p, f, period, amp=1.0):
    b = wave(f, period)
    add(p, 'chest', (-0.9 * amp * b, 0, 0))
    add(p, 'spine', (0.35 * amp * b, 0, 0))
    add(p, 'neck', (0.4 * amp * b, 0, 0))
    add(p, 'clavL', (0, -0.6 * amp * b, 0))
    add(p, 'clavR', (0, -0.6 * amp * b, 0))
    return p


def hang_sway(p, f, period, amp=1.0, phase=0.0):
    for side, ph in (('armL', 0.0), ('armR', 0.37)):
        if p[side]['sw'][0] > 0.99:
            a = p[side]
            a['chest'] = (a['chest'][0] + 0.004 * amp * wave(f, period, phase + ph),
                          a['chest'][1] + 0.006 * amp * wave(f, period, phase + ph + 0.25), a['chest'][2])
    return p


# ── seated base pose (shared by every Sit* clip) ──────────────────────────────────────────────
SEAT = {'hipz': -0.405}  # calibrated at build time so the pelvis rests exactly on the seat
LOUNGE = {'hipz': -0.45}


def thigh_hand(side_x=0.135, y=0.035, z=0.672):
    return arm(char=(side_x, y, z), sw=(0, 1, 0), pole=(0.5, 0.9, -0.2), f=(-0.12, -1, -0.25), pa=(-0.12, -0.1, -1),
               hw=1.0)


def seated():
    p = neutral()
    p['hip'] = (0.0, 0.232, SEAT['hipz'])
    p['hrot'] = (-12.0, 0.0, 0.0)
    p['spine'] = (13.0, 0.0, 0.0)
    p['chest'] = (5.0, 0.0, 0.0)
    p['neck'] = (3.0, 0.0, 0.0)
    p['head'] = (-6.0, 0.0, 0.0)
    p['legL'] = flat(0.125, -0.135, yaw=7.0, pole=(0.18, -1.0, 0.35))
    p['legR'] = flat(0.125, -0.135, yaw=7.0, pole=(0.18, -1.0, 0.35))
    p['armL'] = thigh_hand()
    p['armR'] = thigh_hand()
    return p


def typing_arms(p, z=0.778, y=-0.165, x=0.155):
    for side in ('armL', 'armR'):
        p[side] = arm(char=(x, y, z), sw=(0, 1, 0), pole=(0.6, 0.75, -0.35), f=(-0.18, -1, -0.12),
                      pa=(-0.12, -0.05, -1), hw=1.0)
    return p


def lounge_base():
    p = neutral()
    p['hip'] = (0.0, 0.42, LOUNGE['hipz'])
    p['hrot'] = (-24.0, 0.0, 0.0)
    p['spine'] = (2.0, 0.0, 0.0)
    p['chest'] = (0.0, 0.0, 0.0)
    p['neck'] = (12.0, 0.0, 0.0)
    p['head'] = (8.0, 0.0, 0.0)
    p['legL'] = flat(0.17, -0.13, yaw=16.0, pole=(0.35, -1.0, 0.4))
    p['legR'] = flat(0.13, -0.2, yaw=10.0, pole=(0.25, -1.0, 0.4))
    # right arm along the sofa back, left hand resting on the belly / thigh
    p['armR'] = arm(char=(0.44, 0.68, 0.985), sw=(0, 1, 0), pole=(0.4, 0.3, -1.0), f=(1, 0.1, -0.2), pa=(0, 0.2, -1),
                    hw=1.0)
    p['armL'] = arm(char=(0.1, 0.12, 0.70), sw=(0, 1, 0), pole=(0.6, 0.6, -0.4), f=(-0.6, -0.8, -0.1),
                    pa=(0.0, 0.2, -1), hw=1.0)
    return p


_CACHE = {}


def idle0():
    """Idle frame 0: the canonical standing pose every standing transition starts / ends on."""
    if 'idle0' not in _CACHE:
        _CACHE['idle0'] = clip_idle()[0]
    return copy.deepcopy(_CACHE['idle0'])


def sit0():
    """SitIdle frame 0: the canonical seated pose (SitDown ends / StandUp starts on it)."""
    if 'sit0' not in _CACHE:
        _CACHE['sit0'] = clip_sit_idle()[0]
    return copy.deepcopy(_CACHE['sit0'])


# ── the clips ─────────────────────────────────────────────────────────────────────────────────
def clip_idle(n=120):
    out = []
    glance = [(0, {'y': 0.0, 'p': 0.0}), (36, {'y': 0.0, 'p': 0.0}), (50, {'y': 20.0, 'p': -3.0}),
              (72, {'y': 18.0, 'p': -2.0}), (86, {'y': -4.0, 'p': 1.0}), (98, {'y': 0.0, 'p': 0.0})]
    for f in range(n + 1):
        p = neutral()
        s = wave(f, n)
        p['hip'] = (0.018 * s, 0.0, -0.004 - 0.006 * s * s)
        p['hrot'] = (0.0, -2.2 * s, 0.6 * s)
        add(p, 'spine', (0, 1.2 * wave(f, n, -0.03), 0))
        add(p, 'chest', (0, 0.6 * wave(f, n, -0.06), 0))
        g = spline(glance, f, period=n)
        gl = spline(glance, f - 3, period=n)  # neck leads, head follows a little later
        add(p, 'neck', (gl['p'] * 0.4, 0, gl['y'] * 0.4))
        add(p, 'head', (g['p'] * 0.6, -1.0 * s, g['y'] * 0.6))
        breathe(p, f, n / 2)
        hang_sway(p, f, n, 1.0, -0.08)
        out.append(p)
    return out


def walk_params(phi, y_hs, n=32):
    S = C.WALK_SPEED * n / C.FPS
    ST, HO, FL = 0.58, 0.30, 0.08
    x = 0.088

    def stance(ph):
        g = S * ph
        heel_y = y_hs + g
        if ph < FL:
            pitch = -15.0 * (1 - sm(ph / FL))
            return ankle_from('heel', (x, heel_y, 0.0), 0.0, pitch), pitch, 0.0
        if ph < HO:
            return Vector((x, heel_y - (HEEL.y - ANK.y), ANK.z)), 0.0, 0.0
        t = (ph - HO) / (ST - HO)
        pitch = 55.0 * t ** 1.7
        ball_y = heel_y - (HEEL.y - BALL.y)
        return ankle_from('ball', (x, ball_y, BALL.z), 0.0, pitch), pitch, -pitch

    def foot(ph):
        ph %= 1.0
        if ph < ST:
            a, pitch, toe = stance(ph)
            return a, pitch, toe
        s = (ph - ST) / (1 - ST)
        e = 1e-3
        a0, p0, _ = stance(ST - e)
        a0b, p0b, _ = stance(ST - 2 * e)
        a1, p1, _ = stance(0.0)
        a1b, p1b, _ = stance(e)
        d = 1 - ST
        v0 = (a0 - a0b) / e * d
        v1 = (a1b - a1) / e * d
        w0 = (p0 - p0b) / e * d
        w1 = (p1b - p1) / e * d
        h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
        a = a0 * h00 + v0 * h10 + a1 * h01 + v1 * h11
        a.z += 0.035 * bump(s)
        pitch = p0 * h00 + w0 * h10 + p1 * h01 + w1 * h11
        toe = -55.0 * (1 - sm(s / 0.45))
        return a, pitch, toe

    p = neutral()
    c = math.cos(TAU * phi)
    sn = math.sin(TAU * phi)
    p['hip'] = (0.02 * math.sin(TAU * (phi - 0.03)), 0.006 * math.cos(2 * TAU * (phi - 0.04)),
                -0.034 - 0.013 * math.cos(2 * TAU * (phi - 0.04)))
    p['hrot'] = (3.5 + 1.0 * math.cos(2 * TAU * phi), -3.0 * math.sin(TAU * (phi - 0.02)), -6.0 * c)
    p['spine'] = (2.5, 1.6 * sn, 3.0 * c)
    p['chest'] = (1.5, 1.0 * math.sin(TAU * (phi - 0.04)), 4.5 * math.cos(TAU * (phi - 0.03)))
    p['neck'] = (2.0, 0.0, 0.0)
    p['head_w'] = (-1.5 + 1.2 * math.cos(2 * TAU * (phi - 0.12)), 0.0, 0.0)
    p['head'] = (0.0, 0.0, 0.0)
    for side, off in (('L', 0.0), ('R', 0.5)):
        a, pitch, toe = foot(phi - off)
        p['leg' + side] = leg((a.x, a.y, a.z), yaw=5.0, pitch=pitch, toe=toe, pole=(0.1, -1.0, 0.0))
        th = 21.0 * math.cos(TAU * (phi - off - 0.07))  # + = arm back
        fwd = max(0.0, -th / 21.0)
        r = 0.50 - 0.07 * fwd
        ang = math.radians(th)
        hx = 0.055 - 0.02 * fwd
        hz = -r * math.cos(ang)
        hy = r * math.sin(ang) - 0.01
        p['arm' + side] = arm(chest=(hx, hy, hz), pole=(0.3, 1.0, -0.1),
                              rel=(-6.0 * fwd, 0.0, 0.0))
        p['clav' + side] = (0.0, 0.0, -2.0 * math.cos(TAU * (phi - off - 0.07)))
    return p


def clip_walk(rig, n=32):
    # choose the heel-strike position that balances the reach at heel strike and toe off
    best = None
    for y_hs in np.linspace(-0.36, -0.18, 37):
        worst = 0.0
        for ph in (0.0, 0.02, 0.56, 0.58):
            rig.solve(to_pose(walk_params(ph, y_hs, n)))
            worst = max(worst, rig.last_reach[('leg', 'L')])
        if best is None or worst < best[0]:
            best = (worst, y_hs)
    y_hs = best[1]
    return [walk_params(f / n, y_hs, n) for f in range(n + 1)], {'heelStrikeY': y_hs, 'maxReach': best[0]}


def step_turn(n, total, steps, turn_end, lead=1.0, settle=None):
    """Step-turn in place. steps: (side, f0, f1, q0, q1): foot moves from the placement at turn
    fraction q0 to q1 between frames f0..f1. The root yaws `total` degrees by frame turn_end."""
    out = []
    sgn = 1.0 if total >= 0 else -1.0
    base_l, base_r = Vector((0.106, 0.03, 0)), Vector((-0.106, 0.03, 0))
    for f in range(n + 1):
        q = smr(f / turn_end)
        yaw = total * q
        p = idle0()
        p['yaw'] = yaw
        Rinv = Matrix.Rotation(math.radians(-yaw), 3, 'Z')
        weight = 0.0
        for side, base in (('L', base_l), ('R', base_r)):
            qa = 0.0
            pos_q = None
            for (sd, f0, f1, q0, q1) in steps:
                if sd != side:
                    continue
                if f >= f1:
                    qa = q1
                elif f >= f0:
                    s = (f - f0) / (f1 - f0)
                    pos_q = (q0, q1, s)
                    weight += (-1 if side == 'L' else 1) * bump(min(1.0, (f - f0 + 2) / (f1 - f0 + 2)))
                    break
            def place(qq):
                R = Matrix.Rotation(math.radians(total * qq), 3, 'Z')
                w = R @ base
                c = Rinv @ w
                yw = total * qq - yaw
                return c, yw
            if pos_q:
                q0, q1, s = pos_q
                c0, y0 = place(q0)
                c1, y1 = place(q1)
                e = smr(s)
                c = c0.lerp(c1, e)
                yw = y0 + (y1 - y0) * e
                mx = 1.0 if side == 'L' else -1.0
                lg = leg((c.x * mx, c.y, ANK_Z + 0.055 * bump(s)), yaw=(6.0 + yw * mx), pitch=12.0 * bump(s),
                         toe=-6.0 * bump(s), pole=(0.12, -1.0, 0.0))
            else:
                c, yw = place(qa)
                mx = 1.0 if side == 'L' else -1.0
                lg = leg((c.x * mx, c.y, ANK_Z), yaw=6.0 + yw * mx, pole=(0.12, -1.0, 0.0))
            p['leg' + side] = lg
        prog = bump(f / turn_end) if f <= turn_end else 0.0
        p['hip'] = (0.022 * weight, 0.0, -0.004 - 0.022 * prog)
        p['hrot'] = (2.0 * prog, -2.0 * weight, 0.0)
        add(p, 'spine', (2.0 * prog, 1.0 * weight, 4.0 * sgn * prog * lead))
        add(p, 'chest', (0.0, 0.0, 5.0 * sgn * prog * lead))
        hl = bump(min(1.0, f / (turn_end * 0.8)))
        add(p, 'neck', (0.0, 0.0, 9.0 * sgn * hl * lead))
        add(p, 'head', (2.0 * hl, 0.0, 10.0 * sgn * hl * lead))
        for side, ph in (('armL', 0.0), ('armR', 0.5)):
            a = p[side]
            sw = 0.035 * prog
            a['chest'] = (a['chest'][0] + 0.02 * prog, a['chest'][1] + sw * (1 if (side == 'armL') == (sgn > 0) else -1),
                          a['chest'][2] + 0.01 * prog)
        if settle:
            settle(p, f)
        out.append(p)
    return out


def clip_turn(left=True, n=20):
    if left:
        steps = [('L', 1, 9, 0.0, 0.55), ('R', 6, 15, 0.0, 1.0), ('L', 12, 19, 0.55, 1.0)]
        return step_turn(n, 90.0, steps, 17)
    steps = [('R', 1, 9, 0.0, 0.55), ('L', 6, 15, 0.0, 1.0), ('R', 12, 19, 0.55, 1.0)]
    return step_turn(n, -90.0, steps, 17)


def clip_elevator(n=40):
    steps = [('L', 1, 10, 0.0, 0.38), ('R', 7, 17, 0.0, 0.72), ('L', 14, 24, 0.38, 1.0), ('R', 21, 30, 0.72, 1.0)]

    def settle(p, f):
        # after the turn: a small weight settle and an exhale while waiting for the doors
        s = bump((f - 29) / 11.0) if f > 29 else 0.0
        add(p, 'hip', (0.0, 0.0, -0.008 * s))
        add(p, 'chest', (-1.5 * s, 0.0, 0.0))
        add(p, 'head', (-2.0 * s, 0.0, 0.0))
    return step_turn(n, 180.0, steps, 28, lead=1.3, settle=settle)


# ── sitting ───────────────────────────────────────────────────────────────────────────────────
def clip_sit_down(n=36):
    N = idle0()
    Sx = sit0()
    stand_l, stand_r = N['legL'], N['legR']
    # torso/hips path keys (legs handled separately)
    k0 = copy.deepcopy(N)
    k1 = copy.deepcopy(N)  # anticipation: glance down, slight knee bend, arms forward
    k1['hip'] = (0.0, 0.01, -0.035)
    k1['spine'] = (6.0, 0, 0)
    k1['head'] = (8.0, 0, 0)
    for s in ('armL', 'armR'):
        k1[s] = arm(chest=(0.07, -0.08, -0.47), pole=(0.4, 1.0, -0.15))
    k2 = copy.deepcopy(N)  # lowering, leaning forward to stay balanced over the feet
    k2['hip'] = (0.0, 0.15, -0.26)
    k2['hrot'] = (10.0, 0, 0)
    k2['spine'] = (16.0, 0, 0)
    k2['chest'] = (6.0, 0, 0)
    k2['head'] = (-10.0, 0, 0)
    for s in ('armL', 'armR'):
        k2[s] = arm(chest=(0.09, -0.2, -0.42), char=(0.15, -0.02, 0.73), sw=(0.6, 0.4, 0), pole=(0.5, 1.0, -0.2),
                    f=(-0.12, -1, -0.25), pa=(-0.12, -0.1, -1), hw=0.3)
    k3 = copy.deepcopy(Sx)  # contact
    k3['hrot'] = (-4.0, 0, 0)
    k3['spine'] = (20.0, 0, 0)
    k3['chest'] = (7.0, 0, 0)
    k3['head'] = (-12.0, 0, 0)
    k4 = copy.deepcopy(Sx)  # settle back, slight overshoot of the recline
    k4['spine'] = (10.5, 0, 0)
    k4['chest'] = (4.0, 0, 0)
    k4['head'] = (-4.0, 0, 0)
    k5 = copy.deepcopy(Sx)
    for k in (k0, k1, k2):
        k['legL'], k['legR'] = stand_l, stand_r
    for k in (k3, k4, k5):
        k['legL'], k['legR'] = stand_l, stand_r
    keys = [(0, k0), (6, k1), (16, k2), (24, k3), (30, k4), (36, k5)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f)
        hz = p['hip'][2]
        if f >= 24:
            p['hip'] = (p['hip'][0], p['hip'][1], SEAT['hipz'])
        else:
            p['hip'] = (p['hip'][0], p['hip'][1], max(hz, SEAT['hipz']))
        # feet: planted at the standing spot until seated, then each shuffles forward
        for side, f0, f1 in (('L', 24, 31), ('R', 28, 35)):
            a = stand_l if side == 'L' else stand_r
            b = Sx['leg' + side]
            if f <= f0:
                lg = copy.deepcopy(a)
            elif f >= f1:
                lg = copy.deepcopy(b)
            else:
                lg = step_between(a, b, (f - f0) / (f1 - f0), lift=0.03, heel=8.0)
            lg['pole'] = tuple(np.array(a['pole']) + (np.array(b['pole']) - np.array(a['pole'])) * smr((f - 8) / 20))
            p['leg' + side] = lg
        out.append(p)
    out[0] = idle0()
    out[-1] = sit0()
    return out


def clip_stand_up(n=30):
    N = idle0()
    Sx = sit0()
    stand_l, stand_r = N['legL'], N['legR']
    k0 = copy.deepcopy(Sx)
    k1 = copy.deepcopy(Sx)  # feet pulled back, lean forward, hands push on the thighs
    k1['spine'] = (24.0, 0, 0)
    k1['chest'] = (8.0, 0, 0)
    k1['hrot'] = (4.0, 0, 0)
    k1['head'] = (-14.0, 0, 0)
    for s in ('armL', 'armR'):
        k1[s] = thigh_hand(0.14, -0.06, 0.66)
    k2 = copy.deepcopy(N)  # rising
    k2['hip'] = (0.0, 0.12, -0.2)
    k2['hrot'] = (12.0, 0, 0)
    k2['spine'] = (14.0, 0, 0)
    k2['chest'] = (4.0, 0, 0)
    k2['head'] = (-8.0, 0, 0)
    for s in ('armL', 'armR'):
        k2[s] = arm(chest=(0.08, -0.12, -0.45), char=(0.15, -0.06, 0.74), sw=(0.7, 0.3, 0), pole=(0.5, 1.0, -0.2),
                    f=(-0.12, -1, -0.25), pa=(-0.12, -0.1, -1), hw=0.2)
    k3 = copy.deepcopy(N)  # small overshoot upright
    k3['hip'] = (0.0, -0.004, -0.008)
    k3['chest'] = (-2.0, 0, 0)
    k3['head'] = (-3.5, 0, 0)
    k4 = copy.deepcopy(N)
    keys = [(0, k0), (9, k1), (18, k2), (25, k3), (30, k4)]
    for _, k in keys:
        k['legL'], k['legR'] = stand_l, stand_r
    out = []
    for f in range(n + 1):
        p = spline(keys, f)
        if f <= 9:
            p['hip'] = (p['hip'][0], p['hip'][1], SEAT['hipz'])
        else:
            p['hip'] = (p['hip'][0], p['hip'][1], max(p['hip'][2], SEAT['hipz']))
        for side, f0, f1 in (('R', 0, 6), ('L', 3, 9)):
            a = Sx['leg' + side]
            b = stand_l if side == 'L' else stand_r
            if f <= f0:
                lg = copy.deepcopy(a)
            elif f >= f1:
                lg = copy.deepcopy(b)
            else:
                lg = step_between(a, b, (f - f0) / (f1 - f0), lift=0.03, heel=8.0)
            lg['pole'] = tuple(np.array(a['pole']) + (np.array(b['pole']) - np.array(a['pole'])) * smr((f - 6) / 20))
            p['leg' + side] = lg
        out.append(p)
    out[0] = sit0()
    out[-1] = idle0()
    return out


def _seated_frame(f, n, extra=None):
    p = seated()
    breathe(p, f, n / 2 if n % 2 == 0 else n, 1.0)
    if extra:
        extra(p, f)
    return p


def clip_sit_idle(n=150):
    look = [(0, (0.0, 0.0)), (40, (0.0, 0.0)), (55, (-14.0, 2.0)), (80, (-12.0, 3.0)), (95, (6.0, 0.0)),
            (115, (5.0, -1.0)), (128, (0.0, 0.0))]
    hands = [(0, 0.0), (60, 0.0), (75, 1.0), (110, 1.0), (125, 0.0)]

    def extra(p, f):
        y, pt = spline(look, f, period=n)
        y2, pt2 = spline(look, f - 4, period=n)
        add(p, 'neck', (pt2 * 0.4, 0, y2 * 0.4))
        add(p, 'head', (pt * 0.6, 0.8 * wave(f, n), y * 0.6))
        add(p, 'spine', (0, 0.8 * wave(f, n, 0.1), 0.8 * wave(f, n, 0.3)))
        h = spline(hands, f, period=n)
        # the right hand slides up the thigh toward the knee and back
        a = p['armR']
        a['char'] = (a['char'][0] + 0.01 * h, a['char'][1] - 0.07 * h, a['char'][2] - 0.012 * h)
    return [_seated_frame(f, n, extra) for f in range(n + 1)]


def clip_sit_type(n=60, laptop=False):
    out = []
    for f in range(n + 1):
        p = seated()
        if laptop:
            typing_arms(p, z=0.69, y=-0.12, x=0.12)
            p['spine'] = (19.0, 0, 0)
            p['chest'] = (7.0, 0, 0)
            p['neck'] = (8.0, 0, 0)
            p['head'] = (10.0, 0, 0)
        else:
            typing_arms(p)
            p['spine'] = (20.0, 0, 0)
            p['chest'] = (7.0, 0, 0)
            p['head'] = (-14.0, 0, 0)
        breathe(p, f, n, 0.8)
        # fingers merged: typing reads as small out-of-phase hand taps and wrist flicks
        for side, ph, per in (('armL', 0.0, 10), ('armR', 0.31, 12)):
            a = p[side]
            tap = max(0.0, wave(f, per, ph)) ** 2 * 0.009 + 0.004 * max(0.0, wave(f, 20, ph + 0.2)) ** 2
            slide = 0.012 * wave(f, 30 if side == 'armL' else 60, ph)
            a['char'] = (a['char'][0] + slide, a['char'][1] + 0.004 * wave(f, 15, ph), a['char'][2] + tap)
            a['f'] = (a['f'][0], a['f'][1], a['f'][2] - 0.25 * max(0.0, wave(f, per, ph + 0.1)))
        add(p, 'head', (1.2 * wave(f, 30, 0.1), 0.0, 3.0 * wave(f, 60, 0.2)))
        add(p, 'neck', (0.6 * wave(f, 30), 0.0, 1.5 * wave(f, 60, 0.15)))
        add(p, 'chest', (0.0, 0.5 * wave(f, 60, 0.4), 0.8 * wave(f, 60, 0.1)))
        if laptop:
            p['prop'] = {'on': 1.0, 'pos': (0.0, -0.075, 0.655), 'x': (-1, 0, 0), 'y': (0, -0.99, -0.12)}
        out.append(p)
    return out


def clip_sit_think(n=120):
    S0 = seated()
    k_lean = seated()
    k_lean['hrot'] = (-16.0, 0, 0)
    k_lean['spine'] = (6.0, 0, 0)
    k_lean['chest'] = (-2.0, 0, 0)
    k_lean['neck'] = (6.0, 0, -4.0)
    k_lean['head'] = (-2.0, 4.0, -6.0)
    # right hand to the chin: wrist under the jaw, fingers curled up to the chin
    k_lean['armR'] = arm(head=(0.03, -0.075, -0.17), char=(0.12, -0.02, 0.7), sw=(0, 0.0, 1), pole=(0.15, 0.2, -1.0),
                         f=(-0.12, -0.3, 1), pa=(-0.3, -1, -0.2), hw=1.0)
    # left forearm across the belly supporting the right elbow
    k_lean['armL'] = arm(char=(-0.0, 0.07, 0.81), sw=(0, 1, 0), pole=(0.7, 0.5, -0.8), f=(-1, -0.15, 0.05),
                         pa=(0, 0.4, -1), hw=1.0)
    k_lean2 = copy.deepcopy(k_lean)
    k_lean2['head'] = (2.0, -2.0, 6.0)
    k_lean2['neck'] = (8.0, 0, 3.0)
    S0['armR'] = arm(head=(0.1, -0.05, -0.4), char=S0['armR']['char'], sw=(0, 1, 0), pole=S0['armR']['pole'],
                     f=S0['armR']['f'], pa=S0['armR']['pa'], hw=1.0)
    S0['armL'] = arm(char=S0['armL']['char'], sw=(0, 1, 0), pole=S0['armL']['pole'], f=S0['armL']['f'],
                     pa=S0['armL']['pa'], hw=1.0)
    keys = [(0, S0), (12, S0), (36, k_lean), (62, k_lean2), (84, k_lean), (108, S0)]
    out = []
    for f in range(n + 1):
        p = spline(keys, min(f, 108)) if f <= 108 else copy.deepcopy(S0)
        p['hip'], p['legL'], p['legR'] = S0['hip'], S0['legL'], S0['legR']
        breathe(p, f, n / 2, 0.8)
        out.append(p)
    out[-1] = copy.deepcopy(out[0])
    return out


def clip_sit_talk(n=120):
    base = seated()
    base['spine'] = (16.0, 0, 0)
    for s in ('armL', 'armR'):
        base[s] = arm(char=(0.15, -0.12, 0.765), sw=(0, 1, 0), pole=(0.6, 0.7, -0.4), f=(-0.25, -1, -0.15),
                      pa=(-0.3, 0, -1), hw=1.0)
    g1 = copy.deepcopy(base)  # right hand opens toward the table centre
    g1['armR'] = arm(char=(0.1, -0.24, 0.87), sw=(0, 1, 0), pole=(0.6, 0.6, -0.5), f=(-0.35, -1, 0.15),
                     pa=(-0.2, -0.2, 1), hw=1.0)
    g1['head'] = (-10.0, 0.0, -6.0)
    g1['chest'] = (7.0, 0, -4.0)
    g2 = copy.deepcopy(base)  # both hands, palms up, a "what if" gesture
    for s in ('armL', 'armR'):
        g2[s] = arm(char=(0.18, -0.21, 0.85), sw=(0, 1, 0), pole=(0.6, 0.6, -0.5), f=(0.1, -1, 0.1),
                    pa=(-0.3, 0.0, 1), hw=1.0)
    g2['head'] = (-12.0, 2.0, 4.0)
    g3 = copy.deepcopy(base)  # left hand points / counts on the table, look to the other side
    g3['armL'] = arm(char=(0.07, -0.26, 0.78), sw=(0, 1, 0), pole=(0.6, 0.6, -0.4), f=(-0.3, -1, -0.3),
                     pa=(-0.2, 0, -1), hw=1.0)
    g3['head'] = (-8.0, -1.0, 12.0)
    g3['neck'] = (3.0, 0, 6.0)
    keys = [(0, base), (14, g1), (30, g1), (44, base), (58, g2), (76, g2), (88, g3), (104, g3)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        p['hip'], p['legL'], p['legR'], p['hrot'] = base['hip'], base['legL'], base['legR'], base['hrot']
        breathe(p, f, n / 2, 1.0)
        add(p, 'head', (2.0 * wave(f, 20), 0.0, 0.0))  # talking nods
        out.append(p)
    return out


def clip_lounge(n=150):
    out = []
    for f in range(n + 1):
        p = lounge_base()
        breathe(p, f, n / 3, 1.2)
        look = wave(f, n, 0.1)
        add(p, 'neck', (0, 0, 6.0 * look))
        add(p, 'head', (1.5 * wave(f, n / 2), 1.5 * look, 9.0 * wave(f, n, 0.05)))
        # toe tap on the extended leg (pivoting on the heel, which stays on the floor)
        lg = p['legR']
        tap = (max(0.0, wave(f, 25)) ** 3) * 9.0 * bump(2.0 * f / n) if f < n / 2 else 0.0
        a = Vector(lg['ankle'])
        Df0 = Quaternion((0, 0, 1), math.radians(lg['yaw']))
        heel = a + Df0 @ (HEEL - ANK)
        lg['ankle'] = tuple(ankle_from('heel', heel, lg['yaw'], -tap))
        lg['pitch'] = -tap
        a2 = p['armL']
        a2['char'] = (a2['char'][0], a2['char'][1], a2['char'][2] + 0.006 * wave(f, n / 3))
        out.append(p)
    return out


# ── standing gestures ─────────────────────────────────────────────────────────────────────────
def stand_overlay(p, f, n, shift=0.015):
    s = wave(f, n)
    p['hip'] = (p['hip'][0] + shift * s, p['hip'][1], p['hip'][2] - 0.003 * s * s)
    add(p, 'hrot', (0.0, -2.0 * s, 0.5 * s))
    add(p, 'spine', (0, 1.0 * wave(f, n, -0.03), 0))
    add(p, 'head', (0, -0.8 * s, 0))
    breathe(p, f, n / 2 if n % 2 == 0 else n)


def clip_stand_talk(n=120):
    base = neutral()
    for s in ('armL', 'armR'):
        base[s] = arm(chest=(0.0, -0.17, -0.38), pole=(0.5, 1.0, -0.3), f=(-0.6, -0.8, -0.1), pa=(-0.4, 0.3, -1),
                      hw=0.6)
    g1 = copy.deepcopy(base)
    g1['armR'] = arm(chest=(0.06, -0.33, -0.25), pole=(0.6, 0.7, -0.5), f=(-0.3, -1, 0.2), pa=(-0.2, -0.3, 1), hw=1.0)
    g1['head'] = (-5.0, -3.0, -8.0)
    g1['chest'] = (0.0, 0, -5.0)
    g2 = copy.deepcopy(base)
    for s in ('armL', 'armR'):
        g2[s] = arm(chest=(0.13, -0.3, -0.27), pole=(0.6, 0.7, -0.5), f=(0.2, -1, 0.1), pa=(-0.4, 0.0, 1), hw=1.0)
    g2['head'] = (-6.0, 3.0, 5.0)
    g3 = copy.deepcopy(base)
    g3['armL'] = arm(chest=(-0.02, -0.3, -0.18), pole=(0.6, 0.7, -0.5), f=(-0.5, -1, -0.1), pa=(-0.3, -0.1, -1), hw=1.0)
    g3['head'] = (0.0, 0, 10.0)
    g3['neck'] = (2.0, 0, 5.0)
    keys = [(0, base), (14, g1), (32, g1), (46, base), (60, g2), (78, g2), (90, g3), (106, g3)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        stand_overlay(p, f, n)
        add(p, 'head', (2.2 * wave(f, 24), 0.0, 0.0))
        out.append(p)
    return out


def phone_arm(t=0.0):
    return arm(head=(0.152, -0.047, -0.012), sw=(0, 0, 1), pole=(0.3, 0.2, -1.0), f=(0.0, 0.35, 0.94),
               pa=(-1, 0.0, 0.0), hw=1.0, twist=0.6)


def clip_phone(n=150):
    base = neutral()
    base['armR'] = phone_arm()
    base['head'] = (2.0, 7.0, 0.0)
    base['armL'] = arm(chest=(0.1, 0.02, -0.42), pole=(0.8, 0.7, -0.2), rel=(0, 0, 0))
    g = copy.deepcopy(base)  # free hand gestures while talking
    g['armL'] = arm(chest=(0.08, -0.28, -0.3), pole=(0.6, 0.7, -0.5), f=(-0.3, -1, 0.2), pa=(-0.2, -0.3, 1), hw=1.0)
    g['head'] = (-4.0, 6.0, 8.0)
    base['armL']['f'], base['armL']['pa'] = g['armL']['f'], g['armL']['pa']
    keys = [(0, base), (45, base), (62, g), (88, g), (105, base)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        stand_overlay(p, f, n, 0.02)
        add(p, 'head', (2.5 * wave(f, 30, 0.1), 1.5 * wave(f, 75), 0.0))
        out.append(p)
    return out


def cup_hold():
    return arm(chest=(-0.03, -0.24, -0.25), pole=(0.6, 0.8, -0.4), f=(-0.25, -1, 0.0), pa=(-1, 0.25, 0.0), hw=1.0)


def clip_coffee(n=180):
    base = neutral()
    base['armR'] = cup_hold()
    base['armL'] = arm(chest=(0.06, 0.0, -0.49), pole=(0.5, 1, -0.1))
    sip = copy.deepcopy(base)
    # cup rim at the mouth, tilted toward the face
    sip['armR'] = arm(head=(0.025, -0.14, -0.105), sw=(0, 0, 1), pole=(0.4, 0.3, -1.0), f=(-0.6, -0.75, 0.25),
                      pa=(-0.9, 0.35, -0.3), hw=1.0)
    sip['head'] = (-9.0, 0, 0)
    sip['neck'] = (-2.0, 0, 0)
    sip['chest'] = (-2.5, 0, 0)
    keys = [(0, base), (60, base), (78, sip), (100, sip), (118, base)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        stand_overlay(p, f, n, 0.016)
        out.append(p)
    return out


def clip_pingpong(n=48):
    def parm(c, f, pa, pole=(0.7, 0.5, -0.5)):
        return arm(char=c, sw=(0, 1, 0), pole=pole, f=f, pa=pa, hw=1.0, twist=0.6)
    ready = neutral()
    ready['hip'] = (0.0, 0.025, -0.055)
    ready['hrot'] = (8.0, 0, 0)
    ready['spine'] = (9.0, 0, 0)
    ready['chest'] = (4.0, 0, 0)
    ready['neck'] = (-4.0, 0, 0)
    ready['head'] = (-9.0, 0, 0)
    ready['legL'] = flat(0.19, -0.05, yaw=10.0, pole=(0.3, -1, 0))
    ready['legR'] = flat(0.19, 0.07, yaw=14.0, pole=(0.3, -1, 0))
    ready['armR'] = parm((0.2, -0.33, 1.0), (0.2, -0.7, 0.7), (-1, -0.3, 0))
    ready['armL'] = parm((0.16, -0.27, 1.0), (-0.4, -1, 0.0), (-0.3, 0, -1), (0.6, 0.6, -0.4))
    back = copy.deepcopy(ready)  # backswing: torso turns right, paddle back
    back['hrot'] = (8.0, 0, -12.0)
    back['spine'] = (9.0, 0, -10.0)
    back['chest'] = (4.0, 0, -8.0)
    back['head'] = (-9.0, 0, 16.0)
    back['hip'] = (-0.02, 0.025, -0.065)
    back['armR'] = parm((0.42, 0.02, 0.98), (0.6, 0.1, 0.8), (-0.3, -1, 0.1), (0.6, 0.8, -0.5))
    hit = copy.deepcopy(ready)  # contact in front of the body
    hit['hrot'] = (8.0, 0, 4.0)
    hit['spine'] = (10.0, 0, 6.0)
    hit['chest'] = (4.0, 0, 6.0)
    hit['head'] = (-9.0, 0, -8.0)
    hit['hip'] = (0.015, 0.015, -0.06)
    hit['armR'] = parm((0.24, -0.43, 1.03), (0.45, -0.55, 0.7), (-0.2, -1, 0.05), (0.7, 0.5, -0.6))
    follow = copy.deepcopy(ready)  # follow-through across and up
    follow['hrot'] = (8.0, 0, 10.0)
    follow['spine'] = (9.0, 0, 9.0)
    follow['chest'] = (3.0, 0, 8.0)
    follow['head'] = (-9.0, 0, -12.0)
    follow['hip'] = (0.02, 0.015, -0.06)
    follow['armR'] = parm((-0.02, -0.36, 1.27), (-0.3, -0.4, 0.85), (-0.5, -0.9, 0.1), (0.5, 0.6, -0.8))
    split = copy.deepcopy(ready)
    split['hip'] = (0.0, 0.025, -0.075)
    keys = [(0, ready), (7, back), (12, hit), (18, follow), (30, ready), (40, split)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        breathe(p, f, n, 1.2)
        out.append(p)
    return out


def clip_wave(n=40):
    N = idle0()
    up = copy.deepcopy(N)
    up['armR'] = arm(chest=(0.2, -0.1, 0.15), pole=(0.6, 0.6, -1.0), f=(-0.05, -0.15, 1), pa=(0.0, -1, 0.05),
                     hw=1.0, twist=0.5)
    up['head'] = (-4.0, 5.0, -4.0)
    up['chest'] = (-2.0, -2.0, -3.0)
    up['clavR'] = (0.0, -6.0, 0.0)
    keys = [(0, N), (10, up), (31, up), (40, N)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f)
        w = bump((f - 8) / 25.0) if 8 < f < 33 else 0.0
        osc = math.sin(TAU * (f - 8) / 8.0) * w
        a = p['armR']
        a['chest'] = (a['chest'][0] + 0.03 * osc, a['chest'][1], a['chest'][2] + 0.008 * abs(osc))
        a['f'] = (a['f'][0] - 0.5 * osc, a['f'][1], a['f'][2])
        oscl = math.sin(TAU * (f - 9.5) / 8.0) * w  # the head bobs along, slightly late
        add(p, 'head', (0.0, 2.0 * oscl, 0.0))
        out.append(p)
    out[0], out[-1] = idle0(), idle0()
    return out


def clip_head_scratch(n=90):
    base = neutral()
    base['armR'] = arm(head=(0.15, 0.035, 0.075), sw=(0, 0, 1), pole=(1.0, 0.2, 0.1), f=(-0.5, 0.0, 0.85),
                       pa=(-0.85, 0.0, -0.5), hw=1.0)
    base['armL'] = arm(chest=(0.13, 0.03, -0.42), pole=(1.0, 0.4, 0.0), f=(-0.35, -0.3, -1), pa=(-1, 0, 0.3), hw=1.0)
    base['head'] = (6.0, 8.0, -6.0)
    base['neck'] = (4.0, 0, 0)
    base['chest'] = (1.0, -2.0, 0)
    alt = copy.deepcopy(base)
    alt['head'] = (2.0, -4.0, 8.0)
    alt['armR']['head'] = (0.14, 0.06, 0.085)
    keys = [(0, base), (40, alt), (60, alt)]
    out = []
    for f in range(n + 1):
        p = spline(keys, f, period=n)
        stand_overlay(p, f, n, 0.015)
        sc = math.sin(TAU * f / 9.0) * (0.6 + 0.4 * wave(f, 45))
        a = p['armR']
        a['head'] = (a['head'][0], a['head'][1] + 0.012 * sc, a['head'][2] + 0.006 * sc)
        add(p, 'head', (0.0, 0.0, 2.0 * wave(f, 30)))
        out.append(p)
    return out


# ── registry ──────────────────────────────────────────────────────────────────────────────────
def all_clips(rig):
    _CACHE.clear()
    meta = {}
    walk, info = clip_walk(rig)
    meta['Walk'] = info
    clips = {
        'Idle': clip_idle(), 'Walk': walk, 'TurnL90': clip_turn(True), 'TurnR90': clip_turn(False),
        'SitDown': clip_sit_down(), 'StandUp': clip_stand_up(), 'SitIdle': clip_sit_idle(),
        'SitType': clip_sit_type(), 'SitThink': clip_sit_think(), 'SitTalk': clip_sit_talk(),
        'SitLaptop': clip_sit_type(laptop=True), 'StandTalk': clip_stand_talk(), 'PhoneCall': clip_phone(),
        'DrinkCoffee': clip_coffee(), 'LoungeSit': clip_lounge(), 'PingPong': clip_pingpong(),
        'Wave': clip_wave(), 'HeadScratch': clip_head_scratch(), 'ElevatorIn': clip_elevator(),
    }
    return clips, meta
