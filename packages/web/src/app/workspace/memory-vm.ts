// The Memory browser: list with state badges, detail with provenance, actions enabled per state.
import { MEMORY_SCOPES, type MemoryView } from '@agent-office/shared'
import { ago } from '../format.ts'
import { MEMORY_ALL, MEMORY_GLOBAL, MEMORY_UNASSIGNED } from './state-types.ts'
import { memoryInScope, type WorkspaceState } from './state.ts'
import type {
  BadgeVM,
  ButtonVM,
  MemoryDetailVM,
  MemoryFilterKey,
  MemoryRowVM,
  MemoryVM,
} from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const M = WS_COPY.memory
const FILTERS: readonly MemoryFilterKey[] = ['all', 'pending', 'approved', 'rejected', 'superseded']
const STATE_TONE = {
  pending: 'warn',
  approved: 'good',
  rejected: 'bad',
  superseded: 'neutral',
} as const

export function memoryBadges(m: MemoryView): BadgeVM[] {
  const out: BadgeVM[] = [{ label: M.state[m.state], tone: STATE_TONE[m.state] }]
  if (m.provenance.origin === 'agent-proposal') out.push({ label: M.agentProposed, tone: 'warn' })
  return out
}

/** Resolves ids to human names for provenance text; ids themselves are never shown. */
export interface ProvenanceLookup {
  session(id: string): { title: string; provider: string } | undefined
  memory(id: string): string | undefined
}

export const provenanceLookup = (s: WorkspaceState): ProvenanceLookup => ({
  session(id) {
    const x =
      s.sessions.find((y) => y.id === id) ??
      Object.values(s.dashboards)
        .flatMap((d) => d.sessions)
        .find((y) => y.id === id) ??
      s.sessionTitles[id]
    return x ? { title: x.title, provider: String(x.provider) } : undefined
  },
  memory: (id) => s.memories.find((x) => x.id === id)?.title,
})

export function provenanceLines(m: MemoryView, now: number, lookup?: ProvenanceLookup): string[] {
  const p = m.provenance
  const lines: string[] = [M.prov[p.origin]]
  if (p.sessionId) {
    const found = lookup?.session(p.sessionId)
    lines.push(M.session(found?.title, found?.provider ?? p.provider))
  } else if (p.provider) lines.push(M.provider(p.provider))
  if (p.messageId) lines.push(M.savedFromMessage)
  lines.push(M.created(ago(p.createdAt, now)))
  lines.push(p.reviewedAt ? M.reviewed(ago(p.reviewedAt, now)) : M.notReviewed)
  if (m.supersededBy) lines.push(M.supersededBy(lookup?.memory(m.supersededBy)))
  if (m.mergedFrom?.length) lines.push(M.mergedFrom(m.mergedFrom.length))
  return lines
}

export const memoryVisible = (s: WorkspaceState): MemoryView[] => {
  const q = s.memoryQuery.trim().toLowerCase()
  return s.memories
    .filter((m) => memoryInScope(m, s.memoryScope))
    .filter((m) => s.memoryFilter === 'all' || m.state === s.memoryFilter)
    .filter((m) => !q || m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q))
}

const btn = (id: string, label: string, enabled: boolean, hint?: string): ButtonVM => ({
  id,
  label,
  enabled,
  hint: enabled ? undefined : hint,
})

export function memoryVM(s: WorkspaceState, now: number): MemoryVM {
  const inScope = s.memories.filter((m) => memoryInScope(m, s.memoryScope))
  const count = (k: MemoryFilterKey): number =>
    k === 'all' ? inScope.length : inScope.filter((m) => m.state === k).length
  const rows: MemoryRowVM[] = memoryVisible(s).map((m) => ({
    id: m.id,
    title: m.title,
    kindLabel: m.kind,
    scopeLabel: M.scopes[m.scope],
    badges: memoryBadges(m),
    selected: m.id === s.selectedMemoryId,
    checked: s.checkedMemoryIds.includes(m.id),
  }))
  const scopes = [
    { key: MEMORY_ALL, label: M.all },
    { key: MEMORY_GLOBAL, label: M.global },
    { key: MEMORY_UNASSIGNED, label: M.unassigned },
    ...s.projects.filter((p) => !p.archived).map((p) => ({ key: p.id, label: p.name })),
  ].map((x) => ({ ...x, active: x.key === s.memoryScope }))
  const sel = s.memories.find((m) => m.id === s.selectedMemoryId)
  return {
    heading: M.heading,
    searchPlaceholder: M.searchPlaceholder,
    query: s.memoryQuery,
    error: s.error,
    loading: s.loading,
    scopeLabel: scopes.find((x) => x.active)?.label ?? M.all,
    scopes,
    filters: FILTERS.map((key) => ({
      key,
      label: M.filters[key],
      count: count(key),
      active: s.memoryFilter === key,
    })),
    rows,
    empty: M.empty,
    detail: sel ? memoryDetailVM(s, sel, now) : null,
    detailEmpty: M.detailEmpty,
  }
}

export function memoryDetailVM(s: WorkspaceState, m: MemoryView, now: number): MemoryDetailVM {
  const pending = m.state === 'pending'
  const approved = m.state === 'approved'
  const editable = pending || approved
  const checkedApproved = s.checkedMemoryIds.filter(
    (id) => s.memories.find((x) => x.id === id)?.state === 'approved',
  )
  return {
    id: m.id,
    title: m.title,
    body: m.body,
    kind: m.kind,
    scope: M.scopes[m.scope],
    badges: memoryBadges(m),
    provenance: provenanceLines(m, now, provenanceLookup(s)),
    actions: {
      approve: btn('approve', M.approve, pending, M.onlyPending),
      reject: btn('reject', M.reject, pending, M.onlyPending),
      edit: btn('edit', M.edit, editable, M.notEditable),
      supersede: btn('supersede', M.supersede, approved, M.onlyApproved),
      merge: btn('merge', M.merge, checkedApproved.length >= 2, M.needTwo),
      scope: btn('scope', M.scope, editable, M.notEditable),
    },
    scopeOptions: MEMORY_SCOPES.map((scope) => ({
      scope,
      label: M.scopes[scope],
      current: scope === m.scope,
    })),
  }
}
