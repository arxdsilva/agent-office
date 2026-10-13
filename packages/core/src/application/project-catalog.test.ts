import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'

describe('ProjectCatalogService', () => {
  it('CAT-create: default policy from enabled providers, repo labels only, persisted', async () => {
    const h = harness()
    await h.projects.load()
    const s = await h.projects.catalog.create({
      name: 'Shop',
      folders: ['/work/shop', '/work/shop/packages/web'],
    })
    expect(s).toMatchObject({ name: 'Shop', sessions: 0, activeAgents: 0, archived: false })
    expect(s.repos.map((r) => r.label)).toEqual(['shop', 'web'])
    expect(JSON.stringify(s)).not.toContain('/work')
    const d = h.projects.catalog.get(s.id)
    expect(d.policy).toEqual({
      providers: { 'claude-code': 'read-propose', codex: 'read-propose' },
      scopes: ['global', 'project'],
      sessionExcerpts: false,
    })
    expect(JSON.stringify(d)).not.toContain('/work')
    expect(JSON.stringify(d)).not.toContain('cd-shop')
    await h.projects.store.flush()
    expect(h.log.dump()).toContain('"t":"project"')
  })

  it('CAT-create refuses folders that cannot be resolved and a missing RepoIdentity', async () => {
    const h = harness()
    await h.projects.load()
    await expect(
      h.projects.catalog.create({ name: 'X', folders: ['/nowhere'] }),
    ).rejects.toBeInstanceOf(ValidationError)
    const bare = harness({ repoIdentity: undefined })
    await bare.projects.load()
    await expect(
      bare.projects.catalog.create({ name: 'X', folders: ['/work/shop'] }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect((await bare.projects.catalog.create({ name: 'No repos', folders: [] })).repos).toEqual(
      [],
    )
  })

  it('CAT-update, add/remove repos, list sorted with archived last', async () => {
    const h = harness()
    const id = await withProject(h)
    const b = await h.projects.catalog.create({ name: 'Blog', folders: [] })
    await h.projects.catalog.update({
      projectId: id,
      name: 'Shop 2',
      color: '#123456',
      policy: { providers: { codex: 'read' }, scopes: [], sessionExcerpts: true },
    })
    expect(h.projects.catalog.get(id)).toMatchObject({
      name: 'Shop 2',
      color: '#123456',
      policy: { sessionExcerpts: true },
    })
    const added = await h.projects.catalog.addRepos(b.id, ['/work/blog'])
    expect(added.repos.map((r) => r.label)).toEqual(['blog'])
    const repoId = added.repos[0]!.id
    expect(h.projects.repos.repoPath(b.id, repoId)).toBe('/work/blog')
    expect(h.projects.repos.repoPath(b.id, 'rp_nope')).toBeUndefined()
    expect((await h.projects.catalog.removeRepo(b.id, repoId)).repos).toEqual([])
    await h.projects.catalog.update({ projectId: id, archived: true })
    expect(h.projects.catalog.list().map((p) => [p.name, p.archived])).toEqual([
      ['Blog', false],
      ['Shop 2', true],
    ])
    expect(() => h.projects.catalog.get('prj_unknown00000')).toThrow(NotFoundError)
    await expect(
      h.projects.catalog.update({ projectId: 'prj_unknown00000', name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
