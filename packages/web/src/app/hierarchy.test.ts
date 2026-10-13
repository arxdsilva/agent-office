import { STATUS_COLORS, type Agent, type HarnessBadge } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { buildHierarchy, lifecycleOf } from './hierarchy.ts'
import type { AgentNodeVM, FinishedStore, HierarchyOpts, ProjectNodeVM } from './hierarchy-types.ts'

// Indexable without `undefined`: these tests assert the shape first, then dig in.
type Arr<T> = [T, T, T, T, T, T, ...T[]]
type LNode = Omit<AgentNodeVM, 'children' | 'finished'> & {
  children: Arr<LNode>
  finished: Arr<LNode>
}
type LProject = Omit<ProjectNodeVM, 'roots' | 'unresolved'> & {
  roots: Arr<LNode>
  unresolved: Arr<LNode>
}

const ag = (over: Partial<Agent> & { id: string }): Agent => ({
  name: over.id,
  provider: 'claude-code',
  topic: 'untitled',
  status: 'idle',
  source: 's',
  since: 0,
  lastSeen: 1000,
  interactive: false,
  unread: 0,
  ...over,
})
const NONE: FinishedStore = new Map()
const OPTS: HierarchyOpts = { activeOnly: false, showFinished: true }
const PROJECTS = [
  { id: 'p1', name: 'Alpha', color: '#111111' },
  { id: 'p2', name: 'Beta', color: '#222222' },
]
const build = (agents: Agent[], store = NONE, opts = OPTS, now = 2000, projects = PROJECTS) =>
  buildHierarchy({ agents, projects, now }, store, opts) as unknown as Arr<LProject>
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('projects', () => {
  it('orders known projects, unknown sorted, unassigned last; hides empty ones', () => {
    const vms = build([
      ag({ id: 'a', projectId: 'zz' }),
      ag({ id: 'b' }),
      ag({ id: 'c', projectId: 'p2' }),
      ag({ id: 'd', projectId: 'aa' }),
    ])
    expect(ids(vms)).toEqual(['p2', 'aa', 'zz', 'unassigned'])
    expect(vms[0]).toMatchObject({ name: 'Beta', color: '#222222' })
    expect(vms[1]).toMatchObject({ name: 'Project', color: '#8a8f98' })
    expect(vms[3]).toMatchObject({ name: 'Unassigned' })
    expect(build([])).toEqual([])
  })

  it('moves a whole subtree when its main agent is reassigned', () => {
    const tree = [ag({ id: 'm', projectId: 'p1' }), ag({ id: 's', parentId: 'm', projectId: 'p1' })]
    expect(build(tree)[0].roots[0].children[0].id).toBe('s')
    const moved = build(tree.map((a) => (a.id === 'm' ? { ...a, projectId: 'p2' } : a)))
    expect(ids(moved)).toEqual(['p2'])
    expect(moved[0].roots[0].children[0].id).toBe('s')
  })

  it("lineage wins: a child shows in its parent's project", () => {
    const vms = build([
      ag({ id: 'm', projectId: 'p1' }),
      ag({ id: 's', parentId: 'm', projectId: 'p2' }),
    ])
    expect(ids(vms)).toEqual(['p1'])
    expect(vms[0]).toMatchObject({ mainCount: 1, subCount: 1, active: true })
  })
})

