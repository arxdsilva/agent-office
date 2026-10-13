// Project tasks with evidence levels (docs/projects.md §8). Pure.
import { EVIDENCE_LEVELS, type EvidenceLevel, type TaskView } from '@agent-office/shared'
import { ValidationError } from './errors.ts'

export type TaskState = TaskView['state']

export interface Evidence {
  level: EvidenceLevel
  at: number
  /** e.g. a commit sha (committed). */
  ref?: string
  note?: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  state: TaskState
  source: 'user' | 'agent-reported'
  evidence: Evidence[]
  sessionIds: string[]
  createdAt: number
  doneAt?: number
}

export function createTask(o: {
  id: string
  projectId: string
  title: string
  source: Task['source']
  now: number
  sessionId?: string
}): Task {
  const title = o.title.trim()
  if (!title || title.length > 160) throw new ValidationError('task title must be 1–160 characters')
  return {
    id: o.id,
    projectId: o.projectId,
    title,
    state: 'open',
    source: o.source,
    evidence: [],
    sessionIds: o.sessionId ? [o.sessionId] : [],
    createdAt: o.now,
  }
}

const NEXT: Record<TaskState, TaskState[]> = {
  open: ['doing', 'done', 'dropped'],
  doing: ['open', 'done', 'dropped'],
  done: ['open'],
  dropped: [],
}

export function setTaskState(t: Task, state: TaskState, now: number): Task {
  if (!NEXT[t.state].includes(state))
    throw new ValidationError(`cannot move a ${t.state} task to ${state}`)
  const { doneAt: _d, ...rest } = t
  return state === 'done' ? { ...rest, state, doneAt: now } : { ...rest, state }
}

export function addEvidence(t: Task, e: Evidence): Task {
  if (e.level === 'tests-verified') throw new ValidationError('tests-verified is not available yet')
  return { ...t, evidence: [...t.evidence, e].slice(-20) }
}

export function strongestEvidence(t: Task): EvidenceLevel | undefined {
  let best = -1
  for (const e of t.evidence) best = Math.max(best, EVIDENCE_LEVELS.indexOf(e.level))
  return best < 0 ? undefined : EVIDENCE_LEVELS[best]
}

export function toTaskView(t: Task): TaskView {
  const evidence = strongestEvidence(t)
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    state: t.state,
    source: t.source,
    ...(evidence ? { evidence } : {}),
    sessionIds: [...t.sessionIds],
  }
}
