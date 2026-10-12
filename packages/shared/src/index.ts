import { z } from 'zod'

export const AGENT_STATUSES = ['idle', 'thinking', 'tool', 'waiting', 'error', 'done'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

/**
 * An event any source (HTTP client, Claude Code adapter, mock) can emit.
 * Events are partial updates: only `agentId` is required, missing fields keep their previous value.
 */
export const AgentEventSchema = z.object({
  agentId: z.string().min(1).max(200),
  /** Human-readable name shown above the agent's head. */
  name: z.string().max(100).optional(),
  /** Groups agents into the same room/row of desks (e.g. a project or a crew). */
  team: z.string().max(100).optional(),
  /** Agent that spawned this one; subagents sit next to their parent. */
  parentId: z.string().max(200).optional(),
  status: z.enum(AGENT_STATUSES).optional(),
  /** Tool currently in use, shown in the speech bubble. */
  tool: z.string().max(100).optional(),
  /** Short free-form activity line. */
  text: z.string().max(500).optional(),
  /** Source that produced the event, e.g. "claude-code", "http", "mock". */
  source: z.string().max(50).optional(),
  /** Unix epoch millis; defaults to server receive time. */
  ts: z.number().int().positive().optional(),
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

export const AgentEventBatchSchema = z.union([AgentEventSchema, z.array(AgentEventSchema).max(500)])

export interface Agent {
  id: string
  name: string
  team: string
  parentId?: string
  status: AgentStatus
  tool?: string
  text?: string
  source: string
  /** First time the agent was seen (epoch millis). */
  since: number
  /** Last event time (epoch millis). */
  lastSeen: number
}

/** Messages pushed from server to browser over the WebSocket. */
export type ServerMessage =
  | { type: 'snapshot'; agents: Agent[] }
  | { type: 'upsert'; agent: Agent }
  | { type: 'remove'; id: string }
