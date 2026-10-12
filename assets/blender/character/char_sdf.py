"""Signed-distance modelling + surface-nets meshing (numpy only, runs inside Blender).

Every character part is an SDF expression (smooth unions of ellipsoids, round cones,
rounded boxes, tori). `mesh_sdf` samples it on a grid, extracts a quad mesh with naive
surface nets and projects the vertices back onto the exact zero level set.
Coordinates are Blender's (Z-up, the character faces -Y, its left side is +X).
"""
import numpy as np

F = np.float32


def _v(x):
    return np.asarray(x, dtype=F)


def rot(axis, deg):
    """3x3 rotation matrix about 'x'|'y'|'z' (right-handed, degrees)."""
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    if axis == 'x':
        m = [[1, 0, 0], [0, c, -s], [0, s, c]]
    elif axis == 'y':
        m = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    else:
        m = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    return _v(m)


def frame(y_axis, z_hint):
    """Rotation whose columns are (x, y, z) with y along `y_axis`, z close to `z_hint`."""
    y = _v(y_axis) / np.linalg.norm(y_axis)
    z = _v(z_hint) - y * np.dot(y, z_hint)
    z /= np.linalg.norm(z)
    x = np.cross(y, z)
    return np.stack([x, y, z], axis=1).astype(F)


def _local(P, c, R):
    q = P - _v(c)
    if R is not None:
        q = q @ _v(R)  # world -> local (R columns are local axes in world)
    return q


# ── primitives ────────────────────────────────────────────────────────────────────────────────
def ellipsoid(c, r, R=None):
    r = _v(r)

    def f(P):
        q = _local(P, c, R)
        k0 = np.linalg.norm(q / r, axis=1)
        k1 = np.linalg.norm(q / (r * r), axis=1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
    return f


def sphere(c, r):
    c = _v(c)
    return lambda P: np.linalg.norm(P - c, axis=1) - r


def round_cone(a, b, ra, rb):
    """Exact SDF of the convex hull of two spheres (Inigo Quilez)."""
    a, b = _v(a), _v(b)
    ba = b - a
    l2 = float(np.dot(ba, ba))
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def f(P):
        pa = P - a
        y = pa @ ba
        z = y - l2
        w = pa * l2 - y[:, None] * ba
        x2 = np.einsum('ij,ij->i', w, w)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d_mid = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - ra
        d_b = np.sqrt(x2 + z2) * il2 - rb
        d_a = np.sqrt(x2 + y2) * il2 - ra
        return np.where(np.sign(z) * a2 * z2 > k, d_b, np.where(np.sign(y) * a2 * y2 < k, d_a, d_mid))
    return f


def capsule(a, b, r):
    return round_cone(a, b, r, r)


def round_box(c, half, r, R=None):
    half = _v(half)

    def f(P):
        q = np.abs(_local(P, c, R)) - half + r
        return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(axis=1), 0) - r
    return f


def torus(c, major, minor, R=None):
    """Torus lying in the local XY plane."""
    def f(P):
        q = _local(P, c, R)
        a = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2) - major
        return np.sqrt(a * a + q[:, 2] ** 2) - minor
    return f


def round_cylinder(c, radius, half_h, rnd, R=None):
    """Cylinder along local Z with rounded rims."""
    def f(P):
        q = _local(P, c, R)
        dx = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2) - radius + rnd
        dy = np.abs(q[:, 2]) - half_h + rnd
        return np.minimum(np.maximum(dx, dy), 0) + np.sqrt(np.maximum(dx, 0) ** 2 + np.maximum(dy, 0) ** 2) - rnd
    return f


def plane(n, p0):
    """Half-space: negative on the side opposite to `n` (n points outward)."""
    n = _v(n) / np.linalg.norm(n)
    d = float(np.dot(n, p0))
    return lambda P: P @ n - d


def polyline(points, radii):
    """Smoothly varying tube through points (union of round cones)."""
    fs = [round_cone(points[i], points[i + 1], radii[i], radii[i + 1]) for i in range(len(points) - 1)]
    return union(*fs)


# ── operators ─────────────────────────────────────────────────────────────────────────────────
def _smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def union(*fs, k=0.0):
    def f(P):
        d = fs[0](P)
        for g in fs[1:]:
            d = _smin(d, g(P), k)
        return d
    return f


def sunion(k, *fs):
    return union(*fs, k=k)


def intersect(a, b, k=0.0):
    return lambda P: -_smin(-a(P), -b(P), k)


def subtract(a, b, k=0.0):
    """a minus b."""
    return lambda P: -_smin(-a(P), b(P), k)


def offset(f, d):
    return lambda P: f(P) - d


def shell(f, t):
    return lambda P: np.abs(f(P)) - t


def mirror_x(f):
    return lambda P: f(P * _v([-1, 1, 1]))


def sym_x(f):
    """Evaluates f with |x| (bilateral symmetry from a +X-side definition)."""
    return lambda P: f(np.abs(P) * _v([1, 0, 0]) + P * _v([0, 1, 1]))


def warp(f, fn):
    """Domain warp: f(fn(P))."""
    return lambda P: f(fn(P))


def noise3(P, freq, seed=0):
    """Cheap smooth value-ish noise from summed sines (deterministic, band limited)."""
    rng = np.random.default_rng(seed)
    acc = np.zeros(len(P), dtype=F)
    for _ in range(6):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        ph = rng.uniform(0, 2 * np.pi)
        acc += np.sin((P @ _v(d)) * freq * rng.uniform(0.7, 1.4) + ph)
    return acc / 6.0


