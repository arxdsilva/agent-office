/**
 * Pure edits of Claude Code's settings.json `hooks` section. Our entries are recognized by the
 * marker in their command; foreign hooks are never touched.
 */
export const HOOK_MARKER = 'agent-office-hook'
const EVENTS = ['Stop', 'UserPromptSubmit'] as const
const TIMEOUT_SECONDS = 5

type Json = Record<string, unknown>
interface HookEntry {
  type?: string
  command?: string
  [k: string]: unknown
}
interface HookGroup {
  hooks?: HookEntry[]
  [k: string]: unknown
}

const isOurs = (h: HookEntry) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)
const groupsOf = (settings: Json | undefined, event: string): HookGroup[] => {
  const hooks = settings?.hooks as Record<string, HookGroup[]> | undefined
  return Array.isArray(hooks?.[event]) ? hooks[event] : []
}

export function removeHooks(settings: Json): Json {
  const out = JSON.parse(JSON.stringify(settings ?? {})) as Json
  const hooks = out.hooks as Record<string, HookGroup[]> | undefined
  if (!hooks) return out
  for (const event of EVENTS) {
    const groups = groupsOf(out, event)
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0)
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete out.hooks
  return out
}

/** Registers `command` for Stop and UserPromptSubmit. Idempotent; replaces outdated commands. */
export function addHooks(settings: Json, command: string): Json {
  const out = removeHooks(settings)
  const hooks = (out.hooks ??= {}) as Record<string, HookGroup[]>
  for (const event of EVENTS) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ type: 'command', command, timeout: TIMEOUT_SECONDS }] },
    ]
  }
  return out
}

export function hookStatus(
  settings: Json | undefined,
  expectedCommand: string,
): 'installed' | 'outdated' | 'not-installed' {
  const ours = EVENTS.map((e) =>
    groupsOf(settings, e).flatMap((g) => (g.hooks ?? []).filter(isOurs)),
  )
  if (ours.every((list) => list.length === 0)) return 'not-installed'
  const current = ours.every((list) => list.some((h) => h.command === expectedCommand))
  return current ? 'installed' : 'outdated'
}
