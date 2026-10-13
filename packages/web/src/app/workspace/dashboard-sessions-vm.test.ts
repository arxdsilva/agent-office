import { describe, expect, it } from 'vitest'
import { NOW, P1, P2, dashboard, project, session } from './__fixtures__/projects.ts'
import { activityMatches, dashboardVM } from './dashboard-vm.ts'
import { memoryTitleOf, sessionsVM } from './sessions-vm.ts'
import { initialState, reduce, type WorkspaceState } from './state.ts'
import { WS_COPY } from './workspace-copy.ts'

const base = (): WorkspaceState => {
  let s = initialState()
  s = reduce(s, { type: 'projects', projects: [project(), project({ id: P2, name: 'Beta' })] })
  return reduce(s, { type: 'dashboard', dashboard: dashboard() })
}

describe('dashboardVM', () => {
  it('has the five sections under the five questions', () => {
    const vm = dashboardVM(base(), P1, NOW)!
    expect(vm.sections.map((x) => x.heading)).toEqual([
      'Who is working?',
      'What happened?',
      'What is done?',
      'What is next?',
      'What do we know?',
    ])
    expect(vm.sections.map((x) => x.id)).toEqual([
      'active',
      'activity',
      'completed',
      'tasks',
      'knowledge',
    ])
    expect(vm.name).toBe('Alpha')
    expect(vm.repos).toEqual(['alpha-repo'])
  })
  it('labels completed work with its evidence, agent-reported as unverified', () => {
    const rows = dashboardVM(base(), P1, NOW)!.sections.find((x) => x.id === 'completed')!.rows
    expect(rows[0]?.badge).toBe('Agent reported (unverified)')
    expect(rows[0]?.tone).toBe('warn')
    expect(rows[1]?.badge).toBe('Committed')
    expect(rows[1]?.tone).toBe('good')
    expect(Object.values(WS_COPY.evidence)).toHaveLength(4)
  })
  it('shows waiting agents, open tasks only, knowledge with review link', () => {
    const vm = dashboardVM(base(), P1, NOW)!
    const get = (id: string) => vm.sections.find((x) => x.id === id)!.rows
    expect(get('active')[0]).toMatchObject({
      badge: 'Waiting for you',
      action: { type: 'focus-agent', agentId: 'cc:1' },
    })
    expect(get('tasks').map((r) => r.title)).toEqual(['Write docs'])
    expect(get('knowledge')[0]?.action).toEqual({ type: 'review-approvals', projectId: P1 })
    expect(get('knowledge')[1]?.action).toMatchObject({
      type: 'open-memory',
      memoryId: 'mem_aaaaaaaaaa',
    })
  })
  it('filters activity by group, newest first', () => {
    let s = base()
    expect(dashboardVM(s, P1, NOW)!.sections[1]?.rows.map((r) => r.id)).toEqual([
      'act4',
      'act3',
      'act2',
      'act1',
    ])
    s = reduce(s, { type: 'activity-filter', filter: 'problems' })
    const vm = dashboardVM(s, P1, NOW)!
    expect(vm.sections[1]?.rows.map((r) => r.id)).toEqual(['act3'])
    expect(vm.activityFilters.find((f) => f.active)?.id).toBe('problems')
    expect(activityMatches({ kind: 'handoff.launched' } as never, 'handoffs')).toBe(true)
    expect(activityMatches({ kind: 'handoff.launched' } as never, 'memory')).toBe(false)
  })
  it('offers the six actions; continue/handoff/context need data', () => {
    const vm = dashboardVM(base(), P1, NOW)!
    expect(vm.actions.map((a) => a.id)).toEqual([
      'start',
      'continue',
      'search',
      'memory',
      'context',
      'handoff',
    ])
    expect(vm.actions.every((a) => a.enabled)).toBe(true)
    expect(vm.actions[0]?.action).toEqual({ type: 'start-agent', projectId: P1 })
    expect(vm.actions[4]?.action).toMatchObject({ type: 'inspect-context', agentId: 'cc:1' })
    const empty = reduce(base(), {
      type: 'dashboard',
      dashboard: dashboard({
        active: [],
        sessions: [],
        activity: [],
        completed: [],
        tasks: [],
        knowledge: { approved: 0, pending: 0, decisions: [] },
      }),
    })
    const e = dashboardVM(empty, P1, NOW)!
    expect(e.actions.filter((a) => !a.enabled).map((a) => a.id)).toEqual([
      'continue',
      'context',
      'handoff',
    ])
    expect(e.actions[1]?.hint).toBeTruthy()
    for (const sec of e.sections) {
      expect(sec.rows).toEqual([])
      expect(sec.empty).toBeTruthy()
    }
  })
  it('falls back to the summary while loading, null for unknown projects', () => {
    let s = initialState()
    expect(dashboardVM(s, P1, NOW)).toBeNull()
    s = reduce(s, { type: 'projects', projects: [project()] })
    const vm = dashboardVM(s, P1, NOW)!
    expect(vm.sections).toEqual([])
    expect(vm.actions[1]?.enabled).toBe(false)
  })
  it('activity rows link to their session or memory', () => {
    const d = dashboard({
      activity: [
        {
          id: 'a',
          projectId: P1,
          ts: 1,
          kind: 'session.started',
          actor: 'x',
          text: 't',
          refs: { sessionId: 'ses_aaaaaaaaaa' },
        },
        {
          id: 'b',
          projectId: P1,
          ts: 2,
          kind: 'memory.approved',
          actor: 'x',
          text: 't',
          refs: { memoryId: 'mem_aaaaaaaaaa' },
        },
      ],
    })
    const rows = dashboardVM(reduce(base(), { type: 'dashboard', dashboard: d }), P1, NOW)!
      .sections[1]!.rows
    expect(rows[0]?.action).toMatchObject({ type: 'open-memory' })
    expect(rows[1]?.action).toEqual({ type: 'open-session', sessionId: 'ses_aaaaaaaaaa' })
  })
})

