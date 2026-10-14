import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'

const RULE = {
  name: 'Tests',
  text: 'Run the tests',
  category: 'testing' as const,
  enforcement: 'instruction' as const,
}

describe('HarnessService', () => {
  it('HS-create, update, publish (v+1 on edit), archive, versions', async () => {
    const h = harness()
    await h.projects.load()
    const svc = h.projects.harness
    const d = await svc.create({ name: 'Std', rules: [RULE] })
    expect(d).toMatchObject({ version: 1, status: 'draft', ruleCount: 1, projectIds: [] })
    expect(d.id).toMatch(/^hrn_[a-z0-9]{16}$/)
    expect(svc.list().map((x) => x.id)).toEqual([d.id])
    const u = await svc.update(d.id, { name: 'Std 2', rules: [{ ...RULE, id: d.rules[0]!.id }] })
    expect(u).toMatchObject({ version: 1, name: 'Std 2' })
    expect(u.rules[0]!.id).toBe(d.rules[0]!.id)
    const p = await svc.publish(d.id)
    expect(p).toMatchObject({ status: 'published', publishedAt: h.clock.now() })
    const v2 = await svc.update(d.id, { name: 'Std 3', rules: [RULE] })
    expect(v2).toMatchObject({ version: 2, status: 'draft' })
    expect(svc.versions(d.id).map((x) => [x.version, x.status])).toEqual([
      [1, 'published'],
      [2, 'draft'],
    ])
    expect(svc.get(d.id).version).toBe(2)
    expect((await svc.archive(d.id)).status).toBe('archived')
    await expect(svc.publish(d.id)).rejects.toBeInstanceOf(ValidationError)
    expect(() => svc.get('hrn_unknown00000')).toThrow(NotFoundError)
    await expect(svc.update('hrn_unknown00000', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(svc.get(d.id).conflicts).toEqual([])
  })

  it('HS-attach/detach: project views, activity with names only, archived refused', async () => {
    const h = harness()
    const prj = await withProject(h)
    const svc = h.projects.harness
    const d = await svc.create({ name: 'Std', rules: [RULE] })
    expect((await svc.attach(prj, d.id)).map((x) => x.id)).toEqual([d.id])
    expect(svc.attached(prj)[0]!.projectIds).toEqual([prj])
    expect(svc.get(d.id).projectIds).toEqual([prj])
    await svc.publish(d.id)
    const acts = h.projects.store.activityOf(prj)
    expect(acts.map((a) => [a.kind, a.text])).toEqual([
      ['harness.attached', 'Attached harness “Std”'],
      ['harness.published', 'Published harness “Std” v1'],
    ])
    expect(await svc.detach(prj, d.id)).toEqual([])
    const a = await svc.create({ name: 'Old', rules: [RULE] })
    await svc.archive(a.id)
    await expect(svc.attach(prj, a.id)).rejects.toBeInstanceOf(ValidationError)
    await expect(svc.attach(prj, 'hrn_unknown00000')).rejects.toBeInstanceOf(NotFoundError)
    await expect(svc.attach('prj_unknown00000', d.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('HS-templates: the flow and engineering templates plus custom; unknown ids refused', async () => {
    const h = harness()
    await h.projects.load()
    const list = h.projects.harness.templates()
    expect(list).toHaveLength(11)
    expect(list.at(-1)).toEqual(
      expect.objectContaining({ id: 'custom', ruleCount: 0, gateCount: 0 }),
    )
    expect(list[0]).not.toHaveProperty('draft')
    expect((await h.projects.harness.createFromTemplate('custom')).ruleCount).toBe(0)
    const flow = await h.projects.harness.createFromTemplate('release-checklist')
    expect(flow).toMatchObject({ stepCount: 4, flowMode: 'sequential', status: 'draft' })
    expect(flow.steps![0]!.exit[0]).toMatchObject({ kind: 'gate', gateId: flow.gates[0]!.id })
    expect((await h.projects.harness.publish(flow.id)).status).toBe('published')
    await expect(h.projects.harness.createFromTemplate('nope')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('HS-only the user principal may read or manage harnesses', async () => {
    const h = harness()
    const prj = await withProject(h)
    const svc = h.projects.harness
    const d = await svc.create({ name: 'Std', rules: [RULE] })
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    const mcp = {
      kind: 'mcp' as const,
      provider: 'claude-code',
      projectId: prj,
      access: 'read-propose' as const,
      tokenId: 't',
      sessionId: 'ses_1',
    }
    for (const as of [runtime, mcp]) {
      expect(() => svc.list(as)).toThrow(ForbiddenError)
      expect(() => svc.get(d.id, as)).toThrow(ForbiddenError)
      expect(() => svc.attached(prj, as)).toThrow(ForbiddenError)
      await expect(svc.create({ name: 'x' }, as)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(svc.update(d.id, { name: 'x' }, as)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(svc.publish(d.id, as)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(svc.attach(prj, d.id, as)).rejects.toBeInstanceOf(ForbiddenError)
      await expect(svc.detach(prj, d.id, as)).rejects.toBeInstanceOf(ForbiddenError)
    }
  })
})
