// The Library (docs/capabilities.md §5): skills on 24 book slots, rules on 6 boards, memory on 8
// notebooks. Stable while a capability exists; the last slot of each becomes "+N more".
import type { Capability } from '@agent-office/shared'
import { assignSlots, type SlotMap } from './stations.ts'

export interface LibraryCapacity {
  books: number
  boards: number
  notebooks: number
}
export const LIBRARY_CAPACITY: Readonly<LibraryCapacity> = { books: 24, boards: 6, notebooks: 8 }
/** Books 0–11 are on shelf A (spot:shelf:0), 12–23 on shelf B. */
export const BOOKS_PER_SHELF = 12

export interface LibraryMap {
  books: SlotMap
  boards: SlotMap
  notebooks: SlotMap
}

export type LibraryKind = 'skill' | 'rule' | 'memory'

/** Which library surface a capability lives on (undefined for adapters). */
export function libraryKind(
  c: Pick<Capability, 'id' | 'category' | 'kind'>,
): LibraryKind | undefined {
  if (c.category === 'skill') return 'skill'
  if (c.category !== 'rule') return undefined
  return c.kind === 'memory' || c.id.startsWith('memory:') ? 'memory' : 'rule'
}

const SCOPE_RANK: Record<string, number> = { project: 0, user: 1, plugin: 2 }
const byName = (a: Capability, b: Capability) =>
  a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function boardRank(c: Capability): number {
  const project = c.scope === 'project' || c.id.startsWith('rule:project:')
  if (project) return c.kind === 'project-rules' ? 0 : 1
  return c.kind === 'user-rules' ? 2 : 3
}

export function assignLibrary(
  capabilities: Capability[],
  prev?: LibraryMap,
  capacity: LibraryCapacity = LIBRARY_CAPACITY,
): LibraryMap {
  const of = (k: LibraryKind) => capabilities.filter((c) => libraryKind(c) === k)
  const skills = of('skill').sort(
    (a, b) => (SCOPE_RANK[a.scope ?? ''] ?? 3) - (SCOPE_RANK[b.scope ?? ''] ?? 3) || byName(a, b),
  )
  const rules = of('rule').sort((a, b) => boardRank(a) - boardRank(b) || byName(a, b))
  const memory = of('memory').sort(byName)
  const ids = (cs: Capability[]) => cs.map((c) => c.id)
  return {
    books: assignSlots(ids(skills), prev?.books, capacity.books),
    boards: assignSlots(ids(rules), prev?.boards, capacity.boards),
    notebooks: assignSlots(ids(memory), prev?.notebooks, capacity.notebooks),
  }
}

/** The shelf spot (0 = A, 1 = B) to fetch from: the book's shelf; boards by shelf A, notebooks by B. */
export function libraryShelf(kind: LibraryKind, slot: number): 0 | 1 {
  if (kind === 'skill') return slot < BOOKS_PER_SHELF ? 0 : 1
  return kind === 'rule' ? 0 : 1
}
