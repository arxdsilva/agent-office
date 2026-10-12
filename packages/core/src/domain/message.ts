import type { ChatMessage } from '@agent-office/shared'
import { DomainError } from './errors.ts'

export function newUserMessage(
  id: string,
  agentId: string,
  text: string,
  now: number,
): ChatMessage {
  return { id, agentId, from: 'user', text, ts: now, state: 'queued' }
}

export function newReply(
  id: string,
  agentId: string,
  text: string,
  now: number,
  inReplyTo?: string,
): ChatMessage {
  return {
    id,
    agentId,
    from: 'agent',
    text,
    ts: now,
    state: 'replied',
    ...(inReplyTo ? { inReplyTo } : {}),
  }
}

/** queued → delivered (the agent picked it up). */
export function deliver(m: ChatMessage): ChatMessage {
  if (m.state !== 'queued') throw new DomainError(`cannot deliver a ${m.state} message`)
  return { ...m, state: 'delivered' }
}

/** delivered → replied (the agent answered). */
export function markReplied(m: ChatMessage): ChatMessage {
  if (m.state !== 'delivered') throw new DomainError(`cannot mark a ${m.state} message replied`)
  return { ...m, state: 'replied' }
}

export const isAwaitingReply = (m: ChatMessage) => m.from === 'user' && m.state === 'delivered'