describe('dashboardVM structured fields', () => {
  it('exposes numeric metrics, providers, knowledge counts and activity day/ts', () => {
    const d = dashboard({
      active: [
        { agentId: 'cc:1', name: 'A', provider: 'claude-code', status: 'waiting' },
        { agentId: 'cx:1', name: 'B', provider: 'codex', status: 'thinking' },
      ],
      sessions: [
        session({ provider: 'claude-code' }),
        session({ id: 'ses_zzzzzzzzzz', provider: 'gemini' }),
      ],
      activity: [
        { id: 'a', projectId: P1, ts: NOW - 1000, kind: 'session.started', actor: 'x', text: 't' },
        {
          id: 'b',
          projectId: P1,
          ts: NOW - 86_400_000,
          kind: 'session.ended',
          actor: 'x',
          text: 't',
        },
        {
          id: 'c',
          projectId: P1,
          ts: NOW - 5 * 86_400_000,
          kind: 'session.ended',
          actor: 'x',
          text: 't',
        },
      ],
    })
    const vm = dashboardVM(reduce(base(), { type: 'dashboard', dashboard: d }), P1, NOW)!
    expect(vm.metrics).toEqual({
      activeAgents: 2,
      waiting: 1,
      sessions: 3,
      approvedMemories: 4,
      pendingMemories: 1,
      openTasks: 2,
    })
    expect(vm.providers).toEqual([
      { id: 'claude-code', label: 'claude-code' },
      { id: 'codex', label: 'codex' },
      { id: 'gemini', label: 'gemini' },
    ])
    const rows = vm.sections[1]!.rows
    expect(rows.map((r) => r.ts)).toEqual([NOW - 1000, NOW - 86_400_000, NOW - 5 * 86_400_000])
    expect(rows[0]?.day).toBe('today')
    expect(rows[1]?.day).toBe('yesterday')
    expect(rows[2]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(vm.knowledge).toEqual({ approved: 4, pending: 1 })
  })
  it('fallback VM has zeroed metrics from the summary', () => {
    const s = reduce(initialState(), { type: 'projects', projects: [project()] })
    const vm = dashboardVM(s, P1, NOW)!
    expect(vm.metrics.activeAgents).toBe(2)
    expect(vm.providers).toEqual([])
    expect(vm.knowledge).toEqual({ approved: 4, pending: 1 })
  })
})

describe('sessionsVM', () => {
  const sessions = [
    session(),
    session({
      id: 'ses_cccccccccc',
      projectId: null,
      title: 'Loose end',
      assignedBy: undefined,
      suggestions: [{ projectId: P2, name: 'Beta', rule: 'repo match', confidence: 'high' }],
      lastSeenAt: NOW - 10,
    }),
    session({
      id: 'ses_dddddddddd',
      projectId: P2,
      title: 'Beta work',
      summary: { text: 'did x', source: 'last-replies' },
      continuedFrom: {
        handoffId: 'hof_aaaaaaaaaa',
        sessionId: 'ses_aaaaaaaaaa',
        provider: 'claude-code',
      },
      assignedBy: 'auto',
    }),
  ]
  const s0 = (): WorkspaceState => {
    let s = reduce(base(), { type: 'sessions', sessions })
    s = reduce(s, { type: 'select-session', sessionId: 'ses_cccccccccc' })
    return s
  }
  it('groups by project with Unassigned first', () => {
    const vm = sessionsVM(s0(), NOW)
    expect(vm.groups.map((g) => g.heading)).toEqual(['Unassigned', 'Alpha', 'Beta'])
    expect(vm.groups[0]?.rows[0]).toMatchObject({ unassigned: true, selected: true })
    expect(vm.scopes.map((x) => x.key)).toEqual(['all', 'unassigned', P1, P2])
  })
  it('scopes to unassigned or a project', () => {
    let s = reduce(s0(), { type: 'session-scope', scope: 'unassigned' })
    expect(sessionsVM(s, NOW).groups).toHaveLength(1)
    s = reduce(s, { type: 'session-scope', scope: P2 })
    expect(sessionsVM(s, NOW).groups.map((g) => g.key)).toEqual([P2])
  })
  it('suggestions are buttons only, never applied; resume disabled; continue needs a project', () => {
    const vm = sessionsVM(s0(), NOW).detail!
    expect(vm.suggestions).toHaveLength(1)
    expect(vm.suggestions[0]?.assign).toMatchObject({ enabled: true, label: 'Assign to Beta' })
    expect(vm.suggestions[0]?.assign.action).toBeUndefined()
    expect(vm.projectName).toBeNull()
    expect(vm.resume.enabled).toBe(false)
    expect(vm.resume.hint).toMatch(/experimental/i)
    expect(vm.continueWith.enabled).toBe(false)
    expect(vm.continueWith.label).toBe('Continue with…')
    expect(vm.assignOptions[0]).toMatchObject({ projectId: null, current: true })
  })
  it('assigned sessions show no suggestions, provenance and a working Continue', () => {
    const s = reduce(s0(), { type: 'select-session', sessionId: 'ses_dddddddddd' })
    const vm = sessionsVM(s, NOW).detail!
    expect(vm.suggestions).toEqual([])
    expect(vm.assignedByLabel).toBe('Assigned automatically')
    expect(vm.summary).toEqual({ text: 'did x', sourceLabel: 'Built from the last replies' })
    expect(vm.continuedFrom).toContain('claude-code')
    expect(vm.continueWith.action).toMatchObject({
      type: 'continue-work',
      projectId: P2,
      sessionId: 'ses_dddddddddd',
    })
    expect(vm.resume.label).not.toBe(vm.continueWith.label)
  })
  it('messages carry source badges and highlight the jumped-to one', () => {
    let s = reduce(s0(), {
      type: 'messages',
      sessionId: 'ses_cccccccccc',
      more: true,
      messages: [
        { id: 'm1', role: 'user', text: 'hi', ts: NOW - 5000, source: 'chat' },
        {
          id: 'm2',
          role: 'agent',
          text: 'yo',
          ts: NOW - 4000,
          source: 'transcript',
          tools: ['Bash'],
        },
      ],
    })
    s = reduce(s, { type: 'select-session', sessionId: 'ses_cccccccccc', messageId: 'm2' })
    const vm = sessionsVM(s, NOW).detail!
    expect(vm.messages.map((m) => m.sourceBadge)).toEqual([
      'agent-office chat',
      'Provider transcript',
    ])
    expect(vm.messages[1]).toMatchObject({ highlighted: true, tools: ['Bash'], roleLabel: 'Agent' })
    expect(vm.messages[0]?.highlighted).toBe(false)
    expect(vm.moreMessages).toBe(true)
  })
  it('empty states', () => {
    const vm = sessionsVM(initialState(), NOW)
    expect(vm.groups).toEqual([])
    expect(vm.detail).toBeNull()
    expect(vm.empty).toBeTruthy()
    expect(sessionsVM(s0(), NOW).detail?.messages).toEqual([])
  })
  it('sessions of unknown projects still appear', () => {
    const s = reduce(initialState(), {
      type: 'sessions',
      sessions: [session({ projectId: 'prj_zzzzzzzzzz' })],
    })
    expect(sessionsVM(s, NOW).groups[0]?.rows).toHaveLength(1)
  })
})

describe('task rows', () => {
  const withTasks = (): WorkspaceState => {
    const d = dashboard()
    return reduce(base(), {
      type: 'dashboard',
      dashboard: {
        ...d,
        tasks: [
          {
            id: 'tsk_cccccccccc',
            projectId: P1,
            title: 'Mine',
            state: 'open',
            source: 'user',
            sessionIds: [],
          },
          {
            id: 'tsk_eeeeeeeeee',
            projectId: P1,
            title: 'Theirs',
            state: 'doing',
            source: 'agent-reported',
            sessionIds: [],
          },
          {
            id: 'tsk_ffffffffff',
            projectId: P1,
            title: 'Sure',
            state: 'open',
            source: 'user',
            evidence: 'user-confirmed',
            sessionIds: [],
          },
        ],
      },
    })
  }
  it('offers the four states, a Confirm button and the add form', () => {
    const vm = dashboardVM(withTasks(), P1, NOW)!
    const rows = vm.sections.find((x) => x.id === 'tasks')!.rows
    expect(rows[0]?.task?.stateOptions.map((o) => o.value)).toEqual([
      'open',
      'doing',
      'done',
      'dropped',
    ])
    expect(rows[0]?.task?.confirm).toMatchObject({ label: 'Confirm', enabled: true })
    expect(vm.taskForm).toEqual({ placeholder: 'Add a task…', addLabel: 'Add task' })
  })
  it('keeps agent-reported tasks labelled unverified until confirmed', () => {
    const rows = dashboardVM(withTasks(), P1, NOW)!.sections.find((x) => x.id === 'tasks')!.rows
    expect(rows[0]?.badge).toBeUndefined()
    expect(rows[1]).toMatchObject({ badge: 'Agent reported (unverified)', tone: 'warn' })
    expect(rows[2]).toMatchObject({ badge: 'You confirmed' })
    expect(rows[2]?.task?.confirm.enabled).toBe(false)
  })
  it('the fallback VM carries the form too', () => {
    expect(dashboardVM(initialState(), P1, NOW)).toBeNull()
    const s = reduce(reduce(initialState(), { type: 'projects', projects: [project()] }), {
      type: 'loading',
      on: true,
    })
    expect(dashboardVM(s, P1, NOW)!.taskForm.addLabel).toBe('Add task')
  })
})

describe('session vault additions', () => {
  const resumable = (): WorkspaceState => {
    let s = reduce(base(), {
      type: 'sessions',
      sessions: [
        session({ canResume: true, summary: { text: 'did x', source: 'provider' } }),
        session({ id: 'ses_cccccccccc', projectId: null }),
      ],
    })
    s = reduce(s, { type: 'select-session', sessionId: 'ses_aaaaaaaaaa' })
    return reduce(s, {
      type: 'messages',
      sessionId: 'ses_aaaaaaaaaa',
      messages: [
        { id: 'm1', role: 'agent', text: `  ${'word '.repeat(40)}`, ts: NOW, source: 'chat' },
      ],
      more: false,
    })
  }
  it('enables Resume only when canResume, still marked experimental', () => {
    const d = sessionsVM(resumable(), NOW).detail!
    expect(d.resume.enabled).toBe(true)
    expect(d.resume.hint).toMatch(/experimental/i)
    const other = sessionsVM(
      reduce(resumable(), { type: 'select-session', sessionId: 'ses_cccccccccc' }),
      NOW,
    ).detail!
    expect(other.resume.enabled).toBe(false)
  })
  it('renders the summary with its source', () => {
    expect(sessionsVM(resumable(), NOW).detail!.summary).toEqual({
      text: 'did x',
      sourceLabel: 'Written by the provider',
    })
  })
  it('save-as-memory title defaults to the first 80 characters on one line', () => {
    const m = sessionsVM(resumable(), NOW).detail!.messages[0]!
    expect(m.save.label).toBe('Save as memory')
    expect(m.save.defaultTitle).toHaveLength(80)
    expect(m.save.defaultTitle.startsWith('word word')).toBe(true)
    expect(memoryTitleOf('a\n\nb')).toBe('a b')
  })
  it('has the experimental import button and the notice', () => {
    const vm = sessionsVM(reduce(resumable(), { type: 'notice', notice: 'Imported 2' }), NOW)
    expect(vm.importHistory).toMatchObject({ id: 'import', enabled: true })
    expect(vm.importHistory.hint).toMatch(/experimental/i)
    expect(vm.notice).toBe('Imported 2')
  })
})
