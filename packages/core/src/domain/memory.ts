// Shared memory items: states, versions, merge, supersede (docs/projects.md §1). Pure.
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryOrigin,
  type MemoryScope,
  type MemoryState,
  type MemoryView,
} from '@agent-office/shared'
import { ValidationError } from './errors.ts'
import { cleanText } from './text.ts'

export type { MemoryOrigin }
export type DecisionStatus = 'proposed' | 'accepted' | 'deprecated'

export interface Provenance {
  origin: MemoryOrigin
  provider?: string
  sessionId?: string
  messageId?: string
  /** "you", a provider id, … (internal). */
  createdBy: string
  createdAt: number
  reviewedAt?: number
}

export interface MemoryItem {
  /** Lineage id: stays the same across versions. */
  id: string
  version: number
  /** null for global / workspace items (and memory of unassigned sessions). */
  projectId: string | null
  scope: MemoryScope
  kind: MemoryKind
  title: string
  body: string
  state: MemoryState
  provenance: Provenance
  /** When this version was written. */
  updatedAt: number
  supersededBy?: string
  mergedFrom?: string[]
  decision?: { status: DecisionStatus }
}

export const MAX_TITLE = 120
export const MAX_BODY = 4000

function title(t: string): string {
  const s = t.trim()
  if (!s || s.length > MAX_TITLE) throw new ValidationError('title must be 1–120 characters')
  return s
}

function body(b: string): string {
  const s = b.trim()
  if (!s || s.length > MAX_BODY) throw new ValidationError('body must be 1–4000 characters')
  return s
}

/** global/workspace ⇒ no project; project ⇒ a project; session ⇒ either. */
function placement(scope: MemoryScope, projectId: string | null): string | null {
  if (!MEMORY_SCOPES.includes(scope)) throw new ValidationError('invalid scope')
  if (scope === 'global' || scope === 'workspace') return null
  if (scope === 'project' && !projectId) throw new ValidationError('project scope needs a project')
  return projectId
}

function kind(k: MemoryKind): MemoryKind {
  if (!MEMORY_KINDS.includes(k)) throw new ValidationError('invalid kind')
  return k
}

export interface NewMemory {
  id: string
  projectId: string | null
  scope: MemoryScope
  kind: MemoryKind
  title: string
  body: string
  origin: MemoryOrigin
  createdBy: string
  provider?: string
  sessionId?: string
  messageId?: string
  now: number
}

/** The user's own items are approved at once; everything else waits for review. */
export function createMemory(o: NewMemory): MemoryItem {
  const approved = o.origin === 'user'
  const k = kind(o.kind)
  return {
    id: o.id,
    version: 1,
    projectId: placement(o.scope, o.projectId),
    scope: o.scope,
    kind: k,
    title: title(o.title),
    body: body(o.body),
    state: approved ? 'approved' : 'pending',
    provenance: {
      origin: o.origin,
      ...(o.provider ? { provider: o.provider } : {}),
      ...(o.sessionId ? { sessionId: o.sessionId } : {}),
      ...(o.messageId ? { messageId: o.messageId } : {}),
      createdBy: o.createdBy,
      createdAt: o.now,
      ...(approved ? { reviewedAt: o.now } : {}),
    },
    updatedAt: o.now,
    ...(k === 'decision' ? { decision: { status: approved ? 'accepted' : 'proposed' } } : {}),
  }
}

function review(m: MemoryItem, state: 'approved' | 'rejected', now: number): MemoryItem {
  if (m.state !== 'pending') throw new ValidationError(`cannot review a ${m.state} item`)
  return {
    ...m,
    state,
    updatedAt: now,
    provenance: { ...m.provenance, reviewedAt: now },
    ...(m.decision && state === 'approved' ? { decision: { status: 'accepted' } } : {}),
  }
}

export const approveMemory = (m: MemoryItem, now: number) => review(m, 'approved', now)
export const rejectMemory = (m: MemoryItem, now: number) => review(m, 'rejected', now)

export interface MemoryEdit {
  title?: string
  body?: string
  kind?: MemoryKind
  scope?: MemoryScope
}

/** Pending or approved items only; a new version with the same lineage id. */
export function editMemory(m: MemoryItem, e: MemoryEdit, now: number): MemoryItem {
  if (m.state !== 'pending' && m.state !== 'approved')
    throw new ValidationError(`cannot edit a ${m.state} item`)
  const scope = e.scope ?? m.scope
  const k = kind(e.kind ?? m.kind)
  const next: MemoryItem = {
    ...m,
    version: m.version + 1,
    scope,
    projectId: placement(scope, m.projectId),
    kind: k,
    title: e.title !== undefined ? title(e.title) : m.title,
    body: e.body !== undefined ? body(e.body) : m.body,
    updatedAt: now,
  }
  if (k === 'decision')
    next.decision = m.decision ?? { status: m.state === 'approved' ? 'accepted' : 'proposed' }
  else delete next.decision
  return next
}

function retire(m: MemoryItem, by: string, now: number): MemoryItem {
  return {
    ...m,
    version: m.version + 1,
    state: 'superseded',
    supersededBy: by,
    updatedAt: now,
    ...(m.decision ? { decision: { status: 'deprecated' } } : {}),
  }
}

/** An approved item is replaced by a newer approved one. */
export function supersedeMemory(
  old: MemoryItem,
  replacement: MemoryItem,
  now: number,
): { old: MemoryItem; replacement: MemoryItem } {
  if (old.state !== 'approved') throw new ValidationError('only approved items can be superseded')
  if (replacement.state !== 'approved')
    throw new ValidationError('the replacement must be approved')
  return { old: retire(old, replacement.id, now), replacement }
}

