// The RPG dialogue box (plan §8.2), pure. It only *routes* to the existing panels: Talk/Details/
// Review open the agent panel, Open the Capability panel, Open in Library the drawer. Consequential
// actions (Allow/Deny) never appear here; they stay on the panel's permission card.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import type { AgentPlan } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import type { OfficeState } from '../state.ts'
import { activityLabel, type ActivityInfo } from '../view-models.ts'
import { projectRefLabel, parseProjectRef, type ProjectLibraryVM } from '../project-library.ts'
import type { ProjectDirectoryEntryVM, ProjectDirectoryVM } from '../workspace/types.ts'
import type { DialogueAction, DialogueVM, InteractTarget } from './types.ts'

/** Reception copy (kept here: pixel-copy.ts belongs to the lead). */
const DIRECTORY_COPY = {
  title: 'PROJECT DIRECTORY',
  question: 'Which project would you like to explore?',
  all: 'All Projects',
  unavailable: 'No project directory yet.',
} as const

export interface DialogueContext {
  state: OfficeState
  plans: ReadonlyMap<string, AgentPlan>
  /** The controller's "Now" facts for an agent (same as the panel). */
  activityOf(id: string): ActivityInfo | undefined
  /** The project directory (B1's `projectDirectoryVM`); absent → the reception desk is quiet. */
  projectDirectory?: ProjectDirectoryVM
  /** The selected project's Library (notebooks, shelves, boards as collections). */
  projectLibrary?: ProjectLibraryVM | null
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'idle',
  thinking: '… thinking',
  tool: '⚙ tool',
  waiting: '! waiting',
  error: '✖ error',
  done: 'done',
}

const A = PIXEL_COPY.actions
const action = (id: DialogueAction, label: string, projectId?: string) => ({
  id,
  label,
  ...(projectId !== undefined && { projectId }),
})

/** The reception dialogue: one row per project (active agents shown) plus All Projects. */
export function projectDirectoryDialogue(dir: ProjectDirectoryVM | undefined): DialogueVM {
  if (!dir || !dir.entries.length)
    return {
      title: DIRECTORY_COPY.title,
      lines: [dir?.empty ?? DIRECTORY_COPY.unavailable],
      actions: [],
    }
  return {
    title: DIRECTORY_COPY.title,
    subtitle: dir.heading,
    lines: [DIRECTORY_COPY.question],
    actions: [
      ...dir.entries.map((e) =>
        action('project-select', `${e.name} · ${e.counts.agents} active`, e.projectId),
      ),
      action('project-all', DIRECTORY_COPY.all),
    ],
  }
}

const PROJECT_ACTION: Record<string, DialogueAction> = {
  dashboard: 'project-dashboard',
  memory: 'project-memory',
  sessions: 'project-sessions',
  context: 'context',
  start: 'start-agent',
}

/** After a project is chosen: its counts and the same panels the desktop opens. */
export function projectDialogue(entry: ProjectDirectoryEntryVM): DialogueVM {
  return {
    title: entry.name,
    subtitle: DIRECTORY_COPY.title,
    lines: [entry.countsLabel],
    actions: entry.actions
      .filter((a) => a.enabled && PROJECT_ACTION[a.id])
      .map((a) => action(PROJECT_ACTION[a.id]!, a.label, entry.projectId)),
  }
}

/** Live office numbers for the Main Street stats board. */
export function officeCounts(state: OfficeState, plans: ReadonlyMap<string, AgentPlan>) {
  const agents = [...state.agents.values()]
  const n = (s: AgentStatus[]) => agents.filter((a) => s.includes(a.status)).length
  return {
    active: agents.length,
    working: n(['thinking', 'tool']),
    waiting: n(['waiting']),
    meetings: [...plans.values()].filter((p) => p.intent.activity === 'meeting').length,
    errors: n(['error']),
  }
}

