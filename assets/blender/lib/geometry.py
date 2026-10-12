"""Procedural geometry, accumulated per (group, material) so each module exports a few draw calls.

Coordinates are glTF/runtime (meters, +Y up); see scene.py. `Geo.at(x, z, yaw)` pushes a local frame,
so furniture is authored around its own origin facing +z and placed with a translation + yaw.

Groups:
  static   joined per material, lightmapped (extras.role = "baked")
  ceiling  like static but extras.role = "ceiling" (hidden by the runtime in orbit view)
  glass    blended glass, not baked (extras.role = "glass")
Dynamic surfaces (screens, LEDs, sign, elevator doors) are separate objects with their own material,
created through `Geo.dynamic()`. Colliders are AABBs exported as invisible boxes.
"""
import math
from contextlib import contextmanager

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import materials
from .scene import GLTF_TO_BLENDER, translation, yaw_matrix

C = GLTF_TO_BLENDER
C_INV = GLTF_TO_BLENDER.inverted()
SMOOTH_ANGLE = math.radians(46.0)


def _native_scale(sx, sy, sz):
    # native Blender primitive axes: X = glTF x, Y = glTF −z (depth), Z = glTF y (height)
    return Matrix.Diagonal((sx, sz, sy, 1.0))


class Batch:
    def __init__(self, group, mat):
        self.group = group
        self.mat = mat
        self.bm = bmesh.new()
        self.vcol = materials.VCOL.get(mat, False)
        self.col = self.bm.loops.layers.float_color.new('Col') if self.vcol else None


class Dynamic:
    def __init__(self, name, role, ref, mat, pivot, extras):
        self.name = name
        self.role = role
        self.ref = ref
        self.mat = mat
        self.pivot = pivot  # glTF module coords of the object origin
        self.extras = extras or {}
        self.bm = bmesh.new()
        self.col = None
        self.vcol = False
        self.uv_fixed = False