describe('tree', () => {
  it('nests three levels with true depth, parent links and counts', () => {
    const vms = build([
      ag({ id: 'm', projectId: 'p1' }),
      ag({ id: 's', parentId: 'm', projectId: 'p1', since: 1 }),
      ag({ id: 'g', parentId: 's', projectId: 'p1', since: 2 }),
    ])
    const m = vms[0].roots[0]
    expect(m.depth).toBe(0)
    expect(m.activeChildren).toBe(2)
    const s = m.children[0]
    expect(s).toMatchObject({ id: 's', depth: 1, activeChildren: 1 })
    expect(s.children[0]).toMatchObject({ id: 'g', depth: 2, activeChildren: 0 })
    expect(vms[0]).toMatchObject({ mainCount: 1, subCount: 2 })
  })

  it('keeps provider agents without subagents as plain roots', () => {
    const vms = build([ag({ id: 'a', provider: 'codex' }), ag({ id: 'b', provider: 'codex' })])
    expect(ids(vms[0].roots)).toEqual(['a', 'b'])
    expect(vms[0].roots.every((r) => r.children.length === 0 && r.finished.length === 0)).toBe(true)
  })

  it('orders by since then id and never reorders on status flips', () => {
    const mk = (st: Agent['status']) => [
      ag({ id: 'm' }),
      ag({ id: 'c', parentId: 'm', since: 5, status: st }),
      ag({ id: 'b', parentId: 'm', since: 5 }),
      ag({ id: 'a', parentId: 'm', since: 9, status: st }),
      ag({ id: 'z', parentId: 'm', since: 1, status: 'thinking' }),
    ]
    const order = (st: Agent['status']) => ids(build(mk(st))[0].roots[0].children)
    expect(order('idle')).toEqual(['z', 'b', 'c', 'a'])
    expect(order('tool')).toEqual(['z', 'b', 'c', 'a'])
    expect(order('waiting')).toEqual(['z', 'b', 'c', 'a'])
  })

  it('puts a child with an unknown parent under unresolved, then reconciles it', () => {
    const child = ag({ id: 'c', parentId: 'm', projectId: 'p1' })
    const grand = ag({ id: 'g', parentId: 'c', projectId: 'p1' })
    const early = build([child, grand])[0]
    expect(early.roots).toEqual([])
    expect(ids(early.unresolved)).toEqual(['c'])
    expect(early.unresolved[0].depth).toBe(1)
    expect(early.unresolved[0].children[0].id).toBe('g')
    expect(early).toMatchObject({ mainCount: 0, subCount: 2, active: true })
    const later = build([ag({ id: 'm', projectId: 'p1' }), child, grand])[0]
    expect(later.unresolved).toEqual([])
    expect(later.roots[0].children[0].children[0].id).toBe('g')
  })

  it('breaks cycles and self-parents instead of looping', () => {
    const vms = build([
      ag({ id: 'a', parentId: 'b', since: 1 }),
      ag({ id: 'b', parentId: 'a', since: 2 }),
      ag({ id: 's', parentId: 's', since: 3 }),
    ])
    expect(ids(vms[0].roots).sort()).toEqual(['a', 's'])
    expect(vms[0].roots.find((r) => r.id === 'a')!.children[0].id).toBe('b')
  })

  it('uses the last duplicate id', () => {
    const vms = build([ag({ id: 'a', name: 'old' }), ag({ id: 'a', name: 'new' })])
    expect(vms[0].roots).toHaveLength(1)
    expect(vms[0].roots[0].name).toBe('new')
  })
})

