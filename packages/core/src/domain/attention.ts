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
const QUESTION_CHARS = 80

const firstQuestion = (a: Agent): string | undefined => {
  const q = a.question?.prompts[0]?.question
  if (!q) return undefined
  return q.length > QUESTION_CHARS ? `${q.slice(0, QUESTION_CHARS - 1)}…` : q
}

const quiet = (agentId: string, ctx: AttentionContext) =>
  !ctx.enabled || ctx.focused || ctx.now - (ctx.lastSentAt.get(agentId) ?? -Infinity) < THROTTLE_MS

/** A busy agent started waiting for the human, or an agent hit an error. */
export function noteForAgentChange(
  prev: Agent | undefined,
  next: Agent,
  ctx: AttentionContext,
): Note | null {
  if (!prev || quiet(next.id, ctx)) return null
  if (next.status === 'waiting' && (prev.status === 'thinking' || prev.status === 'tool')) {
    const asks = firstQuestion(next)
    return {
      kind: 'waiting',
      agentId: next.id,
      title: asks ? `${next.name} asks: ${asks}` : `${next.name} is waiting for you`,
      body: next.topic,
    }
  }
  if (next.status === 'error' && prev.status !== 'error') {
    return {
      kind: 'error',
      agentId: next.id,
      title: `${next.name} hit an error`,
      body: next.text || next.topic,
    }
  }
  return null
}

/** An agent answered a message from the UI. */
export function noteForMessage(
  m: ChatMessage,
  agent: Agent | undefined,
  ctx: AttentionContext,
): Note | null {
  if (m.from !== 'agent' || !agent || quiet(agent.id, ctx)) return null
  return {
    kind: 'reply',
    agentId: agent.id,
    title: `${agent.name} replied`,
    body: m.text.slice(0, BODY_CHARS),
  }
}