class Geo:
    def __init__(self):
        self.batches = {}
        self.dynamics = []
        self.colliders = []
        self.stack = [Matrix.Identity(4)]
        self.yaws = [0.0]
        self.group = 'static'
        self._target = None
        self.lights = []  # (kind, glTF pos, params) for lighting.py
        self.tris_estimate = 0

    # ------------------------------------------------------------------ frames
    @contextmanager
    def at(self, x=0.0, z=0.0, yaw=0.0, y=0.0):
        m = self.stack[-1] @ translation(x, y, z) @ yaw_matrix(yaw)
        self.stack.append(m)
        self.yaws.append(self.yaws[-1] + yaw)
        try:
            yield
        finally:
            self.stack.pop()
            self.yaws.pop()

    @contextmanager
    def in_group(self, group):
        prev = self.group
        self.group = group
        try:
            yield
        finally:
            self.group = prev

    @contextmanager
    def into(self, dyn):
        """Route primitives into a dynamic object instead of the batches."""
        prev = self._target
        self._target = dyn
        try:
            yield
        finally:
            self._target = prev

    def world(self, x, y, z):
        """Local glTF point → module glTF point."""
        v = self.stack[-1] @ Vector((x, y, z))
        return (v.x, v.y, v.z)

    def heading(self, h):
        return h + self.yaws[-1]

    # ------------------------------------------------------------------ targets
    def _bm(self, mat):
        if self._target is not None:
            return self._target.bm, self._target.col
        if not isinstance(mat, str):
            mat = mat.name
        key = (self.group, mat)
        b = self.batches.get(key)
        if b is None:
            b = self.batches[key] = Batch(self.group, mat)
        return b.bm, b.col

    def dynamic(self, name, role, ref, mat, pivot=(0, 0, 0), extras=None):
        """A separate runtime-driven object. `pivot` is local (transformed by the current frame)."""
        d = Dynamic(name, role, ref, mat if isinstance(mat, str) else mat.name, self.world(*pivot), extras)
        self.dynamics.append(d)
        return d

    def collider(self, x0, x1, z0, z1, y0=0.0, y1=2.4):
        """Walk-mode collision AABB, given in local coords (transformed; yaw must be a multiple of 90°)."""
        pts = [self.world(x, 0, z) for x in (x0, x1) for z in (z0, z1)]
        xs = [p[0] for p in pts]
        zs = [p[2] for p in pts]
        self.colliders.append((round(min(xs), 4), round(max(xs), 4), round(min(zs), 4), round(max(zs), 4), y0, y1))

    def light(self, kind, pos, **params):
        """Record a light for lighting.py (pos local; direction params are in local glTF axes)."""
        p = self.world(*pos)
        params['yaw'] = self.yaws[-1]
        self.lights.append((kind, p, params))

    # ------------------------------------------------------------------ helpers
    def _matrix(self, pos, yaw=0.0, scale=(1, 1, 1), pitch=0.0, roll=0.0):
        m = self.stack[-1] @ translation(*pos) @ yaw_matrix(yaw)
        if pitch:
            m = m @ Matrix.Rotation(pitch, 4, 'X')
        if roll:
            m = m @ Matrix.Rotation(roll, 4, 'Z')
        return C @ m @ C_INV @ _native_scale(*scale)

    def _finish(self, bm, col, verts, color, bevel=0.0, segs=1, smooth=None):
        if bevel > 0:
            edges = list({e for v in verts for e in v.link_edges})
            res = bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=segs, profile=0.5, affect='EDGES',
                                  clamp_overlap=True)
            verts = [v for v in verts if v.is_valid] + list(res['verts'])
        if col is not None:
            c = materials.rgba(color) if color is not None else (1, 1, 1, 1)
            faces = {f for v in verts if v.is_valid for f in v.link_faces}
            for f in faces:
                for loop in f.loops:
                    loop[col] = c
        return verts

    # ------------------------------------------------------------------ primitives
    def box(self, mat, size, pos, yaw=0.0, bevel=0.004, segs=1, color=None, pitch=0.0, roll=0.0):
        """Box of `size` (sx, sy, sz) centered at `pos` (local glTF)."""
        bm, col = self._bm(mat)
        sx, sy, sz = size
        if min(sx, sy, sz) < 0.055 and max(sx, sy, sz) < 1.0:
            bevel = 0.0  # thin/small parts: chamfers cost triangles the lightmap would hide anyway
        bevel = min(bevel, 0.45 * min(sx, sy, sz))
        res = bmesh.ops.create_cube(bm, size=1.0, matrix=self._matrix(pos, yaw, (sx, sy, sz), pitch, roll))
        return self._finish(bm, col, res['verts'], color, bevel if bevel > 0.0005 else 0, segs)

    def box_b(self, mat, x0, x1, y0, y1, z0, z1, **kw):
        """Box from bounds (local glTF)."""
        return self.box(mat, (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)),
                        ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), **kw)

    def cyl(self, mat, r, h, pos, segs=16, r2=None, yaw=0.0, pitch=0.0, roll=0.0, color=None, caps=True,
            bevel=0.0, bsegs=1):
        """Cylinder/cone standing on `pos` (base center), axis local +y (rotated by pitch/roll)."""
        bm, col = self._bm(mat)
        r2 = r if r2 is None else r2
        m = self.stack[-1] @ translation(*pos) @ yaw_matrix(yaw)
        if pitch:
            m = m @ Matrix.Rotation(pitch, 4, 'X')
        if roll:
            m = m @ Matrix.Rotation(roll, 4, 'Z')
        m = C @ m @ C_INV @ Matrix.Translation((0, 0, h / 2))
        res = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r, radius2=r2,
                                    depth=h, matrix=m)
        return self._finish(bm, col, res['verts'], color, bevel, bsegs)

    def sphere(self, mat, r, pos, segs=12, rings=8, scale=(1, 1, 1), color=None, yaw=0.0):
        bm, col = self._bm(mat)
        m = self._matrix(pos, yaw, (r * scale[0], r * scale[1], r * scale[2]))
        res = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0, matrix=m)
        return self._finish(bm, col, res['verts'], color)

    def torus(self, mat, R, r, pos, segs=32, rsegs=8, yaw=0.0, pitch=0.0, color=None):
        """Torus in the local XZ plane (a ring pendant), centered at pos."""
        bm, col = self._bm(mat)
        m = self.stack[-1] @ translation(*pos) @ yaw_matrix(yaw)
        if pitch:
            m = m @ Matrix.Rotation(pitch, 4, 'X')
        m = C @ m
        rings = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ring = []
            for j in range(rsegs):
                b = 2 * math.pi * j / rsegs
                d = R + r * math.cos(b)
                p = Vector((d * math.cos(a), r * math.sin(b), d * math.sin(a)))
                ring.append(bm.verts.new(m @ p))
            rings.append(ring)
        verts = [v for ring in rings for v in ring]
        for i in range(segs):
            a, b = rings[i], rings[(i + 1) % segs]
            for j in range(rsegs):
                bm.faces.new((a[j], a[(j + 1) % rsegs], b[(j + 1) % rsegs], b[j]))
        return self._finish(bm, col, verts, color)

    def quad(self, mat, w, h, pos, yaw=0.0, pitch=0.0, color=None, uv=True):
        """Single-sided rectangle centered at pos, facing local +z (its front), u → +x, v → +y."""
        bm, col = self._bm(mat)
        m = self.stack[-1] @ translation(*pos) @ yaw_matrix(yaw)
        if pitch:
            m = m @ Matrix.Rotation(pitch, 4, 'X')
        m = C @ m
        pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
        verts = [bm.verts.new(m @ Vector((x, y, 0))) for x, y in pts]
        f = bm.faces.new(verts)
        if uv:
            uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
            for loop, (u, v) in zip(f.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
                loop[uvl].uv = (u, v)
        return self._finish(bm, col, verts, color)

    def plane_y(self, mat, x0, x1, z0, z1, y, up=True, color=None):
        """Horizontal one-sided rectangle (floors face up, ceilings face down)."""
        return self.quad(mat, abs(x1 - x0), abs(z1 - z0), ((x0 + x1) / 2, y, (z0 + z1) / 2),
                         pitch=-math.pi / 2 if up else math.pi / 2, color=color)

    def prism(self, mat, poly, y0, y1, color=None, bevel=0.0, segs=1, top=True, bottom=True):
        """Extrude a local XZ polygon [(x, z), …] (any winding) between heights y0 and y1."""
        bm, col = self._bm(mat)
        m = C @ self.stack[-1]
        area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))
        if area > 0:  # make it clockwise in (x, z) == counter-clockwise seen from +y
            poly = list(reversed(poly))
        lo = [bm.verts.new(m @ Vector((x, y0, z))) for x, z in poly]
        hi = [bm.verts.new(m @ Vector((x, y1, z))) for x, z in poly]
        n = len(poly)
        if top:
            bm.faces.new(hi)
        if bottom:
            bm.faces.new(list(reversed(lo)))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
        return self._finish(bm, col, lo + hi, color, bevel, segs)

    def tri_fan(self, mat, pts, color=None, double=False):
        """Raw polygon from local points (used for leaves). Returns verts."""
        bm, col = self._bm(mat)
        m = C @ self.stack[-1]
        verts = [bm.verts.new(m @ Vector(p)) for p in pts]
        bm.faces.new(verts)
        return self._finish(bm, col, verts, color)

    def ribbon(self, mat, pts_l, pts_r, color=None):
        """Strip of quads between two local polylines (leaf blades, curved shades)."""
        bm, col = self._bm(mat)
        m = C @ self.stack[-1]
        L = [bm.verts.new(m @ Vector(p)) for p in pts_l]
        R = [bm.verts.new(m @ Vector(p)) for p in pts_r]
        for i in range(len(L) - 1):
            if (L[i].co - R[i].co).length < 1e-6:
                bm.faces.new((L[i], R[i + 1], L[i + 1]))
            elif (L[i + 1].co - R[i + 1].co).length < 1e-6:
                bm.faces.new((L[i], R[i], L[i + 1]))
            else:
                bm.faces.new((L[i], R[i], R[i + 1], L[i + 1]))
        return self._finish(bm, col, L + R, color)


