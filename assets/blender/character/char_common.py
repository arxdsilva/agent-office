"""Shared constants: proportions, bone layout, clip table, materials (Blender coordinates).

Blender is Z-up; the character faces -Y and its left side is +X. The glTF exporter maps
(x, y, z) -> (x, z, -y), so the exported character faces +z (heading 0) as the contract wants.
"""
import math

FPS = 30
HEIGHT = 1.75
SEAT_HEIGHT = 0.47
LOUNGE_SEAT_HEIGHT = 0.42

# Where furniture sits relative to the character root in the sit clips (Blender coordinates:
# +Y is *behind* the character). The root is the standing spot in front of the seat.
SEAT_CENTER_Y = 0.29          # chair seat centre, 0.29 m behind the root
LOUNGE_CENTER_Y = 0.36        # sofa seat centre
DESK_EDGE_Y = -0.13           # desk front edge, 0.13 m in front of the root
DESK_HEIGHT = 0.74
DESK_DEPTH = 0.75

# ── skeleton (rest pose, A-pose) ─────────────────────────────────────────────────────────────
_ARM_DEG = 47.0               # upper-arm angle from vertical
_ELBOW_FWD = 14.0             # rest forearm bend toward the front
UPPER_ARM = 0.285
FOREARM = 0.255
HAND = 0.105                  # bone length (wrist -> knuckles); mitten reaches ~0.20


def _arm_points():
    s = (0.182, 0.008, 1.402)
    a = math.radians(_ARM_DEG)
    d1 = (math.sin(a), 0.0, -math.cos(a))
    e = tuple(s[i] + UPPER_ARM * d1[i] for i in range(3))
    b = math.radians(_ELBOW_FWD)
    d2 = (d1[0] * math.cos(b), -math.sin(b), d1[2] * math.cos(b))
    n = math.sqrt(sum(c * c for c in d2))
    d2 = tuple(c / n for c in d2)
    w = tuple(e[i] + FOREARM * d2[i] for i in range(3))
    t = tuple(w[i] + HAND * d2[i] for i in range(3))
    return s, e, w, t, d1, d2


SHOULDER_J, ELBOW_J, WRIST_J, HAND_TIP, UPPER_DIR, FORE_DIR = _arm_points()

HIP_J = (0.093, 0.0, 0.935)
KNEE_J = (0.093, -0.014, 0.505)
ANKLE_J = (0.093, 0.028, 0.088)
BALL_J = (0.101, -0.112, 0.030)
TOE_TIP = (0.104, -0.19, 0.030)
HEEL_GROUND = (0.093, 0.082, 0.0)
BALL_GROUND = (0.101, -0.112, 0.0)


def L(p):
    return p


def R(p):
    return (-p[0], p[1], p[2])


# name: (head, tail, parent, deform, roll-hint (bone Z axis direction))
BONES = {
    'root': ((0, 0, 0), (0, 0, 0.18), None, True, (0, -1, 0)),
    'hips': ((0, 0.0, 0.965), (0, 0.0, 1.06), 'root', True, (0, -1, 0)),
    'spine': ((0, 0.0, 1.06), (0, 0.004, 1.215), 'hips', True, (0, -1, 0)),
    'chest': ((0, 0.004, 1.215), (0, 0.012, 1.42), 'spine', True, (0, -1, 0)),
    'neck': ((0, 0.012, 1.42), (0, 0.006, 1.535), 'chest', True, (0, -1, 0)),
    'head': ((0, 0.006, 1.535), (0, 0.006, 1.75), 'neck', True, (0, -1, 0)),
}
for side, m in (('L', L), ('R', R)):
    BONES.update({
        f'shoulder.{side}': (m((0.028, 0.004, 1.385)), m(SHOULDER_J), 'chest', True, (0, -1, 0)),
        f'upperarm.{side}': (m(SHOULDER_J), m(ELBOW_J), f'shoulder.{side}', True, (0, -1, 0)),
        f'forearm.{side}': (m(ELBOW_J), m(WRIST_J), f'upperarm.{side}', True, (0, -1, 0)),
        f'hand.{side}': (m(WRIST_J), m(HAND_TIP), f'forearm.{side}', True, (0, -1, 0)),
        f'thigh.{side}': (m(HIP_J), m(KNEE_J), 'hips', True, (0, -1, 0)),
        f'shin.{side}': (m(KNEE_J), m(ANKLE_J), f'thigh.{side}', True, (0, -1, 0)),
        f'foot.{side}': (m(ANKLE_J), m(BALL_J), f'shin.{side}', True, (0, 0, 1)),
        f'toe.{side}': (m(BALL_J), m(TOE_TIP), f'foot.{side}', True, (0, 0, 1)),
    })

# Palm normal / thumb direction of the left hand in the rest pose (palms face the thighs).
PALM_REST_L = (-math.cos(math.radians(_ARM_DEG)), 0.0, -math.sin(math.radians(_ARM_DEG)))

DEFORM_BONES = [
    'root', 'hips', 'spine', 'chest', 'neck', 'head',
    'shoulder.L', 'shoulder.R', 'upperarm.L', 'upperarm.R', 'forearm.L', 'forearm.R',
    'hand.L', 'hand.R', 'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R',
    'toe.L', 'toe.R',
]
ALL_BONES = DEFORM_BONES + ['prop.R']

# ── clips (contract §8, plan §3.3) ───────────────────────────────────────────────────────────
CLIPS = [
    ('Idle', 120, True), ('Walk', 32, True), ('TurnL90', 20, False), ('TurnR90', 20, False),
    ('SitDown', 36, False), ('StandUp', 30, False), ('SitIdle', 150, True), ('SitType', 60, True),
    ('SitThink', 120, True), ('SitTalk', 120, True), ('SitLaptop', 60, True), ('StandTalk', 120, True),
    ('PhoneCall', 150, True), ('DrinkCoffee', 180, True), ('LoungeSit', 150, True),
    ('PingPong', 48, True), ('Wave', 40, False), ('HeadScratch', 90, True), ('ElevatorIn', 40, False),
]
CLIP_NAMES = [c[0] for c in CLIPS]
WALK_SPEED = 1.4

# ── materials ────────────────────────────────────────────────────────────────────────────────
# name: (base colour (linear-ish sRGB hex), roughness, metallic)
MATERIALS = {
    'skin': ('#E9B48F', 0.55, 0.0),
    'shirt': ('#4F7FD8', 0.78, 0.0),
    'pants': ('#2F3747', 0.82, 0.0),
    'hair': ('#3B2A22', 0.6, 0.0),
    'shoes': ('#ECE8E2', 0.62, 0.0),
    'eyes': ('#1C1D26', 0.22, 0.0),
    'badge': ('#D97757', 0.6, 0.0),
    # additive (accessories / props only)
    'plastic': ('#2A2C33', 0.4, 0.0),
    'metal': ('#B9BEC6', 0.32, 0.85),
    'screen': ('#10141C', 0.15, 0.0),
    'white': ('#F4F2EE', 0.45, 0.0),
    'rubber': ('#C9393B', 0.7, 0.0),
    'wood': ('#B98552', 0.55, 0.0),
}
