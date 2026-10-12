// Capability fixtures (docs/capabilities.md §1) for unit tests.
import type {
  Capability,
  CapabilityCategory,
  CapabilityKind,
  CapabilityScope,
} from '@agent-office/shared'

const CATEGORY: Record<CapabilityKind, CapabilityCategory> = {
  filesystem: 'adapter',
  shell: 'adapter',
  web: 'adapter',
  subagents: 'adapter',
  mcp: 'adapter',
  api: 'adapter',
  database: 'adapter',
  skill: 'skill',
  'project-rules': 'rule',
  rule: 'rule',
  'user-rules': 'rule',
  memory: 'rule',
  other: 'adapter',
}

/** Kind from the id grammar (fs, shell, web, subagents, mcp:, api:, skill:, rule:, memory:). */
function kindOf(id: string): CapabilityKind {
  if (id === 'fs') return 'filesystem'
  if (id === 'shell' || id === 'web' || id === 'subagents') return id
  if (id.startsWith('mcp:'))
    return /(db|sql|postgres|mongo|redis|sqlite)/i.test(id) ? 'database' : 'mcp'
  if (id.startsWith('api:')) return 'api'
  if (id.startsWith('skill:')) return 'skill'
  if (id.startsWith('memory:')) return 'memory'
  if (/^rule:project:(CLAUDE|AGENTS)\.md$/.test(id)) return 'project-rules'
  if (id === 'rule:user:CLAUDE.md') return 'user-rules'
  return 'rule'
}

export function cap(id: string, over: Partial<Capability> = {}): Capability {
  const kind = over.kind ?? kindOf(id)
  const scope: CapabilityScope | undefined = id.startsWith('rule:user:')
    ? 'user'
    : id.startsWith('rule:project:')
      ? 'project'
      : undefined
  const c: Capability = {
    id,
    provider: 'claude-code',
    category: CATEGORY[kind],
    kind,
    label: id.replace(/^(skill|rule:project|rule:user|memory|mcp|api):/, ''),
    sees: [],
    tools: [],
    declared: true,
    calls: 0,
    active: [],
    ...over,
  }
  if (scope && !over.scope) c.scope = scope
  return c
}

/** The built-in claude-code adapters. */
export const builtins = () => ['fs', 'shell', 'web', 'subagents'].map((id) => cap(id))
