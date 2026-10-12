import { describe, expect, it } from 'vitest'
import { builtins, cap } from './__fixtures__/capabilities.ts'
import { fixtureManifest } from './__fixtures__/manifest.ts'
import { CALL_FADE_MS, LIBRARY_FADE_MS } from './behavior.ts'
import { planBuilding } from './building.ts'
import { hiddenPose } from './choreography.ts'
import { assignLibrary } from './library.ts'
import {
  ARC_LIFT,
  ARC_MAX_Y,
  LINK_COLORS,
  SEATED_HEAD_Y,
  STANDING_HEAD_Y,
  agentPort,
  arcControl,
  handPort,
  linkColor,
  linksForMode,
  planLinks,
  type LinkCall,
} from './links.ts'
import type { AgentPose } from './office-types.ts'
import { assignStations } from './stations.ts'

const layout = planBuilding([{ provider: 'claude-code', agents: 4 }], fixtureManifest, undefined, 0)
const W = 'wing:claude-code:0'
const caps = [
  ...builtins(),
  ...Array.from({ length: 6 }, (_, i) => cap(`mcp:server${i}`)),
  cap('mcp:postgres'),
  cap('skill:run-office'),
  cap('rule:project:TESTING.md'),
  cap('memory:notes'),
  cap('api:crm'),
]
const byId = new Map(caps.map((c) => [c.id, c]))
const ctx = {
  layout,
  stations: new Map([['claude-code', assignStations(caps)]]),
  library: new Map([['claude-code', assignLibrary(caps)]]),
}
const FROM = { x: 0, y: 1.25, z: 0 }
const call = (id: string, over: Partial<LinkCall> = {}): LinkCall => ({
  agentId: 'a',
  capability: byId.get(id)!,
  wing: W,
  from: FROM,
  since: 0,
  last: 1000,
  visiting: false,
  ...over,
})
const port = (id: string) => layout.ports!.get(`${W}/${id}`)!

describe('arcControl', () => {
  it('rises above the higher end by 0.15 × distance, clamped to [0.8, 3] and the 3.4 m envelope', () => {
    const near = arcControl({ x: 0, y: 1, z: 0 }, { x: 2, y: 1.2, z: 0 })
    expect(near).toEqual({ x: 1, y: 1.2 + ARC_LIFT.min, z: 0 })
    const mid = arcControl({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 10 })
    expect(mid.y).toBeCloseTo(1 + 1.5)
    const far = arcControl({ x: 0, y: 1, z: 0 }, { x: 0, y: 2.3, z: 40 })
    expect(far.y).toBe(ARC_MAX_Y)
    expect(ARC_LIFT).toEqual({ factor: 0.15, min: 0.8, max: 3 })
  })
})

describe('linkColor', () => {
  it('colors adapters by kind and the library by category', () => {
    expect(linkColor(cap('fs'))).toBe('#4F8CFF')
    expect(linkColor(cap('shell'))).toBe('#F5A524')
    expect(linkColor(cap('web'))).toBe('#2CB6A0')
    expect(linkColor(cap('subagents'))).toBe('#8B5CF6')
    expect(linkColor(cap('mcp:github'))).toBe('#EC4899')
    expect(linkColor(cap('mcp:postgres'))).toBe('#22C55E')
    expect(linkColor(cap('api:crm'))).toBe('#F97316')
    expect(linkColor(cap('skill:x'))).toBe(LINK_COLORS.skill)
    expect(linkColor(cap('rule:user:CLAUDE.md'))).toBe(LINK_COLORS.rule)
    expect(linkColor(cap('memory:m'))).toBe(LINK_COLORS.memory)
    expect(linkColor(cap('x', { kind: 'other' }))).toBe(LINK_COLORS.api)
  })
})

