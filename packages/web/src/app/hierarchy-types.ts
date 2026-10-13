// Minimal mode's view models (docs/minimal-mode.md): the live agent hierarchy, built on every
// change from the core's agents (`buildHierarchy`, app/hierarchy.ts). No tree is stored here.
import type { Agent, AgentStatus, HarnessBadge } from '@agent-office/shared'
import type { HarnessBadgeVM } from './harness-inspector-vm.ts'

/** What the controller hands a roster view: the core's agents plus project names. */
export interface RosterInput {
  agents: Agent[]
  projects: { id: string; name: string; color: string }[]
  now: number
  /** Per-agent harness state (docs/harness.md), from `projects.harness.badges()`. */
  harness?: HarnessBadge[]
}

/** The lifecycle a node shows (the table in docs/minimal-mode.md). */
export type LifecycleVM =
  | 'active'
  | 'waiting'
  | 'quiet'
  | 'error'
  | 'ended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'terminated'

export interface AgentNodeVM {
  id: string
  name: string
  provider: string
  model?: string
  /** The assigned task; null shows "Task not reported". */
  task: string | null
  /** What the agent does now (sanitized, ≤120 chars); '' when nothing. */
  activity: string
  status: AgentStatus
  /** Pill text: Working, Thinking, Tool use, Waiting, Completed, … */
  pill: string
  /** From STATUS_COLORS. */
  color: string
  lifecycle: LifecycleVM
  since: number
  lastSeen: number
  endedAt?: number
  /** True depth (0 = main agent); the view caps the indentation. */
  depth: number
  /** Active descendants (recursive). */
  activeChildren: number
  /** Active direct children, in stable order (`since`, then id). */
  children: AgentNodeVM[]
  /** Recently finished direct children, newest first (bounded). */
  finished: AgentNodeVM[]
  /** The harness pill (`.mm-harness`); absent when no harness applies to this agent. */
  harness?: HarnessBadgeVM
  /** Visible fields joined: the view rebuilds a node only when this changes. */
  hash: string
}

export interface ProjectNodeVM {
  /** A project id, or 'unassigned'. */
  id: string
  name: string
  color: string
  /** Active main agents. */
  mainCount: number
  /** Active subagents at any depth. */
  subCount: number
  /** Any active agent in the project. */
  active: boolean
  roots: AgentNodeVM[]
  /** Children whose parent isn't known yet; re-parented when it arrives. */
  unresolved: AgentNodeVM[]
}

export interface HierarchyOpts {
  /** Hide finished agents entirely. */
  activeOnly: boolean
  /** Show the Recently finished lists (their counts show either way). */
  showFinished: boolean
}

/** One remembered finished agent: its last state after the core dropped it. */
export interface FinishedEntry {
  agent: Agent
  /** endedAt ?? lastSeen. */
  at: number
}

/** Recently finished agents the core already removed, keyed by agent id (view state only). */
export type FinishedStore = ReadonlyMap<string, FinishedEntry>
