import { describe, expect, it } from 'vitest'
import { FakeClock, FakeRecordLog, MemoryLogger, SeqRandom } from '../../test/fakes/index.ts'
import { createMemory } from '../domain/memory.ts'
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
