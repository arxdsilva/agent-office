import { describe, expect, it } from 'vitest'
import type { PastSession } from '../ports/driven.ts'
import { harness, withProject } from '../../test/projects-harness.ts'
import { FakeHistorySource } from '../../test/fakes/projects.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'

const past = (id: string, over: Partial<PastSession> = {}): PastSession => ({
  provider: 'claude-code',
  providerSessionId: id,
  transcriptRef: `tr_${id.replace(/[^a-z0-9]/gi, '')}`,
  cwd: '/work/shop',
  title: `Invented task ${id}`,
  startedAt: 1000,
  lastSeenAt: 5000,
  ...over,
})

const RUNTIME = { kind: 'runtime' as const, provider: 'codex', projectId: 'prj_aaaaaaaaaaaa' }

describe('SessionHistoryService.importHistory (experimental)', () => {
  it('SH-import: creates imported records, matched like observed sessions; idempotent', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.history.set([
      past('aaa'),
      past('bbb', { cwd: '/work/blog' }),
      past('ccc', { cwd: undefined }),
    ])
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 3,
      skipped: 0,
    })
    const all = h.projects.sessions.list({})
    expect(all).toHaveLength(3)
    const a = all.find((s) => s.title.endsWith('aaa'))!
    expect(a).toMatchObject({ origin: 'imported', state: 'inactive', hasTranscript: true })
    expect(a.projectId).toBe(prj) // /work/shop is linked: the same auto rule as observed sessions
    expect(all.find((s) => s.title.endsWith('bbb'))).toMatchObject({
      origin: 'imported',
      projectId: null,
    })
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 0,
      skipped: 3,
    })
    expect(h.projects.sessions.list({})).toHaveLength(3)
  })

  it('SH-import: honours the limit, skips malformed entries, keeps paths and refs out of views', async () => {
    const h = harness()
    await h.projects.load()
    h.history.set([
      past('one'),
      past('bad id with spaces'),
      past('two', { transcriptRef: '../etc/passwd' }),
      past('three', { cwd: '/secret/home/me/token-project' }),
      past('four'),
    ])
    expect(await h.projects.history.importHistory({ limit: 4 })).toEqual({
      imported: 2,
      skipped: 2,
    })
    const json = JSON.stringify(h.projects.sessions.list({}))
    for (const leak of ['/secret', '/work/', '"cwd"', 'tr_', 'passwd'])
      expect(json).not.toContain(leak)
  })

  it('SH-import: user only; needs a source', async () => {
    const h = harness()
    await h.projects.load()
    await expect(h.projects.history.importHistory({ limit: 5 }, RUNTIME)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    const none = harness({ history: undefined })
    await none.projects.load()
    await expect(none.projects.history.importHistory({ limit: 5 })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('SH-import: a source that throws does not leave half-imported state', async () => {
    const h = harness()
    await h.projects.load()
    h.history.fail = true
    await expect(h.projects.history.importHistory({ limit: 5 })).rejects.toThrow()
    expect(h.projects.sessions.list({})).toHaveLength(0)
  })
})

describe('SessionHistoryService.importHistory with several providers', () => {
  const oc = (id: string, over: Partial<PastSession> = {}) =>
    past(id, { provider: 'opencode', transcriptRef: `tr_oc_${id}`, ...over })

  it('SH-multi: every provider with a source imports under its own agent id prefix; idempotent', async () => {
    const claude = new FakeHistorySource([past('aaa')])
    const opencode = new FakeHistorySource([oc('ses_one'), oc('ses_two', { cwd: '/work/blog' })])
    const goose = new FakeHistorySource([
      past('20260101_1', { provider: 'goose', transcriptRef: 'tr_go_1' }),
    ])
    const h = harness({
      history: { 'claude-code': claude, opencode, goose },
    })
    await h.projects.load()
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 4,
      skipped: 0,
    })
    const all = h.projects.sessions.list({})
    expect(all.map((s) => s.provider).sort()).toEqual([
      'claude-code',
      'goose',
      'opencode',
      'opencode',
    ])
    for (const s of all) expect(s).toMatchObject({ origin: 'imported', state: 'inactive' })
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 0,
      skipped: 4,
    })
    expect(h.projects.sessions.list({})).toHaveLength(4)
  })

  it('SH-multi: an entry whose provider differs from its source, or whose id breaks the source pattern, is skipped', async () => {
    const opencode = new FakeHistorySource([
      oc('ses_ok'),
      oc('with space'),
      past('stray'), // claims claude-code but comes from the OpenCode source
    ])
    const h = harness({ history: { opencode } })
    await h.projects.load()
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 1,
      skipped: 2,
    })
  })

  it('SH-multi: a provider id pattern of the source is enforced', async () => {
    const strict = Object.assign(new FakeHistorySource([oc('ses_a'), oc('other')]), {
      idPattern: /^ses_[a-z]+$/,
    })
    const h = harness({ history: { opencode: strict } })
    await h.projects.load()
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 1,
      skipped: 1,
    })
  })

  it('SH-multi: one failing source is skipped while another works; all failing throws', async () => {
    const broken = new FakeHistorySource([oc('ses_x')])
    broken.fail = true
    const claude = new FakeHistorySource([past('aaa')])
    const h = harness({ history: { opencode: broken, 'claude-code': claude } })
    await h.projects.load()
    expect(await h.projects.history.importHistory({ limit: 10 })).toEqual({
      imported: 1,
      skipped: 0,
    })
    const bad = harness({ history: { opencode: broken } })
    await bad.projects.load()
    await expect(bad.projects.history.importHistory({ limit: 10 })).rejects.toThrow()
    expect(bad.projects.sessions.list({})).toHaveLength(0)
  })

  it('SH-multi: an empty source map means history is not available', async () => {
    const none = harness({ history: {} })
    await none.projects.load()
    await expect(none.projects.history.importHistory({ limit: 5 })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })

  it('SH-multi: the limit applies to each source', async () => {
    const opencode = new FakeHistorySource([oc('a1'), oc('a2'), oc('a3')])
    const claude = new FakeHistorySource([past('b1'), past('b2'), past('b3')])
    const h = harness({ history: { opencode, 'claude-code': claude } })
    await h.projects.load()
    expect(await h.projects.history.importHistory({ limit: 2 })).toEqual({
      imported: 4,
      skipped: 0,
    })
  })
})