export function dialogueVM(t: InteractTarget, ctx: DialogueContext): DialogueVM | null {
  if (t.kind === 'agent') return agentVM(t.id, ctx)
  if (t.kind === 'capability' && parseProjectRef(t.ref.id)) return projectRefDialogue(t, ctx)
  if (t.kind === 'capability') {
    const c = ctx.state.capabilities.get(t.ref.provider)?.find((x) => x.id === t.ref.id)
    if (!c) return null
    const uses = `${c.calls} use${c.calls === 1 ? '' : 's'}`
    const kind = [c.kind, c.scope].filter(Boolean).join(' · ')
    const onShelf = c.category === 'skill' || c.category === 'rule'
    return {
      title: c.label,
      subtitle: kind,
      lines: [...(c.summary ? [c.summary] : []), uses],
      actions: [
        action('open', A.open),
        ...(onShelf ? [action('open-library', A.openLibrary)] : []),
      ],
      ref: { ...t.ref },
    }
  }
  if (t.object === 'stats-board') {
    const k = officeCounts(ctx.state, ctx.plans)
    const S = PIXEL_COPY.stats
    return {
      title: PIXEL_COPY.dialogue.statsBoard,
      lines: [
        `${S.active} ${k.active} · ${S.working} ${k.working} · ${S.waiting} ${k.waiting}`,
        `${S.meetings} ${k.meetings} · ${S.errors} ${k.errors}`,
      ],
      actions: [],
    }
  }
  if (t.object === 'project-directory') return projectDirectoryDialogue(ctx.projectDirectory)
  if (t.object === 'elevator')
    return { title: 'Elevators', lines: [PIXEL_COPY.dialogue.elevator], actions: [] }
  return { title: t.label ?? 'Sign', lines: [], actions: [] }
}

function agentVM(id: string, ctx: DialogueContext): DialogueVM | null {
  const a = ctx.state.agents.get(id) ?? ctx.plans.get(id)?.agent
  if (!a) return null
  const info = ctx.activityOf(id)
  const { activity, ...details } = info ?? { activity: undefined }
  const lines: string[] = []
  if (activity) lines.push(activityLabel(activity, details))
  const vm: DialogueVM = {
    title: a.name,
    subtitle: a.topic,
    status: { status: a.status, label: STATUS_LABEL[a.status], color: STATUS_COLORS[a.status] },
    lines,
    actions: [],
    agentId: id,
  }
  if (a.parentId) {
    const parent = ctx.state.agents.get(a.parentId) ?? ctx.plans.get(a.parentId)?.agent
    const name = parent?.name ?? a.parentId
    lines.push(PIXEL_COPY.dialogue.subagent(name))
    vm.parentId = a.parentId
    vm.actions = [action('go-parent', A.goParent(name)), action('follow', A.follow)]
    return vm
  }
  const pending = ctx.state.permissions?.get(id)?.[0]
  if (pending) {
    lines.push(PIXEL_COPY.dialogue.approval(`${pending.tool} · ${pending.summary}`))
    vm.actions = [
      action('review', A.review),
      action('details', A.details),
      action('follow', A.follow),
    ]
    return vm
  }
  const doing = a.tool ? `Running ${a.tool}${a.text ? ` · ${a.text}` : ''}` : a.text
  if (doing) lines.push(doing)
  vm.actions = [action('talk', A.talk), action('details', A.details), action('follow', A.follow)]
  return vm
}

/** A project collection, archive volume or decisions board: its name and count, then Memory. */
function projectRefDialogue(
  t: Extract<InteractTarget, { kind: 'capability' }>,
  ctx: DialogueContext,
): DialogueVM | null {
  const lib = ctx.projectLibrary
  const label = lib && projectRefLabel(lib, t.ref.id)
  if (!lib || !label) return null
  const kind = parseProjectRef(t.ref.id)!.kind
  return {
    title: label,
    subtitle: lib.name,
    lines: [],
    actions: [
      action(
        kind === 'archive' ? 'project-sessions' : 'project-memory',
        kind === 'archive' ? 'Open sessions' : 'Open memory',
        lib.projectId,
      ),
    ],
    ref: { ...t.ref },
  }
}
