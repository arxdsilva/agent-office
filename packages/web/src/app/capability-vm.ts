// Pure view models for the capability rooms (docs/capabilities.md §5): adapter station screens,
// library spines, rule boards, memory notebooks, the Capability panel and the agent panel chips.
// Every string here is drawn as plain text (canvas fillText or textContent).
import { STATUS_COLORS, type Capability, type CapabilityKind } from '@agent-office/shared'
import { libraryKind, type LibraryMap } from './library.ts'
import { linkColor } from './links.ts'
import type { AgentPlan } from './office-types.ts'
import type { SlotMap } from './stations.ts'
import { LIBRARY_GLOW_MS } from './behavior.ts'
import { hash32 } from './building.ts'
import { ago } from './format.ts'

export type Glyph = 'folder' | 'terminal' | 'globe' | 'people' | 'plug' | 'database' | 'braces'

const GLYPH: Partial<Record<CapabilityKind, Glyph>> = {
  filesystem: 'folder',
  shell: 'terminal',
  web: 'globe',
  subagents: 'people',
  mcp: 'plug',
  database: 'database',
  api: 'braces',
}
const KIND_LABEL: Partial<Record<CapabilityKind, string>> = {
  filesystem: 'Built-in',
  shell: 'Built-in',
  web: 'Built-in',
  subagents: 'Built-in',
  mcp: 'MCP',
  database: 'Database',
  api: 'API',
  skill: 'Skill',
  'project-rules': 'Project rules',
  rule: 'Rule',
  'user-rules': 'User rules',
  memory: 'Memory',
  other: 'Other',
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "a, b, c, +2" with at most `max` items. */
function capped(items: string[], max: number, more: (n: number) => string): string[] {
  return items.length <= max ? items : [...items.slice(0, max - 1), more(items.length - max + 1)]
}

export interface StationVM {
  title: string
  glyph: Glyph
  subtitle: string
  sees: string[]
  tools: string
  callers: string
  last: string
  calls: string
  active: boolean
  color: string
}

/** The holographic screen of one adapter station. */
export function stationVM(c: Capability, now: number, nameOf: (id: string) => string): StationVM {
  const n = c.active.length
  return {
    title: c.label,
    glyph: GLYPH[c.kind] ?? 'braces',
    subtitle: `${KIND_LABEL[c.kind] ?? 'Adapter'} · ${c.declared ? 'declared' : 'observed'}`,
    sees: capped(c.sees, 5, (k) => `+${k} more`),
    tools: capped(c.tools, 7, (k) => `+${k}`).join(', '),
    callers: n ? `● ${n} calling: ${c.active.map(nameOf).join(', ')}` : '',
    last: c.lastUsedAt === undefined ? 'not used yet' : `last call ${ago(c.lastUsedAt, now)}`,
    calls: plural(c.calls, 'call'),
    active: n > 0,
    color: linkColor(c),
  }
}

/** Station 7 when more than 8 adapters exist: "+N more" listing the rest. */
export function overflowVM(rest: Capability[]): StationVM {
  const active = rest.reduce((s, c) => s + c.active.length, 0)
  return {
    title: `+${rest.length} more`,
    glyph: 'plug',
    subtitle: 'More adapters',
    sees: capped(
      rest.map((c) => c.label),
      5,
      (k) => `+${k} more`,
    ),
    tools: '',
    callers: active ? `● ${active} calling` : '',
    last: '',
    calls: plural(
      rest.reduce((s, c) => s + c.calls, 0),
      'call',
    ),
    active: active > 0,
    color: STATUS_COLORS.idle,
  }
}

export interface BookVM {
  title: string
  scope: string
  color: string
}

/** A skill's spine: its name, a scope stripe and a stable cover color from the name. */
export function bookVM(c: Capability): BookVM {
  const h = hash32(c.label)
  const hue = h % 360
  const light = 30 + ((h >>> 9) % 18)
  return { title: c.label, scope: c.scope ?? '', color: hslHex(hue, 45, light) }
}

export interface BoardVM {
  title: string
  scope: string
  summary: string
  uses: string
  last: string
}

/** A rule board: title, scope badge, summary and recent reads. */
export function boardVM(c: Capability, now: number, nameOf: (id: string) => string): BoardVM {
  const reading = c.active.map(nameOf)
  return {
    title: c.label,
    scope: (c.scope ?? '').toUpperCase(),
    summary: c.summary ?? '',
    uses: c.calls ? `read ${c.calls}×` : 'not read yet',
    last: reading.length
      ? `● ${reading.join(', ')} reading now`
      : c.lastUsedAt === undefined
        ? ''
        : `last read ${ago(c.lastUsedAt, now)}`,
  }
}

/** A memory notebook: the title only (memory may hold personal facts, so no summary). */
export const notebookVM = (c: Capability): { title: string } => ({ title: c.label })

/** Name-tag bubble while an agent calls a capability. */
export function capabilityBubble(c: Capability, tool?: string): string {
  const lib = libraryKind(c)
  if (lib === 'skill') return `📖 ${c.label}`
  if (lib === 'rule') return `📜 ${c.label}`
  if (lib === 'memory') return `📓 ${c.label}`
  return tool ? `🔌 ${c.label} · ${tool}` : `🔌 ${c.label}`
}

export interface CapabilityPanelVM {
  /** `<provider> <id>` (stable identity for re-renders). */
  key: string
  provider: string
  id: string
  title: string
  subtitle: string
  summary: string
  sections: { title: string; items: string[] }[]
  meta: [string, string][]
  usedBy: { id: string; name: string }[]
  /** "Show links" toggle state (only this capability's links highlighted). */
  showLinks: boolean
}

/** The side panel for a clicked station, spine, board or notebook. */
export function capabilityPanelVM(
  c: Capability,
  now: number,
  nameOf: (id: string) => string,
  showLinks = false,
): CapabilityPanelVM {
  const adapter = c.category === 'adapter'
  const what = adapter ? (c.declared ? 'declared' : 'observed') : (c.scope ?? c.category)
  const sections = adapter
    ? [
        { title: 'Can see', items: c.sees },
        { title: 'Tools', items: c.tools },
      ].filter((s) => s.items.length)
    : []
  const usesLabel = adapter ? 'Calls' : c.category === 'skill' ? 'Invocations' : 'Reads'
  return {
    key: `${c.provider} ${c.id}`,
    provider: c.provider,
    id: c.id,
    title: c.label,
    subtitle: `${KIND_LABEL[c.kind] ?? c.kind} · ${what} · ${c.provider}`,
    summary: libraryKind(c) === 'memory' ? '' : (c.summary ?? ''),
    sections,
    meta: [
      [usesLabel, String(c.calls)],
      ['Last used', c.lastUsedAt === undefined ? 'never' : ago(c.lastUsedAt, now)],
    ],
    usedBy: c.active.map((id) => ({ id, name: nameOf(id) })),
    showLinks,
  }
}

export interface Chip {
  id: string
  label: string
  count: number
  color: string
}

/** What an agent has used this session (`used`: capability id → uses), adapters vs library. */
export function usedChips(
  caps: Capability[],
  used: Map<string, number>,
): { adapters: Chip[]; library: Chip[] } {
  const chips = caps
    .filter((c) => used.has(c.id))
    .map((c) => ({
      chip: { id: c.id, label: c.label, count: used.get(c.id)!, color: linkColor(c) },
      lib: c.category !== 'adapter',
    }))
    .sort((a, b) => b.chip.count - a.chip.count || a.chip.label.localeCompare(b.chip.label))
  return {
    adapters: chips.filter((x) => !x.lib).map((x) => x.chip),
    library: chips.filter((x) => x.lib).map((x) => x.chip),
  }
}

function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** One filled surface slot: the capability id (or '+more'), what to draw, and how much it glows. */
export interface SurfaceSlot<T> {
  id: string
  vm: T
  /** 1 while in use or within the glow window after the last use, else 0 (the scene eases it). */
  glow: number
  color: string
}

export interface ProviderSurfaces {
  stations: (SurfaceSlot<StationVM> | undefined)[]
  books: (SurfaceSlot<BookVM> | undefined)[]
  boards: (SurfaceSlot<BoardVM> | undefined)[]
  notebooks: (SurfaceSlot<{ title: string }> | undefined)[]
  /** Adapters in use now (drives the core column). */
  activeAdapters: number
}

/** Adapters glow while called; library surfaces also for LIBRARY_GLOW_MS after the last use. */
const glowOf = (c: Capability, now: number) =>
  c.active.length ||
  (c.category !== 'adapter' && c.lastUsedAt !== undefined && now - c.lastUsedAt < LIBRARY_GLOW_MS)
    ? 1
    : 0

function fill<T>(
  slots: SlotMap,
  byId: Map<string, Capability>,
  now: number,
  vm: (c: Capability) => T,
  more: (rest: Capability[]) => T,
): (SurfaceSlot<T> | undefined)[] {
  return slots.occupant.map((id, i) => {
    if (id !== undefined) {
      const c = byId.get(id)
      return c && { id, vm: vm(c), glow: glowOf(c, now), color: linkColor(c) }
    }
    if (i !== slots.occupant.length - 1 || !slots.overflow.length) return undefined
    const rest = slots.overflow.map((x) => byId.get(x)).filter((c): c is Capability => !!c)
    return {
      id: '+more',
      vm: more(rest),
      glow: Math.max(0, ...rest.map((c) => glowOf(c, now))),
      color: STATUS_COLORS.idle,
    }
  })
}

/** Everything the capability surfaces of each provider's wings show (stations, library). */
export function surfacesVM(
  capabilities: Map<string, Capability[]>,
  stations: Map<string, SlotMap>,
  library: Map<string, LibraryMap>,
  now: number,
  nameOf: (id: string) => string,
): Map<string, ProviderSurfaces> {
  const out = new Map<string, ProviderSurfaces>()
  for (const [provider, caps] of capabilities) {
    const byId = new Map(caps.map((c) => [c.id, c]))
    const st = stations.get(provider)
    const lib = library.get(provider)
    const moreTitle = (rest: Capability[]) => ({ title: `+${rest.length} more` })
    out.set(provider, {
      stations: st ? fill(st, byId, now, (c) => stationVM(c, now, nameOf), overflowVM) : [],
      books: lib
        ? fill(lib.books, byId, now, bookVM, (r) => ({
            ...moreTitle(r),
            scope: '',
            color: '#5b5f66',
          }))
        : [],
      boards: lib
        ? fill(
            lib.boards,
            byId,
            now,
            (c) => boardVM(c, now, nameOf),
            (r) => ({
              ...moreTitle(r),
              scope: '',
              summary: r.map((c) => c.label).join(' · '),
              uses: '',
              last: '',
            }),
          )
        : [],
      notebooks: lib ? fill(lib.notebooks, byId, now, notebookVM, moreTitle) : [],
      activeAdapters: caps.filter((c) => c.category === 'adapter' && c.active.length).length,
    })
  }
  return out
}

const CALLING: ReadonlySet<string> = new Set([
  'connection-call',
  'connection-visit',
  'library-call',
  'library-visit',
])

/** Name-tag bubbles for agents calling or visiting a capability (agent id → text). */
export function capabilityBubbles(
  plans: Map<string, AgentPlan>,
  capabilities: Map<string, Capability[]>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, p] of plans) {
    const capId = p.intent.capability
    if (!capId || !CALLING.has(p.intent.activity)) continue
    const c = capabilities.get(p.agent.provider)?.find((x) => x.id === capId)
    if (c) out.set(id, capabilityBubble(c, p.agent.tool))
  }
  return out
}
