"""Night City environment (contract §14): a procedural night HDRI and the bake/preview world.

The HDRI is original work generated here (no photo): a deep navy zenith, a magenta-to-amber haze over the
horizon from the city below, and a band of window and sign specks under the horizon. It ships as
`hdri/night.hdr` (Radiance RGBE) and is the runtime's specular environment.
"""
import math

import bpy
import numpy as np


def _rng(seed):
    return np.random.default_rng(seed)


def night_sky(w=1024, h=512, seed=7):
    """Equirectangular float RGB (h, w, 3), linear. Row 0 is the zenith."""
    r = _rng(seed)
    v = (np.arange(h, dtype=np.float32) + 0.5) / h  # 0 = up, 0.5 = horizon, 1 = down
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    elev = (0.5 - v) * math.pi  # +π/2 zenith … −π/2 nadir
    E = np.repeat(elev[:, None], w, axis=1)
    U = np.repeat(u[None, :], h, axis=0)
    zen = np.array((0.010, 0.016, 0.034), np.float32)
    navy = np.array((0.018, 0.030, 0.062), np.float32)
    magenta = np.array((0.26, 0.05, 0.20), np.float32)
    amber = np.array((0.42, 0.20, 0.06), np.float32)
    up = np.clip(E / (math.pi / 2), 0, 1)[..., None]
    sky = navy * (1 - up) + zen * up
    # city haze: strongest just above the horizon, magenta high, amber low; uneven around the azimuth
    haze_amp = 0.55 + 0.45 * np.sin(U * 2 * math.pi * 3 + 0.7) * np.sin(U * 2 * math.pi * 1.3 + 2.1)
    haze = np.exp(-np.maximum(E, 0) / 0.16)[..., None] * haze_amp[..., None]
    low = np.exp(-np.maximum(E, 0) / 0.05)[..., None]
    sky = sky + haze * magenta * 0.55 + low * amber * 0.7
    # below the horizon: the city, dark with a warm glow that fades with depth
    below = E < 0
    depth = np.clip(-E / (math.pi / 2), 0, 1)[..., None]
    city = (amber * 0.35 + magenta * 0.15) * np.exp(-depth / 0.12) + np.array((0.006, 0.008, 0.014), np.float32)
    img = np.where(below[..., None], city, sky).astype(np.float32)
    # window and sign specks just under the horizon (bright, small) and sparse stars-ish haze sparkles above
    n = 9000
    ys = (h / 2 + np.abs(r.normal(0, h * 0.06, n))).astype(int).clip(0, h - 1)
    xs = r.integers(0, w, n)
    pal = np.array(((1.0, 0.82, 0.55), (0.25, 0.9, 1.0), (1.0, 0.2, 0.85), (0.85, 1.0, 0.25), (1.0, 0.95, 0.9)),
                   np.float32)
    cols = pal[r.choice(len(pal), n, p=(0.45, 0.22, 0.12, 0.05, 0.16))]
    gain = r.uniform(0.6, 4.0, n).astype(np.float32)[:, None]
    np.add.at(img, (ys, xs), cols * gain)
    return img


def write_hdr(path, rgb):
    """Radiance RGBE (uncompressed scanlines), top row first."""
    h, w, _ = rgb.shape
    m = np.maximum(np.maximum(rgb[..., 0], rgb[..., 1]), rgb[..., 2])
    e = np.zeros_like(m, dtype=np.int32)
    ok = m > 1e-32
    mant, ex = np.frexp(m[ok])
    e[ok] = ex
    scale = np.zeros_like(m)
    scale[ok] = mant * 256.0 / m[ok]
    out = np.zeros((h, w, 4), np.uint8)
    out[..., :3] = np.clip(rgb * scale[..., None], 0, 255).astype(np.uint8)
    out[..., 3] = np.where(ok, e + 128, 0).astype(np.uint8)
    with open(path, 'wb') as f:
        f.write(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')
        f.write(f'-Y {h} +X {w}\n'.encode())
        f.write(out.tobytes())


def sky_image(name='night-sky', w=1024, h=512):
    """The night sky as a float bpy image (for the world shader)."""
    rgb = night_sky(w, h)
    img = bpy.data.images.new(name, w, h, float_buffer=True, alpha=True)
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = rgb[::-1]  # Blender rows are bottom-up
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def setup_world(strength=1.0, moon_dir=(-0.35, 0.55, -0.75), moon_strength=0.06, fog=0.0):
    """World = the procedural night sky (equirect) + a faint cool moon so silhouettes read in the bake."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('night')
    sc.world = world
    nt = world.node_tree
    bg = nt.nodes.get('Background')
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = sky_image()
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    if fog > 0:  # previews only: a thin blue haze for depth (the runtime has its own height fog)
        vs = nt.nodes.new('ShaderNodeVolumeScatter')
        vs.inputs['Color'].default_value = (0.55, 0.62, 0.85, 1)
        vs.inputs['Density'].default_value = fog
        nt.links.new(vs.outputs['Volume'], nt.nodes['World Output'].inputs['Volume'])
    if moon_strength > 0:
        from mathutils import Vector
        from lib.scene import GLTF_TO_BLENDER
        d = (GLTF_TO_BLENDER @ Vector(moon_dir)).normalized()
        sun = bpy.data.lights.new('moon', 'SUN')
        sun.energy = moon_strength
        sun.angle = math.radians(2.0)
        sun.color = (0.62, 0.74, 1.0)
        o = bpy.data.objects.new('moon', sun)
        sc.collection.objects.link(o)
        o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return world
