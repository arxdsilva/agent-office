// Minimal mode's hierarchy builder (docs/minimal-mode.md). Pure: time comes in, nothing is stored.
import { STATUS_COLORS, type Agent, type HarnessBadge } from '@agent-office/shared'
import { harnessBadgeVM } from './harness-inspector-vm.ts'
import type {
  AgentNodeVM,
  FinishedStore,
  HierarchyOpts,
  LifecycleVM,
  ProjectNodeVM,
  RosterInput,
} from './hierarchy-types.ts'

const QUIET_MS = 60_000
const MAX_FINISHED = 5
const MAX_ACTIVITY = 120
const NEUTRAL = '#8a8f98'
const UNASSIGNED = 'unassigned'

/** Lifecycle, pill text and color for one agent (the table in docs/minimal-mode.md). */
export function lifecycleOf(
  a: Agent,
  now: number,
  depth: number,
): { lifecycle: LifecycleVM; pill: string; color: string } {
  switch (a.ended) {
    case 'completed':
      return { lifecycle: 'completed', pill: 'Completed', color: STATUS_COLORS.waiting }
    case 'failed':
      return { lifecycle: 'failed', pill: 'Failed', color: STATUS_COLORS.error }
    case 'cancelled':
      return { lifecycle: 'cancelled', pill: 'Cancelled', color: STATUS_COLORS.done }
    case 'terminated':
      return { lifecycle: 'terminated', pill: 'Stopped', color: STATUS_COLORS.done }
  }
  const color = STATUS_COLORS[a.status]
  switch (a.status) {
    case 'error':
      return { lifecycle: 'error', pill: 'Error', color }
    case 'done':
      return { lifecycle: 'ended', pill: 'Ended', color }
    case 'waiting':
      return { lifecycle: 'waiting', pill: 'Waiting', color }
    case 'thinking':
      return { lifecycle: 'active', pill: 'Thinking', color }
    case 'tool':
      return { lifecycle: 'active', pill: depth === 0 ? 'Tool use' : 'Working', color }
    default:
      return now - a.lastSeen > QUIET_MS
        ? { lifecycle: 'quiet', pill: 'No recent activity', color }
        : { lifecycle: 'active', pill: 'Idle', color }
  }
}

interface Count {
  main: number
  sub: number
}
const isActive = (a: Agent) => !a.ended && a.status !== 'done'

const sanitize = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ACTIVITY)

function toolPhrase(tool: string | undefined): string {
  switch (tool) {
    case 'Read':
      return 'Reading files'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Editing files'
    case 'Bash':
      return 'Running a command'
    case 'Grep':
    case 'Glob':
      return 'Searching'
    case 'Task':
    case 'Agent':
      return 'Delegating'
    case 'WebFetch':
    case 'WebSearch':
      return 'Browsing'
    default:
      return tool ? `Using ${tool}` : 'Working'
  }
}

function activityOf(a: Agent): string {
  const t = a.text ? sanitize(a.text) : ''
  if (t) return t
  if (a.status === 'tool') return toolPhrase(a.tool)
  if (a.status === 'thinking') return 'Thinking…'
  if (a.status === 'waiting') return 'Waiting for you'
  return ''
}

const byStable = (a: Agent, b: Agent) =>
  a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const finishedAt = (a: Agent) => a.endedAt ?? a.lastSeen
const byNewest = (a: Agent, b: Agent) =>
  finishedAt(b) - finishedAt(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function nodeOf(
  a: Agent,
  depth: number,
  now: number,
  children: AgentNodeVM[],
  finished: AgentNodeVM[],
  activeChildren: number,
  badge?: HarnessBadge,
): AgentNodeVM {
  const { lifecycle, pill, color } = lifecycleOf(a, now, depth)
  const task =
    a.task ??
    (depth === 0 && a.topic && a.topic !== a.name && a.topic !== 'untitled' ? a.topic : null)
  const activity = activityOf(a)
  const harness = badge ? harnessBadgeVM(badge) : undefined
  const hash = [
    a.name,
    a.model ?? '',
    task ?? '',
    activity,
    pill,
    lifecycle,
    color,
    activeChildren,
    a.endedAt ?? '',
    children.map((c) => c.id).join(','),
    finished.map((c) => c.id).join(','),
    harness
      ? `${harness.title}|${harness.text}|${harness.coverage}|${harness.verification}|${harness.completion}|${harness.denied}`
      : '',
  ].join('\u0001')
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    ...(a.model ? { model: a.model } : {}),
    task,
    activity,
    status: a.status,
    pill,
    color,
    lifecycle,
    since: a.since,
    lastSeen: a.lastSeen,
    ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
    depth,
    activeChildren,
    children,
    finished,
    ...(harness && { harness }),
    hash,
  }
}

