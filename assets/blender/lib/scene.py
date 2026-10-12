"""Scene utilities: reset, units, seeded RNG, collections and the glTF↔Blender frame.

All module code is written in *glTF / runtime coordinates* (meters, +Y up, see docs/graphics-contract.md §1).
`to_blender` converts once, when geometry is emitted: (x, y, z)_gltf → (x, −z, y)_blender, which is exactly
the inverse of what the glTF exporter applies, so exported positions equal the coordinates written here.
"""
import math
import random

import bpy
from mathutils import Matrix

# (x, y, z)_gltf -> (x, -z, y)_blender
GLTF_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    set_units()


def set_units():
    us = bpy.context.scene.unit_settings
    us.system = 'METRIC'
    us.scale_length = 1.0


def rng(seed):
    return random.Random(seed)


def new_collection(name, parent=None):
    col = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(col)
    return col


def yaw_matrix(theta):
    """Rotation about glTF +Y by theta (three.js rotation.y): x' = x cos + z sin, z' = −x sin + z cos."""
    c, s = math.cos(theta), math.sin(theta)
    return Matrix(((c, 0, s, 0), (0, 1, 0, 0), (-s, 0, c, 0), (0, 0, 0, 1)))


def translation(x, y, z):
    return Matrix.Translation((x, y, z))


def link(obj, col=None):
    (col or bpy.context.scene.collection).objects.link(obj)
    return obj


def apply_all(objs):
    """Apply object transforms (geometry is generated in place, so this is normally a no-op)."""
    for o in objs:
        if o.type == 'MESH' and o.matrix_world != Matrix.Identity(4):
            o.data.transform(o.matrix_world)
            o.matrix_world = Matrix.Identity(4)
