// Drag and drop of harnesses (docs/harness.md §7): pure decisions only. The DOM adapters translate
// dragstart/dragover/drop into these calls and act on the returned intent; nothing here touches
// the DOM, so a re-render mid-drag cannot change an answer.
import type { HarnessStatus, HarnessSummary } from '@agent-office/shared'

/** The only payload type a harness drag carries (no text/plain: nothing pastes into inputs). */
export const HARNESS_MIME = 'application/x-agent-office-harness'

export type DragSource = 'library' | 'applied'
/** What is being dragged, set from `dragstart` and cleared on `dragend`/`drop`. */
export interface HarnessDrag {
  harnessId: string
  source: DragSource
  status: HarnessStatus
  /** The target under the pointer, for highlights that survive a re-render. */
  over?: DropTarget
}

export type DropTarget =
  /** The Applied column's drop zone (or the empty column). */
  | { kind: 'applied-zone' }
  /** An Applied row; `after` = the pointer is below the row's midpoint. */
  | { kind: 'applied-row'; harnessId: string; after: boolean }
  /** The Library column (anywhere but a card). */
  | { kind: 'library' }
  | { kind: 'library-card'; harnessId: string; after: boolean }
  /** A project row in the sidebar. */
  | { kind: 'project'; projectId: string }

export type RejectReason = 'draft' | 'archived' | 'no-scope' | 'already'
export type DropIntent =
  /** Attach to `projectId`; `ids` = the Applied order wanted afterwards (when dropped on a row). */
  | { kind: 'attach'; projectId: string; ids?: string[] }
  | { kind: 'reorder'; projectId: string; ids: string[] }
  | { kind: 'detach'; projectId: string }
  | { kind: 'reorder-library'; ids: string[] }
  | { kind: 'reject'; reason: RejectReason; projectId?: string }
  /** Not a drop target for this drag (no highlight, no preventDefault). */
  | { kind: 'none' }

export interface DropContext {
  /** The pane's scope project (`#hb-scope`). */
  scopeProjectId: string | null
  /** The scope project's attached harnesses in Applied order. */
  applied: string[]
  /** The library cards in their current order. */
  library: string[]
  /** Attached harness ids per project (for sidebar drops). */
  attached: (projectId: string) => string[]
}

/** The index a dragged item lands at: the first row whose midpoint is below the pointer. */
export function insertionIndex(rowTops: number[], rowHeights: number[], pointerY: number): number {
  for (let i = 0; i < rowTops.length; i++) {
    if (pointerY < rowTops[i]! + (rowHeights[i] ?? 0) / 2) return i
  }
  return rowTops.length
}

/** `ids` with `id` moved to final position `toIndex` (clamped). Unknown ids leave it unchanged. */
export function moveId(ids: string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids.slice()
  const rest = ids.filter((x) => x !== id)
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** Moves `id` before (or after) `targetId`; inserts it there when it is not in the list yet. */
export function placeId(ids: string[], id: string, targetId: string, after: boolean): string[] {
  const rest = ids.filter((x) => x !== id)
  const t = rest.indexOf(targetId)
  if (t < 0) return ids.includes(id) ? ids.slice() : [...ids, id]
  const at = after ? t + 1 : t
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The user's library order first, then harnesses the order does not know (newest first);
 * archived ones always last.
 */
export function sortLibrary<T extends Pick<HarnessSummary, 'id' | 'status' | 'createdAt'>>(
  summaries: T[],
  order: string[],
): T[] {
  const pos = new Map(order.map((id, i) => [id, i]))
  const rank = (s: T): number => (s.status === 'archived' ? 1 : 0)
  return [...summaries].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r) return r
    const pa = pos.get(a.id)
    const pb = pos.get(b.id)
    if (pa !== undefined && pb !== undefined) return pa - pb
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    return b.createdAt - a.createdAt
  })
}

function attachable(status: HarnessStatus): RejectReason | null {
  if (status === 'draft') return 'draft'
  if (status === 'archived') return 'archived'
  return null
}