describe('task and activity', () => {
  it('shows the assigned task; a main agent falls back to a real topic; else null', () => {
    const vms = build([
      ag({ id: 'm1', task: 'Fix login' }),
      ag({ id: 'm2', topic: 'Refactor auth' }),
      ag({ id: 'm3', topic: 'm3' }),
      ag({ id: 'm4', topic: 'untitled' }),
      ag({ id: 'm5', topic: '' }),
      ag({ id: 's', parentId: 'm2', topic: 'Refactor auth' }),
    ])
    const r = vms[0].roots
    expect(r.map((x) => x.task)).toEqual(['Fix login', 'Refactor auth', null, null, null])
    expect(r[1].children[0].task).toBeNull()
  })

  it('keeps the task when the activity changes', () => {
    const base = ag({ id: 'a', task: 'Write docs' })
    const t = build([{ ...base, status: 'tool', tool: 'Read' }])[0].roots[0]
    const u = build([{ ...base, status: 'thinking' }])[0].roots[0]
    expect([t.task, u.task]).toEqual(['Write docs', 'Write docs'])
    expect([t.activity, u.activity]).toEqual(['Reading files', 'Thinking…'])
    expect(t.hash).not.toBe(u.hash)
  })

  it('reflects a reassigned task', () => {
    const a = build([ag({ id: 'a', task: 'One' })])[0].roots[0]
    const b = build([ag({ id: 'a', task: 'Two' })])[0].roots[0]
    expect([a.task, b.task]).toEqual(['One', 'Two'])
    expect(a.hash).not.toBe(b.hash)
  })

  it('maps tools to phrases and statuses to defaults', () => {
    const act = (over: Partial<Agent>) => build([ag({ id: 'a', ...over })])[0].roots[0].activity
    const tool = (t?: string) => act({ status: 'tool', tool: t })
    expect(tool('Edit')).toBe('Editing files')
    expect(tool('MultiEdit')).toBe('Editing files')
    expect(tool('Write')).toBe('Editing files')
    expect(tool('NotebookEdit')).toBe('Editing files')
    expect(tool('Bash')).toBe('Running a command')
    expect(tool('Grep')).toBe('Searching')
    expect(tool('Glob')).toBe('Searching')
    expect(tool('Task')).toBe('Delegating')
    expect(tool('Agent')).toBe('Delegating')
    expect(tool('WebFetch')).toBe('Browsing')
    expect(tool('WebSearch')).toBe('Browsing')
    expect(tool('Foo')).toBe('Using Foo')
    expect(tool(undefined)).toBe('Working')
    expect(act({ status: 'waiting' })).toBe('Waiting for you')
    expect(act({ status: 'idle' })).toBe('')
  })

  it('prefers sanitized text over the tool phrase', () => {
    const text = `  run\u0007\n  tests\t now ${'x'.repeat(200)}`
    const a = build([ag({ id: 'a', status: 'tool', tool: 'Bash', text })])[0].roots[0]
    expect(a.activity.startsWith('run tests now xxx')).toBe(true)
    expect(a.activity.length).toBe(120)
    expect(
      build([ag({ id: 'a', status: 'tool', tool: 'Bash', text: ' \n ' })])[0].roots[0].activity,
    ).toBe('Running a command')
  })
})

describe('lifecycle', () => {
  const lc = (over: Partial<Agent>, depth = 1, now = 2000) =>
    lifecycleOf(ag({ id: 'a', ...over }), now, depth)

  it('follows the doc table', () => {
    expect(lc({ ended: 'completed', status: 'done' })).toEqual({
      lifecycle: 'completed',
      pill: 'Completed',
      color: STATUS_COLORS.waiting,
    })
    expect(lc({ ended: 'failed', status: 'error' })).toMatchObject({
      lifecycle: 'failed',
      pill: 'Failed',
      color: STATUS_COLORS.error,
    })
    expect(lc({ ended: 'cancelled' })).toMatchObject({
      pill: 'Cancelled',
      color: STATUS_COLORS.done,
    })
    expect(lc({ ended: 'terminated' })).toMatchObject({
      lifecycle: 'terminated',
      pill: 'Stopped',
      color: STATUS_COLORS.done,
    })
    expect(lc({ status: 'error' })).toMatchObject({ lifecycle: 'error', pill: 'Error' })
    expect(lc({ status: 'done' })).toMatchObject({
      lifecycle: 'ended',
      pill: 'Ended',
      color: STATUS_COLORS.done,
    })
    expect(lc({ status: 'waiting' })).toMatchObject({ lifecycle: 'waiting', pill: 'Waiting' })
    expect(lc({ status: 'thinking' })).toMatchObject({ lifecycle: 'active', pill: 'Thinking' })
    expect(lc({ status: 'tool' }, 1)).toMatchObject({ lifecycle: 'active', pill: 'Working' })
    expect(lc({ status: 'tool' }, 0).pill).toBe('Tool use')
    expect(lc({ status: 'idle' })).toMatchObject({ lifecycle: 'active', pill: 'Idle' })
  })

  it('never turns silence into completed', () => {
    expect(lc({ status: 'idle', lastSeen: 0 }, 1, 60_000).lifecycle).toBe('active')
    const q = lc({ status: 'idle', lastSeen: 0 }, 1, 60_001)
    expect(q).toMatchObject({ lifecycle: 'quiet', pill: 'No recent activity' })
  })
})

