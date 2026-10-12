// Capabilities: what a provider's agents can use (adapters, skills, rules) and how a tool call is
// classified as using one. Pure; the single definition is docs/capabilities.md.
import type {
  Capability,
  CapabilityCategory,
  CapabilityDecl,
  CapabilityKind,
  CapabilityScope,
} from '@agent-office/shared'

export const MAX_SEES = 8
export const MAX_TOOLS = 24
const MAX_LINE = 80
const MAX_LABEL = 80

/** What a tool call uses, before it's merged into the provider's catalog. */
export interface CapabilityRef {
  id: string
  category: CapabilityCategory
  kind: CapabilityKind
  label: string
  scope?: CapabilityScope
  /** Adapters only: the tool name recorded in `tools` (the `<tool>` part for MCP). */
  tool?: string
}

const BUILTINS = {
  fs: { kind: 'filesystem', label: 'Filesystem' },
  shell: { kind: 'shell', label: 'Shell' },
  web: { kind: 'web', label: 'Web' },
  subagents: { kind: 'subagents', label: 'Subagents' },
} as const satisfies Record<string, { kind: CapabilityKind; label: string }>
type BuiltinId = keyof typeof BUILTINS

const TOOL_TO_BUILTIN: Record<string, BuiltinId> = {
  Read: 'fs',
  Edit: 'fs',
  Write: 'fs',
  MultiEdit: 'fs',
  Glob: 'fs',
  Grep: 'fs',
  NotebookEdit: 'fs',
  LS: 'fs',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'subagents',
  Task: 'subagents',
}

/** Claude Code harness tools: never a capability. */
const HARNESS = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'ToolSearch',
  'SendMessage',
  'Monitor',
  'TaskStop',
])

const CLAUDE = 'claude-code'
const MCP_TOOL = /^mcp__(.+?)__(.+)$/
const DATABASE = /(db|sql|postgres|mongo|redis|sqlite)/i

// ── Target grammar (docs/capabilities.md §3) ─────────────────────────────────────────────────
export type ParsedTarget =
  | { form: 'project' | 'host' | 'cmd' | 'skill' | 'memory'; value: string }
  | { form: 'rule'; value: string; scope: 'project' | 'user' }

const TARGETS: [ParsedTarget['form'], RegExp][] = [
  ['project', /^project:([^/\\\u0000-\u001f]{1,92})$/],
  ['host', /^host:([A-Za-z0-9.-]{1,95})$/],
  ['cmd', /^cmd:([a-z0-9._-]{1,20})$/],
  ['skill', /^skill:([A-Za-z0-9:_-]{1,80})$/],
  ['memory', /^memory:([A-Za-z0-9_-][A-Za-z0-9._-]{0,79})$/],
]
const RULE_TARGET = /^rule:(project|user):([A-Za-z0-9_-][A-Za-z0-9._-]{0,79})$/

/** Parses a privacy-safe target; anything outside the grammar is dropped (undefined). */
export function parseTarget(target: string | undefined): ParsedTarget | undefined {
  if (!target) return undefined
  const rule = RULE_TARGET.exec(target)
  if (rule) return { form: 'rule', scope: rule[1] as 'project' | 'user', value: rule[2]! }
  for (const [form, re] of TARGETS) {
    const m = re.exec(target)
    if (m) return { form, value: m[1]! } as ParsedTarget
  }
  return undefined
}

/** The `sees` line an adapter target adds: `project: x`, `host: y`, `cmd: z`. */
export function seesLine(target: string | undefined): string | undefined {
  const t = parseTarget(target)
  if (!t || (t.form !== 'project' && t.form !== 'host' && t.form !== 'cmd')) return undefined
  return `${t.form}: ${t.value}`.slice(0, MAX_LINE)
}

