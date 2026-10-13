import { describe, expect, it } from 'vitest'
import type { RepoIdentityInfo } from '../ports/driven.ts'
import type { Project } from './project.ts'
import { matchProject } from './repo-identity.ts'

const info = (over: Partial<RepoIdentityInfo> = {}): RepoIdentityInfo => ({
  commonDirKey: 'cd-shop',
  rootKey: 'rk-shop',
  rootCommit: 'c-shop',
  remotes: ['github.com/acme/shop'],
  name: 'shop',
  isWorktree: false,
  relPath: '',
  ...over,
})

let n = 0
function project(id: string, repos: { identity: RepoIdentityInfo; subpath?: string }[]): Project {
  return {
    id,
    name: id,
    color: '#000000',
    createdAt: 0,
    policy: { providers: {}, scopes: [], sessionExcerpts: false },
    repos: repos.map((r) => ({
      id: `rp_${String(++n).padStart(12, '0')}`,
      identity: r.identity,
      subpath: r.subpath ?? '',
      label: r.identity.name,
      locator: `/x/${r.identity.name}`,
    })),
  }
}

describe('matchProject (docs/projects.md §4)', () => {
  it('RI-1 a worktree of a linked clone (same common dir) auto-matches', () => {
    const a = project('A', [{ identity: info() }])
    const wt = info({ rootKey: 'rk-wt', isWorktree: true, name: 'shop-feature' })
    expect(matchProject(wt, [a])).toMatchObject({
      kind: 'auto',
      projectId: 'A',
      rule: 'common-dir',
    })
  })

  it('RI-1 monorepo: the longest covering subpath wins', () => {
    const root = project('ROOT', [{ identity: info() }])
    const web = project('WEB', [{ identity: info(), subpath: 'packages/web' }])
    expect(matchProject(info({ relPath: 'packages/web/src' }), [root, web])).toMatchObject({
      kind: 'auto',
      projectId: 'WEB',
    })
    expect(matchProject(info({ relPath: 'packages/api' }), [root, web])).toMatchObject({
      kind: 'auto',
      projectId: 'ROOT',
    })
    // 'packages/webapp' is not inside 'packages/web'
    expect(matchProject(info({ relPath: 'packages/webapp' }), [web])).toMatchObject({
      kind: 'suggest',
      suggestions: [{ projectId: 'WEB', rule: 'same-repo', confidence: 'high' }],
    })
  })

  it('RI-2 a moved or renamed clone (first commit + shared remote) auto-matches', () => {
    const a = project('A', [{ identity: info() }])
    const moved = info({ commonDirKey: 'cd-new', rootKey: 'rk-new', name: 'renamed' })
    expect(matchProject(moved, [a])).toMatchObject({
      kind: 'auto',
      projectId: 'A',
      rule: 'commit-remote',
    })
  })

  it('RI-3 only the first commit, or only a remote → suggestion (high)', () => {
    const a = project('A', [{ identity: info() }])
    const fork = info({ commonDirKey: 'x', rootKey: 'y', remotes: ['github.com/me/fork'] })
    expect(matchProject(fork, [a])).toEqual({
      kind: 'suggest',
      suggestions: [{ projectId: 'A', rule: 'commit', confidence: 'high' }],
    })
    const sameRemote = info({ commonDirKey: 'x', rootKey: 'y', rootCommit: 'other' })
    expect(matchProject(sameRemote, [a])).toEqual({
      kind: 'suggest',
      suggestions: [{ projectId: 'A', rule: 'remote', confidence: 'high' }],
    })
  })

  it('RI-4 same basename only → low-confidence suggestion, never auto', () => {
    const a = project('A', [{ identity: info() }])
    const unrelated = info({
      commonDirKey: 'x',
      rootKey: 'y',
      rootCommit: 'z',
      remotes: ['gitlab.com/other/shop'],
    })
    expect(matchProject(unrelated, [a])).toEqual({
      kind: 'suggest',
      suggestions: [{ projectId: 'A', rule: 'name', confidence: 'low' }],
    })
    expect(matchProject(info({ ...unrelated, name: 'Shop' }), [a]).kind).toBe('suggest')
  })

  it('RI-4b nothing in common → none; no root commit never matches on commit', () => {
    const a = project('A', [{ identity: info({ rootCommit: undefined }) }])
    const other = info({
      commonDirKey: 'x',
      rootKey: 'y',
      rootCommit: undefined,
      remotes: [],
      name: 'blog',
    })
    expect(matchProject(other, [a])).toEqual({ kind: 'none' })
    expect(matchProject(other, [])).toEqual({ kind: 'none' })
  })

  it('RI-5 two projects auto-match → both become suggestions', () => {
    const a = project('A', [{ identity: info() }])
    const b = project('B', [{ identity: info() }])
    expect(matchProject(info(), [a, b])).toEqual({
      kind: 'suggest',
      suggestions: [
        { projectId: 'A', rule: 'common-dir', confidence: 'high' },
        { projectId: 'B', rule: 'common-dir', confidence: 'high' },
      ],
    })
    const moved = info({ commonDirKey: 'n', rootKey: 'n' })
    expect(matchProject(moved, [a, b])).toMatchObject({ kind: 'suggest' })
  })

  it('RI-first-rule-wins: an auto match is not mixed with weaker suggestions', () => {
    const a = project('A', [{ identity: info() }])
    const b = project('B', [{ identity: info({ commonDirKey: 'q', rootKey: 'q', remotes: [] }) }])
    expect(matchProject(info(), [a, b])).toMatchObject({ kind: 'auto', projectId: 'A' })
  })

  it('RI-archived projects are never matched', () => {
    const a = { ...project('A', [{ identity: info() }]), archivedAt: 1 }
    expect(matchProject(info(), [a])).toEqual({ kind: 'none' })
  })
})