describe('finished and ended agents', () => {
  const parent = ag({ id: 'm' })
  const entry = (a: Agent) => [a.id, { agent: a, at: a.endedAt ?? a.lastSeen }] as const

  it("moves ended and done children to the parent's finished list, newest first", () => {
    const vms = build([
      parent,
      ag({ id: 'live', parentId: 'm' }),
      ag({ id: 'c1', parentId: 'm', ended: 'completed', endedAt: 100 }),
      ag({ id: 'c2', parentId: 'm', status: 'done', lastSeen: 300 }),
      ag({ id: 'c3', parentId: 'm', ended: 'cancelled', endedAt: 200 }),
    ])
    const m = vms[0].roots[0]
    expect(ids(m.children)).toEqual(['live'])
    expect(ids(m.finished)).toEqual(['c2', 'c3', 'c1'])
    expect(m.activeChildren).toBe(1)
    expect(m.finished[0]).toMatchObject({ lifecycle: 'ended', children: [], finished: [] })
    expect(vms[0].subCount).toBe(1)
  })

  it('merges store entries, dedups by id preferring the live one, and caps at 5', () => {
    const live = ag({ id: 'dup', parentId: 'm', ended: 'completed', endedAt: 500, name: 'live' })
    const stale = ag({ id: 'dup', parentId: 'm', ended: 'failed', endedAt: 400, name: 'stale' })
    const others = Array.from({ length: 6 }, (_, i) =>
      ag({ id: `o${i}`, parentId: 'm', ended: 'completed', endedAt: 10 + i }),
    )
    const orphan = ag({ id: 'orph', parentId: 'gone', ended: 'completed', endedAt: 900 })
    const store: FinishedStore = new Map([stale, ...others, orphan].map(entry))
    const m = build([parent, live], store)[0].roots[0]
    expect(ids(m.finished)).toEqual(['dup', 'o5', 'o4', 'o3', 'o2'])
    expect(m.finished[0].name).toBe('live')
    // Roots in the store are not shown.
    const rootStore: FinishedStore = new Map([
      entry(ag({ id: 'old', ended: 'completed', endedAt: 1 })),
    ])
    expect(ids(build([parent], rootStore)[0].roots)).toEqual(['m'])
  })

  it('keeps ended roots visible with their lifecycle', () => {
    const vms = build([ag({ id: 'r', ended: 'completed', endedAt: 5, status: 'done' })])
    expect(vms[0].roots[0]).toMatchObject({ lifecycle: 'completed', pill: 'Completed', endedAt: 5 })
    expect(vms[0]).toMatchObject({ mainCount: 0, subCount: 0, active: false })
  })

  it('keeps active children under a parent that ended', () => {
    const vms = build([
      ag({ id: 'm', ended: 'completed', endedAt: 5, status: 'done' }),
      ag({ id: 's', parentId: 'm' }),
    ])
    const m = vms[0].roots[0]
    expect(m.lifecycle).toBe('completed')
    expect(m.children[0]).toMatchObject({ id: 's', lifecycle: 'active' })
    expect(m.activeChildren).toBe(1)
    expect(vms[0]).toMatchObject({ mainCount: 0, subCount: 1, active: true })
  })

  it('keeps an ended mid-level agent while its descendants are still active', () => {
    const vms = build([
      ag({ id: 'm' }),
      ag({ id: 's', parentId: 'm', ended: 'completed', endedAt: 5 }),
      ag({ id: 'g', parentId: 's' }),
    ])
    const m = vms[0].roots[0]
    expect(ids(m.children)).toEqual(['s'])
    expect(m.activeChildren).toBe(1)
    expect(m.children[0].children[0].id).toBe('g')
  })

  it('activeOnly hides finished lists and ended roots, but not roots with active children', () => {
    const opts = { activeOnly: true, showFinished: true }
    const agents = [
      ag({ id: 'm' }),
      ag({ id: 'c', parentId: 'm', ended: 'completed', endedAt: 1 }),
      ag({ id: 'old', ended: 'completed', endedAt: 1, projectId: 'p2' }),
      ag({ id: 'er', ended: 'failed', endedAt: 1, projectId: 'p1' }),
      ag({ id: 'es', parentId: 'er', projectId: 'p1' }),
    ]
    const store: FinishedStore = new Map([
      ['x', { agent: ag({ id: 'x', parentId: 'm', ended: 'failed' }), at: 1 }],
    ])
    const vms = build(agents, store, opts)
    expect(ids(vms)).toEqual(['p1', 'unassigned'])
    expect(vms[1].roots[0].finished).toEqual([])
    expect(ids(vms[0].roots)).toEqual(['er'])
    // showFinished is the view's choice: the data is the same.
    expect(build(agents, NONE, { ...opts, showFinished: false })).toEqual(build(agents, NONE, opts))
  })
})

