import type { Agent, ChatMessage } from '@agent-office/shared'

/** A desktop notification the user should see. */
export interface Note {
  kind: 'waiting' | 'reply' | 'error'
  agentId: string
  title: string
  body: string
}

export interface AttentionContext {
  focused: boolean
  enabled: boolean
  now: number
  /** Last note time per agent (throttle). */
  lastSentAt: ReadonlyMap<string, number>
}

export const THROTTLE_MS = 30_000
const BODY_CHARS = 120

const quiet = (agentId: string, ctx: AttentionContext) =>
  !ctx.enabled || ctx.focused || ctx.now - (ctx.lastSentAt.get(agentId) ?? -Infinity) < THROTTLE_MS

/** A busy agent started waiting for the human, or an agent hit an error. */
export function noteForAgentChange(prev: Agent | undefined, next: Agent, ctx: AttentionContext): Note | null {
  if (!prev || quiet(next.id, ctx)) return null
  if (next.status === 'waiting' && (prev.status === 'thinking' || prev.status === 'tool')) {
    return { kind: 'waiting', agentId: next.id, title: `${next.name} is waiting for you`, body: next.topic }
  }
  if (next.status === 'error' && prev.status !== 'error') {
    return { kind: 'error', agentId: next.id, title: `${next.name} hit an error`, body: next.text || next.topic }
  }
  return null
}

/** An agent answered a message from the UI. */
export function noteForMessage(m: ChatMessage, agent: Agent | undefined, ctx: AttentionContext): Note | null {
  if (m.from !== 'agent' || !agent || quiet(agent.id, ctx)) return null
  return { kind: 'reply', agentId: agent.id, title: `${agent.name} replied`, body: m.text.slice(0, BODY_CHARS) }
}
