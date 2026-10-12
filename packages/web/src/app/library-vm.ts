// The Library browser's view model (low-spec plan §B2) and the hover tooltip text. Pure: rows for
// every skill, rule, memory entry and adapter of one provider, including the overflow that has no
// shelf slot. Every string is drawn as plain text by the DOM adapter.
import type { Capability } from '@agent-office/shared'
import { ago } from './format.ts'
import { assignLibrary, libraryKind, type LibraryMap } from './library.ts'
import { LIB_COPY } from './library-copy.ts'
import type { LibraryRowVM, LibrarySort, LibraryTab, LibraryVM } from './library-types.ts'
import { assignStations, type SlotMap } from './stations.ts'

export const LIBRARY_TABS: readonly LibraryTab[] = ['skills', 'rules', 'memory', 'adapters']
const ICON: Record<LibraryTab, string> = { skills: '📖', rules: '📜', memory: '📓', adapters: '🔌' }
const KIND: Record<LibraryTab, string> = {
  skills: 'skill',
  rules: 'rule',
  memory: 'memory',
  adapters: 'adapter',
}
/** Tabs whose unslotted items form the "Not on a shelf" group. */
const OVERFLOW_TABS: ReadonlySet<LibraryTab> = new Set(['skills', 'rules'])
const CLAUDE = 'claude-code'

export function tabOf(c: Pick<Capability, 'id' | 'category' | 'kind'>): LibraryTab {
  const lib = libraryKind(c)
  return lib === 'skill'
    ? 'skills'
    : lib === 'rule'
      ? 'rules'
      : lib === 'memory'
        ? 'memory'
        : 'adapters'
}

/** Providers that have any capability, A–Z. */
export const libraryProviders = (caps: Map<string, Capability[]>): string[] =>
  [...caps]
    .filter(([, list]) => list.length)
    .map(([p]) => p)
    .sort()

/** The requested provider, else the selected agent's, else claude-code, else the first one. */
export function defaultLibraryProvider(
  caps: Map<string, Capability[]>,
  selectedProvider?: string,
  requested?: string,
): string {
  const list = libraryProviders(caps)
  for (const p of [requested, selectedProvider, CLAUDE]) if (p && list.includes(p)) return p
  return list[0] ?? requested ?? ''
}

export interface LibraryInput {
  capabilities: Map<string, Capability[]>
  /** The provider picked in the drawer (falls back per `defaultLibraryProvider`). */
  provider?: string
  /** The selected agent's provider. */
  selectedProvider?: string
  tab: LibraryTab
  query: string
  sort: LibrarySort
  /** The director's slot maps (stable slots); computed from the capabilities when absent. */
  library?: Map<string, LibraryMap>
  stations?: Map<string, SlotMap>
  now: number
  nameOf: (id: string) => string
  focus?: LibraryVM['focus']
}

/** A capability's own surface slot (undefined when it overflowed or has none). */
export function shelfSlot(
  c: Capability,
  lib: LibraryMap | undefined,
  stations: SlotMap | undefined,
  caps: Capability[] = [c],
): number | undefined {
  const tab = tabOf(c)
  const slots = slotsFor(tab, lib ?? assignLibrary(caps), stations ?? assignStations(caps))
  const s = slots.slot.get(c.id)
  return s !== undefined && slots.occupant[s] === c.id ? s : undefined
}

/** Items on the "+N more" aggregate of a tab's surfaces. */
export function overflowCount(tab: LibraryTab, lib: LibraryMap, stations: SlotMap): number {
  return slotsFor(tab, lib, stations).overflow.length
}

/** '+more' or '+more:<tab>' (the scene's overflow aggregate); the tab when it says so. */
export function parseMore(id: string): { tab?: LibraryTab } | undefined {
  if (id === '+more') return {}
  const m = /^\+more:(skills|rules|memory|adapters)$/.exec(id)
  return m ? { tab: m[1] as LibraryTab } : undefined
}

const slotsFor = (tab: LibraryTab, lib: LibraryMap, stations: SlotMap): SlotMap =>
  tab === 'skills'
    ? lib.books
    : tab === 'rules'
      ? lib.boards
      : tab === 'memory'
        ? lib.notebooks
        : stations

function matches(c: Capability, tab: LibraryTab, q: string): boolean {
  if (!q) return true
  if (c.label.toLowerCase().includes(q)) return true
  return tab !== 'memory' && !!c.summary?.toLowerCase().includes(q)
}

