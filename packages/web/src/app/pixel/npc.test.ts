import type { Agent, AgentStatus } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { appearanceOf } from '../motion.ts'
import type { AgentPlan } from '../office-types.ts'
import { NPC_FADE_MS, createNpcs } from './npc.ts'

const agent = (id: string, status: AgentStatus = 'idle', over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
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
const plan = (a: Agent, teamOf?: string): AgentPlan => ({
  agent: a,
  intent: { activity: 'desk-idle', target: 'x', since: 0 },
  ...(teamOf && { teamOf }),
})

describe('NPC identity (NPC-id)', () => {
  it('keeps one entity across status updates and removes it after departed + fade', () => {
    const npcs = createNpcs()
    const first = npcs.sync(new Map([['a', plan(agent('a'))]]), [], 0)
    expect(first.added).toEqual(['a'])
    const e = npcs.get('a')!
    const statuses: AgentStatus[] = ['thinking', 'tool', 'waiting', 'error', 'idle']
    for (let i = 0; i < 20; i++) {
      const s = npcs.sync(new Map([['a', plan(agent('a', statuses[i % 5]))]]), [], i)
      expect(s.added).toEqual([])
      expect(npcs.get('a')).toBe(e)
    }
    expect(e.status).toBe('idle')
    // Departed: kept while the leave fade plays, then removed.
    expect(npcs.sync(new Map(), ['a'], 100).removed).toEqual([])
    expect(npcs.get('a')?.leaving).toBe(true)
    expect(npcs.sync(new Map(), [], 100 + NPC_FADE_MS - 1).removed).toEqual([])
    expect(npcs.sync(new Map(), [], 100 + NPC_FADE_MS).removed).toEqual(['a'])
    expect(npcs.get('a')).toBeUndefined()
    expect(npcs.ids()).toEqual([])
  })

  it('looks the same as in 3D (appearanceOf), with the team badge for subagents', () => {
    const npcs = createNpcs()
    npcs.sync(new Map([['s', plan(agent('s', 'idle', { parentId: 'a' }), 'a')]]), [], 0)
    expect(npcs.get('s')!.appearance).toEqual(appearanceOf('s', 'a'))
    expect(npcs.get('s')!.teamOf).toBe('a')
    // A plan reappearing before the fade ends cancels the removal.
    npcs.sync(new Map(), ['s'], 1)
    npcs.sync(new Map([['s', plan(agent('s'), 'a')]]), [], 2)
    expect(npcs.sync(new Map(), [], 10_000).removed).toEqual([])
  })
})
