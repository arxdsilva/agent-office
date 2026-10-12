import type { Agent, AgentEvent } from '@agent-office/shared'

/** Agent plus internal bookkeeping that never leaves the core. */
export interface AgentState extends Agent {
  /** Last time something read this agent's inbox. */
  inboxReadAt?: number
}

export interface SweepPolicy {
  idleAfterMs: number
  expireAfterMs: number
  doneTtlMs: number
  interactiveTtlMs: number
}

const MERGED = ['name', 'provider', 'topic', 'model', 'kind', 'parentId', 'status', 'tool', 'text'] as const
const VISIBLE: (keyof Agent)[] = [...MERGED, 'interactive', 'unread']

/**
 * Applies a partial event. Returns the new state, or null when the event is older than what we
 * already know (out-of-order delivery must never overwrite newer state).
 */
export function applyEvent(prev: AgentState | undefined, e: AgentEvent, now: number): AgentState | null {
  const ts = e.ts ?? now
  if (prev && ts < prev.lastSeen) return null
  const source = e.source ?? prev?.source ?? 'http'
  const next: AgentState = prev
    ? { ...prev, lastSeen: ts }
    : {
        id: e.agentId,
        name: e.agentId,
        provider: e.provider ?? source,
        topic: 'untitled',
        status: 'idle',
        source,
        since: ts,
        lastSeen: ts,
        interactive: false,
        unread: 0,
      }
  for (const k of MERGED) {
    if (e[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = e[k]
  }
  if (next.status !== 'tool' && e.tool === undefined) delete next.tool
  return next
}

/** True when something a viewer can see changed (lastSeen-only bumps are not visible). */
export function isVisibleChange(prev: Agent | undefined, next: Agent): boolean {
  return !prev || VISIBLE.some((k) => prev[k] !== next[k])
}

export type SweepResult = { kind: 'keep' } | { kind: 'remove' } | { kind: 'update'; agent: AgentState }

export function sweepAgent(a: AgentState, now: number, p: SweepPolicy): SweepResult {
  const silent = now - a.lastSeen
  if (silent > p.expireAfterMs || (a.status === 'done' && silent > p.doneTtlMs)) return { kind: 'remove' }
  let next = a
  if (silent > p.idleAfterMs && (a.status === 'thinking' || a.status === 'tool')) {
    next = { ...next, status: 'idle' }
    delete next.tool
  }
  if (a.interactive && now - (a.inboxReadAt ?? 0) > p.interactiveTtlMs) next = { ...next, interactive: false }
  return next === a ? { kind: 'keep' } : { kind: 'update', agent: next }
}

/** Public shape sent to UIs. */
export function toDto(s: AgentState): Agent {
  const { inboxReadAt: _internal, ...agent } = s
  return agent
}