/** `claude_ai_Google_Drive` → `Google Drive`, `github` → `Github`. */
export function prettifyServer(server: string): string {
  const stripped = server.replace(/^(claude_ai_|plugin_)/, '')
  const words = stripped.split(/[_-]+/).filter(Boolean)
  if (!words.length) return server
  return words
    .map((w) => (w === w.toUpperCase() ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
    .slice(0, MAX_LABEL)
}

const builtin = (id: BuiltinId, tool?: string): CapabilityRef => ({
  id,
  category: 'adapter',
  ...BUILTINS[id],
  ...(tool ? { tool } : {}),
})

const mcp = (server: string, tool?: string): CapabilityRef => ({
  id: `mcp:${server}`,
  category: 'adapter',
  kind: DATABASE.test(server) ? 'database' : 'mcp',
  label: prettifyServer(server),
  ...(tool ? { tool } : {}),
})

const skill = (name: string): CapabilityRef => ({
  id: `skill:${name}`,
  category: 'skill',
  kind: 'skill',
  label: name,
  ...(name.includes(':') ? { scope: 'plugin' as const } : {}),
})

function rule(scope: 'project' | 'user', file: string): CapabilityRef {
  const root = file === 'CLAUDE.md' || file === 'AGENTS.md'
  return {
    id: `rule:${scope}:${file}`,
    category: 'rule',
    kind: !root ? 'rule' : scope === 'user' ? 'user-rules' : 'project-rules',
    label: !root ? file : scope === 'user' ? `${file} (you)` : `${file} (project)`,
    scope,
  }
}

const memory = (slug: string): CapabilityRef => ({
  id: `memory:${slug}`,
  category: 'rule',
  kind: 'memory',
  label: slug,
})

/** Library capability from a parsed skill/rule/memory target. */
function library(t: ParsedTarget | undefined): CapabilityRef | undefined {
  if (t?.form === 'skill') return skill(t.value)
  if (t?.form === 'rule') return rule(t.scope, t.value)
  if (t?.form === 'memory') return memory(t.value)
  return undefined
}

const PLAIN_ID = /^[A-Za-z0-9:._-]{1,120}$/
const MCP_ID = /^mcp:([A-Za-z0-9_.-]{1,100})$/
const API_ID = /^api:([A-Za-z0-9:._-]{1,100})$/

/** An explicit capability id from a generic producer; undefined when malformed. */
function fromExplicit(id: string, tool: string): CapabilityRef | undefined {
  if (!PLAIN_ID.test(id)) return undefined
  if (id in BUILTINS) return builtin(id as BuiltinId, tool)
  const m = MCP_ID.exec(id)
  if (m) return mcp(m[1]!, tool)
  const a = API_ID.exec(id)
  if (a) return { id, category: 'adapter', kind: 'api', label: a[1]!.slice(0, MAX_LABEL), tool }
  if (/^(mcp|api|skill|rule|memory):/.test(id)) return library(parseTarget(id))
  return { id, category: 'adapter', kind: 'other', label: id.slice(0, MAX_LABEL), tool }
}

/**
 * Classifies a tool call (docs/capabilities.md §2). `explicit` is the event's `capability` field,
 * which wins when well-formed. Returns null when the call doesn't use a capability.
 */
export function classifyUse(
  provider: string,
  tool: string,
  target?: string,
  explicit?: string,
): CapabilityRef | null {
  if (explicit) {
    const ref = fromExplicit(explicit, tool)
    if (ref) return ref
  }
  const t = parseTarget(target)
  if (tool === 'Skill') return t?.form === 'skill' ? skill(t.value) : null
  const id = TOOL_TO_BUILTIN[tool]
  if (id) return (tool === 'Read' && library(t)) || builtin(id, tool)
  const m = MCP_TOOL.exec(tool)
  if (m) return mcp(m[1]!, m[2]!)
  if (provider === CLAUDE || HARNESS.has(tool)) return null
  return {
    id: `api:${tool}`,
    category: 'adapter',
    kind: 'api',
    label: tool.slice(0, MAX_LABEL),
    tool,
  }
}

/** Most recent first, deduplicated, capped. */
function front(items: readonly string[], add: readonly string[], cap: number): string[] {
  return [...new Set([...add, ...items])].slice(0, cap)
}

function fresh(provider: string, ref: CapabilityRef): Capability {
  return {
    id: ref.id,
    provider,
    category: ref.category,
    kind: ref.kind,
    label: ref.label,
    ...(ref.scope ? { scope: ref.scope } : {}),
    sees: [],
    tools: [],
    declared: false,
    calls: 0,
    active: [],
  }
}

/**
 * Records one use: adds the tool and the target's `sees` line (adapters only; dedup, recency,
 * caps), counts the call and stamps `lastUsedAt`. Declared metadata is kept.
 */
export function mergeUse(
  prev: Capability | undefined,
  provider: string,
  ref: CapabilityRef,
  use: { tool?: string; target?: string; now: number },
): Capability {
  const base = prev ?? fresh(provider, ref)
  const next: Capability = { ...base, calls: base.calls + 1, lastUsedAt: use.now }
  if (base.category === 'adapter') {
    const line = seesLine(use.target)
    if (line) next.sees = front(base.sees, [line], MAX_SEES)
    if (use.tool) next.tools = front(base.tools, [use.tool.slice(0, MAX_LINE)], MAX_TOOLS)
  }
  return next
}

/**
 * Applies a declaration: metadata comes from it (`declared: true`), `sees`/`tools` merge with what
 * was observed, usage counters stay. Memory never gets a summary; skills and rules never carry
 * `sees`/`tools`.
 */
export function declare(
  prev: Capability | undefined,
  provider: string,
  d: CapabilityDecl,
): Capability {
  const adapter = d.category === 'adapter'
  const next: Capability = {
    id: d.id,
    provider,
    category: d.category,
    kind: d.kind,
    label: d.label,
    sees: adapter ? front(prev?.sees ?? [], d.sees ?? [], MAX_SEES) : [],
    tools: adapter ? front(prev?.tools ?? [], d.tools ?? [], MAX_TOOLS) : [],
    declared: true,
    calls: prev?.calls ?? 0,
    active: prev?.active ?? [],
  }
  if (prev?.lastUsedAt !== undefined) next.lastUsedAt = prev.lastUsedAt
  if (d.summary && d.kind !== 'memory') next.summary = d.summary
  if (d.scope) next.scope = d.scope
  return next
}

/** Adds or removes an agent from `active`; returns `c` itself when nothing changes. */
export function withActive(c: Capability, agentId: string, on: boolean): Capability {
  const has = c.active.includes(agentId)
  if (has === on) return c
  return { ...c, active: on ? [...c.active, agentId] : c.active.filter((a) => a !== agentId) }
}

const ORDER: Record<CapabilityCategory, number> = { adapter: 0, skill: 1, rule: 2 }

/** Adapters, then skills, then rules; by id within a category. */
export function sortCapabilities(cs: Capability[]): Capability[] {
  return [...cs].sort(
    (a, b) => ORDER[a.category] - ORDER[b.category] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** A declaration for a configured MCP server, by name only. */
export function mcpDecl(server: string): CapabilityDecl {
  const { id, category, kind, label } = mcp(server)
  return { id, category, kind, label }
}

/** The always-present Claude Code adapters: fs, shell, web, subagents. */
export function builtinDecls(): CapabilityDecl[] {
  return (Object.keys(BUILTINS) as BuiltinId[]).map((id) => ({
    id,
    category: 'adapter',
    ...BUILTINS[id],
  }))
}
