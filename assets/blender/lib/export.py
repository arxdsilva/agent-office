"""Turn a Geo into Blender objects, bake, split by material and export a .glb with node extras."""
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import geometry, lighting, materials
from .scene import GLTF_TO_BLENDER


def _clear_props(obj):
    for k in list(obj.keys()):
        del obj[k]


def create_objects(geo, col, name):
    """Returns dict: static/ceiling/glass lists (one object per (group, material)), dynamic, collider."""
    out = {'static': [], 'ceiling': [], 'glass': [], 'roofglass': [], 'dynamic': [], 'collider': []}
    for (group, mat), b in sorted(geo.batches.items()):
        if not b.bm.faces:
            b.bm.free()
            continue
        obj = geometry.mesh_object(f'{name}-{group}-{mat}', b.bm, mat, col, tile=materials.TILE.get(mat, 2.0))
        out[group].append(obj)
    for d in geo.dynamics:
        if not d.bm.faces:
            continue
        piv = GLTF_TO_BLENDER @ Vector(d.pivot)
        has_uv = bool(d.bm.loops.layers.uv)
        bmesh.ops.translate(d.bm, vec=-piv, verts=d.bm.verts)
        obj = geometry.mesh_object(d.name, d.bm, d.mat, col, tile=materials.TILE.get(d.mat, 1.0), fixed_uv=has_uv)
        obj.location = piv
        obj['role'] = d.role
        if d.ref is not None:
            obj['ref'] = d.ref
        for k, v in d.extras.items():
            obj[k] = v
        out['dynamic'].append(obj)
    cm = materials.collider()
    for i, (x0, x1, z0, z1, y0, y1) in enumerate(geo.colliders):
        bm = bmesh.new()
        center = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
        m = Matrix.Diagonal((x1 - x0, z1 - z0, y1 - y0, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
        piv = GLTF_TO_BLENDER @ center
        obj = geometry.mesh_object(f'collider-{i}', bm, cm.name, col, tile=1.0)
        obj.location = piv
        obj['role'] = 'collider'
        out['collider'].append(obj)
    return out


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def bake_and_split(objs, res, samples, png, workdir, name, hide=()):
    """Join static+ceiling objects, bake one atlas, split back by material and group."""
    t = time.time()
    # remember the group of every face through a face attribute that survives join/separate
    for o in objs['static'] + objs['ceiling']:
        attr = o.data.attributes.new('is_ceiling', 'BOOLEAN', 'FACE')
        v = o in objs['ceiling']
        attr.data.foreach_set('value', [v] * len(o.data.polygons))
    joined = join(objs['static'] + objs['ceiling'], f'{name}-baked')
    tris = geometry.triangle_count(joined)
    print(f'[asset]   joined {len(joined.data.polygons)} faces / {tris} tris in {time.time() - t:.1f} s', flush=True)
    lighting.lightmap_uvs(joined, res)
    info = lighting.bake_lightmap(joined, res, samples, png, workdir, hide=hide)
    # split: by material, then by the ceiling flag
    bpy.ops.object.select_all(action='DESELECT')
    joined.select_set(True)
    bpy.context.view_layer.objects.active = joined
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    parts = [o for o in bpy.context.selected_objects]
    result = []
    for o in parts:
        attr = o.data.attributes.get('is_ceiling')
        flags = [False] * len(o.data.polygons)
        attr.data.foreach_get('value', flags)
        mat = o.data.materials[0].name if o.data.materials else 'none'
        if any(flags) and not all(flags):
            bm = bmesh.new()
            bm.from_mesh(o.data)
            lay = bm.faces.layers.bool.get('is_ceiling')
            ceil_faces = [f for f in bm.faces if f[lay]]
            bm2 = bm.copy()
            bmesh.ops.delete(bm, geom=ceil_faces, context='FACES')
            lay2 = bm2.faces.layers.bool.get('is_ceiling')
            bmesh.ops.delete(bm2, geom=[f for f in bm2.faces if not f[lay2]], context='FACES')
            bm.to_mesh(o.data)
            bm.free()
            me2 = bpy.data.meshes.new(f'{name}-ceiling-{mat}')
            bm2.to_mesh(me2)
            bm2.free()
            o2 = bpy.data.objects.new(f'{name}-ceiling-{mat}', me2)
            for c in o.users_collection:
                c.objects.link(o2)
            pieces = [(o, False), (o2, True)]
        else:
            pieces = [(o, bool(flags and flags[0]))]
        for p, is_ceiling in pieces:
            p.data.attributes.remove(p.data.attributes['is_ceiling'])
            p.name = f'{name}-{"ceiling" if is_ceiling else "baked"}-{mat}'
            _clear_props(p)
            p['role'] = 'ceiling' if is_ceiling else 'baked'
            if is_ceiling:
                p['lightmap'] = True  # additive: ceilings also carry TEXCOORD_1 for the module atlas
            result.append(p)
    return result, info, tris


def tag_unbaked(objs):
    """Without a bake (previews/tests): give static/ceiling/glass objects their export roles."""
    for o in objs['static']:
        o['role'] = 'baked'
    for o in objs['ceiling']:
        o['role'] = 'ceiling'
    for o in objs['glass'] + objs['roofglass']:
        o['role'] = 'glass'
    for o in objs['roofglass']:
        o['ceiling'] = True


def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_extras=True, export_yup=True,
        export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_vertex_color='MATERIAL', export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False, export_image_format='AUTO',
        export_unused_images=False, export_unused_textures=False, export_gpu_instances=False)


def count_triangles(objs):
    return sum(geometry.triangle_count(o) for o in objs)
