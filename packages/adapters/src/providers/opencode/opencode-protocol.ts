// A tolerant zod subset of the OpenCode server API (opencode 1.19.0, checked against the OpenAPI
// document it serves at GET /doc): only what history, transcripts and the observer read. Unknown
// fields pass through; every list item is validated on its own so one odd record never hides the rest.
import { z } from 'zod'

/** Endpoints agent-office relies on (all GET, all read-only). */
export const OPENCODE_RELIES_ON = [
  'GET /global/health',
  'GET /experimental/session?roots&limit',
  'GET /session/{sessionID}/message?directory',
  'GET /global/event',
] as const

/** HTTP Basic user when OPENCODE_SERVER_PASSWORD is set (OPENCODE_SERVER_USERNAME, default). */
export const OPENCODE_USERNAME = 'opencode'
export const OPENCODE_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'

/** OpenCode ids: `ses_` + base62 (OpenAPI pattern `^ses`). Nothing that could act as a path or flag. */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{1,96}$/
export const OPENCODE_REF_PREFIX = 'tr_oc_'

export const refOf = (sessionId: string) => `${OPENCODE_REF_PREFIX}${sessionId}`
export function sessionOfRef(ref: string): string | undefined {
  if (!ref.startsWith(OPENCODE_REF_PREFIX)) return undefined
  const id = ref.slice(OPENCODE_REF_PREFIX.length)
  return OPENCODE_SESSION_ID.test(id) ? id : undefined
}

export const Health = z.looseObject({ healthy: z.literal(true), version: z.string().optional() })

export const SessionInfo = z.looseObject({
  id: z.string().regex(OPENCODE_SESSION_ID),
  title: z.string().optional(),
  directory: z.string().optional(),
  parentID: z.string().optional(),
  time: z.looseObject({
    created: z.number().nonnegative(),
    updated: z.number().nonnegative().optional(),
    archived: z.number().optional(),
  }),
})
export type SessionInfo = z.infer<typeof SessionInfo>

const Part = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  tool: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  state: z.looseObject({ status: z.string().optional() }).optional(),
})
export type OpenCodePart = z.infer<typeof Part>

export const MessageWithParts = z.looseObject({
  info: z.looseObject({
    id: z.string().min(1).max(200),
    role: z.enum(['user', 'assistant']),
    time: z.looseObject({ created: z.number().nonnegative() }),
  }),
  parts: z.array(z.unknown()),
})
export type MessageWithParts = z.infer<typeof MessageWithParts>

/** Any JSON array; items are validated one by one by `items`. */
export const AnyArray = z.array(z.unknown())

export function items<T>(schema: z.ZodType<T>, raw: unknown[]): T[] {
  const out: T[] = []
  for (const r of raw) {
    const p = schema.safeParse(r)
    if (p.success) out.push(p.data)
  }
  return out
}

export function parts(raw: unknown[]): OpenCodePart[] {
  return items(Part, raw)
}

/** A `/global/event` frame: `{directory?, payload: {type, properties}}`. */
export const GlobalEventFrame = z.looseObject({
  directory: z.string().optional(),
  payload: z.looseObject({ type: z.string().max(100), properties: z.unknown().optional() }),
})

/** OpenCode's built-in tool ids → the shared tool names (others keep their name, ≤ 100). */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  multiedit: 'Edit',
  apply_patch: 'Edit',
  read: 'Read',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  glob: 'Glob',
  grep: 'Grep',
  list: 'Glob',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
}
const TOOL = /^[A-Za-z0-9_.:-]{1,100}$/

/** A tool id → a shared name; undefined when it isn't a plain identifier (never pass odd text on). */
export function toolName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const mapped = TOOL_NAMES[raw.toLowerCase()]
  if (mapped) return mapped
  return TOOL.test(raw) ? raw : undefined
}
