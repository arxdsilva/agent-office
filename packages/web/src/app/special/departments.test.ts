// Departments (plan §5.4): the classic wing order decides each provider's department, and the
// director's intents map onto Night City anchors (workstations, booths, meeting rooms, lounges).
import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import type { AgentPlan, BuildingLayout, Intent, WingSlot } from '../office-types.ts'
import { createStageMap, departmentOf, departmentOrder, MAX_DEPARTMENTS } from './departments.ts'
import { buildSpecialWorld, parseSpecialManifest } from './world.ts'

const a = (x: number, z: number, pose = 'stand') => ({
  x,
  y: 0,
  z,
  heading: 0,
  pose,
  approach: { x, z: z - 0.6 },
})

function world() {
  const anchors: Record<string, ReturnType<typeof a>> = {
    'spot:elevator:0': a(-9, 0),
    'spot:elevator:1': a(-9, 2),
    'spot:reception:0': a(-5, 0),
    'seat:lounge:0': a(5, 5, 'lounge'),
    'seat:lounge:1': a(6, 5, 'lounge'),
    'booth:0': a(0, 9),
    'booth:1': a(1, 9),
    'meet:A:0': a(8, 0, 'sit'),
    'meet:A:1': a(8, 1, 'sit'),
    'spot:terminal:0': a(-3, 9),
  }
  for (let d = 0; d < 2; d++)
    for (let p = 1; p <= 2; p++)
      for (let s = 0; s < 2; s++) anchors[`ws:${d}:${p}:${s}`] = a(d * 4 + p, s, 'sit')
  return buildSpecialWorld(
    parseSpecialManifest({
      version: 1,
      set: 'special',
      hash: 'd',
      modules: {
        'hq-atrium': {
          bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
          anchors,
          nav: { nodes: { n: { x: 0, z: 0, width: 1 } }, edges: [] },
        },
      },
    }),
  )
}

const slot = (index: number, provider: string, annex = 0): WingSlot => ({
  index,
  provider,
  annex,
  theme: 'nordic',
  signVariant: 0,
  lastNeeded: 0,
})

const plan = (id: string, provider: string, intent: Partial<Intent>): AgentPlan => ({
  agent: { id, provider, name: id, status: 'tool' } as Agent,
  intent: { activity: 'desk-work', target: '', since: 0, ...intent },
})