# ---------------------------------------------------------------------------- arcs & outlines
def arc(cx, cz, r, a0, a1, n):
    """Points on an arc in the XZ plane (angles from +x toward +z)."""
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cz + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def rounded_rect(w, d, r, n=4, cx=0.0, cz=0.0):
    hw, hd = w / 2, d / 2
    r = min(r, hw, hd)
    pts = []
    for (sx, sz, a0) in ((1, 1, 0), (-1, 1, math.pi / 2), (-1, -1, math.pi), (1, -1, 1.5 * math.pi)):
        ccx, ccz = cx + sx * (hw - r), cz + sz * (hd - r)
        pts += arc(ccx, ccz, r, a0, a0 + math.pi / 2, n)
    return pts


# ---------------------------------------------------------------------------- object creation
def _set_smooth(bm):
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if not e.is_manifold:
            continue
        if e.calc_face_angle(0.0) > SMOOTH_ANGLE:
            e.smooth = False


def world_uvs(bm, tile):
    """UV0: world-scale box projection (Blender coords; 1 UV unit = `tile` meters)."""
    uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    s = 1.0 / tile
    for f in bm.faces:
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in f.loops:
            co = loop.vert.co
            if az >= ax and az >= ay:
                u, v = co.x, co.y if n.z >= 0 else -co.y
            elif ax >= ay:
                u, v = (co.y if n.x >= 0 else -co.y), co.z
            else:
                u, v = (-co.x if n.y >= 0 else co.x), co.z
            loop[uvl].uv = (u * s, v * s)


