// Pure edits of the providers' hook configs (docs/provider-integrations.md §6). Our entries are
// recognized by OBSERVE_MARKER in their command; foreign entries are never touched. Only
// non-blocking events are subscribed (a crash in our script must never veto an action).
// Verified shapes: see provider-hooks.test.ts.
import type { HookStatus } from '@agent-office/shared'
import { ValidationError } from './errors.ts'

/** Distinct from the Claude hook's marker (`agent-office-hook`). */
export const OBSERVE_MARKER = 'agent-office-observe'
const TIMEOUT_S = 5

export const HOOK_FORMATS = ['cursor-json', 'gemini-settings', 'copilot-file'] as const
export type HookFormat = (typeof HOOK_FORMATS)[number]

export const SUBSCRIBED: Readonly<Record<HookFormat, readonly string[]>> = {
  // `subagentStart` can allow/deny in Cursor, so it is not subscribed.
  'cursor-json': [
    'sessionStart',
    'afterAgentThought',
    'postToolUse',
    'afterShellExecution',
    'afterFileEdit',
    'afterMCPExecution',
    'stop',
    'subagentStop',
    'sessionEnd',
  ],
  'gemini-settings': [
    'SessionStart',
    'AfterModel',
    'AfterTool',
    'AfterAgent',
    'Notification',
    'SessionEnd',
  ],
  'copilot-file': [
    'sessionStart',
    'userPromptSubmitted',
    'postToolUse',
    'postToolUseFailure',
    'errorOccurred',
    'agentStop',
    'subagentStart',
    'subagentStop',
    'sessionEnd',
  ],
}

/** Events that can veto or rewrite an action. Never subscribed. */
export const BLOCKING_EVENTS: Readonly<Record<HookFormat, readonly string[]>> = {
  'cursor-json': [
    'preToolUse',
    'subagentStart',
    'beforeShellExecution',
    'beforeMCPExecution',
    'beforeReadFile',
    'beforeSubmitPrompt',
    'beforeTabFileRead',
  ],
  'gemini-settings': ['BeforeTool', 'BeforeAgent', 'BeforeModel', 'BeforeToolSelection'],
  'copilot-file': ['preToolUse', 'permissionRequest', 'userPromptTransformed'],
}

type Json = Record<string, unknown>
type Item = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const commandsOf = (h: unknown): string[] =>
  isObj(h)
    ? (['command', 'bash', 'powershell'] as const)
        .map((k) => h[k])
        .filter((c): c is string => typeof c === 'string')
    : []
const hasMarker = (h: unknown) => commandsOf(h).some((c) => c.includes(OBSERVE_MARKER))

/** Our hook entries within one item of an event list (Gemini nests them in a group). */
function ourEntries(format: HookFormat, item: unknown): unknown[] {
  if (format !== 'gemini-settings') return hasMarker(item) ? [item] : []
  const inner = isObj(item) && Array.isArray(item.hooks) ? item.hooks : []
  return inner.filter(hasMarker)
}

/** The item without our entries; null when nothing foreign remains in it. */
function withoutOurs(format: HookFormat, item: unknown): unknown | null {
  if (format !== 'gemini-settings') return hasMarker(item) ? null : item
  if (!isObj(item) || !Array.isArray(item.hooks)) return item
  const rest = item.hooks.filter((h) => !hasMarker(h))
  if (rest.length === item.hooks.length) return item
  return rest.length ? { ...item, hooks: rest } : null
}

function entry(format: HookFormat, command: string, event: string): Item {
  switch (format) {
    case 'cursor-json':
      return { command, timeout: TIMEOUT_S, failClosed: false }
    case 'gemini-settings':
      return {
        hooks: [{ type: 'command', name: OBSERVE_MARKER, command, timeout: TIMEOUT_S * 1000 }],
      }
    case 'copilot-file':
      // Copilot's camelCase payloads carry no event name: tell the observe script through `env`.
      return {
        type: 'command',
        command,
        timeoutSec: TIMEOUT_S,
        env: { AGENT_OFFICE_HOOK_EVENT: event },
      }
  }
}

const clone = (j: Json): Json => JSON.parse(JSON.stringify(j ?? {})) as Json
const hooksSection = (j: Json | undefined): Json | undefined =>
  isObj(j?.hooks) ? j.hooks : undefined

function wellFormed(json: Json): Json | undefined {
  if (json.hooks === undefined) return undefined
  if (!isObj(json.hooks)) throw new ValidationError('hooks must be an object')
  for (const v of Object.values(json.hooks))
    if (!Array.isArray(v)) throw new ValidationError('each hook event must be a list')
  return json.hooks
}

/** Removes our entries. Copilot: null = our own file is now empty and should be deleted. */
export function removeHooks(format: HookFormat, json: Json): Json | null {
  const out = clone(json)
  const hooks = hooksSection(out)
  if (!hooks) return out
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue
    const kept = list.map((i) => withoutOurs(format, i)).filter((i) => i !== null)
    if (kept.length === list.length && kept.every((k, n) => k === list[n])) continue
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  const empty = Object.keys(hooks).length === 0
  if (format === 'copilot-file' && empty) return null
  if (format === 'gemini-settings' && empty) delete out.hooks
  return out
}

/** Registers `command` for every subscribed event. Idempotent; replaces outdated commands. */
export function addHooks(format: HookFormat, json: Json, command: string): Json {
  wellFormed(clone(json))
  const out = removeHooks(format, json) ?? {}
  if (format !== 'gemini-settings') out.version ??= 1
  const hooks = (out.hooks ??= {}) as Record<string, unknown[]>
  for (const event of SUBSCRIBED[format])
    hooks[event] = [...(hooks[event] ?? []), entry(format, command, event)]
  return out
}

export function hookStatus(
  format: HookFormat,
  json: Json | undefined,
  expectedCommand: string,
): HookStatus {
  const hooks = hooksSection(json)
  const ours = SUBSCRIBED[format].map((e) => {
    const list = hooks?.[e]
    return Array.isArray(list) ? list.flatMap((i) => ourEntries(format, i)) : []
  })
  if (ours.every((l) => l.length === 0)) return 'not-installed'
  const current = ours.every((l) => l.some((h) => commandsOf(h).includes(expectedCommand)))
  return current ? 'installed' : 'outdated'
}
