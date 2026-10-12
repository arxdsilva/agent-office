"""Character geometry: SDF part definitions -> reduced, smooth meshes; materials; accessories; props."""
import math
import bpy
import numpy as np
from mathutils import Vector, Matrix

import char_common as C
import char_sdf as S
from char_rig import hand_frame

V3 = np.array


# ── materials ─────────────────────────────────────────────────────────────────────────────────
def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h):
    h = h.lstrip('#')
    return tuple(_srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)


def make_materials():
    mats = {}
    for name, (hexc, rough, metal) in C.MATERIALS.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = hex_rgba(hexc)
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
        if name == 'screen':
            bsdf.inputs['Emission Color'].default_value = hex_rgba('#2B3A55')
            bsdf.inputs['Emission Strength'].default_value = 0.6
        m.diffuse_color = hex_rgba(hexc)
        mats[name] = m
    return mats


# ── mesh helpers ──────────────────────────────────────────────────────────────────────────────
class Part:
    def __init__(self, name, sdf, lo, hi, tris, material, mirror=False, part=None, h=None, smooth=True):
        self.name, self.sdf, self.lo, self.hi = name, sdf, lo, hi
        self.tris, self.material, self.mirror = tris, material, mirror
        self.part = part or name
        self.h = h
        self.smooth = smooth


def _obj_from(V, faces, name):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in V], [], [tuple(map(int, f)) for f in faces])
    me.validate()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _read(ob):
    me = ob.data
    V = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', V)
    faces = [tuple(p.vertices) for p in me.polygons]
    return V.reshape(-1, 3), faces


def _tri_count(faces):
    return sum(len(f) - 2 for f in faces)


def _voxel_clean(ob, h):
    """OpenVDB voxel remesh: guarantees the manifold, consistently wound input quadriflow needs."""
    ob.data.remesh_voxel_size = h
    ob.data.remesh_voxel_adaptivity = 0.0
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob],
                                   selected_editable_objects=[ob]):
        bpy.ops.object.voxel_remesh()


def reduce_mesh(V, Q, target_tris, sdf, name, use_quadriflow=True, h=0.004):
    """Quadriflow (fallback: collapse decimation) to ~target_tris, then re-project on the SDF."""
    ok = False
    ob = None
    if use_quadriflow and target_tris >= 160:
        for k in range(4):
            if ob is not None:
                bpy.data.objects.remove(ob, do_unlink=True)
            ob = _obj_from(V, Q, name + '_tmp')
            _voxel_clean(ob, h * (1.0 + 0.11 * k))
            try:
                with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob],
                                               selected_editable_objects=[ob]):
                    r = bpy.ops.object.quadriflow_remesh(target_faces=max(int(target_tris / 2), 40), seed=7,
                                                         use_mesh_symmetry=False, use_preserve_sharp=False,
                                                         use_preserve_boundary=False, preserve_attributes=False)
            except RuntimeError as e:
                r = {'CANCELLED'}
            if 'FINISHED' in r and len(ob.data.polygons) > 20:
                got = _tri_count([p.vertices for p in ob.data.polygons])
                ok = 0.6 * target_tris < got < 1.4 * target_tris
            if ok:
                break
    if ob is None:
        ob = _obj_from(V, Q, name + '_tmp')
    if not ok:
        bpy.data.objects.remove(ob, do_unlink=True)
        ob = _obj_from(V, Q, name + '_tmp')
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.ratio = min(1.0, target_tris / max(_tri_count(Q), 1))
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        ob.modifiers.clear()
        old = ob.data
        ob.data = me
        bpy.data.meshes.remove(old)
    V2, F2 = _read(ob)
    bpy.data.objects.remove(ob, do_unlink=True)
    V2 = S.project(sdf, V2, 4)
    V2 = relax(V2, F2, sdf)
    return V2, F2


def relax(V, faces, sdf, iters=4, w=0.5):
    """Tangential Laplacian relaxation, re-projected on the surface: evens out vertex spacing."""
    E = set()
    for f in faces:
        for i in range(len(f)):
            a, b = f[i], f[(i + 1) % len(f)]
            E.add((min(a, b), max(a, b)))
    E = np.array(sorted(E))
    n = len(V)
    for _ in range(iters):
        acc = np.zeros_like(V)
        cnt = np.zeros(n, dtype=np.float32)
        np.add.at(acc, E[:, 0], V[E[:, 1]])
        np.add.at(acc, E[:, 1], V[E[:, 0]])
        np.add.at(cnt, E[:, 0], 1)
        np.add.at(cnt, E[:, 1], 1)
        V = V + w * (acc / np.maximum(cnt, 1)[:, None] - V)
        V = S.project(sdf, V, 3)
    return V