function usage(c: Capability, now: number, nameOf: (id: string) => string): string {
  const parts = [
    c.lastUsedAt === undefined ? LIB_COPY.never : LIB_COPY.used(c.calls, ago(c.lastUsedAt, now)),
  ]
  if (c.active.length) parts.push(LIB_COPY.by(c.active.map(nameOf).join(', ')))
  return parts.join(' · ')
}

function row(
  c: Capability,
  tab: LibraryTab,
  slot: number | undefined,
  now: number,
  nameOf: (id: string) => string,
): LibraryRowVM {
  const r: LibraryRowVM = {
    ref: { provider: c.provider, id: c.id },
    icon: ICON[tab],
    label: c.label,
    usage: usage(c, now, nameOf),
    inUse: c.active.length > 0,
  }
  if (c.scope) r.scope = c.scope
  if (tab !== 'memory' && c.summary) r.summary = c.summary
  if (tab === 'adapters' && c.sees.length) r.canSee = c.sees.slice(0, 2)
  if (slot !== undefined) r.slot = slot
  return r
}

export function libraryVM(i: LibraryInput): LibraryVM {
  const providers = libraryProviders(i.capabilities)
  const provider = defaultLibraryProvider(i.capabilities, i.selectedProvider, i.provider)
  const caps = i.capabilities.get(provider) ?? []
  const lib = i.library?.get(provider) ?? assignLibrary(caps)
  const stations = i.stations?.get(provider) ?? assignStations(caps)
  const q = i.query.trim().toLowerCase()
  const found = caps.filter((c) => matches(c, tabOf(c), q))
  const tabs = LIBRARY_TABS.map((id) => ({
    id,
    label: LIB_COPY.tabs[id],
    count: found.filter((c) => tabOf(c) === id).length,
  }))

  const slots = slotsFor(i.tab, lib, stations)
  /** Shelf order: slotted by slot, then the overflow in its own order, then anything else. */
  const shelfRank = (c: Capability) => {
    const s = slots.slot.get(c.id)
    if (s !== undefined && slots.occupant[s] === c.id) return s
    const o = slots.overflow.indexOf(c.id)
    return slots.occupant.length + (o < 0 ? slots.overflow.length : o)
  }
  const cmp: Record<LibrarySort, (a: Capability, b: Capability) => number> = {
    shelf: (a, b) => shelfRank(a) - shelfRank(b),
    recent: (a, b) =>
      (b.lastUsedAt ?? -Infinity) - (a.lastUsedAt ?? -Infinity) || shelfRank(a) - shelfRank(b),
    az: (a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  }
  const inTab = found.filter((c) => tabOf(c) === i.tab).sort(cmp[i.sort])
  const rows: LibraryRowVM[] = []
  const overflow: LibraryRowVM[] = []
  for (const c of inTab) {
    const s = slots.slot.get(c.id)
    const slot = s !== undefined && slots.occupant[s] === c.id ? s : undefined
    const r = row(c, i.tab, slot, i.now, i.nameOf)
    if (slot === undefined && OVERFLOW_TABS.has(i.tab)) overflow.push(r)
    else rows.push(r)
  }

  const vm: LibraryVM = {
    provider,
    providers,
    tab: i.tab,
    tabs,
    query: i.query,
    sort: i.sort,
    rows,
    overflow,
  }
  if (overflow.length) vm.overflowLabel = LIB_COPY.overflow(overflow.length)
  if (!rows.length && !overflow.length)
    vm.empty = q ? LIB_COPY.empty.search(i.query.trim()) : LIB_COPY.empty[i.tab]
  if (i.focus) vm.focus = i.focus
  return vm
}

/** Hover tooltip for a capability surface: "📖 run-office · skill (project) · click to open". */
export function tooltipText(c: Capability): string {
  const tab = tabOf(c)
  const kind =
    (tab === 'skills' || tab === 'rules') && c.scope ? `${KIND[tab]} (${c.scope})` : KIND[tab]
  return LIB_COPY.tooltip(ICON[tab], c.label, kind)
}

/** Hover tooltip for a "+N more" surface. */
export const moreTooltipText = (n: number): string =>
  LIB_COPY.tooltip('📚', `+${n} more`, LIB_COPY.notOnShelf)
