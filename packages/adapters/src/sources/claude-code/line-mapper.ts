import { basename } from 'node:path'
import type { AgentEvent, AgentStatus } from '@agent-office/shared'

const PROVIDER = 'claude-code'
const SNIPPET = 80

export interface ParseContext {
  /** Session titles; custom (user-set) wins over AI-generated. */
  titles: Map<string, { ai?: string; custom?: string }>
  /** Subagent metadata from `agent-<id>.meta.json`. */
  meta: Map<string, { agentType?: string; description?: string }>
  /** Last transcript timestamp per session, used for lines without one. */
  lastTs: Map<string, number>
}

export const newParseContext = (): ParseContext => ({
  titles: new Map(),
  meta: new Map(),
  lastTs: new Map(),
})

type Block = { type?: string; name?: string; input?: { description?: unknown }; is_error?: boolean }

const snippet = (s: unknown) => (typeof s === 'string' ? s.slice(0, SNIPPET) : '')

/**
 * Maps one transcript line to an agent event. Pure apart from `ctx`, which carries what earlier
 * lines taught us (titles, subagent meta). Only status, tool, title, model and short snippets
 * are extracted — see PRIVACY_SECURITY rule.
 */
export function lineToEvent(raw: string, ctx: ParseContext): AgentEvent | null {
  let d: Record<string, any>
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || typeof d.sessionId !== 'string') return null
  const sessionId: string = d.sessionId

  if (d.type === 'ai-title' || d.type === 'custom-title') {
    const t = ctx.titles.get(sessionId) ?? {}
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') t.ai = d.aiTitle.slice(0, 200)
    if (d.type === 'custom-title' && typeof d.customTitle === 'string')
      t.custom = d.customTitle.slice(0, 200)
    ctx.titles.set(sessionId, t)
    const ts = ctx.lastTs.get(sessionId)
    // Without a timestamp we can't order it safely; the next message line carries the topic instead.
    if (ts === undefined) return null
    return { agentId: `cc:${sessionId}`, topic: titleOf(ctx, sessionId)!, source: PROVIDER, ts }
  }

  if (d.type !== 'user' && d.type !== 'assistant') return null
  const ts = Date.parse(d.timestamp)
  if (Number.isNaN(ts)) return null
  ctx.lastTs.set(sessionId, Math.max(ts, ctx.lastTs.get(sessionId) ?? 0))

  const content: Block[] | string = d.message?.content ?? []
  const blocks = Array.isArray(content) ? content : []
  let status: AgentStatus = 'thinking'
  let tool: string | undefined
  let text = ''

  if (d.type === 'assistant') {
    const uses = blocks.filter((b) => b?.type === 'tool_use')
    const last = uses[uses.length - 1]
    if (last) {
      status = 'tool'
      tool = typeof last.name === 'string' ? last.name.slice(0, 100) : 'tool'
      text = snippet(last.input?.description)
    } else if (
      d.message?.stop_reason === 'end_turn' ||
      d.message?.stop_reason === 'stop_sequence'
    ) {
      status = 'waiting'
    }
  } else if (blocks.some((b) => b?.type === 'tool_result' && b.is_error)) {
    text = 'tool error'
  }

  const cwdName = typeof d.cwd === 'string' && d.cwd ? basename(d.cwd) : 'claude'
  const model =
    typeof d.message?.model === 'string' && d.message.model !== '<synthetic>'
      ? d.message.model
      : undefined
  const event: AgentEvent = {
    agentId: `cc:${sessionId}`,
    provider: PROVIDER,
    source: PROVIDER,
    name: cwdName.slice(0, 100),
    topic: titleOf(ctx, sessionId) ?? cwdName.slice(0, 200),
    status,
    text,
    ts,
    ...(tool ? { tool } : {}),
    ...(model ? { model: model.slice(0, 100) } : {}),
  }

  if (d.isSidechain && typeof d.agentId === 'string') {
    const meta = ctx.meta.get(d.agentId)
    event.agentId = `cc:${d.agentId}`
    event.parentId = `cc:${sessionId}`
    event.name = (meta?.agentType ?? `sub·${d.agentId.slice(0, 6)}`).slice(0, 100)
    if (meta?.agentType) event.kind = meta.agentType.slice(0, 100)
    if (!text && meta?.description) event.text = snippet(meta.description)
  }
  return event
}

function titleOf(ctx: ParseContext, sessionId: string): string | undefined {
  const t = ctx.titles.get(sessionId)
  return t?.custom ?? t?.ai
}
