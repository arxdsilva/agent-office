"""Wing themes (plan §2.7) and the material palette every module builds from.

All six wing themes share one builder (identical anchors and nav); they differ in materials, accent
lights and decor flags. `HOUSE` is the neutral palette of the shared spaces (atrium, street, garden, cap).
"""
from lib import materials as M

ORDER = ['terracotta', 'nordic', 'forest', 'ocean', 'neon', 'brass']

THEMES = {
    'terracotta': dict(
        sign='#F4EDE4', accent='#D97757',
        floor=('herringbone_parquet', '#ffffff', 0.62, 1.6),
        wall='#F4EDE4', accent_wall='#D97757', trim='#2B2B2B', ceiling='#EFEBE5',
        felt=['#D97757', '#E9C9B0', '#B5553A'], fabric=['#C8643F', '#E8DCCB', '#7A8F6A', '#E4B07A'],
        rug='#B85C3E', leather='#9A5B3A', wood='oak_veneer_01', wood_tint='#ffffff', pot='#C26A48',
        kelvin=3500, accent_kelvin=2700, glow=None, metal='#2B2B2B',
        decor=dict(living_walls=1, hanging=False, neon=False, waves=False, brass=False, arcade=False, shelves=True),
    ),
    'nordic': dict(
        sign='#2E3440', accent='#5E81AC',
        floor=('laminate_floor_02', '#F4F1EC', 0.62, 2.0),
        wall='#F5F5F2', accent_wall='#D8DEE9', trim='#2E3440', ceiling='#F5F5F2',
        felt=['#C9CCD1', '#8FA3B5', '#4C566A'], fabric=['#D8D4CC', '#9AA8B5', '#4C566A', '#BFA98A'],
        rug='#B9BEC6', leather='#B89A78', wood='oak_veneer_01', wood_tint='#F3EEE6', pot='#F2F2EE',
        kelvin=4000, accent_kelvin=4000, glow=None, metal='#2E3440',
        decor=dict(living_walls=1, hanging=False, neon=False, waves=False, brass=False, arcade=False, shelves=True),
    ),
    'forest': dict(
        sign='#E8E2D0', accent='#3E6B48',
        floor=('wood_floor', '#8C7362', 0.62, 2.0),
        wall='#E8E2D0', accent_wall='#3E6B48', trim='#24302A', ceiling='#E8E2D0',
        felt=['#3E6B48', '#A9B38F', '#2F4A36'], fabric=['#556B4E', '#D9CDB4', '#8C6A4F', '#C9A86A'],
        rug='#6E7D58', leather='#7A4E32', wood='walnut_veneer', wood_tint='#ffffff', pot='#D9D2C2',
        kelvin=3500, accent_kelvin=3500, glow=None, metal='#24302A',
        decor=dict(living_walls=2, hanging=True, neon=False, waves=False, brass=False, arcade=False, shelves=True),
    ),
    'ocean': dict(
        sign='#EAF4F4', accent='#1F6F8B',
        floor=('smooth_concrete_floor', '#C3CDD0', 0.42, 2.5),
        wall='#EAF4F4', accent_wall='#1F6F8B', trim='#1D2B33', ceiling='#EEF4F4',
        felt=['#1F6F8B', '#7FB7C4', '#CFE3E6'], fabric=['#2E6E80', '#D4E3E3', '#E3B15E', '#7FB7C4'],
        rug='#3F7F91', leather='#C9A27A', wood='oak_veneer_01', wood_tint='#E9E4DC', pot='#EAF4F4',
        kelvin=5000, accent_kelvin=5000, glow=None, metal='#1D2B33',
        decor=dict(living_walls=1, hanging=False, neon=False, waves=True, brass=False, arcade=False, shelves=False),
    ),
    'neon': dict(
        sign='#2CB67D', accent='#7F5AF0',
        floor=('terrazzo_tiles', '#4A4A5C', 0.45, 1.5),
        wall='#1B1B2F', accent_wall='#2A2346', trim='#0E0E18', ceiling='#16162A',
        felt=['#2A2A44', '#7F5AF0', '#2CB67D'], fabric=['#7F5AF0', '#2CB67D', '#3A3A55', '#E5E5F0'],
        rug='#3B2F6B', leather='#3A3A55', wood='walnut_veneer', wood_tint='#B8B0C8', pot='#2A2A44',
        kelvin=4000, accent_kelvin=4000, glow=['#7F5AF0', '#2CB67D'], metal='#0E0E18',
        decor=dict(living_walls=1, hanging=False, neon=True, waves=False, brass=False, arcade=True, shelves=False),
    ),
    'brass': dict(
        sign='#C8A45D', accent='#C8A45D',
        floor=('poly_wool_herringbone', '#5A5A5C', 0.9, 1.2),
        wall='#3A3836', accent_wall='#2B2B2B', trim='#1E1E1E', ceiling='#2E2D2B',
        felt=['#3A3A3A', '#6B2E2E', '#C8A45D'], fabric=['#6B2E2E', '#C8A45D', '#3C4A3E', '#D9CBB3'],
        rug='#5E2A2A', leather='#8B5A2B', wood='walnut_veneer', wood_tint='#ffffff', pot='#1E1E1E',
        kelvin=3000, accent_kelvin=2700, glow=None, metal='#1E1E1E',
        decor=dict(living_walls=1, hanging=False, neon=False, waves=False, brass=True, arcade=False, shelves=True),
    ),
}

