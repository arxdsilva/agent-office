import { describe, expect, it } from 'vitest'
import { FakeClock, FakeRecordLog, MemoryLogger, SeqRandom } from '../../test/fakes/index.ts'
import {
  createImportedMemory,
  createMemory,
  editMemory,
  rehomeImportedMemory,
  retractMemory,
  supersedeByCap,
} from '../domain/memory.ts'
import { createProject } from '../domain/project.ts'
import { newSessionRecord } from '../domain/session-record.ts'
import { ProjectsStore } from './projects-store.ts'

function make(log = new FakeRecordLog()) {
  const logger = new MemoryLogger()
  const store = new ProjectsStore({ log, clock: new FakeClock(), random: new SeqRandom(), logger })
  return { store, log, logger }
}

const P = 'prj_aaaaaaaaaaaa'

describe('ProjectsStore', () => {
  it('PS-ids are prefixed, [a-z0-9] and unique', () => {
    const { store } = make()
    const a = store.newId('prj')
    const b = store.newId('prj')
    expect(a).toMatch(/^prj_[a-z0-9]{16}$/)
    expect(a).not.toBe(b)
  })

  it('PS-ids fall back to a non-secure source when no SecureRandom is given', () => {
    const store = new ProjectsStore({
      log: new FakeRecordLog(),
      clock: new FakeClock(),
      logger: new MemoryLogger(),
    })
    expect(store.newId('ses')).toMatch(/^ses_[a-z0-9]{16}$/)
    expect(store.newId('ses')).not.toBe(store.newId('ses'))
  })

  it('PS-persists to the partitions of docs §3 and rebuilds the same state on load', async () => {
    const { store, log } = make()
    await store.putProject(createProject({ id: P, name: 'Shop', now: 1 }))
    await store.putSession(
      newSessionRecord({
        id: 'ses_aaaaaaaaaaaa',
        agentId: 'cc:1',
        provider: 'claude-code',
        origin: 'observed',
        title: 't',
        now: 1,
      }),
    )
    const m = createMemory({
      id: 'mem_aaaaaaaaaaaa',
      projectId: P,
      scope: 'project',
      kind: 'note',
      title: 'T',
      body: 'B',
      origin: 'user',
      createdBy: 'you',
      now: 1,
    })
    await store.putMemory(m)
    await store.putMemory({ ...m, version: 2, body: 'B2' })
    const g = createMemory({
      id: 'mem_bbbbbbbbbbbb',
      projectId: null,
      scope: 'global',
      kind: 'note',
      title: 'G',
      body: 'B',
      origin: 'user',
      createdBy: 'you',
      now: 1,
    })
    await store.putMemory(g)
    await store.putChat('ses_aaaaaaaaaaaa', { id: 'm1', role: 'user', text: 'hi', ts: 2 })
    await store.putChat('ses_aaaaaaaaaaaa', { id: 'm1', role: 'user', text: 'hi', ts: 2 })
    await store.addActivity({
      id: 'act_a',
      projectId: P,
      ts: 3,
      kind: 'memory.approved',
      actor: 'you',
      text: 'x',
    })
    expect((await log.partitions('')).sort()).toEqual(['catalog', `p/${P}`, 's/ses_aaaaaaaaaaaa'])
    expect((await log.read('s/ses_aaaaaaaaaaaa')).length).toBe(1) // identical chat not rewritten

    const again = make(log.reopen()).store
    await again.load()
    expect(again.projects.get(P)?.name).toBe('Shop')
    expect(again.sessions.get('ses_aaaaaaaaaaaa')?.agentId).toBe('cc:1')
    expect(again.sessionByAgent('cc:1')?.id).toBe('ses_aaaaaaaaaaaa')
    expect(again.memory.get('mem_aaaaaaaaaaaa')?.body).toBe('B2')
    expect(again.versions('mem_aaaaaaaaaaaa').map((v) => v.version)).toEqual([1, 2])
    expect(again.memory.get('mem_bbbbbbbbbbbb')?.scope).toBe('global')
    expect(again.chatOf('ses_aaaaaaaaaaaa')).toEqual([
      { id: 'm1', role: 'user', text: 'hi', ts: 2 },
    ])
    expect(again.activityOf(P).map((a) => a.id)).toEqual(['act_a'])
  })

  it('PS-load skips unknown or malformed records and compacts a bloated partition', async () => {
    const log = new FakeRecordLog()
    const p = createProject({ id: P, name: 'Shop', now: 1 })
    await log.append('catalog', [
      { t: 'weird', ts: 1, data: {} },
      { t: 'project', ts: 1, data: { nope: 1 } },
    ])
    await log.append(
      'catalog',
      Array.from({ length: 300 }, (_, i) => ({
        t: 'project',
        ts: i,
        data: { ...p, name: `n${i}` },
      })),
    )
    const { store } = make(log)
    await store.load()
    expect(store.projects.get(P)?.name).toBe('n299')
    expect(log.compactions).toEqual(['catalog'])
    // the 300 project snapshots collapse to one; unknown records are kept for newer versions
    expect((await log.read('catalog')).map((r) => r.t)).toEqual(['weird', 'project', 'project'])
  })

  it('PS-emits changes and logs write failures without throwing', async () => {
    const { store, log, logger } = make()
    const seen: string[] = []
    const off = store.onChange((c) => seen.push(c.type))
    log.failNext = true
    await store.putProject(createProject({ id: P, name: 'Shop', now: 1 }))
    expect(seen).toEqual(['project'])
    expect(logger.lines.some((l) => l.startsWith('warn vault write failed'))).toBe(true)
    expect(logger.lines.join()).not.toContain('Shop')
    off()
    store.emit({ type: 'project', id: P })
    expect(seen).toEqual(['project'])
  })

  it('PS-activity is capped in memory and listed newest first', async () => {
    const { store } = make()
    for (let i = 0; i < 2100; i++)
      void store.addActivity({
        id: `act_${i}`,
        projectId: P,
        ts: i,
        kind: 'mcp.retrieval',
        actor: 'x',
        text: '',
      })
    await store.flush()
    const list = store.activityOf(P)
    expect(list.length).toBe(2000)
    expect(store.recentActivity(P, 2).map((a) => a.ts)).toEqual([2099, 2098])
  })
})

