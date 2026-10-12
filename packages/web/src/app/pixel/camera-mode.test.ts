import { describe, expect, it } from 'vitest'
import {
  cameraTarget,
  escapeCancels,
  nextCameraMode,
  PLAYER_CAMERA,
  type CameraState,
} from './camera-mode.ts'

const overview: CameraState = { mode: 'overview' }
const follow: CameraState = { mode: 'follow', agentId: 'a' }
const pan: CameraState = { mode: 'pan', at: { x: 3, z: 4 } }

describe('camera modes (CM)', () => {
  // CM-1: moving keeps the overview and follow; only a pan returns to the player.
  it('lets the player walk in the overview and while following', () => {
    expect(nextCameraMode(overview, { type: 'move' })).toEqual(overview)
    expect(nextCameraMode(follow, { type: 'move' })).toEqual(follow)
    expect(nextCameraMode(pan, { type: 'move' })).toEqual(PLAYER_CAMERA)
    expect(nextCameraMode(PLAYER_CAMERA, { type: 'move' })).toEqual(PLAYER_CAMERA)
  })

  // CM-2: Esc and Space return the camera to the player from any mode.
  it('returns to the player on Esc, Space and travel', () => {
    for (const s of [overview, follow, pan, PLAYER_CAMERA])
      for (const type of ['escape', 'space', 'travel'] as const)
        expect(nextCameraMode(s, { type })).toEqual(PLAYER_CAMERA)
    expect(escapeCancels(PLAYER_CAMERA)).toBe(false)
    expect([overview, follow, pan].every(escapeCancels)).toBe(true)
  })

  // CM-3: O toggles the overview; goTo('overview') always opens it.
  it('toggles the overview', () => {
    expect(nextCameraMode(PLAYER_CAMERA, { type: 'toggle-overview' })).toEqual(overview)
    expect(nextCameraMode(follow, { type: 'toggle-overview' })).toEqual(overview)
    expect(nextCameraMode(overview, { type: 'toggle-overview' })).toEqual(PLAYER_CAMERA)
    expect(nextCameraMode(overview, { type: 'overview' })).toEqual(overview)
  })

  // CM-4: follow(id) follows; follow(null) stops.
  it('follows and stops following', () => {
    expect(nextCameraMode(overview, { type: 'follow', agentId: 'a' })).toEqual(follow)
    expect(nextCameraMode(follow, { type: 'follow', agentId: null })).toEqual(PLAYER_CAMERA)
  })

  // CM-5: a floor click or the wheel in the overview pans the normal view there.
  it('pans from the overview on a floor click or the wheel', () => {
    const at = { x: 1, z: 2 }
    expect(nextCameraMode(overview, { type: 'floor-click', at })).toEqual({ mode: 'pan', at })
    expect(nextCameraMode(overview, { type: 'wheel-in', at })).toEqual({ mode: 'pan', at })
    expect(nextCameraMode(follow, { type: 'floor-click', at })).toEqual(follow)
    expect(nextCameraMode(PLAYER_CAMERA, { type: 'wheel-in', at })).toEqual(PLAYER_CAMERA)
    expect(nextCameraMode(follow, { type: 'pan', at })).toEqual({ mode: 'pan', at })
  })

  // CM-6: the camera looks at the agent (or the player when it left), the pan point or the player.
  it('picks the camera target', () => {
    const player = { x: 0, z: 0 }
    const agents = (id: string) => (id === 'a' ? { x: 9, z: 9 } : undefined)
    expect(cameraTarget(follow, player, agents)).toEqual({ x: 9, z: 9 })
    expect(cameraTarget({ mode: 'follow', agentId: 'gone' }, player, agents)).toBe(player)
    expect(cameraTarget(follow, player)).toBe(player)
    expect(cameraTarget(pan, player)).toEqual({ x: 3, z: 4 })
    expect(cameraTarget(overview, player)).toBe(player)
    expect(cameraTarget(PLAYER_CAMERA, player)).toBe(player)
  })
})
