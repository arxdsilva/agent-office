// Pure ACP → agent-office mapping (docs/provider-integrations.md §5.3, §5.4). Only status, tool
// names and ≤ 80-char reply snippets come out; titles, raw input, plans and thoughts never do.
// Field names follow @agentclientprotocol/sdk 1.8.0 (schema/types.gen.d.ts).
import type { RunnerDecision, RunnerPermission } from '@agent-office/core'
import type { AgentEvent, ModelOption } from '@agent-office/shared'
import type { AcpMode } from './acp-profile.ts'

export type EventPatch = Omit<AgentEvent, 'agentId'>

const MAX_REPLY = 4000

/** ACP `ToolKind` → shared tool names. `think` is absent on purpose: it is "thinking". */
export const DEFAULT_TOOL_KINDS: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Edit',
  move: 'Edit',
  search: 'Grep',
  execute: 'Bash',
  fetch: 'WebFetch',
  other: 'Tool',
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A tool kind → tool name; undefined for `think` (report thinking instead). */
export function toolName(
  kind: unknown,
  map: Partial<Record<string, string>> = {},
): string | undefined {
  const k = str(kind)
  if (k && map[k]) return map[k]
  if (k === 'think') return undefined
  return (k && DEFAULT_TOOL_KINDS[k]) || 'Tool'
}

export interface MapOptions {
  toolKindMap?: Partial<Record<string, string>>
}

/**
 * The short (profile) id of a native mode id; without profile modes the id is used as is. For a
 * future `modeId` event field (agent-initiated mode changes).
 */
export function shortModeId(native: string, modes: AcpMode[] | undefined): string | undefined {
  if (!modes) return native.length <= 60 ? native : undefined
  return modes.find((m) => (m.native ?? m.id) === native)?.id
}

/**
 * A `session/update` payload's `update` → event patch (undefined = nothing to report).
 * `current_mode_update` is handled by the runner (it emits `{modeId}` with the profile's short id).
 */
export function updateEvent(update: unknown, o: MapOptions = {}): EventPatch | undefined {
  const u = obj(update)
  if (!u) return undefined
  switch (u.sessionUpdate) {
    case 'agent_thought_chunk':
    case 'plan':
      return { status: 'thinking' }
    case 'tool_call': {
      const tool = toolName(u.kind, o.toolKindMap)
      return tool ? { status: 'tool', tool } : { status: 'thinking' }
    }
    case 'tool_call_update':
      return u.status === 'completed' || u.status === 'failed' ? { status: 'thinking' } : undefined
    default:
      return undefined
  }
}

/** Text of an `agent_message_chunk` (the reply is accumulated from these). */
export function messageChunk(update: unknown): { text: string; messageId?: string } | undefined {
  const u = obj(update)
  if (u?.sessionUpdate !== 'agent_message_chunk') return undefined
  const c = obj(u.content)
  const text = c?.type === 'text' ? str(c.text) : undefined
  if (text === undefined) return undefined
  const messageId = str(u.messageId)
  return messageId ? { text, messageId } : { text }
}

/** One line, ≤ 80 characters: the agent bubble only. */
export function replySnippet(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}

/** A prompt's `stopReason` → status patch + the turn result (docs §5.2 table). */
export function stopReasonOutcome(
  stopReason: unknown,
  reply: string,
): { event: EventPatch; result: { text: string; isError: boolean } } {
  const text = reply.slice(0, MAX_REPLY)
  switch (stopReason) {
    case 'cancelled':
      return { event: { status: 'idle' }, result: { text: '', isError: false } }
    case 'refusal':
      return { event: { status: 'error' }, result: { text, isError: true } }
    default: {
      // end_turn, max_tokens, max_turn_requests and future reasons: the turn is over.
      const snip = replySnippet(text)
      return {
        event: snip ? { status: 'waiting', text: snip } : { status: 'waiting' },
        result: { text, isError: false },
      }
    }
  }
}

