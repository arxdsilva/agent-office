import { describe, expect, it } from 'vitest'
import { applyEvent, isVisibleChange, sweepAgent, toDto, type AgentState } from './agent.ts'

const policy = {
  idleAfterMs: 60_000,
  expireAfterMs: 600_000,
  doneTtlMs: 30_000,
  interactiveTtlMs: 600_000,
}

describe('applyEvent', () => {
  it('creates an agent with defaults; provider falls back to source, then http', () => {
    expect(applyEvent(undefined, { agentId: 'a', source: 'mock' }, 1000)).toMatchObject({
      id: 'a',
      name: 'a',
      provider: 'mock',
      topic: 'untitled',
      status: 'idle',
      source: 'mock',
      since: 1000,
      lastSeen: 1000,
      interactive: false,
      unread: 0,
    })
    expect(applyEvent(undefined, { agentId: 'a' }, 1)?.provider).toBe('http')
  })

  it('merges only defined fields and clears the tool when leaving tool status', () => {
    const a = applyEvent(
      undefined,
      { agentId: 'a', name: 'Ada', topic: 'T', status: 'tool', tool: 'Bash' },
      1,
    )!
    const b = applyEvent(a, { agentId: 'a', status: 'thinking' }, 2)!
    expect(b).toMatchObject({ name: 'Ada', topic: 'T', status: 'thinking', lastSeen: 2 })
    expect(b.tool).toBeUndefined()
  })

  it('returns null for events older than lastSeen', () => {
    const a = applyEvent(undefined, { agentId: 'a', status: 'waiting', ts: 200 }, 300)!
    expect(applyEvent(a, { agentId: 'a', status: 'thinking', ts: 100 }, 300)).toBeNull()
  })

  it('merges permissionMode; a later ts wins and an older one is dropped (AG-1)', () => {
    const a = applyEvent(undefined, { agentId: 'a', permissionMode: 'default', ts: 100 }, 100)!
    expect(a.permissionMode).toBe('default')
    const b = applyEvent(a, { agentId: 'a', permissionMode: 'plan', ts: 200 }, 200)!
    expect(b.permissionMode).toBe('plan')
    expect(applyEvent(b, { agentId: 'a', status: 'thinking', ts: 300 }, 300)!.permissionMode).toBe(
      'plan',
    )
    expect(applyEvent(b, { agentId: 'a', permissionMode: 'acceptEdits', ts: 150 }, 300)).toBeNull()
    expect(isVisibleChange(a, b)).toBe(true)
  })

  it('does not mutate the previous state', () => {
    const a = applyEvent(undefined, { agentId: 'a', status: 'idle' }, 1)!
    applyEvent(a, { agentId: 'a', status: 'tool' }, 2)
    expect(a.status).toBe('idle')
  })
})

describe('isVisibleChange', () => {
  it('ignores lastSeen-only bumps', () => {
    const a = applyEvent(undefined, { agentId: 'a', status: 'thinking' }, 1)!
    expect(isVisibleChange(a, { ...a, lastSeen: 5 })).toBe(false)
    expect(isVisibleChange(a, { ...a, status: 'tool' })).toBe(true)
    expect(isVisibleChange(undefined, a)).toBe(true)
  })
})

describe('sweepAgent', () => {
  const at = (over: Partial<AgentState>, now = 0): AgentState => ({
    ...applyEvent(undefined, { agentId: 'a' }, now)!,
    ...over,
  })

  it('idles busy agents after idleAfterMs and keeps others', () => {
    const r = sweepAgent(at({ status: 'tool', tool: 'Bash' }), 60_001, policy)
    expect(r.kind).toBe('update')
    if (r.kind === 'update') {
      expect(r.agent.status).toBe('idle')
      expect(r.agent.tool).toBeUndefined()
    }
    expect(sweepAgent(at({ status: 'waiting' }), 60_001, policy).kind).toBe('keep')
  })

  it('removes after expireAfterMs, and done agents after doneTtlMs', () => {
    expect(sweepAgent(at({}), 600_001, policy).kind).toBe('remove')
    expect(sweepAgent(at({ status: 'done' }), 30_001, policy).kind).toBe('remove')
    expect(sweepAgent(at({ status: 'done' }), 10_000, policy).kind).toBe('keep')
  })

  it('turns interactive off when the inbox has not been read recently', () => {
    const s = at({ interactive: true, inboxReadAt: 0, lastSeen: 599_000 })
    const r = sweepAgent(s, 600_001, policy)
    expect(r.kind === 'update' && r.agent.interactive).toBe(false)
  })
})

describe('toDto', () => {
  it('strips internal fields', () => {
    const s = { ...applyEvent(undefined, { agentId: 'a' }, 1)!, inboxReadAt: 5 }
    expect(toDto(s)).not.toHaveProperty('inboxReadAt')
  })
})

describe('tool target and capability (docs/capabilities.md)', () => {
  const tool = (over: Record<string, unknown>, prev?: AgentState, now = 2) =>
    applyEvent(prev, { agentId: 'a', status: 'tool', ...over }, now)!

  it('keeps target and capability internally; a new tool call replaces both', () => {
    const a = tool({ tool: 'Bash', target: 'cmd:git', capability: 'shell' })
    expect(a).toMatchObject({ target: 'cmd:git', capability: 'shell' })
    const b = tool({ tool: 'Read' }, a, 3)
    expect(b.target).toBeUndefined()
    expect(b.capability).toBeUndefined()
    const c = tool({ target: 'project:x' }, b, 4)
    expect(c.target).toBe('project:x')
  })

  it('clears them when the agent leaves tool status', () => {
    const a = tool({ tool: 'Bash', target: 'cmd:git', capability: 'shell' })
    const idle = applyEvent(a, { agentId: 'a', status: 'thinking' }, 3)!
    expect(idle.target).toBeUndefined()
    expect(idle.capability).toBeUndefined()
  })

  it('a target change is a visible change (a new use), but never reaches the DTO', () => {
    const a = tool({ tool: 'Read', target: 'rule:project:A.md' })
    const b = tool({ tool: 'Read', target: 'rule:project:B.md' }, a, 3)
    expect(isVisibleChange(a, b)).toBe(true)
    expect(toDto(b)).not.toHaveProperty('target')
    expect(toDto(b)).not.toHaveProperty('capability')
  })
})

describe('sweepAgent and capability use', () => {
  it('idling a tool agent clears its target and capability', () => {
    const a = applyEvent(
      undefined,
      { agentId: 'a', status: 'tool', tool: 'Bash', target: 'cmd:git', capability: 'shell' },
      1,
    )!
    const r = sweepAgent(a, 1 + policy.idleAfterMs + 1, policy)
    expect(r.kind).toBe('update')
    const next = (r as { agent: AgentState }).agent
    expect(next.target).toBeUndefined()
    expect(next.capability).toBeUndefined()
  })
})