def plate(center, ex, ey, w, h, circle=0):
    """Flat decal (rectangle, or a circle with `circle` segments) facing ex x ey."""
    c, ex, ey = (np.asarray(v, dtype=np.float32) for v in (center, ex, ey))
    if circle:
        ang = np.linspace(0, 2 * np.pi, circle, endpoint=False)
        V = np.array([c + ex * (w * np.cos(a)) + ey * (w * np.sin(a)) for a in ang] + [c])
        F = [(i, (i + 1) % circle, circle) for i in range(circle)]
        return V.astype(np.float32), F
    V = np.array([c - ex * w / 2 - ey * h / 2, c + ex * w / 2 - ey * h / 2,
                  c + ex * w / 2 + ey * h / 2, c - ex * w / 2 + ey * h / 2], dtype=np.float32)
    return V, [(0, 1, 2, 3)]


def mirror_mesh(V, faces):
    V = V.copy()
    V[:, 0] *= -1
    return V, [tuple(reversed(f)) for f in faces]


def _open_edges(Qn):
    E = np.concatenate([np.stack([Qn[:, i], Qn[:, (i + 1) % 4]], 1) for i in range(4)])
    E.sort(axis=1)
    _, counts = np.unique(E, axis=0, return_counts=True)
    return int((counts == 1).sum())


def build_part(p, quality):
    h = p.h or (0.0042 if quality == 'final' else 0.0062)
    lo, hi = np.array(p.lo, dtype=np.float32), np.array(p.hi, dtype=np.float32)
    for attempt in range(4):
        Vn, Qn = S.mesh_sdf(p.sdf, lo, hi, h)
        bad = _open_edges(Qn)
        if not bad:
            break
        print(f'[character] part {p.name}: {bad} open edges, growing bounds')
        lo, hi = lo - 0.03, hi + 0.03
    Vn = S.project(p.sdf, Vn, 2)
    V, Fc = reduce_mesh(Vn, Qn, p.tris, p.sdf, p.name, h=h)
    return V, Fc


def assemble(name, pieces, mats):
    """pieces: list of (V, faces, material name, part name) -> one object + per-vertex part list."""
    allV, allF, mi, parts = [], [], [], []
    names = []
    for _, _, m, _ in pieces:
        if m not in names:
            names.append(m)
    off = 0
    for V, faces, m, part in pieces:
        allV.append(V)
        allF += [tuple(i + off for i in f) for f in faces]
        mi += [names.index(m)] * len(faces)
        parts += [part] * len(V)
        off += len(V)
    V = np.concatenate(allV)
    ob = _obj_from(V, allF, name)
    for m in names:
        ob.data.materials.append(mats[m])
    ob.data.polygons.foreach_set('material_index', mi)
    ob.data.shade_smooth()
    return ob, parts


HEAD_S = 1.12
HEAD_C = (0.0, 0.012, 1.515)


def head_space(f):
    """Stylisation: everything on the head is modelled at real scale then enlarged by HEAD_S."""
    return S.scaled(f, HEAD_C, HEAD_S)


# ── body SDFs ─────────────────────────────────────────────────────────────────────────────────
SH = V3(C.SHOULDER_J, dtype=np.float32)
EL = V3(C.ELBOW_J, dtype=np.float32)
WR = V3(C.WRIST_J, dtype=np.float32)
D1 = V3(C.UPPER_DIR, dtype=np.float32)
D2 = V3(C.FORE_DIR, dtype=np.float32)
HIP = V3(C.HIP_J, dtype=np.float32)
KNEE = V3(C.KNEE_J, dtype=np.float32)
ANK = V3(C.ANKLE_J, dtype=np.float32)


