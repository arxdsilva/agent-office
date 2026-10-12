"""End of the building, x ∈ [−27, 27], z ∈ [0, 0.5]: a floor-to-ceiling window closes Main Street, the
rest is the exterior skin behind the last wings. Outside: a strip of landscaping seen through the glass."""
import math

from lib import furniture as F
from lib.geometry import curtain_wall

H = 3.6


def build(g, A, P, name, t, rng):
    g.plane_y(P['floor'], -3, 3, 0, 0.5, 0.0)
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], -3, 3, 0, 0.5, H, up=False)
    curtain_wall(g, P, (-3, 0.5), (3, 0.5), H, spacing=1.5, transoms=(2.95,), thick=0.12, side=-1)
    # exterior skin behind the last wings (never seen from inside)
    for x0, x1 in ((-27, -3), (3, 27)):
        g.box_b(P['concrete'], x0, x1, -0.1, H + 0.4, 0.38, 0.5, bevel=0.01)
    g.box_b(P['concrete'], -27, 27, H, H + 0.4, 0.38, 0.62, bevel=0.01)
    g.collider(-3, 3, 0.35, 0.6, 0, H)
    # landscaping outside the window
    g.box_b(P['paint'], -12, 12, -0.15, -0.05, 0.62, 14, bevel=0, color='#6f7d4f')
    g.box_b(P['concrete'], -3.5, 3.5, -0.08, -0.02, 0.62, 6, bevel=0)
    for x, z, h in ((-6.5, 4.0, 4.5), (5.5, 5.5, 5.2), (-1.5, 9.5, 5.0), (9.0, 10.5, 4.6), (-9.5, 10.0, 4.8)):
        F.tree(g, P, (x, -0.05, z), h, rng, crown=1.6, leaf_size=0.35, n=140)
    for x in (-8.5, -4.8, 4.2, 8.0):
        F.bush(g, P, (x, -0.05, 2.2), 0.6, 0.6, rng, n=40, leaf_len=0.3, leaf_w=0.12)
    A.node('c:0', 0, 0, 1.4)
    A.node('c:w', -2, 0, 0.8)
    A.node('c:e', 2, 0, 0.8)
    A.chain('c:w', 'c:0', 'c:e')
    return dict(
        bounds={'minX': -27, 'maxX': 27, 'minZ': 0, 'maxZ': 0.5},
        sky=dict(sun_dir=(0.4, 0.7, 0.6), sun_strength=3.0, sky_strength=0.4),
        previews=[('window', (0.4, 1.65, -9.0), (0.0, 1.5, 4.0), 22, False)],
    )


def context(g, P):
    """The last street bay in front of the window."""
    g.box_b(P['floor'], -3, 3, -0.05, 0, -18, 0, bevel=0)
    g.box_b(P['ceiling'], -3, 3, H, H + 0.05, -18, 0, bevel=0)
    for x in (-3.15, 3.0):
        g.box_b(P['wall'], x, x + 0.15, 0, H, -18, 0.5, bevel=0)
    for z in (-15, -9, -3):
        g.light('panel', (0, H - 0.06, z), size=(1.2, 4.0), power=120, kelvin=4000)
