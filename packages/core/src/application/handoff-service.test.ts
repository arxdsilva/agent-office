import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { CONTEXT_OPEN, DATA_PREFACE } from '../domain/handoff.ts'
import { NotFoundError, SessionStartError, ValidationError } from '../domain/errors.ts'

const note = (projectId: string, title: string) => ({
  projectId,
  scope: 'project' as const,
  kind: 'note' as const,
  title,
  body: `${title} body`,
})

async function fromSession() {
  const h = harness()
  const prj = await withProject(h)
  const a = await h.projects.memory.create(note(prj, 'Use pnpm'))
  const b = await h.projects.memory.create(note(prj, 'JWT auth'))
  h.putAgent({
    id: 'cc:1',
    name: 'shop work',
    projectId: prj,
    managed: { chrome: false, pending: 0, phase: 'running' },
  })
  const ses = h.projects.sessions.list({ scope: prj })[0]!.id
  return { h, prj, a, b, ses }
}

describe('HandoffManager', () => {
  it('HO-prepare ranks the bundle for the target provider and logs handoff.prepared', async () => {
    const { h, prj, a, b, ses } = await fromSession()
    const v = await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'codex',
      objective: 'finish jwt',
    })
    expect(v).toMatchObject({
      projectId: prj,
      state: 'draft',
      toProvider: 'codex',
      from: { sessionId: ses, provider: 'claude-code', title: 'shop work' },
    })
    expect(v.bundle.items.map((i) => i.ref.id).sort()).toEqual([a.id, b.id].sort())
    expect(h.projects.store.activityOf(prj).map((e) => e.kind)).toContain('handoff.prepared')
    expect(h.projects.handoffs.list(prj).map((x) => x.id)).toEqual([v.id])
    expect(h.projects.handoffs.list()).toHaveLength(1)
  })

  it('HO-update keeps only included items; launch starts the target with a data block and records delivery', async () => {
    const { h, prj, a, ses } = await fromSession()
    const v = await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'codex',
      objective: 'finish jwt',
    })
    const u = await h.projects.handoffs.update({
      handoffId: v.id,
      note: 'tests flaky',
      include: [a.id],
    })
    expect(u.bundle.items.filter((i) => i.included).map((i) => i.ref.id)).toEqual([a.id])
    const { agentId } = await h.projects.handoffs.launch(v.id)
    const start = h.started[0]!
    expect(start).toMatchObject({
      provider: 'codex',
      projectId: prj,
      cwd: '/work/shop',
      mode: 'default',
    })
    expect(start.first.text).toContain('finish jwt')
    expect(start.first.text).toContain('tests flaky')
    expect(start.first.text).toContain(CONTEXT_OPEN)
    expect(start.first.text).toContain(DATA_PREFACE)
    expect(start.first.text).toContain('Use pnpm body')
    expect(start.first.text).not.toContain('JWT auth body')
    const rec = h.projects.store.sessionByAgent(agentId)!
    expect(rec.continuedFrom).toEqual({ handoffId: v.id, sessionId: ses, provider: 'claude-code' })
    expect(h.projects.handoffs.list(prj)[0]).toMatchObject({
      state: 'launched',
      launchedSessionId: rec.id,
    })
    expect(h.projects.context.inspect(agentId).delivered).toEqual([
      { ts: expect.any(Number), memoryIds: [a.id], via: 'handoff' },
    ])
    await expect(h.projects.handoffs.launch(v.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('HO-launch re-checks items: one superseded after prepare is not delivered', async () => {
    const { h, prj, a, b, ses } = await fromSession()
    const v = await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'codex',
      objective: 'x',
    })
    await h.projects.memory.supersede(b.id, note(prj, 'JWT v2'))
    await h.projects.handoffs.launch(v.id)
    expect(h.started[0]!.first.text).not.toContain('JWT auth body')
    expect(h.started[0]!.first.text).toContain(a.title)
  })

  it('HO-refusals: unassigned session, no repo, unknown ids, no managed sessions; cancel', async () => {
    const { h, ses } = await fromSession()
    h.putAgent({ id: 'cc:2' })
    const loose = h.projects.sessions.list({ scope: 'unassigned' })[0]!.id
    await expect(
      h.projects.handoffs.prepare({ sessionId: loose, toProvider: 'codex', objective: 'x' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      h.projects.handoffs.prepare({
        sessionId: 'ses_unknown00000',
        toProvider: 'codex',
        objective: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(h.projects.handoffs.launch('hof_unknown00000')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    const v = await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'codex',
      objective: 'x',
    })
    expect((await h.projects.handoffs.cancel(v.id)).state).toBe('cancelled')

    const n = harness({ sessions: () => undefined })
    const prj = await withProject(n, 'Bare', [])
    n.putAgent({
      id: 'cc:1',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    const s2 = n.projects.sessions.list({ scope: prj })[0]!.id
    const v2 = await n.projects.handoffs.prepare({
      sessionId: s2,
      toProvider: 'codex',
      objective: 'x',
    })
    await expect(n.projects.handoffs.launch(v2.id)).rejects.toBeInstanceOf(SessionStartError)
    const n2 = harness()
    const p2 = await withProject(n2, 'Bare', [])
    n2.putAgent({
      id: 'cc:1',
      projectId: p2,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    const v3 = await n2.projects.handoffs.prepare({
      sessionId: n2.projects.sessions.list({ scope: p2 })[0]!.id,
      toProvider: 'codex',
      objective: 'x',
    })
    await expect(n2.projects.handoffs.launch(v3.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('HO-startWithContext: New Agent with chosen memories as a data block, recorded as delivered', async () => {
    const { h, prj, a, b } = await fromSession()
    const agentId = await h.projects.handoffs.startWithContext(
      {
        provider: 'codex',
        projectId: prj,
        cwd: '/work/shop',
        name: 'n',
        mode: 'default',
        extraDirs: [],
        chrome: false,
        first: { text: 'Do it', context: [], use: [] },
      },
      [a.id, 'mem_unknown00000'],
    )
    const text = h.started[0]!.first.text
    expect(text.startsWith('Do it')).toBe(true)
    expect(text).toContain(a.title)
    expect(text).not.toContain(b.title)
    expect(h.projects.context.inspect(agentId).delivered[0]).toMatchObject({
      memoryIds: [a.id],
      via: 'first-message',
    })
    await h.projects.handoffs.startWithContext(
      { ...h.started[0]!, projectId: prj, first: { text: 'plain', context: [], use: [] } },
      [],
    )
    expect(h.started[1]!.first.text).toBe('plain')
  })
})