def sdf_head():
    cran = S.ellipsoid((0, 0.006, 1.632), (0.104, 0.112, 0.118))
    jaw = S.ellipsoid((0, -0.014, 1.566), (0.088, 0.09, 0.076))
    chin = S.ellipsoid((0, -0.058, 1.512), (0.04, 0.034, 0.028))
    cheeks = S.sym_x(S.ellipsoid((0.048, -0.05, 1.566), (0.042, 0.042, 0.036)))
    nose = S.ellipsoid((0, -0.111, 1.586), (0.0165, 0.017, 0.024), S.rot('x', -12))
    ears = S.sym_x(S.ellipsoid((0.103, 0.014, 1.598), (0.014, 0.025, 0.034), S.rot('z', -12)))
    neck = S.round_cone((0, 0.024, 1.385), (0, 0.016, 1.54), 0.051, 0.046)
    face = S.union(S.union(cran, jaw, k=0.07), chin, k=0.045)
    face = S.union(face, cheeks, k=0.045)
    face = S.union(face, nose, k=0.014)
    face = S.union(face, ears, k=0.012)
    return S.union(face, neck, k=0.035)


def sdf_shirt():
    chest = S.ellipsoid((0, 0.014, 1.262), (0.17, 0.124, 0.195))
    belly = S.ellipsoid((0, 0.0, 1.10), (0.162, 0.112, 0.17))
    yoke = S.sym_x(S.capsule((0.04, 0.014, 1.398), (0.158, 0.012, 1.383), 0.054))
    sleeve_cut = S.plane(D1, SH + D1 * 0.13)
    sleeve = S.intersect(S.round_cone(SH - D1 * 0.04, SH + D1 * 0.2, 0.07, 0.062), sleeve_cut, k=0.012)
    sleeves = S.sym_x(sleeve)
    collar = S.torus((0, 0.014, 1.438), 0.056, 0.0105, S.rot('x', 10))
    body = S.union(chest, belly, k=0.06)
    body = S.union(body, yoke, k=0.06)
    body = S.union(body, sleeves, k=0.035)
    body = S.intersect(body, S.plane((0, 0, -1), (0, 0, 0.962)), k=0.012)
    return S.union(body, collar, k=0.008)


def sdf_sleeve_inner():
    """Volume inside the sleeves (for hiding / weight transfer of the arm skin)."""
    return S.sym_x(S.round_cone(SH - D1 * 0.04, SH + D1 * 0.2, 0.07, 0.062))


def sdf_arm_l():
    arm = S.union(S.round_cone(SH + D1 * 0.02, EL, 0.05, 0.043),
                  S.round_cone(EL, WR, 0.043, 0.033), k=0.02)
    # cut away most of the part hidden in the sleeve (keep 5 cm of overlap)
    arm = S.intersect(arm, S.plane(-D1, SH + D1 * 0.075), k=0.005)
    return S.union(arm, sdf_hand_l(), k=0.012)


def _hand_local_sdf():
    """Mitten hand in local coords: x -> thumb, y -> fingers, z -> back of the hand; origin = wrist."""
    palm = S.round_box((0, 0.052, 0.001), (0.039, 0.047, 0.0165), 0.0155)
    heel = S.ellipsoid((0.004, 0.022, -0.002), (0.036, 0.03, 0.019))
    wrist = S.round_cone((0, -0.03, 0), (0, 0.012, 0), 0.03, 0.031)
    fingers = []
    for x, ln, r in ((0.026, 0.074, 0.0118), (0.009, 0.081, 0.0122), (-0.009, 0.077, 0.0118), (-0.026, 0.062, 0.011)):
        base = np.array((x, 0.092, -0.001), dtype=np.float32)
        mid = base + np.array((x * 0.06, ln * 0.55, -0.012), dtype=np.float32)
        tip = mid + np.array((x * 0.04, ln * 0.40, -0.022), dtype=np.float32)
        fingers.append(S.union(S.round_cone(base, mid, r, r * 0.96), S.round_cone(mid, tip, r * 0.96, r * 0.88), k=0.004))
    fing = S.union(*fingers, k=0.0075)
    thumb = S.union(S.round_cone((0.03, 0.018, -0.006), (0.054, 0.05, -0.02), 0.0165, 0.0135),
                    S.round_cone((0.054, 0.05, -0.02), (0.062, 0.078, -0.03), 0.0135, 0.0115), k=0.004)
    h = S.union(palm, heel, k=0.02)
    h = S.union(h, wrist, k=0.02)
    h = S.union(h, fing, k=0.012)
    return S.union(h, thumb, k=0.012)


