// The RPG dialogue box (plan §8.2), pure. It only *routes* to the existing panels: Talk/Details/
// Review open the agent panel, Open the Capability panel, Open in Library the drawer. Consequential
// actions (Allow/Deny) never appear here; they stay on the panel's permission card.
import { STATUS_COLORS, type AgentStatus } from '@agent-office/shared'
import type { AgentPlan } from '../office-types.ts'
import { PIXEL_COPY } from '../pixel-copy.ts'
import type { OfficeState } from '../state.ts'
import { activityLabel, type ActivityInfo } from '../view-models.ts'
import type { DialogueAction, DialogueVM, InteractTarget } from './types.ts'

export interface DialogueContext {
  state: OfficeState
  plans: ReadonlyMap<string, AgentPlan>
  /** The controller's "Now" facts for an agent (same as the panel). */
  activityOf(id: string): ActivityInfo | undefined
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
const action = (id: DialogueAction, label: string) => ({ id, label })

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
