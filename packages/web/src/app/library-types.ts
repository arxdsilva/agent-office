// Contract for the Library browser (low-spec plan Part B, §B2/§B7). Pure data. Owned by the lead;
// library-vm.ts produces these shapes, adapters/dom/library-browser.ts renders them.
/** Same shape as ports.ts `CapabilityRef` (kept here so this contract has no import cycle). */
export interface CapabilityRef {
  provider: string
  /** '+more' for an overflow aggregate. */
  id: string
}

export type LibraryTab = 'skills' | 'rules' | 'memory' | 'adapters'
export type LibrarySort = 'recent' | 'az' | 'shelf'

export interface LibraryRowVM {
  ref: CapabilityRef
  /** 📖 skill · 📜 rule · 📓 memory · 🔌 adapter */
  icon: string
  label: string
  scope?: 'project' | 'user' | 'plugin'
  /** ≤ 160 chars; never for memory. */
  summary?: string
  /** "used 3× · 2 m ago · by Maya" or "not used yet". */
  usage: string
  inUse: boolean
  /** Adapters: the first "can see" lines. */
  canSee?: string[]
  /** Shelf/board/notebook/station slot; absent for overflow items. */
  slot?: number
}

export interface LibraryVM {
  provider: string
  providers: string[]
  tab: LibraryTab
  tabs: { id: LibraryTab; label: string; count: number }[]
  query: string
  sort: LibrarySort
  rows: LibraryRowVM[]
  /** Items without a slot ("Not on a shelf"); Skills and Rules only. */
  overflow: LibraryRowVM[]
  overflowLabel?: string
  /** Empty-state text when there are no rows. */
  empty?: string
  /** Row to scroll to and highlight (e.g. after a '+more' pick). */
  focus?: 'overflow' | string
}

/** A view-bar entry (camera bookmark), now rendered by a DOM adapter. */
export interface ViewEntry {
  id: string
  label: string
  /** Grouped entries render as a menu button (Library ▾, Adapters ▾). */
  group?: 'library' | 'adapters'
  /** Provider for grouped entries. */
  provider?: string
  active?: boolean
}