def hand_matrix(side):
    th, u, p = hand_frame(side)
    # local axes (x thumb, y fingers, z dorsal) in world
    return np.array([list(th), list(u), list(-p)], dtype=np.float32).T


def sdf_hand_l():
    loc = _hand_local_sdf()
    R = hand_matrix('L')
    w = WR.copy()
    s = 1.12
    return lambda P: loc(((P - w) @ R) / s) * s


def sdf_pants():
    pelvis = S.ellipsoid((0, 0.012, 0.952), (0.164, 0.114, 0.12))
    waist = S.ellipsoid((0, 0.004, 1.005), (0.156, 0.108, 0.085))
    glutes = S.sym_x(S.sphere((0.058, 0.05, 0.878), 0.086))
    hem_y = ANK + np.array((0, 0.0, 0.03), dtype=np.float32)
    leg = S.union(S.round_cone(HIP + np.array((0.008, 0.004, 0.0), dtype=np.float32), KNEE, 0.1, 0.068),
                  S.round_cone(KNEE, hem_y, 0.068, 0.063), k=0.03)
    legs = S.sym_x(leg)
    p = S.union(pelvis, waist, k=0.04)
    p = S.union(p, glutes, k=0.04)
    p = S.union(p, legs, k=0.045)
    p = S.intersect(p, S.plane((0, 0, 1), (0, 0, 1.055)), k=0.01)
    return S.intersect(p, S.plane((0, 0, -1), (0, 0, 0.112)), k=0.006)


def sdf_shoe_l():
    x = 0.099
    sole = S.round_box((x, -0.066, 0.019), (0.054, 0.158, 0.019), 0.016)
    toe = S.ellipsoid((x + 0.004, -0.13, 0.048), (0.054, 0.094, 0.05))
    heel = S.ellipsoid((x - 0.002, 0.03, 0.07), (0.052, 0.07, 0.066))
    tongue = S.ellipsoid((x, -0.035, 0.08), (0.046, 0.065, 0.045), S.rot('x', 25))
    up = S.union(S.union(toe, heel, k=0.06), tongue, k=0.035)
    up = S.intersect(up, S.plane((0, -0.3, 1), (x, 0.03, 0.128)), k=0.012)
    shoe = S.union(sole, up, k=0.01)
    return S.intersect(shoe, S.plane((0, 0, -1), (0, 0, 0.0)), k=0.004)


def _face_point(head, x, z, out=0.0):
    y = S.surface_y(head, x, z)
    p = np.array((x, y, z), dtype=np.float32)
    g = S._grad(head, p[None])[0]
    g /= np.linalg.norm(g)
    return p + g * out, g


def sdf_face_details(head):
    """Eyes and mouth (material eyes) and brows (material hair), sitting on the face surface."""
    eyes = []
    for sx in (1, -1):
        p, n = _face_point(head, 0.039 * sx, 1.611, 0.0)
        R = S.frame(-n, (0, 0, 1))  # local y = inward normal
        eyes.append(S.ellipsoid(p - n * 0.0035, (0.0135, 0.0078, 0.0198), R))
    brows = []
    for sx in (1, -1):
        pts = [_face_point(head, sx * x, z, 0.0012)[0] for x, z in ((0.02, 1.6525), (0.04, 1.6575), (0.06, 1.6505))]
        brows.append(S.polyline(pts, [0.0048, 0.0058, 0.0042]))
    mouth_pts = [_face_point(head, x, z, 0.0016)[0] for x, z in
                 ((-0.019, 1.5385), (-0.010, 1.5335), (0.0, 1.5322), (0.010, 1.5335), (0.019, 1.5385))]
    mouth = S.polyline(mouth_pts, [0.0024, 0.0034, 0.0036, 0.0034, 0.0024])
    return S.union(*eyes), S.union(*brows), mouth


# ── hair ──────────────────────────────────────────────────────────────────────────────────────
def _scalp(t):
    return S.ellipsoid((0, 0.006, 1.634), (0.104 + t, 0.112 + t, 0.118 + t))


def _hairline_cut(front_z=1.672, back_z=1.53, side_z=1.62):
    """Keep the region above a hairline that is high at the forehead, low at the nape."""
    def f(P):
        y = P[:, 1]
        # blend front->back with the y coordinate, dip at the sides above the ears
        tt = np.clip((y + 0.11) / 0.22, 0, 1)
        zc = front_z + (back_z - front_z) * (tt * tt * (3 - 2 * tt))
        side = np.clip(np.abs(P[:, 0]) / 0.105, 0, 1) ** 2
        zc = zc * (1 - side * 0.6) + side_z * side * 0.6
        return zc - P[:, 2]
    return f