describe('SessionHistoryService.resume (experimental)', () => {
  async function imported() {
    const h = harness()
    const prj = await withProject(h)
    h.history.set([past('aaa'), past('bbb', { cwd: '/work/blog' })])
    await h.projects.history.importHistory({ limit: 10 })
    const list = h.projects.sessions.list({})
    return {
      h,
      prj,
      a: list.find((s) => s.title.endsWith('aaa'))!,
      b: list.find((s) => s.title.endsWith('bbb'))!,
    }
  }

  it('SH-resume: canResume only for inactive Claude sessions with a known folder', async () => {
    const { h, a } = await imported()
    expect(a.canResume).toBe(true)
    h.history.set([past('ddd', { cwd: undefined })])
    await h.projects.history.importHistory({ limit: 10 })
    expect(
      h.projects.sessions.list({}).find((s) => s.title.endsWith('ddd'))!.canResume,
    ).toBeUndefined()
    h.putAgent({ id: 'cc:live1', name: 'live' })
    expect(
      h.projects.sessions.list({}).find((s) => s.agentId === 'cc:live1')!.canResume,
    ).toBeUndefined()
    h.putAgent({ id: 'cx:1', provider: 'codex', status: 'done' })
    expect(
      h.projects.sessions.list({}).find((s) => s.provider === 'codex')!.canResume,
    ).toBeUndefined()
  })

  it('SH-resume: starts in the record folder, on its project, with resume; lineage on a new id', async () => {
    const { h, prj, a } = await imported()
    const r = await h.projects.history.resume(a.id)
    expect(h.started[0]).toMatchObject({
      provider: 'claude-code',
      cwd: '/work/shop',
      projectId: prj,
      resume: 'aaa',
    })
    const rec = h.projects.sessions.list({}).find((s) => s.agentId === r.agentId)!
    expect(rec.continuedFrom).toMatchObject({ sessionId: a.id, provider: 'claude-code' })
    expect(rec.projectId).toBe(prj)
  })

  it('SH-resume: unassigned records start without a project', async () => {
    const { h, b } = await imported()
    await h.projects.history.resume(b.id)
    expect(h.started[0]!.projectId).toBeUndefined()
    expect(h.started[0]!.cwd).toBe('/work/blog')
  })

  it('SH-resume: a runtime that keeps the session id reuses the record without lineage', async () => {
    const put: { fn?: () => void } = {}
    const sessions = {
      start: async () => {
        put.fn?.()
        return 'cc:keep'
      },
    }
    const h = harness({ sessions: () => sessions as never })
    put.fn = () => h.putAgent({ id: 'cc:keep', status: 'thinking' })
    h.history.set([past('keep')])
    await h.projects.load()
    await h.projects.history.importHistory({ limit: 5 })
    const rec = h.projects.sessions.list({})[0]!
    expect(rec.canResume).toBe(true)
    await h.projects.history.resume(rec.id)
    expect(h.projects.sessions.list({})).toHaveLength(1)
    expect(h.projects.sessions.list({})[0]!.continuedFrom).toBeUndefined()
  })

  it('SH-resume: refuses unknown, running, other-principal and unavailable cases', async () => {
    const { h, a } = await imported()
    await expect(h.projects.history.resume('ses_unknown00000')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    h.putAgent({ id: 'cc:live1' })
    const live = h.projects.sessions.list({}).find((s) => s.agentId === 'cc:live1')!
    await expect(h.projects.history.resume(live.id)).rejects.toBeInstanceOf(ValidationError)
    await expect(h.projects.history.resume(a.id, RUNTIME)).rejects.toBeInstanceOf(ForbiddenError)
    const none = harness({ sessions: () => undefined })
    await none.projects.load()
    none.history.set([past('zzz')])
    await none.projects.history.importHistory({ limit: 5 })
    const z = none.projects.sessions.list({})[0]!
    await expect(none.projects.history.resume(z.id)).rejects.toBeInstanceOf(ValidationError)
  })
})
