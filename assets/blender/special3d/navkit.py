"""Nav helpers for the Night City modules: link anchor approaches to hubs without crossing walls or
colliders (contract §3, §11 PLAN-5), so the graph stays valid by construction."""
import math


def _cross(p, q, a, b):
    """Distance along wall a→b where segment p→q properly crosses it, else None (as validate.ts)."""
    rx, rz = q[0] - p[0], q[1] - p[1]
    sx, sz = b[0] - a[0], b[1] - a[1]
    den = rx * sz - rz * sx
    if abs(den) < 1e-9:
        return None
    t = ((a[0] - p[0]) * sz - (a[1] - p[1]) * sx) / den
    u = ((a[0] - p[0]) * rz - (a[1] - p[1]) * rx) / den
    if t <= 1e-6 or t >= 1 - 1e-6 or u < -1e-9 or u > 1 + 1e-9:
        return None
    return u * math.hypot(sx, sz)


def crosses_wall(g, p, q, y=0.0):
    for w in g.plan['walls']:
        if w.get('h', 99) <= y:  # a mezzanine edge passes above the wall
            continue
        s = _cross(p, q, w['a'], w['b'])
        if s is None:
            continue
        if any(t0 - 0.01 <= s <= t1 + 0.01 for t0, t1 in w.get('openings', [])):
            continue
        return True
    return False


def hits_collider(g, p, q, shrink=0.06):
    for (x0, x1, z0, z1, y0, y1) in g.colliders:
        if y0 > 1.8:
            continue
        x0, x1, z0, z1 = x0 + shrink, x1 - shrink, z0 + shrink, z1 - shrink
        if x0 >= x1 or z0 >= z1:
            continue
        t0, t1 = 0.0, 1.0
        ok = True
        for pp, d, lo, hi in ((p[0], q[0] - p[0], x0, x1), (p[1], q[1] - p[1], z0, z1)):
            if abs(d) < 1e-9:
                if pp < lo or pp > hi:
                    ok = False
                    break
            else:
                ta, tb = (lo - pp) / d, (hi - pp) / d
                t0, t1 = max(t0, min(ta, tb)), min(t1, max(ta, tb))
                if t0 > t1:
                    ok = False
                    break
        if ok:
            return True
    return False


def clear(g, a, b):
    return not crosses_wall(g, a, b) and not hits_collider(g, a, b)


def link_anchors(g, A, k=2, max_d=9.0, prefer=None):
    """Connect every anchor's ap:<id> node to its k nearest clear ground hubs (nodes without y, not ap:)."""
    hubs = [n for n, v in A.nodes.items() if not n.startswith('ap:') and 'y' not in v]
    for aid, a in A.anchors.items():
        if 'approach' not in a:
            continue
        ap = f'ap:{aid}'
        p = (a['approach']['x'], a['approach']['z'])
        pool = [h for h in hubs if prefer is None or prefer(aid, h)] or hubs
        cand = sorted(pool, key=lambda h: math.hypot(A.nodes[h]['x'] - p[0], A.nodes[h]['z'] - p[1]))
        got = 0
        for h in cand:
            q = (A.nodes[h]['x'], A.nodes[h]['z'])
            if math.dist(p, q) > max_d and got:
                break
            if clear(g, p, q):
                A.edge(ap, h)
                got += 1
                if got >= k:
                    break
        if not got:
            raise ValueError(f'no clear nav hub for {aid} at {p}')


def check_edges(g, A):
    """Every ground edge clear of walls (outside openings); returns the offending edges."""
    bad = []
    for a, b in A.edges:
        na, nb = A.nodes[a], A.nodes[b]
        y = min(na.get('y', 0.0), nb.get('y', 0.0))
        if crosses_wall(g, (na['x'], na['z']), (nb['x'], nb['z']), y):
            bad.append((a, b))
    return bad