def _ear_clear():
    return S.sym_x(S.ellipsoid((0.106, 0.012, 1.596), (0.03, 0.04, 0.05)))


def sdf_hair(variant):
    head = _scalp(0.0)
    if variant == 'hairA':  # short, chunky swept locks with a side part
        base = _scalp(0.013)
        locks = []
        for c, d, r in (((-0.02, -0.065, 1.722), (-0.5, -1, -0.2), (0.046, 0.078, 0.03)),
                        ((-0.062, -0.04, 1.706), (-0.8, -0.6, -0.35), (0.04, 0.07, 0.028)),
                        ((0.038, -0.07, 1.712), (-0.25, -1, -0.3), (0.036, 0.062, 0.026)),
                        ((0.075, -0.03, 1.70), (0.3, -0.7, -0.6), (0.034, 0.06, 0.026)),
                        ((-0.088, 0.005, 1.685), (-0.25, 0.25, -1), (0.04, 0.07, 0.028)),
                        ((0.09, 0.01, 1.685), (0.25, 0.3, -1), (0.04, 0.07, 0.028)),
                        ((0.0, 0.085, 1.70), (0.0, 0.45, -1), (0.075, 0.08, 0.03)),
                        ((-0.015, 0.0, 1.748), (-0.4, -1, 0.05), (0.06, 0.09, 0.03)),
                        ((0.045, 0.03, 1.738), (0.5, -0.4, -0.2), (0.045, 0.07, 0.028))):
            locks.append(S.ellipsoid(c, r, S.frame(d, (0, 0, 1)) if abs(d[2]) < 0.9 else S.frame(d, (0, -1, 0))))
        h = S.union(base, S.union(*locks, k=0.018), k=0.02)
        h = S.union(h, S.ellipsoid((0, 0.068, 1.565), (0.088, 0.058, 0.07)), k=0.03)
        part = S.capsule((0.036, -0.1, 1.715), (0.03, 0.03, 1.765), 0.0045)
        h = S.subtract(h, part, k=0.006)
        def tex(P, h=h):
            return h(P) + 0.001 * S.noise3(P, 50.0, seed=3)
        h = S.intersect(tex, _hairline_cut(1.668, 1.505, 1.615), k=0.014)
        h = S.subtract(h, _ear_clear(), k=0.01)
    elif variant == 'hairB':  # chin-length bob with bangs
        base = _scalp(0.022)
        bob = S.ellipsoid((0, 0.03, 1.585), (0.128, 0.115, 0.115))
        h = S.union(base, bob, k=0.04)
        face_cut = S.ellipsoid((0, -0.13, 1.56), (0.088, 0.1, 0.098))
        h = S.subtract(h, face_cut, k=0.02)
        h = S.intersect(h, S.plane((0, 0.2, -1), (0, 0, 1.495)), k=0.012)
        def tex(P, h=h):
            return h(P) + 0.002 * S.noise3(P * np.array((1, 1, 0.3), dtype=np.float32), 90.0, seed=5)
        h = tex
    elif variant == 'hairC':  # curly volume: many small, distinct curls over a soft base
        rng = np.random.default_rng(11)
        balls = []
        for _ in range(150):
            d = rng.normal(size=3)
            d[2] = abs(d[2]) * 1.3 + 0.1
            d /= np.linalg.norm(d)
            c = np.array((0, 0.014, 1.645), dtype=np.float32) + d * np.array((0.13, 0.138, 0.142))
            if c[2] < 1.555 or (c[1] < -0.07 and c[2] < 1.675) or (abs(c[0]) > 0.09 and c[2] < 1.6 and c[1] < 0.03):
                continue
            balls.append(S.sphere(c, rng.uniform(0.019, 0.027)))
        h = S.union(_scalp(0.03), S.union(*balls, k=0.004), k=0.008)
        h = S.intersect(h, _hairline_cut(1.672, 1.51, 1.62), k=0.012)
        h = S.subtract(h, _ear_clear(), k=0.01)
    else:  # hairD: slicked back with a bun
        base = _scalp(0.016)
        bun = S.ellipsoid((0, 0.085, 1.745), (0.052, 0.048, 0.046))
        band = S.torus((0, 0.07, 1.718), 0.034, 0.009, S.rot('x', 55))
        h = S.union(base, bun, k=0.025)
        h = S.intersect(h, _hairline_cut(1.665, 1.515, 1.62), k=0.014)
        h = S.subtract(h, _ear_clear(), k=0.01)
        def grooves(P, h=h):
            return h(P) + 0.0012 * np.sin(P[:, 0] * 260.0)
        h = S.union(grooves, band, k=0.004)
    # never inside the head
    return S.subtract(h, S.offset(head, -0.004), k=0.0)


