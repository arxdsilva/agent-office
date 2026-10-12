"""PBR materials that survive the glTF exporter.

Only Principled BSDF inputs fed by constants, image textures, `Mix(MULTIPLY)` by a constant (→ factor),
`Separate Color` of an ARM map, `Normal Map` and `Color Attribute` export to glTF metallic-roughness;
procedural nodes do not, so this module never uses them.

Every material records its world-space texture tile size (meters per UV unit) in `TILE`, which
geometry.world_uvs() uses for the UV0 box projection.
"""
import bpy

from . import textures

TILE = {}
VCOL = {}
BAKE_EMIT = {}  # emissive materials whose emission also lights the bake (accent strips, LEDs)
_cache = {}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    """'#D97757' → linear RGB tuple."""
    h = h.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def rgba(c):
    if isinstance(c, str):
        c = hex_rgb(c)
    return (c[0], c[1], c[2], 1.0)


def reset():
    TILE.clear()
    VCOL.clear()
    BAKE_EMIT.clear()
    _cache.clear()


def get(name):
    return _cache[name]


def exists(name):
    return name in _cache


def pbr(name, base='#cccccc', rough=0.5, metal=0.0, tex=None, tile=2.0, normal=1.0, vcol=False,
        emission=None, strength=0.0, alpha=None, double_sided=False, spec=0.5, rough_tex=False,
        coat=0.0, bake_emit=False):
    """Create (once) a Principled material.

    base:     hex/linear color; with `tex` it multiplies the albedo map (exported as baseColorFactor).
    tex:      Poly Haven id; uses diff, nor_gl and (when `rough_tex`) the ARM map's roughness channel.
    vcol:     multiply base color by the 'Col' color attribute (exported as COLOR_0).
    emission: hex color; `strength` is exported through KHR_materials_emissive_strength.
    alpha:    < 1 makes a blended, double-sided material (glass).
    """
    if name in _cache:
        return _cache[name]
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    out = nt.nodes.get('Material Output')
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Specular IOR Level'].default_value = spec
    if coat:
        p.inputs['Coat Weight'].default_value = coat
    color_socket = p.inputs['Base Color']
    x = -300
    if tex:
        maps = textures.polyhaven(tex)
        img = nt.nodes.new('ShaderNodeTexImage')
        img.image = maps['diff']
        img.location = (x - 500, 300)
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs['B'].default_value = rgba(base)
        mix.location = (x - 200, 300)
        nt.links.new(img.outputs['Color'], mix.inputs['A'])
        if vcol:
            va = nt.nodes.new('ShaderNodeVertexColor')
            va.layer_name = 'Col'
            va.location = (x - 500, 600)
            mix2 = nt.nodes.new('ShaderNodeMix')
            mix2.data_type = 'RGBA'
            mix2.blend_type = 'MULTIPLY'
            mix2.inputs['Factor'].default_value = 1.0
            mix2.location = (x - 100, 450)
            nt.links.new(mix.outputs['Result'], mix2.inputs['A'])
            nt.links.new(va.outputs['Color'], mix2.inputs['B'])
            nt.links.new(mix2.outputs['Result'], color_socket)
        else:
            nt.links.new(mix.outputs['Result'], color_socket)
        if maps['nor_gl'] is not None and normal > 0:
            n_img = nt.nodes.new('ShaderNodeTexImage')
            n_img.image = maps['nor_gl']
            n_img.location = (x - 500, -300)
            nm = nt.nodes.new('ShaderNodeNormalMap')
            nm.inputs['Strength'].default_value = normal
            nm.location = (x - 200, -300)
            nt.links.new(n_img.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
        if maps['arm'] is not None and rough_tex:
            a_img = nt.nodes.new('ShaderNodeTexImage')
            a_img.image = maps['arm']
            a_img.location = (x - 700, 0)
            sep = nt.nodes.new('ShaderNodeSeparateColor')
            sep.location = (x - 400, 0)
            nt.links.new(a_img.outputs['Color'], sep.inputs['Color'])
            mul = nt.nodes.new('ShaderNodeMath')
            mul.operation = 'MULTIPLY'
            mul.inputs[1].default_value = rough / 0.5  # the ARM maps average ≈ 0.5
            mul.location = (x - 200, 0)
            nt.links.new(sep.outputs['Green'], mul.inputs[0])
            nt.links.new(mul.outputs['Value'], p.inputs['Roughness'])
    elif vcol:
        va = nt.nodes.new('ShaderNodeVertexColor')
        va.layer_name = 'Col'
        va.location = (x - 500, 300)
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs['B'].default_value = rgba(base)
        mix.location = (x - 200, 300)
        nt.links.new(va.outputs['Color'], mix.inputs['A'])
        nt.links.new(mix.outputs['Result'], color_socket)
    else:
        color_socket.default_value = rgba(base)
    if emission:
        p.inputs['Emission Color'].default_value = rgba(emission)
        p.inputs['Emission Strength'].default_value = strength
    if alpha is not None and alpha < 1.0:
        p.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
        double_sided = True
    m.use_backface_culling = not double_sided
    TILE[name] = tile
    VCOL[name] = bool(vcol)
    BAKE_EMIT[name] = bool(emission) and bake_emit
    _cache[name] = m
    out.location = (300, 0)
    return m


def glass(name='glass', tint='#dfe9ea', alpha=0.16, rough=0.04):
    return pbr(name, base=tint, rough=rough, alpha=alpha, spec=0.6)


def emissive(name, color, strength, base='#ffffff', bake_emit=False):
    return pbr(name, base=base, rough=0.6, emission=color, strength=strength, bake_emit=bake_emit)


def collider():
    return pbr('collider', base='#ff00ff', rough=1.0)
