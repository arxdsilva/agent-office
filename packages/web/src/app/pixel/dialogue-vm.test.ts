import { STATUS_COLORS, type Agent, type AgentStatus } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { cap } from '../__fixtures__/capabilities.ts'
import type { AgentPlan } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import { emptyState, type OfficeState } from '../state.ts'
import { projectLibraryVM, projectRefId } from '../project-library.ts'
import type { ProjectDirectoryVM } from '../workspace/types.ts'
import {
  dialogueVM,
  officeCounts,
  projectDialogue,
  projectDirectoryDialogue,
  type DialogueContext,
} from './dialogue-vm.ts'

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

  // PD-1..4: the reception desk builds the project directory dialogue from the VM.
  describe('project directory', () => {
    const btn = (id: string, label: string) => ({ id, label, enabled: true })
    const entry = (projectId: string, name: string, agents: number) => ({
      projectId,
      name,
      color: '#fff',
      selected: false,
      counts: { agents, sessions: 3, memories: 2, pending: 1, tasks: 0 },
      countsLabel: `${agents} active, 3 sessions`,
      actions: [
        btn('dashboard', 'Dashboard'),
        btn('memory', 'Memory'),
        btn('sessions', 'Sessions'),
        btn('context', 'Context'),
        { ...btn('start', 'Start agent'), enabled: false },
      ],
    })
    const dir: ProjectDirectoryVM = {
      heading: 'Project directory',
      entries: [entry('prj_a', 'Alpha', 2), entry('prj_b', 'Beta', 0)],
      empty: 'No projects yet.',
      createProject: btn('create-project', 'New project'),
    }

    it('lists each project with its active count, then All Projects', () => {
      const c = { ...ctx([]), projectDirectory: dir }
      const vm = dialogueVM({ kind: 'object', object: 'project-directory' }, c)!
      expect(vm.title).toBe('PROJECT DIRECTORY')
      expect(vm.lines).toEqual(['Which project would you like to explore?'])
      expect(vm.actions).toEqual([
        { id: 'project-select', label: 'Alpha · 2 active', projectId: 'prj_a' },
        { id: 'project-select', label: 'Beta · 0 active', projectId: 'prj_b' },
        { id: 'project-all', label: 'All Projects' },
      ])
    })

    it('says so when there are no projects or no directory', () => {
      expect(projectDirectoryDialogue({ ...dir, entries: [] }).lines).toEqual(['No projects yet.'])
      expect(projectDirectoryDialogue(undefined).actions).toEqual([])
    })

    it('offers the project panels with the project id, skipping disabled buttons', () => {
      const vm = projectDialogue(dir.entries[0]!)
      expect(vm.title).toBe('Alpha')
      expect(vm.lines).toEqual(['2 active, 3 sessions'])
      expect(vm.actions.map((a) => a.id)).toEqual([
        'project-dashboard',
        'project-memory',
        'project-sessions',
        'context',
      ])
      expect(vm.actions.every((a) => a.projectId === 'prj_a')).toBe(true)
    })
  })

  // PD-5: a project library surface opens its collection (name and count), then the project panel.
  it('describes project library surfaces and routes them to memory or sessions', () => {
    const lib = projectLibraryVM(
      { id: 'prj_a', name: 'Alpha', color: '#fff' },
      { byKind: { decision: 4 }, pending: 0, handoffs: 0, acceptedDecisions: 1 },
      [{ lastSeenAt: 5 }],
      5,
    )
    const c = { ...ctx([]), projectLibrary: lib }
    const note = dialogueVM(
      {
        kind: 'capability',
        ref: { provider: 'p', id: projectRefId('prj_a', 'collection', 'decisions') },
      },
      c,
    )!
    expect(note).toMatchObject({ title: 'Decisions · 4', subtitle: 'Alpha' })
    expect(note.actions).toEqual([
      { id: 'project-memory', label: 'Open memory', projectId: 'prj_a' },
    ])
    const book = dialogueVM(
      { kind: 'capability', ref: { provider: 'p', id: projectRefId('prj_a', 'archive', 0) } },
      c,
    )!
    expect(book.actions[0]).toMatchObject({ id: 'project-sessions', projectId: 'prj_a' })
    expect(
      dialogueVM(
        { kind: 'capability', ref: { provider: 'p', id: projectRefId('prj_a', 'archive', 7) } },
        c,
      ),
    ).toBeNull()
    expect(
      dialogueVM(
        { kind: 'capability', ref: { provider: 'p', id: projectRefId('prj_a', 'archive', 0) } },
        ctx([]),
      ),
    ).toBeNull()
  })
})
