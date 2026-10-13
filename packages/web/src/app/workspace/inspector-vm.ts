// The Context Inspector: what was available, retrieved and delivered. Never claims what the model
// "read" or "knows".
import { ago } from '../format.ts'
import type { WorkspaceState } from './state.ts'
import type { InspectorEntryVM, InspectorVM } from './types.ts'
import { WS_COPY } from './workspace-copy.ts'

const I = WS_COPY.inspector

export function inspectorVM(s: WorkspaceState, now: number): InspectorVM {
  const ins = s.inspection
  const title = (id: string): string =>
    s.memories.find((m) => m.id === id)?.title ?? I.unknownMemory
  const projectName = ins?.projectId
    ? (s.projects.find((p) => p.id === ins.projectId)?.name ?? null)
    : null
  const when = (ts: number): string => (ts > 0 ? ago(ts, now) : '')
  const retrieved: InspectorEntryVM[] = (ins?.retrieved ?? []).map((r, i) => ({
    id: `r${i}`,
    title: I.retrieved(r.tool, r.query),
    detail: [when(r.ts), r.memoryIds.map(title).join(', ') || I.items(0)]
      .filter(Boolean)
      .join(' · '),
  }))
  const delivered: InspectorEntryVM[] = (ins?.delivered ?? []).map((d, i) => ({
    id: `d${i}`,
    title: I.delivered(d.via),
    detail: [when(d.ts), d.memoryIds.map(title).join(', ') || I.items(0)]
      .filter(Boolean)
      .join(' · '),
  }))
  const active = (s.projectId ? s.dashboards[s.projectId]?.active : undefined) ?? []
  const current = ins ? ins.agentId : s.inspectAgentId
  return {
    heading: I.heading,
    agents: active.map((a) => ({
      id: a.agentId,
      label: `${a.name} · ${a.provider}`,
      selected: a.agentId === current,
    })),
    agentLabel: I.agentLabel,
    note: I.note,
    error: s.error,
    loading: s.loading,
    agentId: current,
    projectName,
    available: {
      heading: I.availableHeading,
      summary: ins ? I.available(ins.available) : I.noAgent,
    },
    retrieved: { heading: I.retrievedHeading, entries: retrieved, empty: I.retrievedEmpty },
    delivered: { heading: I.deliveredHeading, entries: delivered, empty: I.deliveredEmpty },
  }
}