def mesh_object(name, bm, mat, col, tile=None, fixed_uv=False):
    """bmesh → object with material, UV0, smooth/sharp flags and weighted normals."""
    bm.normal_update()
    if not fixed_uv:
        world_uvs(bm, tile or 2.0)
    elif not bm.loops.layers.uv:
        world_uvs(bm, 1.0)
    _set_smooth(bm)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    col.objects.link(obj)
    me.materials.append(materials.get(mat))
    if me.polygons:
        mod = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
        mod.keep_sharp = True
        mod.weight = 50
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def triangle_count(obj):
    me = obj.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


# ---------------------------------------------------------------------------- architecture kit
def wall(g, mat, a, b, h, thick=0.15, y0=0.0, openings=(), side=1, bevel=0.003, skirting=None):
    """Straight wall from a=(x, z) to b=(x, z) in local coords; the wall body lies on the `side` (+1 left,
    −1 right of a→b) of the line so two modules sharing a boundary never overlap.
    openings: [(t0, t1, ybot, ytop)] distances along a→b."""
    ax, az = a
    bx, bz = b
    L = math.hypot(bx - ax, bz - az)
    yaw = math.atan2(bx - ax, bz - az) - math.pi / 2  # local +x along a→b
    cuts = sorted(openings)
    with g.at(ax, az, yaw):
        zc = side * thick / 2
        spans = []
        t = 0.0
        for (t0, t1, yb, yt) in cuts:
            if t0 > t:
                spans.append((t, t0, y0, y0 + h))
            if yb > y0:
                spans.append((t0, t1, y0, yb))
            if yt < y0 + h:
                spans.append((t0, t1, yt, y0 + h))
            t = t1
        if t < L:
            spans.append((t, L, y0, y0 + h))
        for (s0, s1, yb, yt) in spans:
            if s1 - s0 < 1e-4 or yt - yb < 1e-4:
                continue
            g.box_b(mat, s0, s1, yb, yt, zc - thick / 2, zc + thick / 2, bevel=bevel)
        if skirting:
            t = 0.0
            for (t0, t1, yb, yt) in cuts + [(L, L, 0, 0)]:
                if yb <= y0 + 0.01 and t0 > t:
                    g.box_b(skirting, t, t0, y0, y0 + 0.08, zc + side * (thick / 2) - 0.006,
                            zc + side * (thick / 2 + 0.012), bevel=0.002)
                t = t1


