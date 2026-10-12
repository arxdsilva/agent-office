"""Lights, sky, Cycles lightmap bake (Metal GPU), OIDN denoise and lightmap encoding (contract §6)."""
import math
import os
import struct
import time
import zlib

import bpy
import numpy as np
from mathutils import Euler, Vector

from . import materials
from .scene import GLTF_TO_BLENDER


def kelvin_rgb(k):
    """Approximate blackbody color (linear RGB, max channel 1) for 1000–12000 K."""
    t = k / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
        b = 255.0
    c = [max(0.0, min(255.0, v)) / 255.0 for v in (r, g, b)]
    c = [materials.srgb_to_linear(v) for v in c]
    m = max(c)
    # partially white-balanced (as a camera would be indoors): keep the warm/cool tint, not the full cast
    return tuple(0.45 * (v / m) + 0.55 for v in c)


def _b(p):
    return GLTF_TO_BLENDER @ Vector(p)


# ------------------------------------------------------------------------------------------ world
def setup_world(sun_dir=(0.5, -0.75, 0.42), sun_strength=3.0, sky_strength=0.35, sun_kelvin=5600):
    """Sky (multiple scattering) + a sun lamp. sun_dir is the glTF direction *towards* the sun."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('world')
    sc.world = world
    nt = world.node_tree
    bg = nt.nodes.get('Background')
    sky = nt.nodes.new('ShaderNodeTexSky')
    d = _b(sun_dir).normalized()
    try:
        sky.sky_type = 'MULTIPLE_SCATTERING'
    except TypeError:
        sky.sky_type = 'HOSEK_WILKIE'
    if hasattr(sky, 'sun_elevation'):
        sky.sun_elevation = math.asin(max(-1.0, min(1.0, d.z)))
        sky.sun_rotation = math.atan2(d.x, -d.y) if hasattr(sky, 'sun_rotation') else 0
        if hasattr(sky, 'sun_disc'):
            sky.sun_disc = False
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = sky_strength
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = sun_strength
    sun.angle = math.radians(1.5)
    sun.color = kelvin_rgb(sun_kelvin)
    obj = bpy.data.objects.new('sun', sun)
    sc.collection.objects.link(obj)
    obj.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return obj


def add_lights(lights, col):
    """Create Blender lights from Geo.lights records (positions in glTF module coords)."""
    made = []
    for i, (kind, pos, p) in enumerate(lights):
        if kind == 'panel':  # downward rectangle
            L = bpy.data.lights.new(f'l{i}', 'AREA')
            L.shape = 'RECTANGLE'
            sx, sz = p['size']
            yaw = p.get('yaw', 0.0)
            L.size, L.size_y = sx, sz
            rot = Euler((0, 0, yaw))  # area lights point down (−Z) by default
        elif kind == 'disk':
            L = bpy.data.lights.new(f'l{i}', 'AREA')
            L.shape = 'DISK'
            L.size = p['size']
            rot = Euler((0, 0, 0))
        elif kind == 'point':
            L = bpy.data.lights.new(f'l{i}', 'POINT')
            L.shadow_soft_size = p.get('radius', 0.1)
            rot = Euler((0, 0, 0))
        elif kind == 'wallwash':  # area light facing a local direction (glTF), e.g. (0, 0, 1)
            L = bpy.data.lights.new(f'l{i}', 'AREA')
            L.shape = 'RECTANGLE'
            L.size, L.size_y = p['size']
            d = Vector(p['dir'])
            yaw = p.get('yaw', 0.0)
            d = Vector((d.x * math.cos(yaw) + d.z * math.sin(yaw), d.y, -d.x * math.sin(yaw) + d.z * math.cos(yaw)))
            rot = (-_b(d)).to_track_quat('Z', 'Y').to_euler()
        else:
            raise ValueError(kind)
        L.energy = p['power']
        L.color = kelvin_rgb(p.get('kelvin', 4000)) if 'color' not in p else p['color']
        if hasattr(L, 'use_soft_falloff'):
            L.use_soft_falloff = True
        o = bpy.data.objects.new(f'light{i}', L)
        o.location = _b(pos)
        o.rotation_euler = rot
        col.objects.link(o)
        made.append(o)
    return made


# ------------------------------------------------------------------------------------------- bake
def enable_gpu():
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'METAL'
    except TypeError:
        pass
    prefs.get_devices()
    gpu = False
    for d in prefs.devices:
        d.use = d.type != 'CPU'
        gpu = gpu or d.use
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU' if gpu else 'CPU'
    return gpu


def lightmap_uvs(obj, res, margin_px=1.5):
    """UV1: Smart UV Project of the joined static mesh, packed into one atlas."""
    me = obj.data
    uv1 = me.uv_layers.new(name='UVMap.lightmap')
    me.uv_layers.active = uv1
    for i, l in enumerate(me.uv_layers):
        l.active_render = (i == 0)
    bpy.context.view_layer.objects.active = obj
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    t = time.time()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    # Absolute ('ADD') margins of ~1.5 texel: with tens of thousands of islands, per-island margins dominate
    # the atlas (and margin_method='FRACTION' leaves islands unscaled on large meshes in 5.2). The bake's
    # 8 px EXTEND margin then fills the gaps.
    bpy.ops.uv.pack_islands(rotate=True, margin_method='ADD', margin=max(0.0004, margin_px / res),
                            shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'[asset]   lightmap UVs {len(me.polygons)} faces in {time.time() - t:.1f} s', flush=True)
    return uv1


def _png_write(path, rgb8):
    """Minimal deterministic PNG writer (RGB, 8-bit, rows top → bottom, no metadata)."""
    h, w, _ = rgb8.shape
    raw = b''.join(b'\x00' + rgb8[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def _denoise(img, workdir):
    """OIDN through the compositor (Denoise node) on a throw-away scene; returns float RGBA array."""
    w, h = img.size
    sc = bpy.data.scenes.new('denoise')
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.engine = 'BLENDER_EEVEE'
    sc.view_settings.view_transform = 'Standard'
    ng = bpy.data.node_groups.new('denoise', 'CompositorNodeTree')
    sc.compositing_node_group = ng
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    ni = ng.nodes.new('CompositorNodeImage')
    ni.image = img
    dn = ng.nodes.new('CompositorNodeDenoise')
    if 'HDR' in dn.inputs:
        dn.inputs['HDR'].default_value = True
    go = ng.nodes.new('NodeGroupOutput')
    ng.links.new(ni.outputs[0], dn.inputs['Image'])
    ng.links.new(dn.outputs[0], go.inputs[0])
    cam = bpy.data.objects.new('dncam', bpy.data.cameras.new('dncam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    bpy.ops.render.render(scene=sc.name)
    path = os.path.join(workdir, f'_denoise_{img.name}.exr')
    bpy.data.images['Render Result'].save_render(path, scene=sc)
    out = bpy.data.images.load(path)
    arr = np.array(out.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(out)
    os.remove(path)
    bpy.data.scenes.remove(sc)
    return arr


def bake_lightmap(obj, res, samples, out_png, workdir, hide=()):
    """Bake diffuse direct+indirect (no color) of `obj` (UV1) into an 8-bit sRGB PNG of irradiance / I.

    Returns the runtime lightMapIntensity (three.js multiplies by albedo/π, so I = π · ref).
    """
    sc = bpy.context.scene
    gpu = enable_gpu()
    cy = sc.cycles
    cy.samples = samples
    cy.use_adaptive_sampling = False
    cy.seed = 0
    cy.max_bounces = 6
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 1
    cy.transmission_bounces = 2
    cy.transparent_max_bounces = 4
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.sample_clamp_indirect = 8.0
    bk = sc.render.bake
    bk.margin = 8
    bk.margin_type = 'EXTEND'
    bk.use_pass_direct = True
    bk.use_pass_indirect = True
    bk.use_pass_color = False
    bk.target = 'IMAGE_TEXTURES'
    bk.use_selected_to_active = False
    bk.use_clear = True

    img = bpy.data.images.new('lightmap', res, res, float_buffer=True, alpha=True)
    img.colorspace_settings.name = 'Linear Rec.709' if 'Linear Rec.709' in [
        c.name for c in bpy.types.ColorManagedInputColorspaceSettings.bl_rna.properties['name'].enum_items] else 'Non-Color'
    touched = []
    for slot in obj.material_slots:
        m = slot.material
        nt = m.node_tree
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'UVMap.lightmap'
        nt.links.new(uvn.outputs['UV'], n.inputs['Vector'])
        nt.nodes.active = n
        touched.append((m, n, uvn))
    # Fixture emitters are replaced by real area lights during the bake (cleaner, less noise).
    emit_off = []
    for m in bpy.data.materials:
        p = m.node_tree.nodes.get('Principled BSDF') if m.node_tree else None
        if p and p.inputs['Emission Strength'].default_value > 0 and not materials.BAKE_EMIT.get(m.name):
            emit_off.append((p, p.inputs['Emission Strength'].default_value))
            p.inputs['Emission Strength'].default_value = 0.0
    hidden = []
    for o in hide:
        hidden.append((o, o.hide_render))
        o.hide_render = True
    for o in bpy.context.view_layer.objects:
        o.select_set(o == obj)
    bpy.context.view_layer.objects.active = obj
    t = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True,
                        target='IMAGE_TEXTURES', uv_layer='UVMap.lightmap')
    bake_s = time.time() - t
    print(f'[asset]   bake {res}px {samples} spp on {"GPU" if gpu else "CPU"}: {bake_s:.1f} s', flush=True)
    for p, v in emit_off:
        p.inputs['Emission Strength'].default_value = v
    for o, h in hidden:
        o.hide_render = h
    for m, n, uvn in touched:
        m.node_tree.nodes.remove(n)
        m.node_tree.nodes.remove(uvn)

    raw = np.array(img.pixels[:], dtype=np.float32).reshape(res, res, 4)
    valid = raw[..., 3] > 0.5
    t = time.time()
    den = _denoise(img, workdir)
    print(f'[asset]   denoise {time.time() - t:.1f} s', flush=True)
    rgb = np.where(valid[..., None], np.maximum(den[..., :3], 0.0), 0.0)
    lum = rgb.max(axis=-1)[valid]
    ref = float(np.percentile(lum, 99.0)) if lum.size else 1.0
    ref = max(ref, 1e-4)
    x = np.clip(rgb / ref, 0.0, 1.0)
    srgb = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    rgb8 = np.round(srgb * 255.0).astype(np.uint8)[::-1]  # Blender rows are bottom-up
    _png_write(out_png, np.ascontiguousarray(rgb8))
    bpy.data.images.remove(img)
    return {'intensity': round(math.pi * ref, 4), 'bake_seconds': round(bake_s, 1), 'ref': ref}


# ---------------------------------------------------------------------------------------- previews
def _look_at(cam, pos, target):
    loc = _b(pos)
    d = _b(target) - loc
    cam.location = loc
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def render_previews(spec, shots, objs, out, quality, engine=None):
    """Preview stills (AgX) of a module: shots = [(slug, pos, target, lens_mm, hide_ceiling)].

    Cycles (Metal GPU, OIDN) by default: it matches the baked look and, unlike Eevee in background mode on this
    machine, never stalls. Set ASSET_PREVIEW_ENGINE=EEVEE to use Eevee."""
    engine = engine or os.environ.get('ASSET_PREVIEW_ENGINE', 'CYCLES').upper()
    sc = bpy.context.scene
    final = quality == 'final'
    if engine == 'CYCLES':
        enable_gpu()
        sc.cycles.samples = 160 if final else 48
        sc.cycles.use_adaptive_sampling = True
        sc.cycles.use_denoising = True
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
        sc.cycles.max_bounces = 6
        sc.cycles.diffuse_bounces = 3
        sc.cycles.glossy_bounces = 2
        sc.cycles.transmission_bounces = 4
        sc.cycles.sample_clamp_indirect = 6.0
        sc.cycles.caustics_reflective = False
        sc.cycles.caustics_refractive = False
    else:
        sc.render.engine = 'BLENDER_EEVEE'
        ee = sc.eevee
        ee.taa_render_samples = 128 if final else 48
        ee.use_raytracing = True
        ee.ray_tracing_method = 'SCREEN'
        ee.use_shadows = True
        ee.shadow_pool_size = '1024'
        ee.shadow_ray_count = 2
        ee.shadow_step_count = 8
        ee.use_fast_gi = True
        ee.fast_gi_method = 'GLOBAL_ILLUMINATION'
        ee.fast_gi_resolution = '2'
        ee.fast_gi_ray_count = 4
        ee.fast_gi_distance = 6.0
        ee.ray_tracing_options.resolution_scale = '1'
        ee.ray_tracing_options.trace_max_roughness = 0.6
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.render.resolution_x = 1600 if final else 1280
    sc.render.resolution_y = 900 if final else 720
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.sensor_width = 36
    cam.data.clip_start = 0.05
    cam.data.clip_end = 300
    name = spec.replace(':', '-')
    for shot, pos, target, lens, hide_ceiling in shots:
        for o in objs['ceiling']:
            o.hide_render = hide_ceiling
        cam.data.lens = lens
        _look_at(cam, pos, target)
        sc.render.filepath = os.path.join(out, f'{name}-{shot}.png')
        t = time.time()
        bpy.ops.render.render(write_still=True)
        print(f'[asset] preview {name}-{shot}.png {time.time() - t:.1f} s', flush=True)
    for o in objs['ceiling']:
        o.hide_render = False