# ── meshing ───────────────────────────────────────────────────────────────────────────────────
def _grad(f, V, eps=1e-4):
    g = np.zeros_like(V)
    for i in range(3):
        e = np.zeros(3, dtype=F)
        e[i] = eps
        g[:, i] = (f(V + e) - f(V - e)) / (2 * eps)
    return g


def project(f, V, steps=4):
    """Newton steps onto the zero level set."""
    V = V.astype(F)
    for _ in range(steps):
        d = f(V)
        g = _grad(f, V)
        n2 = np.maximum(np.einsum('ij,ij->i', g, g), 1e-8)
        V = V - (d / n2)[:, None] * g
    return V


def mesh_sdf(f, lo, hi, h, chunk=2_000_000):
    """Naive surface nets. Returns (verts (N,3) float32, quads (M,4) int)."""
    lo, hi = _v(lo), _v(hi)
    n = np.maximum(np.ceil((hi - lo) / h).astype(int) + 1, 2)
    xs = [lo[i] + np.arange(n[i], dtype=F) * h for i in range(3)]
    G = np.stack(np.meshgrid(*xs, indexing='ij'), axis=-1).reshape(-1, 3)
    vals = np.concatenate([f(G[i:i + chunk]) for i in range(0, len(G), chunk)]).reshape(n)
    del G
    inside = vals < 0
    nc = n - 1
    acc = np.zeros(tuple(nc) + (3,), dtype=F)
    cnt = np.zeros(tuple(nc), dtype=np.int32)
    faces = []
    for ax in range(3):
        a = [slice(None)] * 3
        b = [slice(None)] * 3
        a[ax] = slice(0, -1)
        b[ax] = slice(1, None)
        v0, v1 = vals[tuple(a)], vals[tuple(b)]
        ch = inside[tuple(a)] != inside[tuple(b)]
        idx = np.argwhere(ch)
        if len(idx) == 0:
            continue
        f0 = v0[ch]
        f1 = v1[ch]
        t = (f0 / (f0 - f1)).astype(F)
        p = lo + idx.astype(F) * h
        p[:, ax] += t * h
        o1, o2 = [i for i in range(3) if i != ax]
        # the four cells sharing this edge
        for d1 in (0, -1):
            for d2 in (0, -1):
                c = idx.copy()
                c[:, o1] += d1
                c[:, o2] += d2
                ok = (c[:, o1] >= 0) & (c[:, o2] >= 0) & (c[:, o1] < nc[o1]) & (c[:, o2] < nc[o2]) & (c[:, ax] < nc[ax])
                cc = c[ok]
                np.add.at(acc, (cc[:, 0], cc[:, 1], cc[:, 2]), p[ok])
                np.add.at(cnt, (cc[:, 0], cc[:, 1], cc[:, 2]), 1)
        # quads around interior edges
        ok = (idx[:, o1] >= 1) & (idx[:, o2] >= 1) & (idx[:, o1] < nc[o1]) & (idx[:, o2] < nc[o2]) & (idx[:, ax] < nc[ax])
        e = idx[ok]
        flip = inside[tuple(e.T)]  # inside at lower end -> outward normal along +ax
        cells = []
        for d1, d2 in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
            c = e.copy()
            c[:, o1] += d1
            c[:, o2] += d2
            cells.append(c)
        faces.append((cells, flip, ax))
    active = cnt > 0
    vid = -np.ones(tuple(nc), dtype=np.int64)
    vid[active] = np.arange(active.sum())
    verts = acc[active] / cnt[active][:, None]
    quads = []
    for cells, flip, ax in faces:
        ids = np.stack([vid[tuple(c.T)] for c in cells], axis=1)
        # orientation: for ax, (o1, o2) cyclic order gives normal +ax when o1,o2 = next axes
        o1, o2 = [i for i in range(3) if i != ax]
        cyclic = (o1 == (ax + 1) % 3)
        want_rev = flip if not cyclic else ~flip
        ids[want_rev] = ids[want_rev][:, ::-1]
        quads.append(ids)
    quads = np.concatenate(quads) if quads else np.zeros((0, 4), dtype=np.int64)
    quads = quads[(quads >= 0).all(axis=1)]
    return verts.astype(F), quads


def surface_y(f, x, z, y0=-0.3, y1=0.3, iters=40):
    """Smallest y (front-most, character faces -Y) where f crosses zero along the line (x, ·, z)."""
    ys = np.linspace(y0, y1, 600, dtype=F)
    P = np.stack([np.full_like(ys, x), ys, np.full_like(ys, z)], axis=1)
    d = f(P)
    i = int(np.argmax(d < 0))
    a, b = ys[max(i - 1, 0)], ys[i]
    for _ in range(iters):
        m = 0.5 * (a + b)
        if f(_v([[x, m, z]]))[0] < 0:
            b = m
        else:
            a = m
    return float(0.5 * (a + b))


def push_out(f, p, clearance, iters=20):
    """Move a point along the gradient until f(p) >= clearance."""
    p = _v([p])
    for _ in range(iters):
        d = f(p)[0]
        if d >= clearance:
            break
        g = _grad(f, p)[0]
        g /= max(np.linalg.norm(g), 1e-8)
        p = p + g * (clearance - d)
    return p[0]