/** What dropping `drag` on `target` would do. */
export function dropIntent(
  drag: HarnessDrag | null,
  target: DropTarget,
  ctx: DropContext,
): DropIntent {
  if (!drag) return { kind: 'none' }
  const id = drag.harnessId
  if (drag.source === 'library') {
    switch (target.kind) {
      case 'library':
        return { kind: 'none' }
      case 'library-card': {
        if (target.harnessId === id) return { kind: 'none' }
        const ids = placeId(ctx.library, id, target.harnessId, target.after)
        return same(ids, ctx.library) ? { kind: 'none' } : { kind: 'reorder-library', ids }
      }
      case 'project': {
        const bad = attachable(drag.status)
        if (bad) return { kind: 'reject', reason: bad, projectId: target.projectId }
        if (ctx.attached(target.projectId).includes(id))
          return { kind: 'reject', reason: 'already', projectId: target.projectId }
        return { kind: 'attach', projectId: target.projectId }
      }
      case 'applied-zone':
      case 'applied-row': {
        const pid = ctx.scopeProjectId
        if (!pid) return { kind: 'reject', reason: 'no-scope' }
        const bad = attachable(drag.status)
        if (bad) return { kind: 'reject', reason: bad, projectId: pid }
        const has = ctx.applied.includes(id)
        if (target.kind === 'applied-zone') {
          if (!has) return { kind: 'attach', projectId: pid }
          const ids = moveId(ctx.applied, id, ctx.applied.length)
          return same(ids, ctx.applied)
            ? { kind: 'none' }
            : { kind: 'reorder', projectId: pid, ids }
        }
        if (target.harnessId === id) return { kind: 'none' }
        const ids = placeId(ctx.applied, id, target.harnessId, target.after)
        if (!has) return { kind: 'attach', projectId: pid, ids }
        return same(ids, ctx.applied) ? { kind: 'none' } : { kind: 'reorder', projectId: pid, ids }
      }
    }
  }
  // From the Applied column.
  const pid = ctx.scopeProjectId
  if (!pid) return { kind: 'none' }
  switch (target.kind) {
    case 'library':
    case 'library-card':
      return { kind: 'detach', projectId: pid }
    case 'applied-zone': {
      const ids = moveId(ctx.applied, id, ctx.applied.length)
      return same(ids, ctx.applied) ? { kind: 'none' } : { kind: 'reorder', projectId: pid, ids }
    }
    case 'applied-row': {
      if (target.harnessId === id) return { kind: 'none' }
      const ids = placeId(ctx.applied, id, target.harnessId, target.after)
      return same(ids, ctx.applied) ? { kind: 'none' } : { kind: 'reorder', projectId: pid, ids }
    }
    case 'project':
      return { kind: 'none' }
  }
}

/** Whether a target accepts the drop (the adapter calls `preventDefault()` on dragover then). */
export const accepts = (i: DropIntent): boolean => i.kind !== 'none' && i.kind !== 'reject'

export interface AnnounceNames {
  harness: string
  project?: string
  /** 1-based position after a reorder. */
  position?: number
}
export const LIVE = {
  hover: (h: string, p: string) => `Drop to apply ${h} to ${p}`,
  attached: (h: string, p: string) => `Applied ${h} to ${p}`,
  moved: (h: string, n: number) => `Moved ${h} to position ${n}`,
  detach: (h: string, p: string) => `Detach ${h} from ${p}?`,
  detached: (h: string, p: string) => `Detached ${h} from ${p}`,
  arranged: (h: string) => `Moved ${h} in the library`,
  draft: (h: string) => `Publish ${h} first`,
  archived: 'Archived harnesses cannot be applied',
  noScope: 'Pick a project to apply harnesses to.',
  already: (h: string, p: string) => `${h} is already applied to ${p}`,
}

/** The `#hb-live` sentence for an intent (the outcome when dropped). */
export function announce(i: DropIntent, n: AnnounceNames): string {
  const p = n.project ?? ''
  switch (i.kind) {
    case 'attach':
      return LIVE.attached(n.harness, p)
    case 'reorder':
      return LIVE.moved(n.harness, n.position ?? i.ids.length)
    case 'detach':
      return LIVE.detach(n.harness, p)
    case 'reorder-library':
      return LIVE.arranged(n.harness)
    case 'reject':
      return i.reason === 'draft'
        ? LIVE.draft(n.harness)
        : i.reason === 'archived'
          ? LIVE.archived
          : i.reason === 'already'
            ? LIVE.already(n.harness, p)
            : LIVE.noScope
    case 'none':
      return ''
  }
}