/** The live Project → agent → subagent hierarchy, rebuilt from the core's agents on every change. */
export function buildHierarchy(
  input: RosterInput,
  finished: FinishedStore,
  opts: HierarchyOpts,
): ProjectNodeVM[] {
  const { now } = input
  const badges = new Map((input.harness ?? []).map((b) => [b.agentId, b]))
  const byId = new Map<string, Agent>()
  for (const a of input.agents) byId.set(a.id, a)
  const sorted = [...byId.values()].sort(byStable)

  // Effective parent: known parentId, with cycles broken at the first member in stable order.
  const parentOf = new Map<string, string | undefined>()
  for (const a of sorted)
    parentOf.set(a.id, a.parentId && byId.has(a.parentId) ? a.parentId : undefined)
  const state = new Map<string, 1 | 2>() // 1 = on the current path, 2 = settled
  for (const a of sorted) {
    const path: string[] = []
    let cur: string | undefined = a.id
    while (cur && !state.has(cur)) {
      state.set(cur, 1)
      path.push(cur)
      const p: string | undefined = parentOf.get(cur)
      if (p && state.get(p) === 1) {
        parentOf.set(p, undefined)
        break
      }
      cur = p
    }
    for (const id of path) state.set(id, 2)
  }

  const kids = new Map<string, Agent[]>()
  const treeRoots: Agent[] = []
  for (const a of sorted) {
    const p = parentOf.get(a.id)
    if (p) {
      const l = kids.get(p)
      if (l) l.push(a)
      else kids.set(p, [a])
    } else treeRoots.push(a)
  }

  const stored = new Map<string, Agent[]>()
  if (!opts.activeOnly)
    for (const e of finished.values()) {
      const p = e.agent.parentId
      if (!p || byId.has(e.agent.id) || !byId.has(p)) continue
      const l = stored.get(p)
      if (l) l.push(e.agent)
      else stored.set(p, [e.agent])
    }

  const flat = (a: Agent, depth: number) => nodeOf(a, depth, now, [], [], 0, badges.get(a.id))

  const build = (a: Agent, depth: number): AgentNodeVM => {
    const children: AgentNodeVM[] = []
    const done: Agent[] = []
    let activeChildren = 0
    for (const k of kids.get(a.id) ?? []) {
      const sub = build(k, depth + 1)
      if (isActive(k) || sub.activeChildren > 0) {
        children.push(sub)
        activeChildren += (isActive(k) ? 1 : 0) + sub.activeChildren
      } else done.push(k)
    }
    const fin: AgentNodeVM[] = opts.activeOnly
      ? []
      : [...done, ...(stored.get(a.id) ?? [])]
          .sort(byNewest)
          .slice(0, MAX_FINISHED)
          .map((k) => flat(k, depth + 1))
    return nodeOf(a, depth, now, children, fin, activeChildren, badges.get(a.id))
  }

  const countActive = (n: AgentNodeVM, live: Map<string, Agent>, acc: Count, root: boolean) => {
    const a = live.get(n.id)
    if (a && isActive(a)) acc[root ? 'main' : 'sub']++
    for (const c of n.children) countActive(c, live, acc, false)
  }

  const projects = new Map<string, ProjectNodeVM>()
  const known = new Map(input.projects.map((p) => [p.id, p]))
  const counts = new Map<string, Count>()
  const projectOf = (a: Agent) => {
    const id = a.projectId ?? UNASSIGNED
    let p = projects.get(id)
    if (!p) {
      const meta = known.get(id)
      p = {
        id,
        name: id === UNASSIGNED ? 'Unassigned' : (meta?.name ?? 'Project'),
        color: meta?.color ?? NEUTRAL,
        mainCount: 0,
        subCount: 0,
        active: false,
        roots: [],
        unresolved: [],
      }
      projects.set(id, p)
      counts.set(id, { main: 0, sub: 0 })
    }
    return p
  }

  for (const a of treeRoots) {
    const unresolved = !!a.parentId && !byId.has(a.parentId)
    const node = build(a, unresolved ? 1 : 0)
    const hasActive = isActive(a) || node.activeChildren > 0
    if (opts.activeOnly && !hasActive) continue
    const p = projectOf(a)
    if (unresolved) p.unresolved.push(node)
    else p.roots.push(node)
    countActive(node, byId, counts.get(p.id)!, !unresolved)
  }

  const order = new Map(input.projects.map((p, i) => [p.id, i]))
  const rank = (id: string) => (id === UNASSIGNED ? 2 : order.has(id) ? 0 : 1)
  const out = [...projects.values()].sort(
    (x, y) =>
      rank(x.id) - rank(y.id) ||
      (rank(x.id) === 0
        ? order.get(x.id)! - order.get(y.id)!
        : x.id < y.id
          ? -1
          : x.id > y.id
            ? 1
            : 0),
  )
  for (const p of out) {
    const { main: m, sub: s } = counts.get(p.id)!
    p.mainCount = m
    p.subCount = s
    p.active = m + s > 0
  }
  return out
}
