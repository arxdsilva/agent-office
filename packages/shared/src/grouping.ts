import type { Agent } from './protocol.ts'

/**
 * Decides where an agent sits: which zone (area of the office) and which row of desks.
 * This is the single place office organization is decided — swap it to reorganize.
 */
export type Grouping = (
  agent: Agent,
  lookup: (id: string) => Agent | undefined,
) => { zone: string; row: string }

export interface Row {
  name: string
  agents: Agent[]
}

export interface Zone {
  name: string
  rows: Row[]
}

const MAX_PARENT_DEPTH = 10

/** Zone per provider, row per topic. Subagents follow their root parent. */
export const byProviderAndTopic: Grouping = (agent, lookup) => {
  let root = agent
  for (let i = 0; i < MAX_PARENT_DEPTH && root.parentId; i++) {
    const parent = lookup(root.parentId)
    if (!parent) break
    root = parent
  }
  return { zone: root.provider, row: root.topic }
}

/** Groups agents into sorted zones → rows. Agent order inside a row is preserved. */
export function groupAgents(agents: Agent[], grouping: Grouping): Zone[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const zones = new Map<string, Map<string, Agent[]>>()
  for (const a of agents) {
    const { zone, row } = grouping(a, (id) => byId.get(id))
    const rows = zones.get(zone) ?? new Map<string, Agent[]>()
    zones.set(zone, rows)
    rows.set(row, [...(rows.get(row) ?? []), a])
  }
  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name)
  return [...zones]
    .map(([name, rows]) => ({
      name,
      rows: [...rows].map(([name, agents]) => ({ name, agents })).sort(byName),
    }))
    .sort(byName)
}
