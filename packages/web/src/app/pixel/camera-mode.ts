// 2D camera modes (plan §2b): what the camera looks at and which inputs leave a mode. Pure.
//   player    follows the player (default)
//   overview  the whole map; the player keeps walking inside it (O / Esc / Space leave)
//   follow    follows an agent; the player keeps walking (Esc / Space / follow(null) leave)
//   pan       looks at a point (minimap, directory, view bar); any movement returns to the player
import type { Vec2 } from '../office-types.ts'

export type CameraState =
  | { mode: 'player' }
  | { mode: 'overview' }
  | { mode: 'follow'; agentId: string }
  | { mode: 'pan'; at: Vec2 }

export type CameraEvent =
  | { type: 'move' }
  | { type: 'escape' }
  | { type: 'space' }
  | { type: 'toggle-overview' }
  | { type: 'overview' }
  | { type: 'follow'; agentId: string | null }
  | { type: 'pan'; at: Vec2 }
  /** A click on the floor (in the overview: pan there; elsewhere: nothing changes). */
  | { type: 'floor-click'; at: Vec2 }
  /** The wheel zooms in from the overview to the normal view at a point. */
  | { type: 'wheel-in'; at: Vec2 }
  /** The player was placed somewhere (fast travel, teleport). */
  | { type: 'travel' }

export const PLAYER_CAMERA: CameraState = { mode: 'player' }

export function nextCameraMode(s: CameraState, e: CameraEvent): CameraState {
  switch (e.type) {
    case 'move':
      return s.mode === 'pan' ? PLAYER_CAMERA : s
    case 'escape':
    case 'space':
    case 'travel':
      return PLAYER_CAMERA
    case 'toggle-overview':
      return s.mode === 'overview' ? PLAYER_CAMERA : { mode: 'overview' }
    case 'overview':
      return { mode: 'overview' }
    case 'follow':
      return e.agentId ? { mode: 'follow', agentId: e.agentId } : PLAYER_CAMERA
    case 'pan':
      return { mode: 'pan', at: e.at }
    case 'floor-click':
    case 'wheel-in':
      return s.mode === 'overview' ? { mode: 'pan', at: e.at } : s
  }
}

/** True when Esc has a camera override to cancel (otherwise Esc deselects). */
export const escapeCancels = (s: CameraState): boolean => s.mode !== 'player'

/** Where the camera looks: the followed agent (when still there), the pan point, or the player. */
export function cameraTarget(
  s: CameraState,
  player: Vec2,
  agentPos?: (id: string) => Vec2 | undefined,
): Vec2 {
  if (s.mode === 'follow') return agentPos?.(s.agentId) ?? player
  if (s.mode === 'pan') return s.at
  return player
}
