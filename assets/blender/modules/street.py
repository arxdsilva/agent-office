"""Main Street bay, x ∈ [−3, 3], z ∈ [0, 18] (one per bay). Wings/gardens own the side walls; their doors
meet the street nodes at (±3, 9). A skylight runs down the middle; planters with benches line both sides.
"""
import math

from lib import furniture as F

H = 3.6


def build(g, A, P, name, t, rng):
    # floor + timber boardwalk down the middle
    g.plane_y(P['floor'], -3, 3, 0, 18, 0.0)
    g.box_b(P['wood'], -1.5, 1.5, 0.0, 0.012, 0.15, 17.85, bevel=0.003)
    for x in (-1.56, 1.56):
        g.box_b(P['metal'], x - 0.03, x + 0.03, 0.0, 0.014, 0.15, 17.85, bevel=0)

    # ceiling with a central skylight well
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], -3, -1.2, 0, 18, H, up=False)
        g.plane_y(P['ceiling'], 1.2, 3, 0, 18, H, up=False)
        g.plane_y(P['ceiling'], -1.2, 1.2, 0, 0.8, H, up=False)
        g.plane_y(P['ceiling'], -1.2, 1.2, 17.2, 18, H, up=False)
        for x in (-1.2, 1.2):
            g.box_b(P['ceiling'], x - 0.05, x + 0.05, H, H + 0.7, 0.8, 17.2, bevel=0.004)
        for z in (0.8, 17.2):
            g.box_b(P['ceiling'], -1.25, 1.25, H, H + 0.7, z - 0.05, z + 0.05, bevel=0.004)
        for k in range(17):
            z = 0.8 + k * (16.4 / 16)
            g.box_b(P['metal'], -1.2, 1.2, H + 0.62, H + 0.7, z - 0.03, z + 0.03, bevel=0.003)
        for x in (-2.25, 2.25):  # recessed linear light lines
            g.box_b(P['light'], x - 0.05, x + 0.05, H - 0.01, H - 0.005, 0.3, 17.7, bevel=0)
    with g.in_group('roofglass'):
        g.box_b(P['glass'], -1.2, 1.2, H + 0.7, H + 0.71, 0.8, 17.2, bevel=0)
    for x in (-2.25, 2.25):
        for z in (3.0, 9.0, 15.0):
            g.light('panel', (x, H - 0.03, z), size=(0.15, 5.6), power=70, kelvin=t['kelvin'])

    # planters with benches (keep z ∈ [7.6, 10.4] clear for the wing doors)
    for s in (-1, 1):
        for (z0, z1) in ((1.2, 7.0), (11.0, 16.8)):
            zc, L = (z0 + z1) / 2, z1 - z0
            with g.at(s * 2.45, zc, math.pi / 2):
                F.planter(g, P, L, 0.9, 0.5, rng, kind='mixed', color='#2f2f2f', density=2.6)
            # small tree in each planter
            F.tree(g, P, (s * 2.5, 0.48, zc + rng.uniform(-1.2, 1.2)), 2.3, rng, crown=0.75, leaf_size=0.2)
            # bench on the inner face
            g.furn('bench', 0.42, L - 0.6, x=s * 1.77, z=zc)
            g.box_b(P['wood'], s * 1.77 - 0.21, s * 1.77 + 0.21, 0.42, 0.47, z0 + 0.3, z1 - 0.3, bevel=0.006, segs=2)
            g.box_b(P['metal'], s * 1.77 - 0.17, s * 1.77 + 0.17, 0.0, 0.42, z0 + 0.5, z0 + 0.56, bevel=0.003)
            g.box_b(P['metal'], s * 1.77 - 0.17, s * 1.77 + 0.17, 0.0, 0.42, z1 - 0.56, z1 - 0.5, bevel=0.003)
            g.collider(min(s * 1.55, s * 2.9), max(s * 1.55, s * 2.9), z0, z1, 0, 0.6)
            g.light('point', (s * 2.45, 0.7, zc), radius=0.3, power=12, kelvin=3000)

    g.room('street', 'Main Street', -3, 0, 3, 18, floor='wood')
    # nav: spine + connectors (contract §3)
    A.node('s:0', 0, 0, 1.6)
    A.node('s:a', 0, 4.5, 1.4)
    A.node('s:mid', 0, 9, 1.6)
    A.node('s:b', 0, 13.5, 1.4)
    A.node('s:end', 0, 18, 1.6)
    A.node('s:L', -3, 9, 1.0)
    A.node('s:R', 3, 9, 1.0)
    A.chain('s:0', 's:a', 's:mid', 's:b', 's:end')
    A.edge('s:mid', 's:L')
    A.edge('s:mid', 's:R')

    return dict(
        bounds={'minX': -3, 'maxX': 3, 'minZ': 0, 'maxZ': 18},
        foliage_inset=0.02,
        extra={'bayLength': 18, 'width': 6},
        sky=dict(sun_dir=(0.35, 0.85, 0.4), sun_strength=3.0, sky_strength=0.4),
        previews=[
            ('view', (0.6, 1.65, 0.4), (-0.2, 1.3, 14.0), 18, False),
            ('top', (6.5, 9.0, -3.0), (0.0, 0.0, 9.0), 22, True),
        ],
    )


def context(g, P):
    """Neighbouring wing walls (with their door openings) and a slice of the wing interiors behind them,
    so the bake sees a closed street."""
    for s in (-1, 1):
        x0, x1 = (3.0, 3.15) if s > 0 else (-3.15, -3.0)
        g.box_b(P['wall'], x0, x1, 0, H, 0, 7.8, bevel=0)
        g.box_b(P['wall'], x0, x1, 0, H, 10.2, 18, bevel=0)
        g.box_b(P['wall'], x0, x1, 2.7, H, 7.8, 10.2, bevel=0)
        xa, xb = (3.15, 9.0) if s > 0 else (-9.0, -3.15)
        g.box_b(P['floor'], xa, xb, -0.05, 0, 0, 18, bevel=0)
        g.box_b(P['ceiling'], xa, xb, H, H + 0.05, 0, 18, bevel=0)
        g.light('panel', (s * 6, H - 0.06, 9), size=(2, 2), power=160, kelvin=4000)