describe('departmentOrder', () => {
  it('follows the classic wing slots (pinned/hash order), main wings only', () => {
    const layout = {
      slots: [slot(2, 'gemini'), slot(0, 'codex'), slot(1, 'claude-code'), slot(3, 'codex', 1)],
    } as unknown as BuildingLayout
    expect(departmentOrder(layout, [])).toEqual(['codex', 'claude-code', 'gemini'])
  })

  it('falls back to the sorted providers of the plans without a layout', () => {
    expect(departmentOrder(null, ['b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('caps departments at six; later providers share the overflow', () => {
    const order = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    expect(MAX_DEPARTMENTS).toBe(6)
    expect(departmentOf('p5', order)).toBe(5)
    expect(departmentOf('p6', order)).toBeNull()
    expect(departmentOf('zz', order)).toBeNull()
  })
})

describe('createStageMap', () => {
  const order = ['codex', 'claude-code']

  it('keeps the director’s desk: wing:<p>:0/seat:desk:P:S → ws:<dept>:P:S', () => {
    const m = createStageMap(world())
    const i = m.map(
      plan('a1', 'claude-code', { target: 'wing:claude-code:0/seat:desk:2:1' }),
      order,
    )
    expect(i.target).toBe('hq-atrium/ws:1:2:1')
    expect(i.activity).toBe('desk-work')
  })

  it('gives another free seat of the department when the desk is unknown or taken', () => {
    const m = createStageMap(world())
    m.map(plan('a1', 'codex', { target: 'wing:codex:0/seat:desk:1:0' }), order)
    const b = m.map(plan('b1', 'codex', { target: 'wing:codex:1/seat:desk:1:0' }), order)
    expect(b.target).toMatch(/^hq-atrium\/ws:0:/)
    expect(b.target).not.toBe('hq-atrium/ws:0:1:0')
  })

  it('seats overflow providers at any free workstation', () => {
    const m = createStageMap(world())
    const i = m.map(plan('x', 'cursor', { target: 'wing:cursor:0/seat:desk:1:0' }), order)
    expect(i.target).toMatch(/\/ws:\d:\d:\d$/)
  })

  it('keeps a seat for the agent’s lifetime and frees it when the agent leaves the scene', () => {
    const m = createStageMap(world())
    const first = m.map(plan('a1', 'codex', { target: 'wing:codex:0/seat:desk:2:0' }), order)
    // A break and back: the same workstation.
    m.map(
      plan('a1', 'codex', { activity: 'kitchen', target: 'wing:codex:0/spot:kitchen:0' }),
      order,
    )
    const back = m.map(plan('a1', 'codex', { target: 'wing:codex:0/seat:desk:2:0' }), order)
    expect(back.target).toBe(first.target)
    m.drop('a1')
    const other = m.map(plan('b1', 'codex', { target: 'wing:codex:0/seat:desk:2:0' }), order)
    expect(other.target).toBe(first.target)
  })

  it('sends waiting agents to a free booth, and back to the desk when none is free', () => {
    const m = createStageMap(world())
    const booth = (id: string) =>
      m.map(plan(id, 'codex', { activity: 'booth', target: 'wing:codex:0/spot:booth:0' }), order)
    expect(booth('a').target).toBe('hq-atrium/booth:0')
    expect(booth('b').target).toBe('hq-atrium/booth:1')
    const c = booth('c')
    expect(c.target).toMatch(/\/ws:0:/)
    expect(c.activity).toBe('booth')
    // Same agent again: keeps its booth.
    expect(booth('a').target).toBe('hq-atrium/booth:0')
  })

  it('maps a team meeting onto one shared room, seat by seat', () => {
    const m = createStageMap(world())
    const meet = (id: string, seat: number, wing = 'codex') =>
      m.map(
        plan(id, wing, { activity: 'meeting', target: `wing:${wing}:0/seat:meeting:B:${seat}` }),
        order,
      ).target
    expect(meet('p', 0)).toBe('hq-atrium/meet:A:0')
    expect(meet('q', 1)).toBe('hq-atrium/meet:A:1')
    // Another team while the only room is busy: they stay at their desks.
    expect(meet('r', 0, 'claude-code')).toMatch(/\/ws:1:/)
  })

  it('breaks go to lounge seats; capability visits to a terminal', () => {
    const m = createStageMap(world())
    expect(
      m.map(plan('a', 'codex', { activity: 'cafe', target: 'atrium/seat:cafe:3' }), order).target,
    ).toMatch(/seat:lounge:\d$/)
    expect(
      m.map(
        plan('b', 'codex', { activity: 'connection-visit', target: 'wing:codex:0/spot:station:2' }),
        order,
      ).target,
    ).toBe('hq-atrium/spot:terminal:0')
    expect(
      m.map(
        plan('c', 'codex', { activity: 'library-call', target: 'wing:codex:0/seat:desk:2:1' }),
        order,
      ).target,
    ).toBe('hq-atrium/ws:0:2:1')
  })

  it('arrivals come by elevator past reception; leaving heads to an elevator', () => {
    const m = createStageMap(world())
    const arr = m.map(
      plan('a', 'codex', {
        activity: 'arriving',
        target: 'wing:codex:0/seat:desk:1:0',
        via: ['atrium/spot:elevator:3', 'atrium/spot:reception:1'],
      }),
      order,
    )
    expect(arr.target).toBe('hq-atrium/ws:0:1:0')
    expect(arr.via?.[0]).toMatch(/^hq-atrium\/spot:elevator:\d$/)
    expect(arr.via?.[1]).toBe('hq-atrium/spot:reception:0')
    const out = m.map(
      plan('a', 'codex', { activity: 'leaving', target: 'atrium/spot:elevator:2' }),
      order,
    )
    expect(out.target).toMatch(/^hq-atrium\/spot:elevator:\d$/)
    expect(out.via).toBeUndefined()
  })

  it('reports where each agent is mapped (debug) and which workstation shows its status', () => {
    const m = createStageMap(world())
    m.map(plan('a', 'codex', { target: 'wing:codex:0/seat:desk:1:0' }), order)
    expect(m.deskOf('a')).toBe('hq-atrium/ws:0:1:0')
    expect(m.deskOf('zz')).toBeUndefined()
  })
})
