import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import type { ProviderSurfaces } from '../capability-vm.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { buildPixelMap } from './map.ts'
import {
  INTERACT_RANGE_M,
  interactionTarget,
  objectTargets,
  promptFor,
  slotCapability,
  type InteractObject,
} from './interact.ts'

const player = { pos: { x: 0, z: 0 }, facing: 's' as const }
const box = (x: number, z: number, hw = 0.25): InteractObject => ({
  id: `o@${x},${z}`,
  target: { kind: 'object', object: 'sign', label: 'S' },
  box: { minX: x - hw, maxX: x + hw, minZ: z - hw, maxZ: z + hw },
})

describe('interactionTarget (IN)', () => {
  // IN-1: the nearest thing in the 90° cone in front wins.
  it('picks the nearest target in the facing cone', () => {
    const hit = interactionTarget(
      player,
      [
        { id: 'far', pos: { x: 0, z: 1.1 } },
        { id: 'near', pos: { x: 0.3, z: 0.8 } },
      ],
      [],
    )
    expect(hit?.target).toEqual({ kind: 'agent', id: 'near' })
    expect(hit?.distance).toBeCloseTo(Math.hypot(0.3, 0.8))
  })

  // IN-2: an agent beats a closer object.
  it('prefers agents over objects', () => {
    const hit = interactionTarget(player, [{ id: 'ada', pos: { x: 0, z: 1 } }], [box(0, 0.6)])
    expect(hit?.target).toEqual({ kind: 'agent', id: 'ada' })
    expect(interactionTarget(player, [], [box(0, 0.6)])?.target.kind).toBe('object')
  })

  // IN-3: beyond 1.2 m nothing is reachable (objects measure to their nearest edge).
  it('returns null out of range', () => {
    expect(INTERACT_RANGE_M).toBe(1.2)
    expect(interactionTarget(player, [{ id: 'a', pos: { x: 0, z: 1.3 } }], [])).toBeNull()
    expect(interactionTarget(player, [], [box(0, 1.6)])).toBeNull()
    expect(interactionTarget(player, [], [box(0, 1.4, 0.5)])).not.toBeNull()
  })

  // IN-4: behind or beside (outside ±45°) gives null.
  it('ignores targets behind or beside the player', () => {
    expect(interactionTarget(player, [{ id: 'a', pos: { x: 0, z: -0.8 } }], [])).toBeNull()
    expect(interactionTarget(player, [{ id: 'a', pos: { x: 0.8, z: 0.3 } }], [])).toBeNull()
    expect(
      interactionTarget({ ...player, facing: 'e' }, [{ id: 'a', pos: { x: 0.8, z: 0.3 } }], []),
    ).not.toBeNull()
  })

  // IN-5: a subagent resolves with its parent (its dialogue offers "Go to <parent>").
  it('carries the parent of a subagent', () => {
    const hit = interactionTarget(player, [{ id: 'sub', pos: { x: 0, z: 1 }, parentId: 'ada' }], [])
    expect(hit).toMatchObject({ target: { kind: 'agent', id: 'sub' }, parentId: 'ada' })
    expect(promptFor(hit!.target)).toBe(PIXEL_COPY.prompt.talk)
    expect(promptFor({ kind: 'capability', ref: { provider: 'p', id: 'x' } })).toBe(
      PIXEL_COPY.prompt.open,
    )
    expect(promptFor({ kind: 'object', object: 'sign' })).toBe(PIXEL_COPY.prompt.read)
  })

  it('turns map objects into targets, resolving capability slots from the surfaces', () => {
    const layout = planBuilding([{ provider: 'p', agents: 1 }], fixtureManifest, undefined, 0)
    const map = buildPixelMap(
      layout,
      {
        wing: {
          rooms: [],
          walls: [],
          furniture: [
            { kind: 'station', x: 1, z: 1, w: 1, d: 1, yaw: 0, ref: 'station:1' },
            { kind: 'bookshelf', x: 3, z: 1, w: 2, d: 0.5, yaw: 0, ref: 'book:5' },
            { kind: 'elevator', x: 5, z: 1, w: 1, d: 1, yaw: 0 },
            { kind: 'desk', x: 7, z: 1, w: 1, d: 1, yaw: 0 },
          ],
        },
      },
      { tile: () => 1 },
    )
    const slot = <T>(id: string) => ({ id, vm: {} as T, glow: 0, color: '#000' })
    const surfaces = new Map<string, ProviderSurfaces>([
      [
        'p',
        {
          stations: [undefined, slot('fs')],
          books: [],
          boards: [],
          notebooks: [],
          activeAdapters: 0,
        },
      ],
    ])
    const resolve = slotCapability(layout, surfaces)
    const objs = objectTargets(map, resolve)
    expect(objs.map((o) => o.target)).toEqual([
      { kind: 'capability', ref: { provider: 'p', id: 'fs' } },
      { kind: 'object', object: 'elevator' },
    ])
    const station = objs[0]!
    expect(station.box.maxX - station.box.minX).toBeCloseTo(1)
    expect(resolve('nowhere', 'station:1')).toBeUndefined()
    // Books and notebooks come from the layout's ports (the plan has no ref for them).
    surfaces.get('p')!.books = [undefined, undefined, slot('skill:pdf')]
    const withBooks = objectTargets(map, slotCapability(layout, surfaces), layout.ports)
    const book = withBooks.find((o) => o.id === 'wing:p:0/book:2')!
    expect(book.target).toEqual({ kind: 'capability', ref: { provider: 'p', id: 'skill:pdf' } })
    const port = layout.ports!.get('wing:p:0/port:book:2')!
    expect((book.box.minX + book.box.maxX) / 2).toBeCloseTo(port.x)
    expect(withBooks.filter((o) => o.id.includes('/book:'))).toHaveLength(1)
    expect(resolve('wing:p:0', 'board:0')).toBeUndefined()
  })
})
