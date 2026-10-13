// Meaningful project activity (docs/projects.md §7): never tool calls, statuses or animations.
import { ACTIVITY_KINDS, type ActivityKind, type ActivityView } from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import { oneLine } from './text.ts'

export { ACTIVITY_KINDS }

export interface ActivityData {
  tool?: string
  query?: string
  returned?: { id: string; version: number }[]
  memoryIds?: string[]
  via?: 'first-message' | 'handoff'
}

export interface ActivityEvent extends ActivityView {
  /** Internal details (retrievals and deliveries) for the Context Inspector. */
  data?: ActivityData
}

export function newActivity(e: ActivityEvent): ActivityEvent {
  if (!(ACTIVITY_KINDS as readonly string[]).includes(e.kind))
    throw new ValidationError('unknown activity kind')
  const data = e.data && {
    ...e.data,
    ...(e.data.query !== undefined ? { query: oneLine(e.data.query, 80) } : {}),
    ...(e.data.tool !== undefined ? { tool: oneLine(e.data.tool, 60) } : {}),
  }
  return {
    ...e,
    kind: e.kind as ActivityKind,
    actor: oneLine(e.actor, 60),
    text: oneLine(e.text, 160),
    ...(data ? { data } : {}),
  }
}

export function toActivityView(e: ActivityEvent): ActivityView {
  const { data: _d, ...view } = e
  return { ...view, ...(e.refs ? { refs: { ...e.refs } } : {}) }
}
