// Counts for the Project Library: numbers only, so a world label can never leak a memory title.
import type { HandoffView, MemoryView } from '@agent-office/shared'
import type { ProjectMemoryCounts } from '../project-library.ts'

export function libraryCounts(
  memories: readonly MemoryView[],
  handoffs: readonly HandoffView[],
  projectId: string,
): ProjectMemoryCounts {
  const mine = memories.filter((m) => m.projectId === projectId)
  const approved = mine.filter((m) => m.state === 'approved')
  const byKind: ProjectMemoryCounts['byKind'] = {}
  for (const m of approved) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1
  return {
    byKind,
    pending: mine.filter((m) => m.state === 'pending').length,
    handoffs: handoffs.filter((h) => h.projectId === projectId && h.state === 'draft').length,
    acceptedDecisions: approved.filter(
      (m) => m.kind === 'decision' && m.decision?.status === 'accepted',
    ).length,
  }
}
