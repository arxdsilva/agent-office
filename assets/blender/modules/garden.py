"""Indoor garden, same footprint as a wing (x ∈ [0, 24], z ∈ [−9, 9], door at (0, 0)): fills an empty side
of a bay. A glass roof over planting beds, a reflecting pool, a looping path with benches; 6 garden spots."""
import math

from lib import furniture as F
from lib.geometry import curtain_wall, glass_partition, wall

H = 3.6


def build(g, A, P, name, t, rng):
    # floor: stone path field; beds and pool sit on top
    g.plane_y(P['floor'], 0, 24, -9, 9, 0.0)
    # street wall: glass storefront with a wide opening at the door
    wall(g, P['wall'], (0, -9), (0, 9), H, thick=0.15, side=-1, openings=[(0.6, 7.4, 0, 2.9), (7.4, 10.6, 0, 2.9),
                                                                          (10.6, 17.4, 0, 2.9)])
    glass_partition(g, P, (0.08, -8.4), (0.08, -1.6), h=2.9, spacing=1.36)
    glass_partition(g, P, (0.08, 1.6), (0.08, 8.4), h=2.9, spacing=1.36)
    for z in (-1.6, 1.6):
        g.box_b(P['metal'], -0.04, 0.19, 0, 2.9, z - 0.05, z + 0.05, bevel=0.004)
    wall(g, P['wall'], (0, -9), (24, -9), H, thick=0.15, side=1)
    wall(g, P['wall'], (0, 9), (24, 9), H, thick=0.15, side=-1)
    curtain_wall(g, P, (24, -9), (24, 9), H, spacing=1.5, transoms=(2.95,), thick=0.14, side=1)
    g.collider(-0.05, 0.15, -9, -1.6, 0, H)
    g.collider(-0.05, 0.15, 1.6, 9, 0, H)
    g.collider(23.8, 24.2, -9, 9, 0, H)
    g.collider(0, 24, -9.1, -8.85, 0, H)
    g.collider(0, 24, 8.85, 9.1, 0, H)

    # glass roof: perimeter ceiling band + steel grid + glazing
    with g.in_group('ceiling'):
        g.plane_y(P['ceiling'], 0, 24, -9, -7.2, H, up=False)
        g.plane_y(P['ceiling'], 0, 24, 7.2, 9, H, up=False)
        g.plane_y(P['ceiling'], 0, 1.5, -7.2, 7.2, H, up=False)
        g.plane_y(P['ceiling'], 22.5, 24, -7.2, 7.2, H, up=False)
        for k in range(8):
            x = 1.5 + k * 3.0
            g.box_b(P['metal'], x - 0.06, x + 0.06, H - 0.3, H, -7.2, 7.2, bevel=0.004)
        for z in (-7.2, -3.6, 0.0, 3.6, 7.2):
            g.box_b(P['metal'], 1.5, 22.5, H - 0.15, H, z - 0.04, z + 0.04, bevel=0.003)
    with g.in_group('glass'):
        g.box_b(P['glass'], 1.5, 22.5, H, H + 0.01, -7.2, 7.2, bevel=0)

    # living walls on both long walls
    with g.at(1.0, -8.85):
        F.living_wall(g, P, 7.0, 2.6, rng, y0=0.4, density=0.85)
    with g.at(23.0, 8.85, math.pi):
        F.living_wall(g, P, 7.0, 2.6, rng, y0=0.4, density=0.85)

    # reflecting pool with a stone rim
    px0, px1, pz0, pz1 = 8.5, 15.5, -1.6, 1.6
    for (a, b, c, d) in ((px0 - 0.3, px1 + 0.3, pz0 - 0.3, pz0), (px0 - 0.3, px1 + 0.3, pz1, pz1 + 0.3),
                         (px0 - 0.3, px0, pz0, pz1), (px1, px1 + 0.3, pz0, pz1)):
        g.box_b(P['stone'], a, b, 0, 0.42, c, d, bevel=0.01, segs=2)
    g.box_b(P['black'], px0, px1, 0, 0.34, pz0, pz1, bevel=0)
    g.collider(px0 - 0.3, px1 + 0.3, pz0 - 0.3, pz1 + 0.3, 0, 0.42)
    for k in range(5):  # stepping lily pads / floating planters
        F.bush(g, P, (px0 + 1.0 + k * 1.25, 0.34, rng.uniform(-0.8, 0.8)), 0.25, 0.15, rng, n=10)

    # planting beds (raised, wood-rimmed) with trees
    beds = [(3.0, 7.5, -7.6, -4.6), (9.0, 15.0, -7.6, -4.6), (16.5, 21.5, -7.6, -4.6),
            (3.0, 7.5, 4.6, 7.6), (9.0, 15.0, 4.6, 7.6), (16.5, 21.5, 4.6, 7.6)]
    for (x0, x1, z0, z1) in beds:
        with g.at((x0 + x1) / 2, (z0 + z1) / 2):
            F.planter(g, P, x1 - x0, z1 - z0, 0.45, rng, kind='mixed', color='#3a3a3a', density=1.4, rim='wood')
        for k in range(2):
            F.tree(g, P, (rng.uniform(x0 + 0.8, x1 - 0.8), 0.43, rng.uniform(z0 + 0.6, z1 - 0.6)),
                   rng.uniform(2.4, 3.0), rng, crown=0.95, leaf_size=0.22)
        g.collider(x0, x1, z0, z1, 0, 0.5)
    # benches facing the pool
    for x in (10.0, 14.0):
        for s in (-1, 1):
            z = s * 2.75
            g.box_b(P['wood'], x - 0.9, x + 0.9, 0.42, 0.47, z - 0.22, z + 0.22, bevel=0.006, segs=2)
            for dx in (-0.7, 0.7):
                g.box_b(P['metal'], x + dx - 0.03, x + dx + 0.03, 0, 0.42, z - 0.18, z + 0.18, bevel=0.003)
            g.collider(x - 0.9, x + 0.9, z - 0.22, z + 0.22, 0, 0.47)
    # sun + warm uplights on the trees
    for (x0, x1, z0, z1) in beds:
        g.light('point', ((x0 + x1) / 2, 0.6, (z0 + z1) / 2), radius=0.2, power=20, kelvin=3000)
    for x in (4.5, 12.0, 19.5):
        g.light('panel', (x, H - 0.05, -8.1), size=(5.0, 0.6), power=90, kelvin=3500)
        g.light('panel', (x, H - 0.05, 8.1), size=(5.0, 0.6), power=90, kelvin=3500)

    # nav: a loop around the pool, entering from the door
    A.node('g:door', 0, 0, 1.4)
    A.node('g:in', 3.5, 0, 1.2)
    A.node('g:out', 20.5, 0, 1.2)
    north = [('g:n1', 7.0, 3.3), ('g:n2', 12.0, 3.5), ('g:n3', 17.5, 3.3)]
    south = [('g:s1', 7.0, -3.3), ('g:s2', 12.0, -3.5), ('g:s3', 17.5, -3.3)]
    for nid, x, z in north + south:
        A.node(nid, x, z, 0.9)
    A.chain('g:door', 'g:in')
    A.chain('g:in', *[n for n, _, _ in north], 'g:out')
    A.chain('g:in', *[n for n, _, _ in south], 'g:out')
    A.node('g:w', 7.6, 0, 0.6)
    A.chain('g:in', 'g:w')
    spots = [(6.0, 3.6, 0.0, 'g:n1'), (12.0, 3.9, 0.0, 'g:n2'), (19.0, 3.6, 0.0, 'g:n3'),
             (6.0, -3.6, math.pi, 'g:s1'), (12.0, -3.9, math.pi, 'g:s2'), (19.0, -3.6, math.pi, 'g:s3')]
    for i, (x, z, h, hub) in enumerate(spots):
        A.spot(f'spot:garden:{i}', x, z, h, room='garden', approach=-0.35, hubs=[hub])
    return dict(
        bounds={'minX': 0, 'maxX': 24, 'minZ': -9, 'maxZ': 9},
        sky=dict(sun_dir=(0.45, 0.8, 0.35), sun_strength=3.2, sky_strength=0.45),
        previews=[
            ('view', (1.2, 1.7, 0.4), (16.0, 1.0, -1.5), 18, False),
            ('top', (-5.0, 15.0, -14.0), (12.0, 0.0, 0.0), 22, True),
        ],
    )


def context(g, P):
    g.box_b(P['floor'], -6, 0, -0.05, 0, -9, 9, bevel=0)
    g.box_b(P['ceiling'], -6, 0, H, H + 0.05, -9, 9, bevel=0)
    g.box_b(P['wall'], -6.15, -6, 0, H, -9, 9, bevel=0)
    g.box_b(P['paint'], 24.2, 80, -0.6, -0.5, -40, 40, bevel=0, color='#7d8466')
