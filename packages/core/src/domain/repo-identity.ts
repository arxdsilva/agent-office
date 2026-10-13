// Which project a session belongs to, from its repository identity (docs/projects.md §4).
// Identity never depends on a basename alone; unrelated projects are never merged.
import type { RepoIdentityInfo } from '../ports/driven.ts'
import type { Project, RepoLink } from './project.ts'

export type MatchRule =
  | 'common-dir'
  | 'commit-remote'
  | 'workspace-key'
  /** Same clone (rule 1 or 2 identity) but outside every linked subpath. */
  | 'same-repo'
  | 'commit'
  | 'remote'
  | 'name'

export interface Suggestion {
  projectId: string
  rule: MatchRule
  confidence: 'high' | 'low'
}

export type MatchResult =
  | { kind: 'auto'; projectId: string; repoId: string; rule: MatchRule }
  | { kind: 'suggest'; suggestions: Suggestion[] }
  | { kind: 'none' }

/** `sub` contains `rel` ('' contains everything; 'a/b' contains 'a/b' and 'a/b/c', not 'a/bc'). */
export function covers(sub: string, rel: string): boolean {
  return sub === '' || rel === sub || rel.startsWith(`${sub}/`)
}

const sharesRemote = (a: RepoIdentityInfo, b: RepoIdentityInfo) =>
  a.remotes.some((r) => b.remotes.includes(r))
const sameCommit = (a: RepoIdentityInfo, b: RepoIdentityInfo) =>
  !!a.rootCommit && a.rootCommit === b.rootCommit

interface Candidate {
  project: Project
  link: RepoLink
}

/** The best covering link per project for an identity predicate. */
function autoCandidates(
  info: RepoIdentityInfo,
  projects: Project[],
  same: (link: RepoLink) => boolean,
): Candidate[] {
  const out: Candidate[] = []
  for (const project of projects) {
    let best: RepoLink | undefined
    for (const link of project.repos)
      if (same(link) && covers(link.subpath, info.relPath))
        if (!best || link.subpath.length > best.subpath.length) best = link
    if (best) out.push({ project, link: best })
  }
  return out
}

/** Longest subpath wins; a tie across projects (rule 5) becomes suggestions. */
function decide(cands: Candidate[], rule: MatchRule): MatchResult | null {
  if (!cands.length) return null
  const longest = Math.max(...cands.map((c) => c.link.subpath.length))
  const top = cands.filter((c) => c.link.subpath.length === longest)
  if (top.length === 1)
    return { kind: 'auto', projectId: top[0]!.project.id, repoId: top[0]!.link.id, rule }
  return {
    kind: 'suggest',
    suggestions: top.map((c) => ({ projectId: c.project.id, rule, confidence: 'high' })),
  }
}

/** Rules in order, first one wins (docs/projects.md §4). Archived projects never match. */
export function matchProject(info: RepoIdentityInfo, all: Project[]): MatchResult {
  const projects = all.filter((p) => p.archivedAt === undefined)
  const sameDir = (l: RepoLink) => l.identity.commonDirKey === info.commonDirKey
  const moved = (l: RepoLink) => sameCommit(l.identity, info) && sharesRemote(l.identity, info)
  const r1 = decide(autoCandidates(info, projects, sameDir), 'common-dir')
  if (r1) return r1
  const r2 = decide(autoCandidates(info, projects, moved), 'commit-remote')
  if (r2) return r2

  const high: Suggestion[] = []
  for (const p of projects) {
    let rule: MatchRule | undefined
    for (const l of p.repos) {
      if (sameDir(l) || moved(l)) rule = 'same-repo'
      else if (!rule && sameCommit(l.identity, info)) rule = 'commit'
      else if (!rule && sharesRemote(l.identity, info)) rule = 'remote'
    }
    if (rule) high.push({ projectId: p.id, rule, confidence: 'high' })
  }
  if (high.length) return { kind: 'suggest', suggestions: high }

  const name = info.name.toLowerCase()
  const low: Suggestion[] = projects
    .filter((p) => name && p.repos.some((l) => l.identity.name.toLowerCase() === name))
    .map((p) => ({ projectId: p.id, rule: 'name', confidence: 'low' }))
  return low.length ? { kind: 'suggest', suggestions: low } : { kind: 'none' }
}
