import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, NotFoundError } from '../domain/errors.ts'
import type { McpPrincipal } from '../ports/driving.ts'

const note = (projectId: string | null, title: string, kind = 'note', scope?: string) => ({
  projectId,
  scope: (scope ?? (projectId ? 'project' : 'global')) as 'project',
  kind: kind as 'note',
  title,
  body: `${title} body`,
})

describe('ContextEngineService', () => {
  it('CE-preview ranks what the policy makes available (approved, own + listed scopes)', async () => {
    const h = harness()
    const prj = await withProject(h)
    await h.projects.memory.create(note(prj, 'Run tests with pnpm', 'instruction'))
    await h.projects.memory.create(note(prj, 'JWT decision', 'decision'))
    await h.projects.memory.create(note(null, 'Global style'))
    await h.projects.memory.create(note(null, 'Workspace thing', 'note', 'workspace'))
    const v = h.projects.context.preview({ projectId: prj, objective: 'jwt' })
    expect(v.items.map((i) => i.title)).toEqual([
      'Run tests with pnpm',
      'JWT decision',
      'Global style',
    ])
    expect(v.items.every((i) => i.included)).toBe(true)
    expect(h.projects.context.preview({ projectId: prj, provider: 'cursor' }).items).toEqual([])
    expect(() => h.projects.context.preview({ projectId: 'prj_unknown00000' })).toThrow(
      NotFoundError,
    )
  })

  it('CE-summaries are candidates only with sessionExcerpts', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.putAgent({
      id: 'cc:1',
      name: 'shop work',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    h.removeAgent('cc:1')
    expect(h.projects.context.preview({ projectId: prj }).items).toEqual([])
    const pol = h.projects.catalog.get(prj).policy
    await h.projects.catalog.update({ projectId: prj, policy: { ...pol, sessionExcerpts: true } })
    expect(h.projects.context.preview({ projectId: prj }).items.map((i) => i.kind)).toEqual([
      'summary',
    ])
  })

  it('CE-inspect separates available, retrieved and delivered', async () => {
    const h = harness()
    const prj = await withProject(h)
    const m = await h.projects.memory.create(note(prj, 'A'))
    h.putAgent({
      id: 'cx:1',
      provider: 'codex',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    const ses = h.projects.sessions.list({ scope: prj })[0]!.id
    const p: McpPrincipal = {
      kind: 'mcp',
      projectId: prj,
      sessionId: ses,
      provider: 'codex',
      tokenId: 't',
      access: 'read',
    }
    expect(h.projects.context.bundleFor(p, 'a').items.map((i) => i.ref.id)).toEqual([m.id])
    await h.projects.context.recordDelivered(prj, ses, 'cx:1', [m.id], 'first-message')
    await h.projects.context.recordRetrieval(p, 'cx:1', 'search_memory', 'A?', [
      { id: m.id, version: 1 },
    ])
    const i = h.projects.context.inspect('cx:1')
    expect(i).toMatchObject({ agentId: 'cx:1', projectId: prj, available: 1 })
    expect(i.retrieved).toEqual([
      { ts: expect.any(Number), tool: 'search_memory', query: 'A?', memoryIds: [m.id] },
    ])
    expect(i.delivered).toEqual([
      { ts: expect.any(Number), memoryIds: [m.id], via: 'first-message' },
    ])
    expect(h.projects.context.inspect('cc:nobody')).toEqual({
      agentId: 'cc:nobody',
      projectId: null,
      available: 0,
      retrieved: [],
      delivered: [],
    })
    expect(() => h.projects.context.inspect('cx:1', p)).toThrow(ForbiddenError)
  })
})