describe('hash', () => {
  it('changes with visible fields and stays equal otherwise', () => {
    const a = ag({ id: 'a', model: 'm1' })
    const h = (x: Agent, extra: Agent[] = []) => build([x, ...extra])[0].roots[0].hash
    expect(h(a)).toBe(h({ ...a, lastSeen: 1500 }))
    expect(h(a)).not.toBe(h({ ...a, model: 'm2' }))
    expect(h(a)).not.toBe(h({ ...a, status: 'thinking' }))
    expect(h(a)).not.toBe(h(a, [ag({ id: 'k', parentId: 'a' })]))
  })
})

describe('performance', () => {
  it('builds 300 agents across 20 projects quickly', () => {
    const agents: Agent[] = []
    for (let i = 0; i < 300; i++)
      agents.push(
        ag({
          id: `a${i}`,
          projectId: `p${i % 20}`,
          parentId: i % 5 === 0 ? undefined : `a${i - (i % 5)}`,
          since: i,
          status: i % 7 === 0 ? 'done' : 'tool',
        }),
      )
    const t0 = performance.now()
    const vms = build(agents)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(vms.length).toBeGreaterThan(0)
  })
})

describe('harness badges', () => {
  const badge = (over: Partial<HarnessBadge> = {}): HarnessBadge => ({
    agentId: 'm',
    harnessNames: ['Team standards'],
    ruleCount: 3,
    coverage: 'partial',
    verification: 'verified',
    completion: 'harness-verified',
    denied: 0,
    ...over,
  })
  const run = (harness?: HarnessBadge[]) =>
    (
      buildHierarchy(
        {
          agents: [ag({ id: 'm', projectId: 'p1' }), ag({ id: 'x', projectId: 'p1' })],
          projects: PROJECTS,
          now: 2000,
          ...(harness && { harness }),
        },
        NONE,
        OPTS,
      ) as unknown as Arr<LProject>
    )[0].roots

  it('attaches the badge to its agent only', () => {
    const roots = run([badge()])
    expect(roots[0].harness).toMatchObject({ text: 'Harness: verified', coverage: 'partial' })
    expect(roots[1].harness).toBeUndefined()
  })

  it('has no badge when the roster carries none', () => {
    expect(run()[0].harness).toBeUndefined()
  })

  it('changes the node hash when coverage, verification, completion or blocked count change', () => {
    const base = run([badge()])[0].hash
    expect(run([badge()])[0].hash).toBe(base)
    expect(run([badge({ coverage: 'enforced' })])[0].hash).not.toBe(base)
    expect(run([badge({ verification: 'failed' })])[0].hash).not.toBe(base)
    expect(run([badge({ completion: 'validation-failed' })])[0].hash).not.toBe(base)
    expect(run([badge({ denied: 4 })])[0].hash).not.toBe(base)
    expect(run()[0].hash).not.toBe(base)
  })
})