# ── accessories ───────────────────────────────────────────────────────────────────────────────
def sdf_glasses(head):
    parts = []
    for sx in (1, -1):
        c, n = _face_point(head, 0.04 * sx, 1.612, 0.016)
        R = S.frame(-n, (0, 0, 1))  # local y inward; rims lie in local xz
        Rr = R[:, [0, 2, 1]]  # torus in local XY = (x, z)
        def ring(P, c=c, Rr=Rr):
            q = (P - c) @ Rr
            # rounded rectangle ring
            dx = np.abs(q[:, 0]) - 0.022
            dy = np.abs(q[:, 1]) - 0.014
            d2 = np.sqrt(np.maximum(dx, 0) ** 2 + np.maximum(dy, 0) ** 2) + np.minimum(np.maximum(dx, dy), 0) - 0.008
            return np.sqrt(d2 ** 2 + q[:, 2] ** 2) - 0.0028
        parts.append(ring)
        hinge = c + np.array((0.03 * sx, 0.005, 0.004), dtype=np.float32)
        back = np.array((0.106 * sx, 0.02, 1.612), dtype=np.float32)
        parts.append(S.capsule(hinge, back, 0.0022))
        parts.append(S.capsule(back, back + np.array((0, 0.02, -0.018), dtype=np.float32), 0.0022))
    lc, _ = _face_point(head, 0.016, 1.62, 0.017)
    rc = lc * np.array((-1, 1, 1), dtype=np.float32)
    parts.append(S.polyline([lc, (lc + rc) / 2 + np.array((0, -0.002, 0.004), dtype=np.float32), rc], [0.0024] * 3))
    return S.union(*parts, k=0.002)


def sdf_headset():
    band_c = np.array((0, 0.01, 1.62), dtype=np.float32)
    def band(P):
        q = P - band_c
        r = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2)
        d = np.sqrt((r - 0.128) ** 2 + q[:, 1] ** 2) - 0.008
        return np.where(q[:, 2] > -0.02, d, 1.0)
    band_f = lambda P: np.maximum(band(P), np.abs(P[:, 1] - 0.01) - 0.012)  # noqa: E731
    cups = S.sym_x(S.round_cylinder((0.114, 0.012, 1.598), 0.036, 0.016, 0.008, S.frame((0, 1, 0), (1, 0, 0))))
    pads = S.sym_x(S.round_cylinder((0.106, 0.012, 1.598), 0.031, 0.012, 0.01, S.frame((0, 1, 0), (1, 0, 0))))
    boom = S.polyline([(0.112, -0.02, 1.585), (0.098, -0.075, 1.555), (0.05, -0.11, 1.535)], [0.0045, 0.004, 0.0035])
    mic = S.ellipsoid((0.043, -0.112, 1.534), (0.011, 0.009, 0.008))
    return S.union(S.union(band_f, cups, pads, k=0.004), boom, mic, k=0.004)


def sdf_badge(shirt):
    """Lanyard cord around the neck + card on the chest (material badge) and the card face (white)."""
    card_c = S.push_out(shirt, (0.0, -0.11, 1.205), 0.006)
    n = S._grad(shirt, card_c[None])[0]
    n /= np.linalg.norm(n)
    R = S.frame((0, 0, 1), -n)  # local x across, y up, z into the chest
    holder = S.round_box(card_c, (0.03, 0.044, 0.0022), 0.002, R)
    top = card_c + R[:, 1] * 0.044
    ring = S.torus(top + R[:, 1] * 0.006, 0.006, 0.0018, R)
    loop = []
    for sx in (1, -1):
        side = [S.push_out(shirt, (0.012 * sx, -0.105, 1.27), 0.004),
                S.push_out(shirt, (0.035 * sx, -0.088, 1.36), 0.004),
                S.push_out(shirt, (0.058 * sx, -0.045, 1.425), 0.004),
                S.push_out(shirt, (0.062 * sx, 0.02, 1.44), 0.004),
                S.push_out(shirt, (0.0, 0.07, 1.445), 0.004)]
        side = [top + R[:, 1] * 0.008] + side
        loop.append(S.polyline(side, [0.0032] * len(side)))
    cord = S.union(*loop, ring)
    face = plate(card_c - R[:, 1] * 0.006 + n * 0.0026, R[:, 0], -R[:, 1], 0.049, 0.062)
    return S.union(holder, cord, k=0.002), face


