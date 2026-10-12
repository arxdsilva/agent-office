import { describe, expect, it } from 'vitest'
import { fixtureManifest, fixtureManifestJson } from './__fixtures__/manifest.ts'
import {
  BAY_LENGTH,
  WING_GRACE_MS,
  anchorId,
  hash32,
  parseAnchorId,
  planBuilding,
  toWorld,
  type ProviderDemand,
} from './building.ts'
import { parseManifest } from './manifest.ts'
import type { BuildingLayout, ModulePlacement } from './office-types.ts'

const m = fixtureManifest
const d = (...pairs: [string, number][]): ProviderDemand[] =>
  pairs.map(([provider, agents]) => ({ provider, agents }))
const wing = (l: BuildingLayout, provider: string, annex = 0) =>
  l.placements.find((p) => p.kind === 'wing' && p.provider === provider && p.annex === annex)
const kinds = (l: BuildingLayout) => l.placements.map((p) => p.id)
const pose = (p: ModulePlacement | undefined) =>
  p && { bay: p.bay, side: p.side, position: p.position, yaw: p.yaw }

/** Ids reachable from `start` in the merged graph. */
function reachable(l: BuildingLayout, start: string) {
  const seen = new Set([start])
  const stack = [start]
  while (stack.length)
    for (const n of l.nav.adj.get(stack.pop()!) ?? [])
      if (!seen.has(n)) (seen.add(n), stack.push(n))
  return seen
}

