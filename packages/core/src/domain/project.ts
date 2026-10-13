// Projects: the persistent workspace (docs/projects.md §1). Pure rules; time and ids passed in.
import {
  ContextPolicySchema,
  type ContextPolicy,
  type ProviderAccess,
  type ProviderId,
} from '@agent-office/shared'
import type { RepoIdentityInfo } from '../ports/driven.ts'
import { ValidationError } from './errors.ts'
import type { HarnessAttachment } from './harness-types.ts'

export const PROJECT_COLORS = [
  '#4f7cff',
  '#16a37f',
  '#e0802c',
  '#a35dd8',
  '#d64561',
  '#2aa3c4',
  '#8a9a2b',
  '#c4512a',
] as const

/** A linked repository. `identity` and `locator` stay in main; views show `label` only. */
export interface RepoLink {
  id: string
  identity: RepoIdentityInfo
  /** Monorepo subproject path relative to the repository root ('' = the whole repository). */
  subpath: string
  /** Basename (display only). */
  label: string
  /** The absolute directory the user picked (main only; never in a view, log or IPC payload). */
  locator: string
}

export interface Project {
  id: string
  name: string
  color: string
  createdAt: number
  archivedAt?: number
  repos: RepoLink[]
  policy: ContextPolicy
  /** Attached harnesses (docs/harness.md), ≤ MAX_HARNESSES; absent on older records. */
  harnesses?: HarnessAttachment[]
}

/** `prefix_` + 16 chars of [a-z0-9] derived from a random token (any alphabet, ≥ 16 chars). */
export function idFrom(prefix: string, token: string): string {
  if (token.length < 16) throw new Error('token too short for an id')
  let s = ''
  for (let i = 0; i < 16; i++) s += (token.charCodeAt(i) % 36).toString(36)
  return `${prefix}_${s}`
}

export function defaultPolicy(enabled: readonly ProviderId[]): ContextPolicy {
  return {
    providers: Object.fromEntries(enabled.map((p) => [p, 'read-propose' as const])),
    scopes: ['global', 'project'],
    sessionExcerpts: false,
  }
}

function cleanName(name: string): string {
  const n = name.trim()
  if (!n || n.length > 60) throw new ValidationError('project name must be 1–60 characters')
  return n
}

export function createProject(o: {
  id: string
  name: string
  now: number
  index?: number
  policy?: ContextPolicy
}): Project {
  return {
    id: o.id,
    name: cleanName(o.name),
    color: PROJECT_COLORS[(o.index ?? 0) % PROJECT_COLORS.length]!,
    createdAt: o.now,
    repos: [],
    policy: o.policy ?? defaultPolicy([]),
  }
}

export interface ProjectPatch {
  name?: string
  color?: string
  policy?: ContextPolicy
  archived?: boolean
}

export function updateProject(p: Project, patch: ProjectPatch, now: number): Project {
  const next: Project = { ...p }
  if (patch.name !== undefined) next.name = cleanName(patch.name)
  if (patch.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(patch.color)) throw new ValidationError('invalid color')
    next.color = patch.color.toLowerCase()
  }
  if (patch.policy !== undefined) {
    const r = ContextPolicySchema.safeParse(patch.policy)
    if (!r.success) throw new ValidationError('invalid context policy')
    next.policy = r.data
  }
  if (patch.archived === true) next.archivedAt = p.archivedAt ?? now
  if (patch.archived === false) delete next.archivedAt
  return next
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

export function addRepo(
  p: Project,
  r: { id: string; identity: RepoIdentityInfo; locator: string },
): Project {
  const subpath = r.identity.relPath
  if (
    p.repos.some(
      (x) => x.identity.commonDirKey === r.identity.commonDirKey && x.subpath === subpath,
    )
  )
    throw new ValidationError('this repository is already linked')
  if (p.repos.length >= 16) throw new ValidationError('too many repositories')
  const label = (subpath ? basename(subpath) : r.identity.name || basename(r.locator)).slice(0, 80)
  return {
    ...p,
    repos: [...p.repos, { id: r.id, identity: r.identity, subpath, label, locator: r.locator }],
  }
}

export function removeRepo(p: Project, repoId: string): Project {
  if (!p.repos.some((r) => r.id === repoId)) throw new ValidationError('unknown repository')
  return { ...p, repos: p.repos.filter((r) => r.id !== repoId) }
}

export function providerAccess(p: Project | undefined, provider: string): ProviderAccess {
  if (!p) return 'none'
  return (p.policy.providers as Record<string, ProviderAccess | undefined>)[provider] ?? 'none'
}

export const MAX_HARNESSES = 16

/** Attaching twice is a no-op (same project returned). */
export function attachHarness(p: Project, harnessId: string, now: number): Project {
  const list = p.harnesses ?? []
  if (list.some((h) => h.harnessId === harnessId)) return p
  if (list.length >= MAX_HARNESSES) throw new ValidationError('too many harnesses')
  return { ...p, harnesses: [...list, { harnessId, attachedAt: now }] }
}

export function detachHarness(p: Project, harnessId: string): Project {
  const list = p.harnesses ?? []
  if (!list.some((h) => h.harnessId === harnessId))
    throw new ValidationError('this harness is not attached')
  return { ...p, harnesses: list.filter((h) => h.harnessId !== harnessId) }
}
