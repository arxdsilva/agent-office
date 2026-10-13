"""Wing themes (plan §2.7) and the material palette every module builds from.

All six wing themes share one builder (identical anchors and nav); they differ in materials, accent
lights and decor flags. `HOUSE` is the neutral palette of the shared spaces (atrium, street, garden, cap).

Two asset sets (contract §14) use the same theme ids: Classic (`THEMES`, `HOUSE`) and Horizon (`HORIZON`,
`HORIZON_HOUSE`: the same office in a bright, calm near-future palette). Keys a Classic theme leaves out
are read with their Classic value as the default, so adding an optional key never changes Classic output:

  glass_dark, screen_base, led_color   colours of the black-glass, screen and LED materials
  light_strength                       emission strength of the light-panel materials
  emit_max                             cap on every emissive strength (Horizon: ≤ 1.5× white)
  planter, chair_dark, pendant, game_floor, arcade_body, mural_dark, tech_floor, tech_felt, hub_floor,
  handoff_floor                        colours the module scripts used to hard-code (dark in Classic)
  light_scale, sky_scale               multipliers on the module's lamp powers and sky/sun (build.py)
  library_wood                         the Library floor's material key (Classic 'wood_dark')
  flat                                 material keys that keep only their texture's relief (normal map) and
                                       take their colour from the palette alone (Horizon: pale floors, felt)

Optional decor flags (default off): cove_lights, wayfinding, elevator_glow, kiosk_ring.
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

# ------------------------------------------------------------------------------- Horizon (contract §14)
# A bright near-future HQ on a clear day: warm whites, pearl greys, light wood, one soft accent per wing,
# light grey metal (never black), and light lines only where they help (cove lines, wayfinding, elevator
# frames, the kiosk ring). docs/horizon/art-direction.md.
_H_DARK = dict(
    glass_dark='#DCE4E8', screen_base='#3A4652', led_color='#9AA4AD', light_strength=1.4, emit_max=1.4,
    chair_dark='#C9D1D8', pendant='#F2F2EF', game_floor='#D3E6EE', arcade_body='#E6E8EF', mural_dark='#9AA4AD',
    tech_floor='#E6EAED', tech_felt='#D3D9DE', hub_floor='#DCEBEC', handoff_floor='#ECE5DA',
    light_scale=1.25, sky_scale=1.6, flat=('floor', 'accent', 'felt'), library_wood='wood',
)
_H_DECOR = dict(living_walls=1, hanging=False, neon=False, waves=False, brass=False, arcade=False, shelves=True,
                cove_lights=True, wayfinding=False, elevator_glow=False, kiosk_ring=False)


def _h(accent, sign, floor, felt, fabric, kelvin, **kw):
    t = dict(
        sign=sign, accent=accent, floor=floor,
        wall='#F7F7F4', accent_wall=kw.pop('accent_wall'), trim='#B5BEC6', ceiling='#FBFBF9',
        felt=felt, fabric=fabric, rug=kw.pop('rug'), leather=kw.pop('leather', '#D8C3A5'),
        wood=kw.pop('wood', 'oak_veneer_01'), wood_tint=kw.pop('wood_tint', '#FFFFFF'), pot='#FFFFFF',
        kelvin=kelvin, accent_kelvin=kw.pop('accent_kelvin', kelvin - 500), glow=None, metal='#9AA4AD',
        planter='#EEF0F1', **_H_DARK,
    )
    t['decor'] = dict(_H_DECOR, **kw.pop('decor', {}))
    assert not kw, kw
    return t


HORIZON = {
    'terracotta': _h('#F5B79A', '#6B3A27', ('herringbone_parquet', '#E4DACD', 0.45, 1.6),
                     ['#F5B79A', '#F3E5D8', '#E7CDBD'], ['#F2C4AE', '#F6EEE4', '#D9CFC6', '#F0D9B5'], 4000,
                     accent_wall='#FBE3D6', rug='#F1DDD0'),
    'nordic': _h('#8EC9F0', '#244A63', ('laminate_floor_02', '#E6E8E5', 0.5, 2.0),
                 ['#DCE9F3', '#B8D9EF', '#C9D2DA'], ['#E8EEF2', '#B9D9EF', '#CBD4DC', '#E6DCCB'], 4500,
                 accent_wall='#E3F1FA', rug='#E4EBF0', wood_tint='#FBF8F3'),
    'forest': _h('#A9C9A0', '#304A2B', ('oak_veneer_01', '#E2DDD0', 0.5, 2.0),
                 ['#A9C9A0', '#E8E9DE', '#CFDDC6'], ['#BCD5B3', '#EFEDE3', '#D6CFC0', '#E3D7B8'], 4000,
                 accent_wall='#E6F0E1', rug='#E2E8D9', decor=dict(living_walls=2, hanging=True)),
    'ocean': _h('#7FD8C4', '#1F5A4E', ('concrete_wall_008', '#E1E9E9', 0.32, 2.5),
                ['#7FD8C4', '#D9F1EC', '#EAF6F4'], ['#A9E4D7', '#EDF5F4', '#F1DCB0', '#C6E9E1'], 5000,
                accent_wall='#DDF4EE', rug='#DDEFEB', wood_tint='#FBF8F3', decor=dict(waves=True, shelves=False)),
    'neon': _h('#B9A8F0', '#3E3270', ('terrazzo_tiles', '#E5E5EE', 0.35, 1.5),
               ['#E4DEFA', '#B9A8F0', '#D3CCEB'], ['#C9BDF4', '#EEEDF6', '#D6D9EA', '#F4F0FA'], 4500,
               accent_wall='#ECE7FC', rug='#E7E3F4', decor=dict(shelves=False)),
    'brass': _h('#E2C27A', '#5C4716', ('poly_wool_herringbone', '#E7E0D2', 0.9, 1.2),
                ['#F0E6CF', '#E9D6A8', '#E2C27A'], ['#EBD9AE', '#F7F1E4', '#D9D2C2', '#F1E3C2'], 3800,
                accent_wall='#F7EDD6', rug='#EFE5CF', leather='#E3CFAE', accent_kelvin=3300),
}

HORIZON_HOUSE = dict(
    sign='#244A44', accent='#6CCFC0',
    floor=('concrete_wall_008', '#DCE1E3', 0.3, 3.5),
    wall='#F7F7F4', accent_wall='#D6F0EB', trim='#B5BEC6', ceiling='#FBFBF9',
    felt=['#6CCFC0', '#C9D3DA', '#E8ECEF'], fabric=['#A9DFD5', '#E3E8EC', '#C3DCCF', '#F1E6CF', '#F4F4F1'],
    rug='#DCE6EA', leather='#D8C3A5', wood='oak_veneer_01', wood_tint='#FFFFFF', pot='#FFFFFF',
    kelvin=4500, accent_kelvin=3500, glow=None, metal='#9AA4AD', planter='#EEF0F1', **_H_DARK,
    decor=dict(living_walls=1, hanging=True, neon=False, waves=False, brass=False, arcade=False, shelves=True,
               cove_lights=True, wayfinding=True, elevator_glow=True, kiosk_ring=True),
)

def theme_for(asset_set, kind, name):
    """The theme dict a module of `asset_set` builds with: the wing theme `name`, or the house palette."""
    if asset_set == 'horizon':
        return HORIZON[name] if kind == 'wing' else HORIZON_HOUSE
    if asset_set != 'classic':
        raise ValueError(f'unknown asset set {asset_set!r}')
    return THEMES[name] if kind == 'wing' else HOUSE


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
    flat = t.get('flat', ())

    def add(key, name, **kw):
        if key in flat:
            kw['albedo'] = False
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
    add('black', 'black-glass', base=t.get('glass_dark', '#0c0d0f'), rough=0.12, spec=0.7)
    light = emit(t, t.get('light_strength', 1.4))
    add('light', 'light-panel', base='#ffffff', emission='#f4f6f8', strength=light)
    add('light_warm', 'light-warm', base='#fff4e6', emission='#ffd9a8', strength=light)
    if t.get('glow'):
        for i, c in enumerate(t['glow']):
            P[f'glow{i}'] = M.pbr(f'glow-{i}', base=c, emission=c, strength=emit(t, 2.2), bake_emit=True).name
    P['glow_accent'] = M.pbr('glow-accent', base=t['accent'], emission=t['accent'], strength=emit(t, 1.5),
                             bake_emit=True).name
    P['glass'] = M.glass().name
    P['screen'] = M.pbr('screen', base=t.get('screen_base', '#0b0d12'), rough=0.2, emission='#1a2a3a', strength=1.0).name
    P['led'] = M.pbr('led', base='#202020', rough=0.4, emission=t.get('led_color', '#5a6470'), strength=emit(t, 2.0)).name
    P['sign'] = M.pbr('sign', base=t['accent'], rough=0.6).name
    P['door'] = M.pbr('elevator-door', base='#b9bcbe', rough=0.3, metal=1.0).name
    d = t['decor']
    if d.get('cove_lights') or d.get('wayfinding') or d.get('elevator_glow') or d.get('kiosk_ring'):
        # Horizon light lines (contract §14): a soft accent tint, lit into the bake, ≤ 1.4× white.
        P['line'] = M.pbr('light-line', base=t['accent'], emission=t['accent'], strength=emit(t, 1.2),
                          bake_emit=True).name
    return P


def emit(t, strength):
    """An emission strength, capped by the theme's optional `emit_max` (Horizon: calm light lines)."""
    cap = t.get('emit_max')
    return strength if cap is None else min(strength, cap)
