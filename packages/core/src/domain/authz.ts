// The security boundary of the projects layer (docs/projects.md §2): projects are boundaries.
// Every application service calls `authorize` before acting. The renderer's selected project is
// never proof of anything; only the principal and the stored project count.
import type { MemoryScope, MemoryState, ProviderAccess } from '@agent-office/shared'
import type { McpPrincipal } from '../ports/driving.ts'
import { ForbiddenError } from './errors.ts'
import { providerAccess, type Project } from './project.ts'

export type Principal =
  | { kind: 'user' }
  | McpPrincipal
  /** A provider runtime acting for a project (e.g. a handoff bundle). Reads only. */
  | { kind: 'runtime'; provider: string; projectId: string }

export const USER: Principal = { kind: 'user' }

export const ACTIONS = [
  'memory.read',
  'memory.propose',
  /** approve, reject, edit, merge, supersede, delete */
  'memory.review',
  'summary.read',
  'chat.read',
  'transcript.read',
  'session.read',
  'session.assign',
  'project.read',
  /** create, rename, repos, archive, policy */
  'project.manage',
  'handoff.manage',
  'context.preview',
  'search',
] as const
export type Action = (typeof ACTIONS)[number]

export type Resource =
  | { kind: 'memory'; projectId: string | null; scope: MemoryScope; state: MemoryState }
  | { kind: 'summary'; projectId: string | null }
  | { kind: 'session'; projectId: string | null }
  | { kind: 'project'; projectId: string | null }

export type Decision = { ok: true } | { ok: false; reason: string }

const ALLOW: Decision = { ok: true }
const deny = (reason: string): Decision => ({ ok: false, reason })

const RANK: Record<ProviderAccess, number> = { none: 0, read: 1, 'read-propose': 2 }

/** What the principal may do now: the token's access, capped by the project's current policy. */
function effectiveAccess(
  p: Exclude<Principal, { kind: 'user' }>,
  project: Project,
): ProviderAccess {
  const policy = providerAccess(project, p.provider)
  if (p.kind === 'runtime') return policy === 'none' ? 'none' : 'read'
  return RANK[p.access] <= RANK[policy] ? p.access : policy
}

export function authorize(
  p: Principal,
  action: Action,
  resource: Resource,
  project: Project | undefined,
): Decision {
  if (p.kind === 'user') return ALLOW
  // Non-user principals act only inside their own, live project.
  if (!project || project.id !== p.projectId) return deny('project')
  if (project.archivedAt !== undefined) return deny('archived')
  const access = effectiveAccess(p, project)
  if (access === 'none') return deny('policy')
  const own = resource.projectId === p.projectId

  switch (action) {
    case 'memory.read': {
      if (resource.kind !== 'memory' || resource.state !== 'approved') return deny('state')
      if (own) return ALLOW
      const shared = resource.scope === 'global' || resource.scope === 'workspace'
      if (resource.projectId === null && shared && project.policy.scopes.includes(resource.scope))
        return ALLOW
      return deny('scope')
    }
    case 'memory.propose':
      if (p.kind !== 'mcp' || access !== 'read-propose') return deny('access')
      if (resource.kind !== 'memory' || resource.state !== 'pending' || !own) return deny('scope')
      return resource.scope === 'project' || resource.scope === 'session' ? ALLOW : deny('scope')
    case 'summary.read':
      return resource.kind === 'summary' && own && project.policy.sessionExcerpts
        ? ALLOW
        : deny('excerpts')
    case 'project.read':
      return resource.kind === 'project' && own ? ALLOW : deny('project')
    default:
      // chat, transcripts, review, assignment, policy, handoffs, previews, search: the user only.
      return deny('user-only')
  }
}

export function assertAuthorized(
  p: Principal,
  action: Action,
  resource: Resource,
  project: Project | undefined,
): void {
  if (!authorize(p, action, resource, project).ok) throw new ForbiddenError()
}
