import { STATUS_COLORS, type Agent, type AgentStatus } from '@agent-office/shared'
import { byProviderAndTopic } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { fixtureManifest } from '../__fixtures__/manifest.ts'
import { planBuilding } from '../building.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { emptyState, type OfficeState } from '../state.ts'
import { directoryVM } from './directory-vm.ts'
import { MAX_ALERTS, alertsVM, pixelHudVM } from './hud-vm.ts'
import { minimapVM } from './minimap.ts'

const agent = (id: string, status: AgentStatus, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id.toUpperCase(),
  provider: 'p',
  topic: 't',
  status,
  source: 's',
  since: 0,
  lastSeen: 0,
  interactive: true,
  unread: 0,
  ...over,
})
function stateOf(agents: Agent[], perms: string[] = []): OfficeState {
  const s = emptyState()
  for (const a of agents) s.agents.set(a.id, a)
  for (const id of perms) s.permissions!.set(id, [{ id: 'perm_x', tool: 'Bash', summary: 'ls' }])
  return s
}

describe('pixel HUD (HUD)', () => {
  // HUD-1: the room comes straight from the scene; the selected chip names the agent.
  it('shows the room and the selected agent', () => {
    const s = stateOf([agent('a', 'thinking')])
    const vm = pixelHudVM({ state: s, room: 'p · Pod 2', selected: 'a' })
    expect(vm.room).toBe('p · Pod 2')
    expect(vm.selected).toEqual({ id: 'a', text: 'A · thinking' })
    expect(pixelHudVM({ state: s, room: '', selected: 'gone' }).selected).toBeUndefined()
  })

  // HUD-2: counts of agents, waiting and errors.
  it('counts agents, waiting and errors', () => {
    const s = stateOf([
      agent('a', 'waiting'),
      agent('b', 'waiting'),
      agent('c', 'error'),
      agent('d', 'tool'),
    ])
    expect(pixelHudVM({ state: s, room: '' }).counts).toEqual({ agents: 4, waiting: 2, errors: 1 })
  })

  // HUD-3: alerts: approvals, then waiting, then errors; newest first; at most 4 plus "+N".
  it('orders and caps alerts', () => {
    const s = stateOf(
      [
        agent('e1', 'error', { lastSeen: 50 }),
        agent('w1', 'waiting', { lastSeen: 10 }),
        agent('w2', 'waiting', { lastSeen: 20 }),
        agent('m', 'waiting', {
          lastSeen: 1,
          managed: { chrome: false, pending: 1, phase: 'running' },
        }),
        agent('e2', 'error', { lastSeen: 60 }),
        agent('ok', 'tool'),
      ],
      ['m'],
    )
    const all = alertsVM(s)
    expect(all.map((a) => a.agentId)).toEqual(['m', 'w2', 'w1', 'e2', 'e1'])
    expect(all[0]).toEqual({
      agentId: 'm',
      kind: 'approval',
      text: PIXEL_COPY.alerts.approval('M'),
      opensPermission: true,
    })
    expect(all[1]!.text).toBe(PIXEL_COPY.alerts.waiting('W2'))
    expect(all[3]!.text).toBe(PIXEL_COPY.alerts.error('E2'))
    const vm = pixelHudVM({ state: s, room: '' })
    expect(MAX_ALERTS).toBe(4)
    expect(vm.alerts).toHaveLength(4)
    expect(vm.moreAlerts).toBe(1)
  })

  // HUD-4: minimap dots in status colours at the agents' 1 m tiles, plus the player.
  it('builds minimap dots', () => {
    const proj = { originM: { x: -10, z: -10 }, widthTiles: 40, heightTiles: 40 }
    const vm = minimapVM(
      proj,
      [
        { id: 'b', pos: { x: 0, z: 0 }, status: 'error' },
        { id: 'a', pos: { x: -9.9, z: -9.9 }, status: 'waiting' },
      ],
      { x: 1, z: 1 },
    )
    expect(vm).toEqual({
      widthTiles: 40,
      heightTiles: 40,
      dots: [
        { id: 'a', tx: 0, ty: 0, color: STATUS_COLORS.waiting },
        { id: 'b', tx: 10, ty: 10, color: STATUS_COLORS.error },
      ],
      player: { tx: 11, ty: 11 },
    })
    expect(minimapVM(proj, []).player).toBeUndefined()
  })
})

describe('directoryVM (DIR)', () => {
  const layout = planBuilding(
    [
      { provider: 'p', agents: 2 },
      { provider: 'q', agents: 1 },
    ],
    fixtureManifest,
    undefined,
    0,
  )
  const s = stateOf([
    agent('zed', 'tool', { topic: 'Auth' }),
    agent('amy', 'idle', { topic: 'Auth' }),
    agent('bob', 'waiting', { topic: 'Billing' }),
    agent('sub', 'thinking', { topic: 'other', parentId: 'bob' }),
    agent('qa', 'idle', { provider: 'q', topic: 'Docs' }),
  ])

  // DIR-1: wings → topics → agents, in wing order, names sorted.
  it('lists wings, topics and agents', () => {
    const vm = directoryVM(s, layout, byProviderAndTopic, '')
    expect(vm.query).toBe('')
    expect(vm.wings.map((w) => w.viewId)).toEqual(['wing:p:0', 'wing:q:0'])
    const p = vm.wings[0]!
    expect(p.label).toBe('p')
    expect(p.topics.map((t) => t.label)).toEqual(['Auth', 'Billing'])
    expect(p.topics[0]!.agents.map((a) => a.name)).toEqual(['AMY', 'ZED'])
    // A subagent sits in its parent's topic.
    expect(p.topics[1]!.agents.map((a) => a.id)).toEqual(['bob', 'sub'])
    expect(p.topics[1]!.agents[0]).toEqual({ id: 'bob', name: 'BOB', status: 'waiting' })
  })

  // DIR-2: search matches wing, topic or agent names (case-insensitive) and drops empty groups.
  it('filters by search', () => {
    expect(directoryVM(s, layout, byProviderAndTopic, 'ZE').wings).toEqual([
      {
        viewId: 'wing:p:0',
        label: 'p',
        topics: [{ label: 'Auth', agents: [{ id: 'zed', name: 'ZED', status: 'tool' }] }],
      },
    ])
    const topic = directoryVM(s, layout, byProviderAndTopic, 'billing')
    expect(topic.wings[0]!.topics[0]!.agents).toHaveLength(2)
    const wing = directoryVM(s, layout, byProviderAndTopic, ' q ')
    expect(wing.wings.map((w) => w.viewId)).toEqual(['wing:q:0'])
    expect(directoryVM(s, layout, byProviderAndTopic, 'nothing').wings).toEqual([])
    expect(directoryVM(s, undefined, byProviderAndTopic, '').wings).toEqual([])
  })
})