describe('planLinks', () => {
  it('links an adapter call from the agent port to its station port, as dashes', () => {
    const [l] = planLinks([call('shell')], ctx, 1000)
    expect(l).toMatchObject({
      id: 'a>shell',
      agentId: 'a',
      capabilityId: 'shell',
      category: 'adapter',
      from: FROM,
      to: port('port:station:1'),
      color: '#F5A524',
      label: 'shell',
      style: 'dash',
      state: 'calling',
      since: 0,
      opacity: 1,
    })
    expect(l!.control).toEqual(arcControl(FROM, port('port:station:1')))
  })

  it('links overflowed adapters to the "+N more" station 7', () => {
    expect(planLinks([call('api:crm')], ctx, 1000)[0]!.to).toEqual(port('port:station:7'))
  })

  it('links skills to their book, rules to their board and memory to its notebook, as particles', () => {
    const [skill, rule, memory] = planLinks(
      [call('skill:run-office'), call('rule:project:TESTING.md'), call('memory:notes')],
      ctx,
      1000,
    )
    expect(skill).toMatchObject({
      to: port('port:book:0'),
      style: 'particles',
      color: LINK_COLORS.skill,
    })
    expect(rule).toMatchObject({ to: port('port:board:0'), color: LINK_COLORS.rule })
    expect(memory).toMatchObject({ to: port('port:notebook:0'), color: LINK_COLORS.memory })
  })

  it('fades out after the use ends: 0.6 s for adapters, 1.5 s for the library', () => {
    expect(planLinks([call('fs')], ctx, 1000 + CALL_FADE_MS / 2)[0]!.opacity).toBeCloseTo(0.5)
    expect(planLinks([call('fs')], ctx, 1000 + CALL_FADE_MS)).toEqual([])
    expect(
      planLinks([call('skill:run-office')], ctx, 1000 + LIBRARY_FADE_MS / 2)[0]!.opacity,
    ).toBeCloseTo(0.5)
    expect(planLinks([call('skill:run-office')], ctx, 1000 + LIBRARY_FADE_MS)).toEqual([])
    // A visit keeps its link at full strength while it lasts.
    expect(planLinks([call('fs', { visiting: true })], ctx, 60_000)[0]).toMatchObject({
      state: 'visiting',
      opacity: 1,
    })
  })

  it('skips capabilities without a slot or a port', () => {
    const other = cap('skill:not-assigned')
    expect(planLinks([call('fs', { capability: other })], ctx, 1000)).toEqual([])
    expect(planLinks([call('fs', { wing: 'wing:nobody:0' })], ctx, 1000)).toEqual([])
    expect(planLinks([call('fs')], { ...ctx, stations: new Map() }, 1000)).toEqual([])
  })
})

describe('agent ports', () => {
  const at = (over: Partial<AgentPose>): AgentPose => ({ ...hiddenPose(), visible: true, ...over })

  it('starts at the desk monitor port when seated at a desk', () => {
    const seat = layout.anchors.get(`${W}/seat:desk:2:1`)!
    expect(agentPort(at({ pos: seat.pos, posture: 'sit', anchor: seat.id }), layout)).toEqual(
      port('port:desk:2:1'),
    )
  })

  it('starts at head height elsewhere (seated or walking)', () => {
    const meet = layout.anchors.get(`${W}/seat:meeting:A:0`)!
    expect(agentPort(at({ pos: meet.pos, posture: 'sit', anchor: meet.id }), layout)).toEqual({
      ...meet.pos,
      y: SEATED_HEAD_Y,
    })
    expect(agentPort(at({ pos: { x: 1, z: 2 } }), layout)).toEqual({
      x: 1,
      y: STANDING_HEAD_Y,
      z: 2,
    })
  })

  it('starts at the hand while visiting', () => {
    const h = handPort(at({ pos: { x: 0, z: 0 }, heading: 0 }))
    expect(h.x).toBeCloseTo(0)
    expect(h.z).toBeGreaterThan(0)
    expect(handPort(at({ posture: 'sit' })).y).toBeLessThan(h.y)
  })
})

describe('linksForMode (LK-1)', () => {
  const l = (id: string, style: 'dash' | 'particles') =>
    ({
      id,
      agentId: 'a',
      capabilityId: id,
      category: 'adapter',
      from: { x: 0, y: 1, z: 0 },
      to: { x: 1, y: 1, z: 1 },
      control: { x: 0.5, y: 2, z: 0.5 },
      color: '#fff',
      label: id,
      style,
      state: 'calling',
      since: 0,
      opacity: 1,
    }) as const
  const links = [l('fs', 'dash'), l('skill:x', 'particles')]

  it('off draws no links', () => {
    expect(linksForMode(links, 'off')).toEqual([])
  })

  it('static marks every link as a straight line', () => {
    const out = linksForMode(links, 'static')
    expect(out.map((x) => x.style)).toEqual(['line', 'line'])
    expect(out.map((x) => x.id)).toEqual(['fs', 'skill:x'])
  })

  it('animated keeps them as planned', () => {
    expect(linksForMode(links, 'animated')).toBe(links)
  })
})
