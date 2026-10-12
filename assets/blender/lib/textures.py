"""Poly Haven CC0 textures, read from assets/cache/ (downloaded and sha256-verified by assets/build.mjs).

The pinned list lives in assets/blender/polyhaven.json; this module refuses ids that are not pinned there.
"""
import hashlib
import json
import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
CACHE = os.path.join(os.path.dirname(BLENDER_DIR), 'cache')
PINS = json.load(open(os.path.join(BLENDER_DIR, 'polyhaven.json')))

_images = {}


def _file(asset_id, m):
    t = PINS['textures'].get(asset_id)
    if t is None:
        raise KeyError(f'texture {asset_id} is not pinned in polyhaven.json')
    if m not in t['maps']:
        return None
    rel = f"textures/{asset_id}_{m}_{t['res']}.jpg"
    path = os.path.join(CACHE, rel)
    if not os.path.exists(path):
        raise FileNotFoundError(f'{path} missing; run node assets/build.mjs (it downloads the cache)')
    want = PINS['sha256'].get(rel)
    got = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if want != got:
        raise ValueError(f'sha256 mismatch for {rel}')
    return path


def image(asset_id, m):
    """bpy image for map `m` (diff | nor_gl | arm) of a pinned Poly Haven texture, or None if not pinned."""
    key = (asset_id, m)
    if key in _images:
        return _images[key]
    path = _file(asset_id, m)
    if path is None:
        return None
    img = bpy.data.images.load(path, check_existing=True)
    img.name = f'{asset_id}_{m}'
    img.colorspace_settings.name = 'sRGB' if m == 'diff' else 'Non-Color'
    _images[key] = img
    return img


def polyhaven(asset_id):
    """All available maps of a texture: {'diff': img, 'nor_gl': img|None, 'arm': img|None}."""
    return {m: image(asset_id, m) for m in ('diff', 'nor_gl', 'arm')}


def hdri_path():
    h = PINS['hdri']
    return os.path.join(CACHE, 'hdri', f"{h['id']}_{h['res']}.hdr")


def reset():
    _images.clear()