describe('ProjectsStore: cross-partition moves and auto-imported knowledge', () => {
  const Q = 'prj_bbbbbbbbbbbb'
  const imported = (
    projectId: string | null,
    id = 'mem_iiiiiiiiiiii',
    sessionId = 'ses_aaaaaaaaaaaa',
  ) =>
    createImportedMemory({
      id,
      session: { id: sessionId, title: 'Invented session' },
      summary: 'Invented session\n• Did a thing.',
      projectId,
      now: 1,
      approvedAt: 1,
    })

  it('PS-move: a re-home leaves a tombstone in the old partition; reload resolves the newest place', async () => {
    const { store, log } = make()
    const v1 = imported(null)
    await store.putMemory(v1)
    const v2 = rehomeImportedMemory(v1, P, 2)
    await store.putMemory(v2)
    const v3 = rehomeImportedMemory(v2, Q, 3)
    await store.putMemory(v3)
    expect(store.memory.get(v1.id)).toMatchObject({ version: 3, projectId: Q, state: 'approved' })
    // The tombstones are on disk only, never a version in the history list.
    expect(store.versions(v1.id).map((v) => v.version)).toEqual([1, 2, 3])
    const catalog = log.storage.get('catalog')!.filter((r) => r.t === 'memory')
    expect(catalog.map((r) => [r.data.version, r.data.state])).toEqual([
      [1, 'approved'],
      [2, 'superseded'],
    ])
    expect(log.storage.get(`p/${P}`)!.map((r) => [r.data.version, r.data.state])).toEqual([
      [2, 'approved'],
      [3, 'superseded'],
    ])
    await store.flush()

    // Any load order resolves to the live record: reload, and reload with partitions reversed.
    const a = make(log.reopen()).store
    await a.load()
    expect(a.memory.get(v1.id)).toMatchObject({ version: 3, projectId: Q, state: 'approved' })
    expect(a.knowledgeOf('ses_aaaaaaaaaaaa')?.projectId).toBe(Q)
    const reversed = log.reopen()
    const parts = reversed.partitions.bind(reversed)
    reversed.partitions = async (prefix: string) => (await parts(prefix)).reverse()
    const b = make(reversed).store
    await b.load()
    expect(b.memory.get(v1.id)).toMatchObject({ version: 3, projectId: Q })

    // The new partition is gone (project deleted): the moved item does not come back elsewhere.
    log.storage.delete(`p/${Q}`)
    const c = make(log.reopen()).store
    await c.load()
    expect(c.memory.get(v1.id)).toMatchObject({ state: 'superseded' })
  })

  it('PS-move: an edit that changes partition (project → global) is tombstoned too', async () => {
    const { store, log } = make()
    const m = createMemory({
      id: 'mem_aaaaaaaaaaaa',
      projectId: P,
      scope: 'project',
      kind: 'note',
      title: 'T',
      body: 'B',
      origin: 'user',
      createdBy: 'you',
      now: 1,
    })
    await store.putMemory(m)
    await store.putMemory(editMemory(m, { scope: 'global' }, 2))
    await store.flush()
    log.storage.delete('catalog')
    const c = make(log.reopen()).store
    await c.load()
    expect(c.memory.get(m.id)?.state).toBe('superseded')
  })

  it('PS-knowledge: session → its auto-imported item (approved first, never rejected), rebuilt on load', async () => {
    const { store, log } = make()
    expect(store.knowledgeOf('ses_aaaaaaaaaaaa')).toBeUndefined()
    const a = imported(P)
    await store.putMemory(a)
    expect(store.knowledgeOf('ses_aaaaaaaaaaaa')?.id).toBe(a.id)
    // Removed: no longer the session's knowledge.
    await store.putMemory(retractMemory(a, 2))
    expect(store.knowledgeOf('ses_aaaaaaaaaaaa')).toBeUndefined()
    // A new lineage for the same session; and a capped one for another session.
    const b = imported(P, 'mem_jjjjjjjjjjjj')
    await store.putMemory(b)
    const c = imported(P, 'mem_kkkkkkkkkkkk', 'ses_bbbbbbbbbbbb')
    await store.putMemory(supersedeByCap(c, 3))
    expect(store.knowledgeOf('ses_aaaaaaaaaaaa')?.id).toBe(b.id)
    // Capped items stay the session's knowledge (so they are not recreated).
    expect(store.knowledgeOf('ses_bbbbbbbbbbbb')).toMatchObject({ id: c.id, state: 'superseded' })
    await store.flush()
    const r = make(log.reopen()).store
    await r.load()
    expect(r.knowledgeOf('ses_aaaaaaaaaaaa')?.id).toBe(b.id)
    expect(r.knowledgeOf('ses_bbbbbbbbbbbb')?.id).toBe(c.id)
    // User memory with a sessionId is not knowledge.
    const own = createMemory({
      id: 'mem_llllllllllll',
      projectId: P,
      scope: 'project',
      kind: 'note',
      title: 'Mine',
      body: 'B',
      origin: 'user',
      createdBy: 'you',
      sessionId: 'ses_cccccccccccc',
      now: 1,
    })
    await r.putMemory(own)
    expect(r.knowledgeOf('ses_cccccccccccc')).toBeUndefined()
  })

  it('PS-harness: versions, snapshots, events and gate results persist and reload', async () => {
    const { store, log } = make()
    const changes: unknown[] = []
    store.onChange((c) => changes.push(c))
    const h = {
      id: 'hrn_aaaaaaaaaa',
      version: 1,
      name: 'Std',
      scope: 'project' as const,
      status: 'draft' as const,
      launchPolicy: 'advisory' as const,
      gateTrigger: 'manual' as const,
      fsIsolation: 'off' as const,
      retryBudget: 2,
      rules: [
        {
          id: 'rul_aaaaaa',
          name: 'R',
          text: 'RULE-SENTINEL',
          category: 'coding' as const,
          enforcement: 'instruction' as const,
          severity: 'required' as const,
        },
      ],
      gates: [
        {
          id: 'gat_aaaaaa',
          name: 'G',
          argv: ['make', 'ARGV-SENTINEL'],
          timeoutMs: 1000,
          required: true,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }
    await store.putHarness({ ...h, version: 2, status: 'draft' })
    await store.putHarness({ ...h, status: 'published' })
    await store.putHarness({ ...h, status: 'published', name: 'Std2' }) // same version rewritten
    expect(store.harnessVersions(h.id).map((x) => [x.version, x.name])).toEqual([
      [1, 'Std2'],
      [2, 'Std'],
    ])
    expect(store.harness(h.id)?.version).toBe(2)
    expect(store.allHarnesses().map((x) => x.id)).toEqual([h.id])
    const S = 'ses_aaaaaaaaaaaa'
    await store.putHarnessSnapshot({
      id: 'hsn_1',
      sessionId: S,
      agentId: 'cc:1',
      projectId: P,
      provider: 'claude-code',
      effective: {} as never,
      report: {} as never,
      createdAt: 1,
    })
    for (let i = 0; i < 505; i++)
      await store.addHarnessEvent({
        id: `hev_${i}`,
        projectId: P,
        sessionId: S,
        agentId: 'cc:1',
        ts: i,
        kind: 'action-allowed',
        ruleIds: [],
        detail: { tool: 'Read', summary: 'a' },
      })
    const gr = {
      id: 'gtr_1',
      sessionId: S,
      projectId: P,
      gateId: 'gat_aaaaaa',
      name: 'G',
      required: true,
      harnessVersion: `${h.id}@1`,
      startedAt: 2,
      run: { status: 'fail' as const, exitCode: 1, durationMs: 1, outputTail: '' },
    }
    await store.putGateResult(gr)
    await store.putGateResult({ ...gr, run: { ...gr.run, status: 'pass', exitCode: 0 } })
    expect(store.gateResultsOf(S)).toMatchObject([{ id: 'gtr_1', run: { status: 'pass' } }])
    for (let i = 2; i < 105; i++) await store.putGateResult({ ...gr, id: `gtr_${i}` })
    expect(store.harnessEventsOf(S)).toHaveLength(500)
    expect(store.gateResultsOf(S)).toHaveLength(100)
    store.setGateRunning(S, {
      gateId: 'gat_aaaaaa',
      name: 'G',
      required: true,
      harnessVersion: 'v',
      startedAt: 3,
    })
    expect(store.runningGates(S)).toHaveLength(1)
    store.setGateRunning(S, undefined, 'gat_aaaaaa')
    expect(store.runningGates(S)).toEqual([])
    expect(changes).toContainEqual({ type: 'harness', harnessId: h.id })
    expect(changes).toContainEqual({ type: 'harness', agentId: 'cc:1', projectId: P })
    await store.flush()

    const r = make(log.reopen()).store
    await r.load()
    expect(r.harnessVersions(h.id).map((x) => [x.version, x.name])).toEqual([
      [1, 'Std2'],
      [2, 'Std'],
    ])
    expect(r.harnessSnapshot(S)?.id).toBe('hsn_1')
    expect(r.harnessEventsOf(S)).toHaveLength(500)
    expect(r.gateResultsOf(S)).toHaveLength(100)
    expect(r.gateResultsOf(S).at(-1)?.id).toBe('gtr_104')
    // Gate argv lives only in the harness record, never in events or activity.
    const recs = [...log.storage.values()].flat()
    for (const rec of recs.filter((x) => x.t === 'harness-event' || x.t === 'activity'))
      expect(JSON.stringify(rec)).not.toContain('ARGV-SENTINEL')
    expect(log.dump()).toContain('RULE-SENTINEL') // the fake stores plaintext; the real vault encrypts
  })

  it('PS-flow: flow progress per session persists in s/<ses>, replaces in place and reloads', async () => {
    const { store, log } = make()
    const changes: unknown[] = []
    store.onChange((c) => changes.push(c))
    const S = 'ses_bbbbbbbbbbbb'
    const fp = {
      id: 'fpg_aaaaaaaaaa',
      sessionId: S,
      agentId: 'cc:2',
      projectId: P,
      harnessVersion: 'hrn_aaaaaaaaaa@1',
      mode: 'sequential' as const,
      current: 'stp_aaaaaaaa',
      steps: [{ stepId: 'stp_aaaaaaaa', state: 'active' as const, checks: ['pending' as const] }],
      updatedAt: 1,
    }
    await store.putFlowProgress(fp)
    await store.putFlowProgress({ ...fp, current: null, updatedAt: 2 })
    expect(store.flowOf(S)).toMatchObject({ current: null, updatedAt: 2 })
    expect(store.flowOf('ses_nothing0000')).toBeUndefined()
    expect(store.allFlows().map((f) => f.id)).toEqual(['fpg_aaaaaaaaaa'])
    expect(changes).toContainEqual({ type: 'harness', agentId: 'cc:2', projectId: P })
    await store.flush()
    expect([...log.storage.keys()]).toContain(`s/${S}`)
    const r = make(log.reopen()).store
    await r.load()
    expect(r.flowOf(S)).toMatchObject({ id: 'fpg_aaaaaaaaaa', current: null })
  })
})
