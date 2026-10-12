"""Builds the stylized, rigged, animated office character (contract §8).

Usage (headless):
  Blender --background --factory-startup --python assets/blender/modules/character.py -- \
      --out <dir> --quality draft|final [--save-blend <file.blend>]
Writes <dir>/character.glb and <dir>/character.json.
"""
import argparse
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.normpath(os.path.join(HERE, '..', 'character'))
if PKG not in sys.path:
    sys.path.insert(0, PKG)

import bpy  # noqa: E402

import char_common as C  # noqa: E402
import char_build as B  # noqa: E402
import char_anim as A  # noqa: E402
import char_clips as K  # noqa: E402
from char_pose import Rig  # noqa: E402

CLIP_EXTRAS = {
    'Walk': {'speed': C.WALK_SPEED, 'footPlants': [0, 0.5]},
    'TurnL90': {'turn': math.pi / 2},
    'TurnR90': {'turn': -math.pi / 2},
    'ElevatorIn': {'turn': math.pi},
    'SitDown': {'pose': 'sit'}, 'StandUp': {'pose': 'sit'}, 'SitIdle': {'pose': 'sit'},
    'SitType': {'pose': 'sit'}, 'SitThink': {'pose': 'sit'}, 'SitTalk': {'pose': 'sit'},
    'SitLaptop': {'pose': 'sit', 'prop': 'laptop'},
    'LoungeSit': {'pose': 'lounge'},
    'PhoneCall': {'prop': 'phone'},
    'DrinkCoffee': {'prop': 'cup'},
    'PingPong': {'prop': 'paddle', 'hitPhase': 0.25, 'pairOffset': 0.5},
}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--quality', choices=('draft', 'final'), default='draft')
    ap.add_argument('--save-blend', default=None)
    return ap.parse_args(argv)


def build_scene(quality):
    """Mesh + rig + all actions. Returns (scene dict, clip metadata)."""
    t0 = time.time()
    res = B.build(quality)
    arm = res['armature']
    rig = Rig(arm)
    sit_min, sit_pt = A.calibrate_seat(arm, rig, res['body'], res['part_of'], K.seated, K.SEAT, C.SEAT_HEIGHT,
                                      C.SEAT_CENTER_Y - 0.23)
    lounge_min, lounge_pt = A.calibrate_seat(arm, rig, res['body'], res['part_of'], K.lounge_base, K.LOUNGE,
                                             C.LOUNGE_SEAT_HEIGHT, C.LOUNGE_CENTER_Y - 0.27)
    B.log(f'seat contact {sit_min:.4f} m at y={sit_pt.y:.3f}; lounge {lounge_min:.4f} m at y={lounge_pt.y:.3f}')
    A.reset_pose(arm)
    clips, meta = K.all_clips(rig)
    B.log(f"walk heel strike y={meta['Walk']['heelStrikeY']:.3f}, max leg reach {meta['Walk']['maxReach']:.3f}")
    actions = {}
    for name, n, loop in C.CLIPS:
        frames = clips[name]
        assert len(frames) == n + 1, (name, len(frames))
        actions[name] = A.write_action(arm, rig, name, frames, loop)
    arm.animation_data.action = actions['Idle']
    A.reset_pose(arm)
    bpy.context.scene.frame_set(0)
    B.log(f'scene built in {time.time() - t0:.1f}s')
    res['actions'] = actions
    res['rig'] = rig
    res['seat'] = {'sit': (sit_min, sit_pt), 'lounge': (lounge_min, lounge_pt)}
    return res


def character_json(res):
    clips = {}
    for name, n, loop in C.CLIPS:
        c = {'duration': round(n / C.FPS, 4), 'loop': loop, 'frames': n}
        c.update(CLIP_EXTRAS.get(name, {}))
        clips[name] = c
    sit_pt = res['seat']['sit'][1]
    lounge_pt = res['seat']['lounge'][1]
    return {
        'height': C.HEIGHT,
        'seatHeight': C.SEAT_HEIGHT,
        'loungeSeatHeight': C.LOUNGE_SEAT_HEIGHT,
        'fps': C.FPS,
        # additive: where furniture sits relative to the root in the sit/lounge clips (glTF, local)
        'sit': {'seatCenterZ': -C.SEAT_CENTER_Y, 'hipContactZ': round(-sit_pt.y, 3),
                'deskEdgeZ': -C.DESK_EDGE_Y, 'deskHeight': C.DESK_HEIGHT},
        'lounge': {'seatCenterZ': -C.LOUNGE_CENTER_Y, 'hipContactZ': round(-lounge_pt.y, 3)},
        'accessories': {'hairA': True, 'hairB': False, 'hairC': False, 'hairD': False, 'glasses': False,
                        'headset': False, 'badge': False},
        'props': ['laptop', 'cup', 'phone', 'paddle'],
        'clips': clips,
    }


def export_glb(path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=False, use_visible=False, use_renderable=False,
        export_yup=True, export_extras=True, export_cameras=False, export_lights=False,
        export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
        export_skins=True, export_influence_nb=4, export_all_influences=False, export_def_bones=False,
        export_animations=True, export_animation_mode='ACTIONS', export_merge_animation='ACTION',
        export_force_sampling=True, export_frame_step=1, export_anim_slide_to_zero=False,
        export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=True,
        export_reset_pose_bones=True, export_morph=False, export_apply=False, export_leaf_bone=False,
    )


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    res = build_scene(args.quality)
    glb = os.path.join(args.out, 'character.glb')
    export_glb(glb)
    with open(os.path.join(args.out, 'character.json'), 'w') as fh:
        json.dump(character_json(res), fh, indent=2)
        fh.write('\n')
    B.log(f'wrote {glb} ({os.path.getsize(glb) / 1e6:.2f} MB)')
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend), compress=True)


if __name__ == '__main__':
    main()