describe('planBuilding', () => {
  it('builds an empty office: atrium, one street with gardens on both sides, and a cap', () => {
    const l = planBuilding([], m, undefined, 0)
    expect(kinds(l)).toEqual(['atrium', 'street:0', 'garden:0:R', 'garden:0:L', 'cap'])
    expect(l.placements.find((p) => p.id === 'cap')!.position).toEqual({ x: 0, z: BAY_LENGTH })
    expect(l.wingsByProvider.size).toBe(0)
    expect(l.bounds).toEqual({ minX: -27, maxX: 27, minZ: -24, maxZ: 18.5 })
  })

  it('places 1–7 providers in bay order: bay0-R, bay0-L, bay1-R, …', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    let l: BuildingLayout | undefined
    // Providers arrive one at a time, so the order is arrival order.
    for (let i = 0; i < names.length; i++) {
      l = planBuilding(
        d(...names.slice(0, i + 1).map((n) => [n, 1] as [string, number])),
        m,
        l,
        i * 1000,
      )
      const w = wing(l, names[i]!)!
      expect(w.bay).toBe(Math.floor(i / 2))
      expect(w.side).toBe(i % 2 ? 'L' : 'R')
      expect(w.position).toEqual({ x: i % 2 ? -3 : 3, z: BAY_LENGTH * Math.floor(i / 2) + 9 })
      expect(w.yaw).toBe(i % 2 ? Math.PI : 0)
    }
    // 7 wings → 4 bays; the empty side is a garden and the cap closes bay 3.
    expect(l!.placements.filter((p) => p.kind === 'street')).toHaveLength(4)
    expect(l!.placements.find((p) => p.id === 'garden:3:L')).toBeDefined()
    expect(l!.placements.find((p) => p.kind === 'cap')!.position.z).toBe(72)
  })

  it('places several new providers of one update in name order (deterministic)', () => {
    const l = planBuilding(d(['zeta', 1], ['alpha', 2], ['mid', 1]), m, undefined, 0)
    expect(['alpha', 'mid', 'zeta'].map((p) => wing(l, p)!.id)).toEqual([
      'wing:alpha:0',
      'wing:mid:0',
      'wing:zeta:0',
    ])
    expect(wing(l, 'alpha')!.side).toBe('R')
    expect(wing(l, 'mid')!.side).toBe('L')
    // Duplicate demand rows add up; zero-agent providers get no wing.
    const dup = planBuilding(d(['x', 20], ['x', 10], ['y', 0]), m, undefined, 0)
    expect(dup.wingsByProvider.get('x')).toHaveLength(2)
    expect(dup.wingsByProvider.has('y')).toBe(false)
  })

  it('never moves existing wings when a provider is added', () => {
    const first = planBuilding(d(['claude-code', 3], ['langgraph', 2]), m, undefined, 0)
    const second = planBuilding(
      d(['claude-code', 3], ['langgraph', 2], ['openai-agents', 1]),
      m,
      first,
      1000,
    )
    for (const p of ['claude-code', 'langgraph'])
      expect(pose(wing(second, p))).toEqual(pose(wing(first, p)))
    // Existing anchors keep their world positions.
    const id = anchorId('wing:claude-code:0', 'seat:desk:2:1')
    expect(second.anchors.get(id)).toEqual(first.anchors.get(id))
    expect(second.key).not.toBe(first.key)
  })

  it('gives a provider with more than 24 agents an annex in its next free slot', () => {
    const first = planBuilding(d(['claude-code', 10], ['langgraph', 3]), m, undefined, 0)
    const l = planBuilding(d(['claude-code', 30], ['langgraph', 3]), m, first, 1000)
    expect(l.wingsByProvider.get('claude-code')).toEqual([
      'wing:claude-code:0',
      'wing:claude-code:1',
    ])
    const annex = wing(l, 'claude-code', 1)!
    expect(annex.bay).toBe(1)
    expect(annex.side).toBe('R')
    expect(annex.label).toBe('claude-code · 2')
    expect(wing(l, 'claude-code')!.label).toBe('claude-code')
    expect(annex.theme).toBe('terracotta')
    expect(pose(wing(l, 'langgraph'))).toEqual(pose(wing(first, 'langgraph')))
    expect(planBuilding(d(['p', 49]), m, undefined, 0).wingsByProvider.get('p')).toHaveLength(3)
  })

  it('dims a removed provider for 60 s, then frees the slot without compacting', () => {
    const t0 = 0
    const l0 = planBuilding(d(['a', 1], ['b', 1], ['c', 1]), m, undefined, t0)
    const cPose = pose(wing(l0, 'c'))
    // b goes away: its wing stays but dims.
    const l1 = planBuilding(d(['a', 1], ['c', 1]), m, l0, t0 + 1000)
    expect(wing(l1, 'b')!.dimmed).toBe(true)
    expect(wing(l1, 'a')!.dimmed).toBeUndefined()
    expect(l1.key).not.toBe(l0.key)
    const l2 = planBuilding(d(['a', 1], ['c', 1]), m, l1, t0 + WING_GRACE_MS - 1)
    expect(wing(l2, 'b')).toBeDefined()
    // After the grace period the slot becomes a garden; c does not move.
    const l3 = planBuilding(d(['a', 1], ['c', 1]), m, l2, t0 + WING_GRACE_MS)
    expect(wing(l3, 'b')).toBeUndefined()
    expect(l3.placements.find((p) => p.id === 'garden:0:L')).toBeDefined()
    expect(pose(wing(l3, 'c'))).toEqual(cPose)
    expect(l3.wingsByProvider.has('b')).toBe(false)
    // A newcomer takes the first free slot.
    const l4 = planBuilding(d(['a', 1], ['c', 1], ['d', 1]), m, l3, t0 + WING_GRACE_MS + 1)
    expect(wing(l4, 'd')!.side).toBe('L')
    expect(wing(l4, 'd')!.bay).toBe(0)
  })

  it('un-dims a provider that comes back within the grace period, in the same slot', () => {
    const l0 = planBuilding(d(['a', 1], ['b', 1]), m, undefined, 0)
    const l1 = planBuilding(d(['a', 1]), m, l0, 1000)
    const l2 = planBuilding(d(['a', 1], ['b', 2]), m, l1, 30_000)
    expect(wing(l2, 'b')!.dimmed).toBeUndefined()
    expect(pose(wing(l2, 'b'))).toEqual(pose(wing(l0, 'b')))
    expect(l2.key).toBe(l0.key)
    // Grace counts from the last time the wing was needed.
    const l3 = planBuilding(d(['a', 1]), m, l2, 31_000)
    expect(wing(planBuilding(d(['a', 1]), m, l3, 30_000 + WING_GRACE_MS - 1), 'b')).toBeDefined()
  })

  it('releases an annex that is no longer needed after the grace period', () => {
    const l0 = planBuilding(d(['a', 30]), m, undefined, 0)
    const l1 = planBuilding(d(['a', 10]), m, l0, 1000)
    expect(wing(l1, 'a', 1)!.dimmed).toBe(true)
    expect(wing(l1, 'a', 0)!.dimmed).toBeUndefined()
    const l2 = planBuilding(d(['a', 10]), m, l1, WING_GRACE_MS + 1)
    expect(l2.wingsByProvider.get('a')).toEqual(['wing:a:0'])
  })

  it('pins themes for known providers and gives others the first unused theme in hash order', () => {
    const l = planBuilding(
      d(['langgraph', 1], ['openai-agents', 1], ['claude-code', 1], ['crew', 1], ['autogen', 1]),
      m,
      undefined,
      0,
    )
    expect(wing(l, 'claude-code')!.theme).toBe('terracotta')
    expect(wing(l, 'openai-agents')!.theme).toBe('nordic')
    expect(wing(l, 'langgraph')!.theme).toBe('forest')
    const others = [wing(l, 'crew')!.theme, wing(l, 'autogen')!.theme]
    for (const t of others) expect(['ocean', 'neon', 'brass']).toContain(t)
    expect(new Set(others).size).toBe(2)
    // Same inputs → same themes.
    const again = planBuilding(
      d(['crew', 1], ['autogen', 1], ['langgraph', 1], ['openai-agents', 1], ['claude-code', 1]),
      m,
      undefined,
      0,
    )
    expect(wing(again, 'crew')!.theme).toBe(wing(l, 'crew')!.theme)
  })

  it('repeats themes with a different sign variant beyond six providers', () => {
    const names = Array.from({ length: 8 }, (_, i) => `p${i}`)
    const l = planBuilding(d(...names.map((n) => [n, 1] as [string, number])), m, undefined, 0)
    const wings = l.placements.filter((p) => p.kind === 'wing')
    const firstUse = wings.filter((w) => w.signVariant === 0)
    expect(new Set(firstUse.map((w) => w.theme)).size).toBe(6)
    expect(wings.filter((w) => w.signVariant === 1)).toHaveLength(2)
    // Unpinned providers prefer unpinned themes while any are free.
    const one = planBuilding(d(['solo', 1]), m, undefined, 0)
    expect(['ocean', 'neon', 'brass']).toContain(wing(one, 'solo')!.theme)
  })

  it('uses only the themes the manifest ships', () => {
    const only = parseManifest(fixtureManifestJson(['terracotta']))
    const l = planBuilding(d(['langgraph', 1], ['x', 1], ['claude-code', 1]), only, undefined, 0)
    const wings = l.placements.filter((p) => p.kind === 'wing')
    expect(wings.every((w) => w.theme === 'terracotta')).toBe(true)
    expect(wings.map((w) => w.signVariant).sort()).toEqual([0, 1, 2])
    expect(wing(l, 'claude-code')!.theme).toBe('terracotta')
  })

  it('rotates left-side wings by π so their anchors face the correct way', () => {
    const l = planBuilding(d(['a', 1], ['b', 1]), m, undefined, 0)
    const local = m.modules.wing.anchors['seat:desk:1:0']!
    const right = l.anchors.get(anchorId('wing:a:0', 'seat:desk:1:0'))!
    const left = l.anchors.get(anchorId('wing:b:0', 'seat:desk:1:0'))!
    expect(right.pos).toEqual({ x: local.x + 3, z: local.z + 9 })
    expect(left.pos.x).toBeCloseTo(-local.x - 3)
    expect(left.pos.z).toBeCloseTo(-local.z + 9)
    expect(right.heading).toBeCloseTo(local.heading)
    expect(Math.cos(left.heading - (local.heading + Math.PI))).toBeCloseTo(1)
    // In both wings the seat faces its pod center (same relative layout, rotated, never mirrored).
    for (const [a, pid] of [
      [right, 'wing:a:0'],
      [left, 'wing:b:0'],
    ] as const) {
      const p = l.placements.find((x) => x.id === pid)!
      const center = toWorld({ x: 7, z: -3 }, p)
      const fwd = { x: Math.sin(a.heading), z: Math.cos(a.heading) }
      const toC = { x: center.x - a.pos.x, z: center.z - a.pos.z }
      expect(fwd.x * toC.x + fwd.z * toC.z).toBeGreaterThan(0)
      // The approach stays behind the seat.
      expect(fwd.x * (a.approach.x - a.pos.x) + fwd.z * (a.approach.z - a.pos.z)).toBeCloseTo(-0.6)
    }
    expect(right).toMatchObject({
      placement: 'wing:a:0',
      local: 'seat:desk:1:0',
      pose: 'sit',
      room: 'pod-1',
    })
    expect(right.screen).toBe('desk:1:0')
    // Headings stay normalized to (−π, π].
    for (const a of l.anchors.values())
      expect(a.heading > -Math.PI - 1e-9 && a.heading <= Math.PI + 1e-9).toBe(true)
  })

  it('merges module graphs at connector nodes into one connected graph', () => {
    const l = planBuilding(d(['a', 1], ['b', 1], ['c', 30]), m, undefined, 0)
    const all = reachable(l, 'atrium/entry')
    expect(all.size).toBe(l.nav.nodes.size)
    // Coincident connector nodes collapse into one (the first placed module keeps its id).
    expect(l.nav.nodes.has('street:0/s:0')).toBe(false)
    expect(l.nav.adj.get('atrium/entry')).toContain('street:0/s:3')
    expect(l.nav.nodes.has('wing:a:0/door')).toBe(false)
    expect(l.nav.adj.get('street:0/door:R')).toContain('wing:a:0/g:2:0')
    expect(l.nav.adj.get('street:0/door:L')).toContain('wing:b:0/g:2:0')
    expect(l.nav.nodes.has('cap/end')).toBe(false)
    expect(l.nav.nodes.has('street:1/s:18')).toBe(true)
    expect(l.nav.adj.get('street:1/s:18')).toContain('street:1/s:15')
    // Adjacency is symmetric and has no self loops or duplicates.
    for (const [id, ns] of l.nav.adj) {
      expect(new Set(ns).size).toBe(ns.length)
      expect(ns).not.toContain(id)
      for (const n of ns) expect(l.nav.adj.get(n)).toContain(id)
    }
  })

  it('links every anchor to a world nav node at its approach point', () => {
    const l = planBuilding(d(['a', 1]), m, undefined, 0)
    expect(l.anchors.size).toBe(
      Object.keys(m.modules.atrium.anchors).length +
        Object.keys(m.modules.wing.anchors).length +
        Object.keys(m.modules.garden.anchors).length,
    )
    for (const a of l.anchors.values()) {
      const n = l.nav.nodes.get(a.navNode!)!
      expect(n).toBeDefined()
      expect(Math.hypot(n.pos.x - a.approach.x, n.pos.z - a.approach.z)).toBeLessThan(0.05)
    }
  })

  it('falls back to the nearest nav node when an anchor has no ap: node', () => {
    const j = fixtureManifestJson() as any
    delete j.modules.wing.nav.nodes['ap:spot:booth:0']
    j.modules.wing.nav.edges = j.modules.wing.nav.edges.filter(
      (e: string[]) => !e.includes('ap:spot:booth:0'),
    )
    const l = planBuilding(d(['a', 1]), parseManifest(j), undefined, 0)
    const a = l.anchors.get('wing:a:0/spot:booth:0')!
    expect(l.nav.nodes.has(a.navNode!)).toBe(true)
  })

  it('keeps the key and reuses anchors and nav while placements are unchanged', () => {
    const l0 = planBuilding(d(['a', 3]), m, undefined, 0)
    const l1 = planBuilding(d(['a', 5]), m, l0, 1000)
    expect(l1.key).toBe(l0.key)
    expect(l1.anchors).toBe(l0.anchors)
    expect(l1.nav).toBe(l0.nav)
    expect(l1.slots![0]!.lastNeeded).toBe(1000)
  })

  it('computes world bounds over all modules', () => {
    const l = planBuilding(d(['a', 1], ['b', 1], ['c', 1]), m, undefined, 0)
    expect(l.bounds).toEqual({ minX: -27, maxX: 27, minZ: -24, maxZ: 36.5 })
  })
})

describe('helpers', () => {
  it('anchor ids round-trip', () => {
    expect(anchorId('wing:a:0', 'seat:desk:3:2')).toBe('wing:a:0/seat:desk:3:2')
    expect(parseAnchorId('wing:a:0/seat:desk:3:2')).toEqual({
      placement: 'wing:a:0',
      local: 'seat:desk:3:2',
    })
    expect(parseAnchorId('nonsense')).toEqual({ placement: '', local: 'nonsense' })
  })

  it('hash32 is stable and spreads', () => {
    expect(hash32('abc')).toBe(hash32('abc'))
    expect(hash32('abc')).not.toBe(hash32('abd'))
    expect(hash32('x')).toBeGreaterThanOrEqual(0)
  })
})
