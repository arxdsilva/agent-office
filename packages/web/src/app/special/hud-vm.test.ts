// The Night City HUD and holo displays: counts and names only (plan §7), from real state.
import type { GlobalOverview, ProjectDashboard } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { displayVM } from './display-vm.ts'
import { specialHudVM } from './hud-vm.ts'

const agents = [
  { id: 'a', name: 'Ada', status: 'tool' as const },
  { id: 'b', name: 'Bo', status: 'waiting' as const },
  { id: 'c', name: 'Cy', status: 'thinking' as const },
  { id: 'd', name: 'Di', status: 'idle' as const },
]

describe('specialHudVM', () => {
  it('shows the project, active and waiting counts, the location and the camera', () => {
    const vm = specialHudVM({
      agents,
      selectedId: null,
      room: 'Project Command Center',
      prompt: null,
      camera: 'third',
      projectName: 'Payments',
    })
    expect(vm).toMatchObject({
      project: 'Payments',
      active: 2,
      waiting: 1,
      location: 'Project Command Center',
      selected: null,
      prompt: null,
      camera: 'Third person',
    })
  })

  it('defaults to All projects and an unknown location', () => {
    const vm = specialHudVM({
      agents: [],
      selectedId: null,
      room: null,
      prompt: null,
      camera: 'overview',
    })
    expect(vm.project).toBe('All projects')
    expect(vm.location).toBe('Meridian HQ')
    expect(vm.camera).toBe('Overview')
  })

  it('shows the selected agent with its status, and the interaction prompt', () => {
    const vm = specialHudVM({
      agents,
      selectedId: 'b',
      room: null,
      prompt: 'memory-terminal',
      camera: 'first',
    })
    expect(vm.selected).toEqual({
      id: 'b',
      name: 'Bo',
      status: 'waiting',
      label: 'Waiting for you',
      color: '#3ccf91',
    })
    expect(vm.prompt).toBe('E: Open Memory Vault')
    expect(
      specialHudVM({ agents, selectedId: 'zz', room: null, prompt: null, camera: 'first' })
        .selected,
    ).toBeNull()
  })

  it('strips control characters and caps long names', () => {
    const vm = specialHudVM({
      agents: [{ id: 'x', name: `A\u0007${'b'.repeat(80)}`, status: 'idle' }],
      selectedId: 'x',
      room: null,
      prompt: null,
      camera: 'third',
      projectName: `P\u0000${'q'.repeat(80)}`,
    })
    expect(vm.selected!.name).not.toMatch(/\u0007/)
    expect(vm.selected!.name.length).toBeLessThanOrEqual(40)
    expect(vm.project.length).toBeLessThanOrEqual(40)
  })
})

const dashboard = {
  project: { id: 'p', name: 'Payments', openTasks: 3, archived: false },
  active: [
    { agentId: 'a', name: 'Ada', provider: 'codex', status: 'tool' },
    { agentId: 'b', name: 'Bo', provider: 'codex', status: 'waiting' },
  ],
  completed: [
    { taskId: 't1', title: 'Secret task title', evidence: 'verified', at: 1_000 },
    { taskId: 't2', title: 'Another', evidence: 'claimed', at: 61_000 },
  ],
  tasks: [],
  knowledge: { approved: 9, pending: 2, decisions: [{}, {}, {}] },
  activity: [],
  sessions: [],
} as unknown as ProjectDashboard

const overview = {
  projects: [{ archived: false }, { archived: true }, { archived: false }],
  waiting: [{}, {}],
  recentCompletions: [],
  recentDecisions: [],
  pendingApprovals: 4,
  unfinishedHandoffs: [{}],
  unassignedSessions: 0,
  vault: 'encrypted',
} as unknown as GlobalOverview

describe('displayVM', () => {
  it('a selected project: its name and counts, never task titles or memory text', () => {
    const vm = displayVM({
      dashboard,
      overview: null,
      live: { active: 5, waiting: 0 },
      now: 241_000,
    })
    expect(vm.title).toBe('Payments')
    expect(Object.fromEntries(vm.tiles.map((t) => [t.label, t.value]))).toEqual({
      Active: 2,
      Waiting: 1,
      Completed: 2,
      'Open tasks': 3,
      'Pending memory': 2,
      Decisions: 3,
    })
    expect(vm.footer).toBe('Last completion 3 min ago')
    expect(JSON.stringify(vm)).not.toMatch(/Secret task title|Another/)
  })

  it('all projects: projects, live counts, approvals and handoffs', () => {
    const vm = displayVM({ dashboard: null, overview, live: { active: 5, waiting: 1 }, now: 0 })
    expect(vm.title).toBe('All projects')
    expect(Object.fromEntries(vm.tiles.map((t) => [t.label, t.value]))).toEqual({
      Projects: 2,
      Active: 5,
      Waiting: 2,
      Approvals: 4,
      Handoffs: 1,
    })
    expect(vm.footer).toBe('Vault encrypted')
  })

  it('before any workspace data: the live counts only', () => {
    const vm = displayVM({
      dashboard: null,
      overview: null,
      live: { active: 1, waiting: 2 },
      now: 0,
    })
    expect(vm.tiles).toEqual([
      { label: 'Active', value: 1 },
      { label: 'Waiting', value: 2 },
    ])
    expect(vm.footer).toBe('')
  })

  it('a project without completions says so', () => {
    const vm = displayVM({
      dashboard: { ...dashboard, completed: [] },
      overview: null,
      live: { active: 0, waiting: 0 },
      now: 0,
    })
    expect(vm.footer).toBe('No completions yet')
  })
})
