import { describe, expect, it } from 'vitest'
import type { RepoIdentityInfo } from '../ports/driven.ts'
import { ValidationError } from './errors.ts'
import {
  addRepo,
  createProject,
  defaultPolicy,
  idFrom,
  PROJECT_COLORS,
  providerAccess,
  removeRepo,
  updateProject,
} from './project.ts'

const info = (over: Partial<RepoIdentityInfo> = {}): RepoIdentityInfo => ({
  commonDirKey: 'cd1',
  rootKey: 'rk1',
  rootCommit: 'c0ffee',
  remotes: ['github.com/acme/shop'],
  name: 'shop',
  isWorktree: false,
  relPath: '',
  ...over,
})

describe('ids', () => {
  it('PRJ-id derives [a-z0-9] ids of 16 chars from any token alphabet', () => {
    expect(idFrom('prj', 'AbC-_+/=0123456789xyzXYZ')).toMatch(/^prj_[a-z0-9]{16}$/)
    expect(idFrom('mem', 'deadbeefdeadbeefdeadbeef')).toMatch(/^mem_[a-z0-9]{16}$/)
    expect(() => idFrom('prj', 'short')).toThrow()
  })
})

describe('project', () => {
  it('PRJ-default policy: enabled providers read-propose, global + project, no excerpts', () => {
    expect(defaultPolicy(['claude-code', 'codex'])).toEqual({
      providers: { 'claude-code': 'read-propose', codex: 'read-propose' },
      scopes: ['global', 'project'],
      sessionExcerpts: false,
    })
  })

  it('PRJ-create trims and validates the name and picks a palette color', () => {
    const p = createProject({ id: 'prj_aaaaaaaaaaaa', name: '  Shop  ', now: 5, index: 1 })
    expect(p).toMatchObject({ name: 'Shop', color: PROJECT_COLORS[1], createdAt: 5, repos: [] })
    expect(() => createProject({ id: 'prj_aaaaaaaaaaaa', name: '  ', now: 5 })).toThrow(
      ValidationError,
    )
    expect(() => createProject({ id: 'prj_aaaaaaaaaaaa', name: 'x'.repeat(61), now: 5 })).toThrow(
      ValidationError,
    )
  })

  it('PRJ-update renames, recolors, archives, sets a validated policy', () => {
    const p = createProject({ id: 'prj_aaaaaaaaaaaa', name: 'Shop', now: 1 })
    const q = updateProject(p, { name: 'Shop 2', color: '#112233', archived: true }, 9)
    expect(q).toMatchObject({ name: 'Shop 2', color: '#112233', archivedAt: 9 })
    expect(updateProject(q, { archived: false }, 10).archivedAt).toBeUndefined()
    const pol = { providers: { codex: 'read' as const }, scopes: [], sessionExcerpts: true }
    expect(updateProject(p, { policy: pol }, 2).policy).toEqual(pol)
    expect(() => updateProject(p, { color: 'red' }, 2)).toThrow(ValidationError)
    expect(() =>
      updateProject(p, { policy: { providers: { codex: 'all' }, scopes: [] } as never }, 2),
    ).toThrow(ValidationError)
  })

  it('PRJ-repos: add keeps the basename label and the subpath; duplicates are refused', () => {
    const p = createProject({ id: 'prj_aaaaaaaaaaaa', name: 'Shop', now: 1 })
    const q = addRepo(p, {
      id: 'rp_aaaaaaaaaaaa',
      identity: info({ relPath: 'packages/web' }),
      locator: '/x/shop/packages/web',
    })
    expect(q.repos[0]).toMatchObject({ label: 'web', subpath: 'packages/web' })
    expect(() =>
      addRepo(q, {
        id: 'rp_bbbbbbbbbbbb',
        identity: info({ relPath: 'packages/web' }),
        locator: '/y',
      }),
    ).toThrow(ValidationError)
    const r = addRepo(q, { id: 'rp_bbbbbbbbbbbb', identity: info(), locator: '/x/shop' })
    expect(r.repos[1]).toMatchObject({ label: 'shop', subpath: '' })
    expect(removeRepo(r, 'rp_aaaaaaaaaaaa').repos.map((x) => x.id)).toEqual(['rp_bbbbbbbbbbbb'])
    expect(() => removeRepo(r, 'rp_cccccccccccc')).toThrow(ValidationError)
  })

  it('PRJ-access: unlisted providers get none', () => {
    const p = createProject({
      id: 'prj_aaaaaaaaaaaa',
      name: 'Shop',
      now: 1,
      policy: defaultPolicy(['codex']),
    })
    expect(providerAccess(p, 'codex')).toBe('read-propose')
    expect(providerAccess(p, 'cursor')).toBe('none')
    expect(providerAccess(undefined, 'codex')).toBe('none')
  })
})

describe('harness attachments', () => {
  it('attach is idempotent, capped at 16; detach refuses unknown ids', async () => {
    const { attachHarness, detachHarness, MAX_HARNESSES } = await import('./project.ts')
    let p = createProject({ id: 'prj_aaaaaaaaaaaa', name: 'Shop', now: 1 })
    p = attachHarness(p, 'hrn_a', 5)
    expect(p.harnesses).toEqual([{ harnessId: 'hrn_a', attachedAt: 5 }])
    expect(attachHarness(p, 'hrn_a', 6)).toBe(p)
    for (let i = 1; i < MAX_HARNESSES; i++) p = attachHarness(p, `hrn_${i}`, 7)
    expect(() => attachHarness(p, 'hrn_x', 8)).toThrow(ValidationError)
    p = detachHarness(p, 'hrn_a')
    expect(p.harnesses!.some((h) => h.harnessId === 'hrn_a')).toBe(false)
    expect(() => detachHarness(p, 'hrn_a')).toThrow(ValidationError)
  })
})
