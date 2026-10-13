import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'

describe('TaskService', () => {
  it('TS-list newest first; transitions validated; unknown ids and agents refused', async () => {
    const h = harness()
    const prj = await withProject(h)
    const a = await h.projects.tasks.create(prj, 'A', {
      source: 'agent-reported',
      sessionId: 'ses_aaaaaaaaaaaa',
    })
    h.clock.advance(1)
    await h.projects.tasks.create(prj, 'B')
    expect(h.projects.tasks.list(prj).map((t) => t.title)).toEqual(['B', 'A'])
    expect(a).toMatchObject({ source: 'agent-reported', sessionIds: ['ses_aaaaaaaaaaaa'] })
    await h.projects.tasks.setState(a.id, 'dropped')
    await expect(h.projects.tasks.setState(a.id, 'open')).rejects.toBeInstanceOf(ValidationError)
    await expect(h.projects.tasks.setState('tsk_unknown00000', 'done')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(h.projects.tasks.create('prj_unknown00000', 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    expect(() => h.projects.tasks.list(prj, runtime)).toThrow(ForbiddenError)
    await expect(
      h.projects.tasks.addEvidence(a.id, { level: 'user-confirmed' }, runtime),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
