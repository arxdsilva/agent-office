import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError } from '../domain/errors.ts'
import { InMemorySearchIndex } from './global-search.ts'
import { searchIndexContract } from '../../test/contracts/projects.ts'

searchIndexContract('InMemorySearchIndex (core default)', () => new InMemorySearchIndex())

describe('GlobalSearchService', () => {
  it('GS-finds projects, sessions, messages, memory and handoffs; project filter; hit shape', async () => {
    const h = harness()
    const prj = await withProject(h, 'Kangaroo shop')
    const other = (await h.projects.catalog.create({ name: 'Other', folders: [] })).id
    await h.projects.memory.create({
      projectId: prj,
      scope: 'project',
      kind: 'note',
      title: 'Kangaroo notes',
      body: 'b',
    })
    await h.projects.memory.create({
      projectId: other,
      scope: 'project',
      kind: 'note',
      title: 'Kangaroo elsewhere',
      body: 'b',
    })
    h.putAgent({
      id: 'cc:1',
      name: 'kangaroo session',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm1',
        agentId: 'cc:1',
        from: 'agent',
        text: 'the kangaroo jumped',
        ts: 1,
        state: 'replied',
      },
    })
    const ses = h.projects.sessions.list({ scope: prj })[0]!.id
    await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'codex',
      objective: 'kangaroo handoff',
    })
    await h.projects.store.flush()
    const all = await h.projects.search.search({ query: 'kangaroo' })
    expect(new Set(all.map((x) => x.kind))).toEqual(
      new Set(['project', 'session', 'message', 'memory', 'handoff', 'agent']),
    )
    const msg = all.find((x) => x.kind === 'message')!
    expect(msg).toMatchObject({ sessionId: ses, messageId: 'm1', projectId: prj })
    const only = await h.projects.search.search({ query: 'kangaroo', projectId: prj })
    expect(only.some((x) => x.title === 'Kangaroo elsewhere')).toBe(false)
    for (const x of all) expect(x.snippet.length).toBeLessThanOrEqual(200)
  })

  it('GS-reindexes on change: reassigned messages move project; deep search reads transcripts', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.transcripts.set('tr_1', [
      { uuid: 'u1', role: 'assistant', text: 'the wombat migration', ts: 1, tools: [] },
    ])
    h.putAgent({ id: 'cc:1' })
    await h.projects.observation.located('cc:1', 'claude-code', { transcriptRef: 'tr_1' })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm1',
        agentId: 'cc:1',
        from: 'user',
        text: 'platypus',
        ts: 1,
        state: 'queued',
      },
    })
    const ses = h.projects.sessions.list({})[0]!.id
    expect((await h.projects.search.search({ query: 'platypus', projectId: prj })).length).toBe(0)
    await h.projects.assignment.assign(ses, prj)
    expect((await h.projects.search.search({ query: 'platypus', projectId: prj })).length).toBe(1)
    expect(await h.projects.search.search({ query: 'wombat' })).toEqual([])
    const deep = await h.projects.search.search({ query: 'wombat', deep: true })
    expect(deep).toEqual([
      {
        kind: 'message',
        id: 'u1',
        projectId: prj,
        title: expect.any(String),
        snippet: 'the wombat migration',
        sessionId: ses,
        messageId: 'u1',
      },
    ])
  })

  it('GS-is for the user only', async () => {
    const h = harness()
    const prj = await withProject(h)
    await expect(
      h.projects.search.search(
        { query: 'x' },
        { kind: 'runtime', provider: 'codex', projectId: prj },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('GS-rebuilds the index from the vault at load', async () => {
    const h = harness()
    const prj = await withProject(h)
    await h.projects.memory.create({
      projectId: prj,
      scope: 'project',
      kind: 'note',
      title: 'Echidna',
      body: 'b',
    })
    await h.projects.store.flush()
    const h2 = harness({ searchIndex: undefined }, h.log.reopen())
    await h2.projects.load()
    expect((await h2.projects.search.search({ query: 'echidna' })).map((x) => x.kind)).toEqual([
      'memory',
    ])
  })

  it('GS-rejected and superseded memory leaves search; approved and pending stay', async () => {
    const h = harness()
    const prj = await withProject(h)
    const m = await h.projects.memory.create({
      projectId: prj,
      scope: 'project',
      kind: 'note',
      title: 'Platypus',
      body: 'b',
    })
    const hits = async () => (await h.projects.search.search({ query: 'platypus' })).length
    expect(await hits()).toBe(1)
    await h.projects.memory.supersede(m.id, {
      projectId: prj,
      scope: 'project',
      kind: 'note',
      title: 'Wombat',
      body: 'b',
    })
    expect(await hits()).toBe(0)
    const p = await h.projects.memory.propose(
      {
        kind: 'mcp',
        projectId: prj,
        sessionId: 'ses_x',
        provider: 'codex',
        tokenId: 't',
        access: 'read-propose',
      },
      { kind: 'note', title: 'Platypus idea', body: 'b' },
    )
    expect(await hits()).toBe(1)
    await h.projects.memory.review(p.id, 'reject')
    expect(await hits()).toBe(0)
    // And at load.
    await h.projects.store.flush()
    const h2 = harness({ searchIndex: undefined }, h.log.reopen())
    await h2.projects.load()
    expect(await h2.projects.search.search({ query: 'platypus' })).toEqual([])
  })
})