def glass_partition(g, P, a, b, h=2.7, spacing=1.2, door=None, frame='metal', top=None, sill=0.0):
    """Glazed partition with black mullions from a to b (local XZ). door=(t0, t1) leaves an opening with
    a frame; `top` (height) adds a solid head above the glazing up to that height."""
    ax, az = a
    bx, bz = b
    L = math.hypot(bx - ax, bz - az)
    yaw = math.atan2(bx - ax, bz - az) - math.pi / 2
    fm = P[frame]
    mw = 0.05
    with g.at(ax, az, yaw):
        g.box_b(fm, 0, L, h - 0.06, h, -0.03, 0.03, bevel=0.003)
        segs = []
        t = 0.0
        if door:
            segs = [(0.0, door[0]), (door[1], L)]
        else:
            segs = [(0.0, L)]
        for s0, s1 in segs:
            if s1 - s0 < 0.05:
                continue
            g.box_b(fm, s0, s1, sill, sill + 0.06, -0.03, 0.03, bevel=0.003)
            n = max(1, round((s1 - s0) / spacing))
            for i in range(n + 1):
                x = s0 + (s1 - s0) * i / n
                x = min(max(x, s0 + mw / 2), s1 - mw / 2)
                g.box((fm), (mw, h - sill, 0.06), (x, (h + sill) / 2, 0), bevel=0.003)
            with g.in_group('glass'):
                g.box(P['glass'], (s1 - s0 - mw, h - sill - 0.12, 0.012), ((s0 + s1) / 2, (h + sill) / 2, 0), bevel=0)
            # frosted manifestation band at eye level (safety film), as a slightly opaque strip
            g.box(P['white'], (s1 - s0 - mw, 0.08, 0.004), ((s0 + s1) / 2, 1.35, 0.009), bevel=0)
            g.box(P['white'], (s1 - s0 - mw, 0.08, 0.004), ((s0 + s1) / 2, 1.35, -0.009), bevel=0)
        if door:
            d0, d1 = door
            g.box_b(fm, d0 - 0.06, d0, 0, h, -0.05, 0.05, bevel=0.003)
            g.box_b(fm, d1, d1 + 0.06, 0, h, -0.05, 0.05, bevel=0.003)
            g.box_b(fm, d0, d1, 2.15, 2.21, -0.05, 0.05, bevel=0.003)
            with g.in_group('glass'):
                g.box(P['glass'], (d1 - d0, h - 2.27, 0.012), ((d0 + d1) / 2, (h + 2.21) / 2, 0), bevel=0)
        if top and top > h:
            g.box_b(P['wall'], 0, L, h, top, -0.06, 0.06, bevel=0.002)


def curtain_wall(g, P, a, b, h, spacing=1.5, transoms=(), thick=0.12, sill=0.0, side=1, frame='metal'):
    """Exterior floor-to-ceiling glazing with deep mullions (the wall body sits on `side`)."""
    ax, az = a
    bx, bz = b
    L = math.hypot(bx - ax, bz - az)
    yaw = math.atan2(bx - ax, bz - az) - math.pi / 2
    fm = P[frame]
    zc = side * thick / 2
    with g.at(ax, az, yaw):
        n = max(1, round(L / spacing))
        for i in range(n + 1):
            x = min(max(L * i / n, 0.04), L - 0.04)
            g.box(fm, (0.07, h, thick), (x, h / 2, zc), bevel=0.004)
        for y in (0.0,) + tuple(transoms) + (h - 0.08,):
            g.box_b(fm, 0, L, y, y + 0.08, zc - thick / 2, zc + thick / 2, bevel=0.004)
        with g.in_group('glass'):
            g.box_b(P['glass'], 0, L, 0.08, h - 0.08, zc - 0.006, zc + 0.006, bevel=0)