/** Approved items become one approved item listing `mergedFrom`; the sources are superseded. */
export function mergeMemories(
  items: MemoryItem[],
  into: MemoryItem,
  now: number,
): { merged: MemoryItem; sources: MemoryItem[] } {
  const ids = new Set(items.map((i) => i.id))
  if (items.length < 2 || ids.size !== items.length)
    throw new ValidationError('merge needs at least two different items')
  if (items.some((i) => i.state !== 'approved'))
    throw new ValidationError('only approved items can be merged')
  if (into.state !== 'approved') throw new ValidationError('the merged item must be approved')
  return {
    merged: { ...into, mergedFrom: items.map((i) => i.id) },
    sources: items.map((i) => retire(i, into.id, now)),
  }
}

// ── Automatic knowledge import (docs/projects.md §8b) ──
// A separate, explicit constructor: the user approved these summaries once, through the opt-in
// (`approvedAt`). `createMemory`'s rule (only the user's own items are approved) is unchanged.

export const IMPORT_ORIGIN = 'session-import'
export const MAX_IMPORTED_BODY = 2000

const importedTitle = (sessionTitle: string) =>
  cleanText(`Session: ${sessionTitle.replace(/\s+/g, ' ').trim() || 'Untitled session'}`, MAX_TITLE)

function importedBody(summary: string): string {
  const s = cleanText(summary.trim(), MAX_IMPORTED_BODY)
  if (!s) throw new ValidationError('an imported summary cannot be empty')
  return s
}

function requireImported(m: MemoryItem): void {
  if (m.provenance.origin !== IMPORT_ORIGIN) throw new ValidationError('not an auto-imported item')
  if (m.state !== 'approved') throw new ValidationError(`cannot change a ${m.state} item`)
}

/** One session's summary as approved memory: project scope when assigned, else session scope. */
export function createImportedMemory(o: {
  id: string
  session: { id: string; title: string }
  summary: string
  projectId: string | null
  now: number
  /** When the user opted in (recorded as `reviewedAt`). */
  approvedAt: number
}): MemoryItem {
  return {
    id: o.id,
    version: 1,
    projectId: o.projectId,
    scope: o.projectId ? 'project' : 'session',
    kind: 'note',
    title: importedTitle(o.session.title),
    body: importedBody(o.summary),
    state: 'approved',
    provenance: {
      origin: IMPORT_ORIGIN,
      provider: 'claude-code',
      sessionId: o.session.id,
      createdBy: 'auto-import',
      createdAt: o.now,
      reviewedAt: o.approvedAt,
    },
    updatedAt: o.now,
  }
}

/** A new version with the new summary (and title); unchanged text returns `m` itself. */
export function reviseImportedMemory(
  m: MemoryItem,
  summary: string,
  now: number,
  sessionTitle?: string,
): MemoryItem {
  requireImported(m)
  const nextBody = importedBody(summary)
  const nextTitle = sessionTitle === undefined ? m.title : importedTitle(sessionTitle)
  if (nextBody === m.body && nextTitle === m.title) return m
  return { ...m, version: m.version + 1, body: nextBody, title: nextTitle, updatedAt: now }
}

/** The session was (re)assigned: a new version in the new place; the same place returns `m`. */
export function rehomeImportedMemory(
  m: MemoryItem,
  projectId: string | null,
  now: number,
): MemoryItem {
  requireImported(m)
  if (m.projectId === projectId) return m
  return {
    ...m,
    version: m.version + 1,
    projectId,
    scope: projectId ? 'project' : 'session',
    updatedAt: now,
  }
}

/** The user removed it ("Remove imported memory"): approved → rejected, as a new version. */
export function retractMemory(m: MemoryItem, now: number): MemoryItem {
  if (m.state !== 'approved') throw new ValidationError(`cannot retract a ${m.state} item`)
  return { ...m, version: m.version + 1, state: 'rejected', updatedAt: now }
}

/** Over the per-project cap: the oldest approved items are retired (`supersededBy: 'cap'`). */
export function supersedeByCap(m: MemoryItem, now: number): MemoryItem {
  if (m.state !== 'approved') throw new ValidationError('only approved items can be superseded')
  return retire(m, 'cap', now)
}

/**
 * The copy a cross-partition move leaves in the OLD partition: the moved version's number, marked
 * superseded by itself. On load a live record of the same version always wins over it, so the
 * lineage resolves to the newest place; if the new partition is gone, the item stays retired.
 */
export function moveTombstone(prev: MemoryItem, moved: MemoryItem): MemoryItem {
  return {
    ...prev,
    version: moved.version,
    state: 'superseded',
    supersededBy: prev.id,
    updatedAt: moved.updatedAt,
  }
}

export const isMoveTombstone = (m: MemoryItem) =>
  m.state === 'superseded' && m.supersededBy === m.id

export function toMemoryView(m: MemoryItem): MemoryView {
  const p = m.provenance
  return {
    id: m.id,
    version: m.version,
    projectId: m.projectId,
    scope: m.scope,
    kind: m.kind,
    title: m.title,
    body: m.body,
    state: m.state,
    provenance: {
      origin: p.origin,
      ...(p.provider ? { provider: p.provider } : {}),
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      ...(p.messageId ? { messageId: p.messageId } : {}),
      createdAt: p.createdAt,
      ...(p.reviewedAt !== undefined ? { reviewedAt: p.reviewedAt } : {}),
    },
    ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}),
    ...(m.mergedFrom ? { mergedFrom: [...m.mergedFrom] } : {}),
    ...(m.decision ? { decision: { ...m.decision } } : {}),
  }
}
