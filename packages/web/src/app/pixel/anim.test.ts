import { describe, expect, it } from 'vitest'
import type { ClipName } from '../office-types.ts'
import { CLIP_ANIM, STRIDE_PX, animFor, frameAt, npcVisual, statusIcon, walkFps } from './anim.ts'
import { PIXEL_ANIMS } from './types.ts'

const CLIPS: ClipName[] = [
  'Idle',
  'Walk',
  'TurnL90',
  'TurnR90',
  'SitDown',
  'StandUp',
  'SitIdle',
  'SitType',
  'SitThink',
  'SitTalk',
  'SitLaptop',
  'StandTalk',
  'PhoneCall',
  'DrinkCoffee',
  'LoungeSit',
  'PingPong',
  'Wave',
  'HeadScratch',
  'ElevatorIn',
  'StandInteract',
  'SitRead',
  'ShelfPick',
]

describe('clip → pixel animation (AN)', () => {
  // AN-1: every 3D clip has a 2D animation (exhaustive, plan §5.4).
  it('maps every clip', () => {
    expect(Object.keys(CLIP_ANIM).sort()).toEqual([...CLIPS].sort())
    for (const c of CLIPS) expect(PIXEL_ANIMS).toContain(animFor(c))
    expect(animFor('SitLaptop')).toBe('sit-type')
    expect(animFor('StandTalk')).toBe('idle-talk')
    expect(animFor('HeadScratch')).toBe('confused')
    expect(animFor('ShelfPick')).toBe('stand-interact')
    expect(animFor('SitDown')).toBe('sit')
    expect(animFor(undefined)).toBe('idle')
  })

  // AN-2: one walk frame every 8 on-screen px, so feet never slide at any speed (player or agent).
  it('derives the walk frame rate from on-screen speed', () => {
    expect(STRIDE_PX).toBe(8)
    expect(walkFps(3)).toBeCloseTo(6) // the player: 48 px/s
    expect(walkFps(5)).toBeCloseTo(10) // running
    expect(walkFps(1.4)).toBeCloseTo(2.8) // an agent strolling at 22.4 px/s
    expect(walkFps(0)).toBe(0)
    expect(frameAt(0.26, 4, 8)).toBe(2)
    expect(frameAt(1.0, 4, 8)).toBe(0)
    expect(frameAt(5, 1, 8)).toBe(0)
  })

  // AN-3: props become overlays in a stable order.
  it('lists prop overlays', () => {
    const v = npcVisual({ status: 'tool', clip: 'SitType', speed: 0, props: ['laptop', 'cup'] })
    expect(v.props).toEqual(['cup', 'laptop'])
  })

  // AN-status: the icon follows the business status even while walking.
  it('takes the status icon from the business status, not the clip', () => {
    const walking = npcVisual({ status: 'waiting', clip: 'Walk', speed: 1.2, props: [] })
    expect(walking.anim).toBe('walk')
    expect(walking.icon).toBe('waiting')
    expect(walking.fps).toBeCloseTo(walkFps(1.2))
    expect(statusIcon('error')).toBe('error')
    expect(statusIcon('thinking')).toBe('thinking')
    expect(statusIcon('tool')).toBe('tool')
    expect(statusIcon('idle')).toBeNull()
    expect(statusIcon('done')).toBeNull()
    expect(
      npcVisual({ status: 'idle', clip: 'Idle', speed: 0, props: [], leaving: true }).anim,
    ).toBe('elevator-out')
  })
})
