import { STATUS_COLORS, type Agent, type AgentStatus } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { cap } from '../__fixtures__/capabilities.ts'
import type { AgentPlan } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { emptyState, type OfficeState } from '../state.ts'
import { dialogueVM, officeCounts, type DialogueContext } from './dialogue-vm.ts'

const agent = (id: string, status: AgentStatus = 'tool', over: Partial<Agent> = {}): Agent => ({
  id,
  name: id === 'ada' ? 'Ada' : id,
  provider: 'claude-code',
  topic: 'Refactor auth',
  status,
  source: 's',
  since: 0,
  lastSeen: 0,
  interactive: true,
  unread: 0,
  ...over,
})

function ctx(agents: Agent[], extra: Partial<OfficeState> = {}): DialogueContext {
  const state = emptyState()
  for (const a of agents) state.agents.set(a.id, a)
  Object.assign(state, extra)
  const plans = new Map<string, AgentPlan>(
    agents.map((a) => [
      a.id,
      {
        agent: a,
        intent: { activity: a.status === 'waiting' ? 'booth' : 'desk-work', target: 'x', since: 0 },
      },
    ]),
  )
  return {
    state,
    plans,
    activityOf: (id) => {
      const p = plans.get(id)
      return p && { activity: p.intent.activity, room: 'pod-2' }
    },
  }
}

const ids = (vm: { actions: { id: string }[] } | null) => vm?.actions.map((a) => a.id)

describe('dialogueVM (DLG)', () => {
  // DLG-1: an agent: name, topic, the activity sentence, a status chip and Talk/Details/Follow.
  it('shows an agent with Talk, Details and Follow', () => {
    const vm = dialogueVM(
      { kind: 'agent', id: 'ada' },
      ctx([agent('ada', 'tool', { tool: 'Bash', text: 'Run the tests' })]),
    )!
    expect(vm.title).toBe('Ada')
    expect(vm.subtitle).toBe('Refactor auth')
    expect(vm.status).toEqual({ status: 'tool', label: '⚙ tool', color: STATUS_COLORS.tool })
    expect(vm.lines).toEqual(['Working at their desk in pod 2', 'Running Bash · Run the tests'])
    expect(ids(vm)).toEqual(['talk', 'details', 'follow'])
    expect(vm.actions[0]!.label).toBe(PIXEL_COPY.actions.talk)
    expect(vm.agentId).toBe('ada')
  })

  // DLG-2: a subagent can't read messages: no Talk, a hint and "Go to <parent>".
  it('points a subagent at its parent', () => {
    const vm = dialogueVM(
      { kind: 'agent', id: 'sub' },
      ctx([agent('ada'), agent('sub', 'thinking', { parentId: 'ada' })]),
    )!
    expect(ids(vm)).not.toContain('talk')
    expect(ids(vm)).toContain('go-parent')
    expect(vm.actions.find((a) => a.id === 'go-parent')!.label).toBe('Go to Ada')
    expect(vm.lines).toContain(PIXEL_COPY.dialogue.subagent('Ada'))
    expect(vm.parentId).toBe('ada')
  })

  // DLG-3: a pending approval offers Review (the panel's card), never Allow or Deny.
  it('offers Review for a pending permission', () => {
    const managed = agent('ada', 'waiting', {
      managed: { chrome: false, pending: 1, phase: 'running' },
    })
    const vm = dialogueVM(
      { kind: 'agent', id: 'ada' },
      ctx([managed], {
        permissions: new Map([['ada', [{ id: 'perm_1', tool: 'Bash', summary: 'pnpm test' }]]]),
      }),
    )!
    expect(ids(vm)).toEqual(['review', 'details', 'follow'])
    expect(vm.lines).toContain(PIXEL_COPY.dialogue.approval('Bash · pnpm test'))
    expect(JSON.stringify(vm)).not.toMatch(/allow|deny/i)
  })

  // DLG-4: a capability: Open, plus Open in Library for skills and rules.
  it('opens capabilities, and the Library for books and boards', () => {
    const c = ctx([])
    c.state.capabilities.set('claude-code', [
      cap('fs', { calls: 3 }),
      cap('skill:pdf', { summary: 'Reads PDFs', calls: 1 }),
    ])
    const station = dialogueVM(
      { kind: 'capability', ref: { provider: 'claude-code', id: 'fs' } },
      c,
    )!
    expect(station.title).toBe('fs')
    expect(ids(station)).toEqual(['open'])
    expect(station.ref).toEqual({ provider: 'claude-code', id: 'fs' })
    expect(station.lines.join(' ')).toMatch(/3 uses/)
    const book = dialogueVM(
      { kind: 'capability', ref: { provider: 'claude-code', id: 'skill:pdf' } },
      c,
    )!
    expect(ids(book)).toEqual(['open', 'open-library'])
    expect(book.lines).toContain('Reads PDFs')
    expect(dialogueVM({ kind: 'capability', ref: { provider: 'x', id: 'y' } }, c)).toBeNull()
  })

  // DLG-5: the stats board shows the live counts; elevators and signs get a short text.
  it('shows the stats board counts and object texts', () => {
    const c = ctx([
      agent('a', 'tool'),
      agent('b', 'waiting'),
      agent('d', 'error'),
      agent('e', 'idle'),
    ])
    ;(c.plans as Map<string, AgentPlan>).set('e', {
      ...c.plans.get('e')!,
      intent: { activity: 'meeting', target: 'm', since: 0 },
    })
    expect(officeCounts(c.state, c.plans)).toEqual({
      active: 4,
      working: 1,
      waiting: 1,
      meetings: 1,
      errors: 1,
    })
    const board = dialogueVM({ kind: 'object', object: 'stats-board' }, c)!
    expect(board.title).toBe(PIXEL_COPY.dialogue.statsBoard)
    expect(board.lines.join(' ')).toContain('Waiting 1')
    expect(dialogueVM({ kind: 'object', object: 'elevator' }, c)!.lines).toEqual([
      PIXEL_COPY.dialogue.elevator,
    ])
    expect(dialogueVM({ kind: 'object', object: 'sign', label: 'claude-code' }, c)!.title).toBe(
      'claude-code',
    )
    expect(ids(dialogueVM({ kind: 'object', object: 'sign' }, c))).toEqual([])
  })

  // DLG-6: an error shows the red chip and the error sentence; a gone agent gives null.
  it('shows an error and gives null for an agent that left', () => {
    const vm = dialogueVM({ kind: 'agent', id: 'ada' }, ctx([agent('ada', 'error')]))!
    expect(vm.status).toMatchObject({ status: 'error', color: STATUS_COLORS.error })
    expect(vm.status!.label).toContain('✖')
    expect(dialogueVM({ kind: 'agent', id: 'nobody' }, ctx([]))).toBeNull()
  })
})
