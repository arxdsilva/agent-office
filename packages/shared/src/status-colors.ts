import type { AgentStatus } from './protocol.ts'

/** Single source of status colors for the legend, avatars and monitors. */
export const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#8a8f98',
  thinking: '#4f8cff',
  tool: '#f5a524',
  waiting: '#3ccf91',
  error: '#ef4444',
  done: '#5b5f66',
}