/**
 * `session/request_permission` params → the core's permission shape. The tool is normalized and
 * `input` holds only the one field `summarizeToolRequest` shows (never the title).
 */
export function permissionRequest(
  params: unknown,
  cwd: string,
  o: MapOptions & { knownKind?: string } = {},
): RunnerPermission {
  const call = obj(obj(params)?.toolCall)
  const kind = str(call?.kind) ?? o.knownKind
  const tool = toolName(kind, o.toolKindMap) ?? 'Tool'
  const raw = obj(call?.rawInput) ?? {}
  const firstPath = () => {
    const locs = Array.isArray(call?.locations) ? call.locations : []
    return str(obj(locs[0])?.path) ?? ''
  }
  let input: Obj = {}
  switch (tool) {
    case 'Bash': {
      const c = raw.command
      const command = Array.isArray(c)
        ? c.filter((x) => typeof x === 'string').join(' ')
        : (str(c) ?? '')
      input = { command }
      break
    }
    case 'Edit':
    case 'Read':
      input = { file_path: firstPath() }
      break
    case 'Grep': {
      const pattern = str(raw.pattern) ?? str(raw.query)
      if (pattern) input = { pattern }
      break
    }
    case 'WebFetch': {
      const url = str(raw.url)
      if (url) input = { url }
      break
    }
  }
  return { tool, input, cwd }
}

type Outcome = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }

/**
 * The user's decision → a permission option. Never `allow_always` (it can persist beyond the
 * session in the provider's store): with no other allow option, allowing becomes a reject.
 */
export function chooseOption(options: unknown, d: RunnerDecision | 'cancel'): Outcome {
  const cancelled: Outcome = { outcome: { outcome: 'cancelled' } }
  if (d === 'cancel' || !Array.isArray(options)) return cancelled
  const opts = options.flatMap((x) => {
    const o = obj(x)
    const optionId = str(o?.optionId)
    return optionId ? [{ optionId, kind: str(o?.kind) ?? '' }] : []
  })
  const pick = (...kinds: string[]) => {
    for (const k of kinds) {
      const hit = opts.find((x) => x.kind === k)
      if (hit) return hit
    }
    return undefined
  }
  const reject = () => pick('reject_once', 'reject_always')
  const chosen =
    d.behavior === 'allow'
      ? (pick('allow_once') ??
        opts.find((x) => x.kind.startsWith('allow') && x.kind !== 'allow_always') ??
        reject())
      : reject()
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : cancelled
}

/** How a session's model can be changed, from a `session/new` result. */
export type ModelChoice =
  | { via: 'config'; configId: string; models: ModelOption[] }
  | { via: 'set_model'; models: ModelOption[] }

const option = (id: string | undefined, label: string | undefined, d: unknown) =>
  id ? [{ id, label: label ?? id, ...(str(d) ? { description: str(d)! } : {}) }] : []

/**
 * A `select` config option with category `model` (stable ACP: `session/set_config_option`), else the
 * session's `models` (`session/set_model`), else none.
 */
export function modelChoice(result: unknown): ModelChoice | undefined {
  const r = obj(result)
  if (!r) return undefined
  const configs = Array.isArray(r.configOptions) ? r.configOptions : []
  for (const c of configs.map(obj)) {
    if (!c || c.category !== 'model' || c.type !== 'select' || !str(c.id)) continue
    const raw = Array.isArray(c.options) ? c.options : []
    const flat = raw.flatMap((x) => {
      const o = obj(x)
      return Array.isArray(o?.options) ? (o.options as unknown[]) : [x]
    })
    const models = flat.flatMap((x) => {
      const o = obj(x)
      return option(str(o?.value), str(o?.name), o?.description)
    })
    if (models.length) return { via: 'config', configId: str(c.id)!, models }
  }
  const list = obj(r.models)?.availableModels
  const models = (Array.isArray(list) ? list : []).flatMap((x) => {
    const o = obj(x)
    return option(str(o?.modelId), str(o?.name), o?.description)
  })
  return models.length ? { via: 'set_model', models } : undefined
}