HOUSE = dict(
    sign='#F4EDE4', accent='#E07A5F',
    floor=('concrete_wall_008', '#F3F1EC', 0.42, 3.5),
    wall='#F2EFEA', accent_wall='#E07A5F', trim='#1E1E1E', ceiling='#F2F0EC',
    felt=['#E07A5F', '#3D5A80', '#F2CC8F'], fabric=['#E07A5F', '#3D5A80', '#81B29A', '#F2CC8F', '#E8E1D6'],
    rug='#3D5A80', leather='#8B5A2B', wood='oak_veneer_01', wood_tint='#ffffff', pot='#E9E4DA',
    kelvin=4000, accent_kelvin=3000, glow=None, metal='#1E1E1E',
    decor=dict(living_walls=1, hanging=True, neon=False, waves=False, brass=False, arcade=True, shelves=True),
)


def palette(t):
    """Create the module's materials from a theme dict; returns {key: material name}."""
    ftex, ftint, frough, ftile = t['floor']
    P = {}

    def add(key, name, **kw):
        P[key] = M.pbr(name, **kw).name

    add('floor', 'floor', tex=ftex, base=ftint, rough=frough, tile=ftile, normal=0.8)
    add('wall', 'paint-wall', base=t['wall'], rough=0.88)
    add('accent', 'plaster-accent', tex='white_plaster_02', base=t['accent_wall'], rough=0.85, tile=3.0, normal=0.4)
    add('concrete', 'concrete', tex='concrete_wall_008', base='#d9d6d0', rough=0.8, tile=3.0, normal=0.6)
    add('wood', 'wood', tex=t['wood'], base=t['wood_tint'], rough=0.42, tile=1.2, normal=0.4, coat=0.0)
    add('wood_dark', 'wood-dark', tex='walnut_veneer', base='#ffffff', rough=0.4, tile=1.2, normal=0.4)
    add('fabric', 'fabric', tex='cotton_jersey', base='#ffffff', rough=0.9, tile=0.6, normal=0.6, vcol=True)
    add('felt', 'felt', tex='poly_wool_herringbone', base='#ffffff', rough=0.95, tile=0.8, normal=0.5, vcol=True)
    add('leather', 'leather', tex='leather_white', base=t['leather'], rough=0.45, tile=0.6, normal=0.5)
    add('tile', 'tile', tex='long_white_tiles', base='#ffffff', rough=0.2, tile=0.6, normal=0.6)
    add('metal', 'metal-dark', base=t['metal'], rough=0.38, metal=0.85)
    add('steel', 'steel', base='#c9cbcc', rough=0.28, metal=1.0)
    add('brass', 'brass', base='#C8A45D', rough=0.3, metal=1.0)
    add('white', 'powder-white', base='#f1f0ec', rough=0.45)
    add('paint', 'paint', base='#ffffff', rough=0.5, vcol=True)
    add('gloss', 'gloss', base='#ffffff', rough=0.18, vcol=True, spec=0.6)
    add('leaf', 'foliage', base='#ffffff', rough=0.55, vcol=True, double_sided=True, spec=0.35)
    add('soil', 'soil', base='#3a2c22', rough=1.0)
    add('stone', 'quartz', base='#efeeea', rough=0.22, spec=0.6)
    add('ceiling', 'ceiling', base=t['ceiling'], rough=0.92)
    add('black', 'black-glass', base='#0c0d0f', rough=0.12, spec=0.7)
    add('light', 'light-panel', base='#ffffff', emission='#f4f6f8', strength=1.4)
    add('light_warm', 'light-warm', base='#fff4e6', emission='#ffd9a8', strength=1.4)
    if t.get('glow'):
        for i, c in enumerate(t['glow']):
            P[f'glow{i}'] = M.pbr(f'glow-{i}', base=c, emission=c, strength=2.2, bake_emit=True).name
    P['glow_accent'] = M.pbr('glow-accent', base=t['accent'], emission=t['accent'], strength=1.5, bake_emit=True).name
    P['glass'] = M.glass().name
    P['screen'] = M.pbr('screen', base='#0b0d12', rough=0.2, emission='#1a2a3a', strength=1.0).name
    P['led'] = M.pbr('led', base='#202020', rough=0.4, emission='#5a6470', strength=2.0).name
    P['sign'] = M.pbr('sign', base=t['accent'], rough=0.6).name
    P['door'] = M.pbr('elevator-door', base='#b9bcbe', rough=0.3, metal=1.0).name
    return P
