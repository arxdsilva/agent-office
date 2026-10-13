"""Anchors (seats/spots) and navigation graphs, in module-local glTF coordinates (contract §3/§4).

Anchors are written to the manifest only (not as glTF nodes). Every anchor gets an approach point and a
dedicated nav node `ap:<anchorId>` exactly on it, linked to one or more hub nodes of the module graph.
"""
import math
import os
import re

ANCHOR_RE = re.compile(
    r'^(seat:desk:[1-6]:[0-3]'
    r'|seat:meeting:[AB]:[0-5]'
    r'|seat:(lounge|cafe|reading):\d+'
    r'|spot:(kitchen|booth|reception|elevator|garden|station|shelf|handoff):\d+'
    r'|console:context:[0-5]'
    r'|kiosk:project-directory'
    r'|spot:pingpong:\d+:[AB])$')
PORT_RE = re.compile(r'^port:(desk:[1-6]:[0-3]|station:[0-7]|book:\d+|board:[0-5]|notebook:[0-7]|archive:(\d|1[01]))$')


def _interaction_kinds():
    """The renderer's INTERACTION_KINDS (packages/web/src/app/office-types.ts), the one source of truth."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'packages', 'web', 'src',
                        'app', 'office-types.ts')
    src = open(path).read()
    body = src[src.index('INTERACTION_KINDS = ['):]
    return tuple(re.findall(r"'([a-z-]+)'", body[:body.index(']')]))


INTERACTION_KINDS = _interaction_kinds()
# Contract §14 (Night City, `set == 'special'` only, in addition to the classic grammar):
# ws:<dept>:<pod>:<seat>, booth:<n>, meet:<room>:<seat>, interact:<kind>:<n>, player:spawn.
SPECIAL_RE = re.compile(
    r'^(ws:[0-9]:[0-9]:[0-3]'
    r'|booth:\d+'
    r'|meet:[A-Z]:\d+'
    r'|interact:(' + '|'.join(re.escape(k) for k in INTERACTION_KINDS) + r'):\d+'
    r'|player:spawn)$')
SETS = ('classic', 'special')
POSES = ('sit', 'stand', 'lounge')
# Contract §4 / character.json: the anchor is where the character's root stands. The seat center is this
# far behind the root (opposite the heading); `stand` spots are the root itself.
ROOT_OFFSET = {'sit': 0.29, 'lounge': 0.36, 'stand': 0.0}
AP_WIDTH = 0.35


def _r(v):
    v = round(v, 4)
    return 0.0 if v == 0 else v


def norm_heading(h):
    h = math.fmod(h, 2 * math.pi)
    if h <= -math.pi:
        h += 2 * math.pi
    elif h > math.pi:
        h -= 2 * math.pi
    return h


def valid_id(aid, set_='classic'):
    """Whether `aid` follows the anchor grammar of asset set `set_` (contract §4; §14 for 'special')."""
    if set_ not in SETS:
        raise ValueError(f'unknown asset set {set_!r}')
    return bool(ANCHOR_RE.match(aid) or (set_ == 'special' and SPECIAL_RE.match(aid)))


class Anchors:
    def __init__(self, geo, prefix, asset_set='classic'):
        if asset_set not in SETS:
            raise ValueError(f'unknown asset set {asset_set!r}')
        self.geo = geo
        self.prefix = prefix
        self.asset_set = asset_set
        self.anchors = {}
        self.seat_centers = {}  # internal (tests): seat center of every seat anchor
        self.ports = {}
        self.nodes = {}
        self.edges = set()

    # ----------------------------------------------------------------- nav
    def node(self, nid, x, z, width=0.8, local=True, y=None):
        """A nav node. `y` (Night City mezzanines, contract §14) is the walkable height above the module
        floor; it is written only when given, so classic graphs are unchanged."""
        if local:
            x, _, z = self.geo.world(x, 0, z)
        if nid in self.nodes:
            raise ValueError(f'duplicate nav node {nid}')
        self.nodes[nid] = {'x': _r(x), 'z': _r(z), 'width': round(width, 3)}
        if y is not None and self.asset_set == 'special':
            self.nodes[nid]['y'] = _r(y)
        elif y is not None:
            raise ValueError('nav node heights are a Night City (special set) feature')
        return nid

    def edge(self, a, b):
        if a == b:
            return
        for n in (a, b):
            if n not in self.nodes:
                raise KeyError(f'unknown nav node {n}')
        self.edges.add((a, b) if a < b else (b, a))

    def chain(self, *ids):
        for a, b in zip(ids, ids[1:]):
            self.edge(a, b)

    def nearest(self, x, z, exclude_ap=True):
        best, bd = None, 1e9
        for nid, n in self.nodes.items():
            if exclude_ap and nid.startswith('ap:'):
                continue
            d = math.hypot(n['x'] - x, n['z'] - z)
            if d < bd:
                best, bd = nid, d
        return best

    # ----------------------------------------------------------------- anchors
    def _add(self, aid, x, z, heading, pose, room, approach, hubs, extra):
        if not valid_id(aid, self.asset_set):
            raise ValueError(f'anchor id {aid} breaks the {self.asset_set} grammar')
        if aid in self.anchors:
            raise ValueError(f'duplicate anchor {aid}')
        if pose not in POSES:
            raise ValueError(f'bad pose {pose}')
        # (x, z) is the seat center (or the standing spot); approach distances are measured from it
        cx, _, cz = self.geo.world(x, 0, z)
        h = norm_heading(self.geo.heading(heading))
        off = ROOT_OFFSET[pose]
        wx, wz = cx + off * math.sin(h), cz + off * math.cos(h)
        if isinstance(approach, (int, float)):
            ax, az = cx + approach * math.sin(h), cz + approach * math.cos(h)
        else:
            ax, _, az = self.geo.world(approach[0], 0, approach[1])
        if aid.startswith('seat:'):
            self.seat_centers[aid] = (cx, cz)
        a = {'x': _r(wx), 'y': 0, 'z': _r(wz), 'heading': _r(h), 'pose': pose}
        if room:
            a['room'] = room
        for k, v in extra.items():
            if v is not None:
                a[k] = v
        a['approach'] = {'x': _r(ax), 'z': _r(az)}
        self.anchors[aid] = a
        nid = self.node(f'ap:{aid}', a['approach']['x'], a['approach']['z'], AP_WIDTH, local=False)
        if isinstance(hubs, str):
            hubs = [hubs]
        if hubs is None:
            hubs = [self.nearest(ax, az)]
        for hb in hubs:
            self.edge(nid, hb)
        return aid

    def seat(self, aid, x, z, heading, pose='sit', room=None, approach=-0.6, hubs=None, **extra):
        """Seat facing `heading` (local). approach: signed distance along the facing (negative = behind
        the seat, the open side of a desk chair) or an explicit local (x, z)."""
        return self._add(aid, x, z, heading, pose, room, approach, hubs, extra)

    def spot(self, aid, x, z, heading, room=None, approach=-0.6, hubs=None, **extra):
        return self._add(aid, x, z, heading, 'stand', room, approach, hubs, extra)

    def port(self, pid, x, y, z):
        """3D link attach point (local coords), the only anchor kind with y ≠ 0 (contract §4)."""
        if not PORT_RE.match(pid):
            raise ValueError(f'port id {pid} breaks the grammar')
        if pid in self.anchors:
            raise ValueError(f'duplicate port {pid}')
        wx, wy, wz = self.geo.world(x, y, z)
        self.anchors[pid] = {'x': _r(wx), 'y': _r(wy), 'z': _r(wz)}
        self.ports[pid] = True
        return pid

    # ----------------------------------------------------------------- output
    def manifest(self):
        return {
            'anchors': {k: self.anchors[k] for k in sorted(self.anchors)},
            'nav': {
                'nodes': {k: self.nodes[k] for k in sorted(self.nodes)},
                'edges': [list(e) for e in sorted(self.edges)],
            },
        }