# ── props (built around the right hand in the rest pose, then parented to prop.R) ────────────
def prop_frame():
    """World frame of the prop.R socket in the rest pose: (origin, x, y=fingers, z=palm)."""
    th, u, p = hand_frame('R')
    w = Vector(C.WRIST_J)
    w.x = -w.x
    grip = w + u * 0.072 + p * 0.03
    return np.array(grip, dtype=np.float32), np.array(th), np.array(u), np.array(p)


def sdf_in_frame(loc_sdf, o, X, Y, Z):
    M = np.stack([X, Y, Z], axis=1).astype(np.float32)
    return lambda P: loc_sdf((P - o) @ M)


def sdf_cup_local():
    """Mug: local z up (= thumb direction when held), centred so the palm wraps it. Solid body
    with a shallow coffee recess (no thin walls to break under decimation)."""
    outer = S.round_cylinder((0, 0, 0), 0.04, 0.048, 0.007)
    recess = S.round_cylinder((0, 0, 0.05), 0.0335, 0.012, 0.003)
    mug = S.subtract(outer, recess, k=0.002)
    handle = S.torus((0.047, 0, 0.004), 0.022, 0.0065, S.frame((0, 0, 1), (0, 1, 0)))
    handle = S.intersect(handle, S.plane((-1, 0, 0), (0.038, 0, 0)))
    return S.union(mug, handle, k=0.005)


def sdf_coffee_local():
    return S.round_cylinder((0, 0, 0.0385), 0.0338, 0.0012, 0.001)


def sdf_phone_local():
    return S.round_box((0, 0, 0), (0.036, 0.074, 0.0045), 0.004)


def sdf_phone_screen_local():
    return S.round_box((0, 0, -0.0046), (0.032, 0.068, 0.0008), 0.0007)


def sdf_paddle_local():
    blade = S.round_cylinder((0, 0.12, 0), 0.077, 0.0065, 0.004)
    return blade


def sdf_paddle_handle_local():
    return S.union(S.round_box((0, 0.02, 0), (0.014, 0.05, 0.011), 0.008),
                   S.round_box((0, 0.065, 0), (0.024, 0.016, 0.0068), 0.004), k=0.012)


def sdf_laptop_local():
    """Base centred at the origin (x width, y depth toward the hinge, z up); lid open ~105°."""
    base = S.round_box((0, 0, 0.0085), (0.155, 0.108, 0.0085), 0.006)
    lid_R = S.frame((0, math.cos(math.radians(-15)), math.sin(math.radians(-15))), (0, 0, 1))
    hinge = np.array((0, 0.104, 0.016), dtype=np.float32)
    lid_c = hinge + np.array((0, math.sin(math.radians(15)) * 0.105, math.cos(math.radians(15)) * 0.105), dtype=np.float32)
    Rl = S.frame((0, math.sin(math.radians(15)), math.cos(math.radians(15))), (0, 1, 0))
    lid = S.round_box(lid_c, (0.155, 0.104, 0.005), 0.005, Rl)
    return S.union(base, lid)


def laptop_screen_decal():
    hinge = np.array((0, 0.104, 0.016), dtype=np.float32)
    s15, c15 = math.sin(math.radians(15)), math.cos(math.radians(15))
    lid_c = hinge + np.array((0, s15 * 0.105, c15 * 0.105), dtype=np.float32)
    Rl = S.frame((0, s15, c15), (0, 1, 0))
    n = Rl[:, 2]
    return (lid_c - n * 0.0053, Rl[:, 0], -Rl[:, 1], 0.284, 0.184)


def sdf_keys_local():
    return S.round_box((0, -0.01, 0.0172), (0.13, 0.05, 0.0008), 0.0006)
