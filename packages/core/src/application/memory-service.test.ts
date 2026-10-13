import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import type { McpPrincipal } from '../ports/driving.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'

const draft = (projectId: string | null, over: Record<string, unknown> = {}) => ({
  projectId,
  scope: (projectId ? 'project' : 'global') as 'project' | 'global',
  kind: 'note' as const,
  title: 'Use pnpm',
  body: 'We use pnpm workspaces.',
  ...over,
})
const mcp = (
  projectId: string,
  access: McpPrincipal['access'] = 'read-propose',
  provider = 'codex',
): McpPrincipal => ({
  kind: 'mcp',
  projectId,
  sessionId: 'ses_aaaaaaaaaaaa',
  provider,
  tokenId: 'tok_1',
  access,
})

describe('ProjectMemoryService', () => {
  it('MS-create: the user’s items are approved, persisted and listed per scope', async () => {
    const h = harness()
    const prj = await withProject(h)
    const m = await h.projects.memory.create(draft(prj))
    expect(m).toMatchObject({ state: 'approved', version: 1, provenance: { origin: 'user' } })
    await h.projects.memory.create(draft(null, { title: 'Global rule' }))
    await h.projects.memory.create(draft(null, { scope: 'session', title: 'Loose' }))
    expect(h.projects.memory.list({ scope: prj }).map((x) => x.title)).toEqual(['Use pnpm'])
    expect(h.projects.memory.list({ scope: 'global' }).map((x) => x.title)).toEqual(['Global rule'])
    expect(h.projects.memory.list({ scope: 'unassigned' }).map((x) => x.title)).toEqual(['Loose'])
    expect(h.projects.memory.list({ scope: prj, query: 'WORKSPACES' }).length).toBe(1)
    expect(h.projects.memory.list({ scope: prj, states: ['pending'] })).toEqual([])
    await expect(h.projects.memory.create(draft('prj_unknown00000'))).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('MS-save-as-memory keeps the message provenance (session, provider, message)', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.putAgent({ id: 'cx:1', provider: 'codex' })
    const ses = h.projects.sessions.list({})[0]!.id
    const m = await h.projects.memory.create(
      draft(prj, { from: { sessionId: ses, messageId: 'm7' } }),
    )
    expect(m.provenance).toMatchObject({
      origin: 'user',
      sessionId: ses,
      messageId: 'm7',
      provider: 'codex',
    })
    await expect(
      h.projects.memory.create(
        draft(prj, { from: { sessionId: 'ses_unknown00000', messageId: 'x' } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('MS-propose → pending in the principal’s project, then review (approve/reject) with activity', async () => {
    const h = harness()
    const prj = await withProject(h)
    const p = await h.projects.memory.propose(mcp(prj), {
      kind: 'decision',
      title: 'JWT',
      body: 'Use JWT',
      rationale: 'stateless',
    })
    expect(p).toMatchObject({
      state: 'pending',
      projectId: prj,
      provenance: { origin: 'agent-proposal', provider: 'codex' },
      decision: { status: 'proposed' },
    })
    expect(p.body).toContain('Rationale: stateless')
    await expect(
      h.projects.memory.propose(mcp(prj, 'read'), { kind: 'note', title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    const a = await h.projects.memory.review(p.id, 'approve')
    expect(a).toMatchObject({ state: 'approved', decision: { status: 'accepted' } })
    const q = await h.projects.memory.propose(mcp(prj), { kind: 'note', title: 'n', body: 'b' })
    expect((await h.projects.memory.review(q.id, 'reject')).state).toBe('rejected')
    expect(h.projects.store.activityOf(prj).map((x) => x.kind)).toEqual(
      expect.arrayContaining(['memory.proposed', 'memory.approved', 'memory.rejected']),
    )
    await expect(h.projects.memory.review(a.id, 'approve')).rejects.toBeInstanceOf(ValidationError)
    await expect(h.projects.memory.review('mem_unknown00000', 'approve')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('MS-non-user principals cannot list, create or review', async () => {
    const h = harness()
    const prj = await withProject(h)
    const m = await h.projects.memory.create(draft(prj))
    expect(() => h.projects.memory.list({ scope: prj }, mcp(prj))).toThrow(ForbiddenError)
    await expect(h.projects.memory.create(draft(prj), mcp(prj))).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(h.projects.memory.review(m.id, 'approve', mcp(prj))).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('MS-edit/versions, supersede and merge', async () => {
    const h = harness()
    const prj = await withProject(h)
    const a = await h.projects.memory.create(draft(prj))
    const e = await h.projects.memory.edit({ memoryId: a.id, body: 'pnpm 10' })
    expect(e.version).toBe(2)
    expect(h.projects.memory.versions(a.id).map((v) => v.body)).toEqual([
      'We use pnpm workspaces.',
      'pnpm 10',
    ])
    const r = await h.projects.memory.supersede(a.id, draft(prj, { title: 'pnpm 10 only' }))
    expect(r.state).toBe('approved')
    expect(h.projects.store.memory.get(a.id)).toMatchObject({
      state: 'superseded',
      supersededBy: r.id,
    })
    const b = await h.projects.memory.create(draft(prj, { title: 'B' }))
    const c = await h.projects.memory.create(draft(prj, { title: 'C' }))
    const m = await h.projects.memory.merge([b.id, c.id], draft(prj, { title: 'B+C' }))
    expect(m.mergedFrom).toEqual([b.id, c.id])
    expect(h.projects.store.memory.get(b.id)?.state).toBe('superseded')
    expect(
      h.projects.store.activityOf(prj).filter((x) => x.kind === 'memory.superseded').length,
    ).toBe(3)
    await expect(
      h.projects.memory.merge([b.id, 'mem_unknown00000'], draft(prj)),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('MS-readable(principal): approved own + listed scopes only', async () => {
    const h = harness()
    const prj = await withProject(h)
    const other = (await h.projects.catalog.create({ name: 'Other', folders: [] })).id
    await h.projects.memory.create(draft(prj, { title: 'own' }))
    await h.projects.memory.create(draft(other, { title: 'other' }))
    await h.projects.memory.create(draft(null, { title: 'global' }))
    await h.projects.memory.create(draft(null, { scope: 'workspace', title: 'ws' }))
    await h.projects.memory.propose(mcp(prj), { kind: 'note', title: 'pending', body: 'b' })
    expect(
      h.projects.memory
        .readable(mcp(prj))
        .map((m) => m.title)
        .sort(),
    ).toEqual(['global', 'own'])
    expect(h.projects.memory.readable(mcp(prj, 'read', 'gemini'))).toEqual([])
  })

  it('MS-survives a restart', async () => {
    const h = harness()
    const prj = await withProject(h)
    const a = await h.projects.memory.create(draft(prj))
    await h.projects.memory.edit({ memoryId: a.id, title: 'v2' })
    await h.projects.store.flush()
    const h2 = harness({}, h.log.reopen())
    await h2.projects.load()
    expect(h2.projects.memory.list({ scope: prj })[0]).toMatchObject({
      id: a.id,
      version: 2,
      title: 'v2',
    })
  })
})
