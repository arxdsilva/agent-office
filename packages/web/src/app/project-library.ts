// The Library as a project's collections (plan §8). Pure: counts and collection names only, so a
// world label can never leak a memory title. Notebooks (port:notebook:0..7) become collections,
// shelves (port:book:*) Session Archive volumes by time bucket, boards the accepted decisions.
// Both renderers draw this through their capability-surface path when a project is selected.
import type { MemoryKind } from '@agent-office/shared'
import type { ProviderSurfaces, SurfaceSlot } from './capability-vm.ts'

export const COLLECTIONS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'constraints', label: 'Constraints' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'notes', label: 'Notes' },
  { id: 'pending', label: 'Pending review' },
  { id: 'handoffs', label: 'Handoffs' },
] as const
export type CollectionId = (typeof COLLECTIONS)[number]['id']

/** Approved-memory counts per kind, plus the review queue and handoffs (all numbers, no titles). */
export interface ProjectMemoryCounts {
  byKind: Partial<Record<MemoryKind, number>>
  pending: number
  handoffs: number
  /** Decisions whose status is accepted (a subset of byKind.decision). */
  acceptedDecisions: number
}

/** The slice of a session the archive needs. */
export interface ArchiveSession {
  lastSeenAt: number
}

export interface ProjectLibraryVM {
  projectId: string
  name: string
  color: string
  /** Notebook slot i → collection; the slots past the six collections stay empty. */
  notebooks: { id: CollectionId; label: string; count: number }[]
  /** Book slot i → one archive volume (a time bucket). Empty buckets are skipped. */
  books: { label: string; count: number }[]
  /** Board slot i → accepted decisions. */
  boards: { label: string; count: number }[]
}

const DAY = 86_400_000
const BUCKETS: { label: string; maxAgeDays: number }[] = [
  { label: 'Today', maxAgeDays: 1 },
  { label: 'This week', maxAgeDays: 7 },
  { label: 'This month', maxAgeDays: 30 },
  { label: 'Last 3 months', maxAgeDays: 90 },
  { label: 'Earlier', maxAgeDays: Infinity },
]

/** Sessions grouped into time-bucket volumes; never one book per session. */
export function archiveVolumes(
  sessions: readonly ArchiveSession[],
  now: number,
): { label: string; count: number }[] {
  const counts = BUCKETS.map(() => 0)
  for (const s of sessions) {
    const age = Math.max(0, now - s.lastSeenAt) / DAY
    const i = BUCKETS.findIndex((b) => age < b.maxAgeDays)
    counts[i === -1 ? BUCKETS.length - 1 : i]!++
  }
  return BUCKETS.map((b, i) => ({ label: b.label, count: counts[i]! })).filter((v) => v.count > 0)
}

export function projectLibraryVM(
  project: { id: string; name: string; color: string },
  memory: ProjectMemoryCounts,
  sessions: readonly ArchiveSession[],
  now: number,
): ProjectLibraryVM {
  const k = memory.byKind
  const count: Record<CollectionId, number> = {
    instructions: k.instruction ?? 0,
    constraints: k.constraint ?? 0,
    decisions: k.decision ?? 0,
    notes: (k.note ?? 0) + (k.fact ?? 0),
    pending: memory.pending,
    handoffs: memory.handoffs,
  }
  return {
    projectId: project.id,
    name: project.name,
    color: project.color,
    notebooks: COLLECTIONS.map((c) => ({ id: c.id, label: c.label, count: count[c.id] })),
    books: archiveVolumes(sessions, now),
    boards: [{ label: 'Accepted decisions', count: memory.acceptedDecisions }],
  }
}

/** The text a world label shows: a name and a number, nothing else. */
export const countLabel = (label: string, count: number): string => `${label} · ${count}`

// ── Drawing through the existing capability-surface path ────────────────────────────────────────
/** Notebook ports per wing (port:notebook:0..7). */
export const NOTEBOOK_SLOTS = 8
const REF_PREFIX = 'project:'

export type ProjectRefKind = 'collection' | 'archive' | 'decisions'
export interface ProjectRef {
  projectId: string
  kind: ProjectRefKind
  /** Collection id, archive bucket index, or board index. */
  key: string
}

/** The capability id a project surface carries through `CapabilityRef` (`project:<id>:<kind>:<key>`). */
export const projectRefId = (projectId: string, kind: ProjectRefKind, key: string | number) =>
  `${REF_PREFIX}${projectId}:${kind}:${key}`

export function parseProjectRef(id: string): ProjectRef | null {
  if (!id.startsWith(REF_PREFIX)) return null
  const [projectId, kind, key] = id.slice(REF_PREFIX.length).split(':')
  if (!projectId || !key) return null
  if (kind !== 'collection' && kind !== 'archive' && kind !== 'decisions') return null
  return { projectId, kind, key }
}

/** "Decisions · 4" for a project surface id, or null (not a project ref / no such slot). */
export function projectRefLabel(vm: ProjectLibraryVM, id: string): string | null {
  const r = parseProjectRef(id)
  if (!r || r.projectId !== vm.projectId) return null
  const row =
    r.kind === 'collection'
      ? vm.notebooks.find((n) => n.id === r.key)
      : r.kind === 'archive'
        ? vm.books[Number(r.key)]
        : vm.boards[Number(r.key)]
  return row ? countLabel(row.label, row.count) : null
}

const slot = <T>(id: string, vm: T, color: string): SurfaceSlot<T> => ({ id, vm, glow: 0, color })
const SPINE = '#5b5f66'

/**
 * Replaces every provider's notebooks, books and boards with the project's collections, archive
 * volumes and accepted decisions (stations stay). Slots past the project's content are empty.
 */
export function projectSurfaces(
  base: ReadonlyMap<string, ProviderSurfaces>,
  vm: ProjectLibraryVM,
): Map<string, ProviderSurfaces> {
  const out = new Map<string, ProviderSurfaces>()
  for (const [provider, s] of base) {
    const notebooks: ProviderSurfaces['notebooks'] = Array.from(
      { length: Math.max(s.notebooks.length, NOTEBOOK_SLOTS) },
      (_, i) => {
        const n = vm.notebooks[i]
        return n
          ? slot(
              projectRefId(vm.projectId, 'collection', n.id),
              { title: countLabel(n.label, n.count) },
              vm.color,
            )
          : undefined
      },
    )
    const books: ProviderSurfaces['books'] = Array.from(
      { length: Math.max(s.books.length, vm.books.length) },
      (_, i) => {
        const b = vm.books[i]
        return b
          ? slot(
              projectRefId(vm.projectId, 'archive', i),
              { title: countLabel(b.label, b.count), scope: 'ARCHIVE', color: SPINE },
              SPINE,
            )
          : undefined
      },
    )
    const boards: ProviderSurfaces['boards'] = Array.from(
      { length: Math.max(s.boards.length, vm.boards.length) },
      (_, i) => {
        const b = vm.boards[i]
        return b
          ? slot(
              projectRefId(vm.projectId, 'decisions', i),
              { title: b.label, scope: 'DECISIONS', summary: String(b.count), uses: '', last: '' },
              vm.color,
            )
          : undefined
      },
    )
    out.set(provider, { ...s, notebooks, books, boards })
  }
  return out
}
