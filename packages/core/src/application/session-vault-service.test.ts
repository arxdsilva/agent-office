import { describe, expect, it } from 'vitest'
import { FakeRepoIdentity } from '../../test/fakes/index.ts'
import { harness, identity, withProject } from '../../test/projects-harness.ts'
import { NotFoundError, ValidationError } from '../domain/errors.ts'

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('VaultRecorder (office events → session records + chat)', () => {
  it('VR-agent.upserted creates an unassigned observed record; done → inactive with a summary', async () => {
    const h = harness()
    await h.projects.load()
    h.putAgent({ id: 'cc:1', name: 'shop', status: 'tool', tool: 'Bash' })
    const [s] = h.projects.sessions.list({})
    expect(s).toMatchObject({
      agentId: 'cc:1',
      origin: 'observed',
      projectId: null,
      state: 'active',
      title: 'shop',
    })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm1',
        agentId: 'cc:1',
        from: 'user',
        text: 'fix it',
        ts: 1,
        state: 'delivered',
      },
    })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm2',
        agentId: 'cc:1',
        from: 'agent',
        text: 'Fixed the login bug',
        ts: 2,
        state: 'replied',
      },
    })
    h.clock.advance(120_000)
    h.putAgent({ id: 'cc:1', status: 'done' })
    await tick()
    const done = h.projects.sessions.get(s!.id)
    expect(done.state).toBe('inactive')
    expect(done.agentId).toBeUndefined()
    expect(done.summary).toMatchObject({ source: 'last-replies' })
    expect(done.summary!.text).toContain('Fixed the login bug')
    expect(done.summary!.text).toContain('Tools: Bash')
    // a lastSeen-only bump does not rewrite the record
    await h.projects.store.flush()
    const before = h.log.appends
    h.putAgent({ id: 'cc:1', lastSeen: h.clock.now() + 1 })
    await h.projects.store.flush()
    expect(h.log.appends).toBe(before)
  })

  it('VR-lastSeen-only changes are persisted at most once a minute', async () => {
    const h = harness()
    await h.projects.load()
    h.putAgent({ id: 'cc:1', name: 'x' })
    await h.projects.store.flush()
    const base = h.log.appends
    for (let i = 0; i < 5; i++) {
      h.clock.advance(10_000)
      h.putAgent({ id: 'cc:1', lastSeen: h.clock.now() })
    }
    await h.projects.store.flush()
    expect(h.log.appends).toBe(base)
    h.clock.advance(15_000)
    h.putAgent({ id: 'cc:1', lastSeen: h.clock.now() })
    await h.projects.store.flush()
    expect(h.log.appends).toBe(base + 1)
  })

  it('VR-chat text is capped at 4000 and control-stripped; agent removal ends the record', async () => {
    const h = harness()
    await h.projects.load()
    h.putAgent({ id: 'cc:1' })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm1',
        agentId: 'cc:1',
        from: 'agent',
        text: `a\u0007${'x'.repeat(5000)}`,
        ts: 1,
        state: 'replied',
      },
    })
    h.bus.publish({
      type: 'message.changed',
      message: {
        id: 'm9',
        agentId: 'cc:unknown',
        from: 'user',
        text: 'lost',
        ts: 1,
        state: 'queued',
      },
    })
    const id = h.projects.sessions.list({})[0]!.id
    const msgs = await h.projects.sessions.messages({ sessionId: id, limit: 10 })
    expect(msgs.messages[0]!.text.length).toBeLessThanOrEqual(4000)
    expect(msgs.messages[0]!.text).not.toContain('\u0007')
    expect(msgs.messages[0]).toMatchObject({ role: 'agent', source: 'chat' })
    h.removeAgent('cc:1')
    expect(h.projects.sessions.get(id).state).toBe('inactive')
  })

  it('VR-backfill: live agents become unassigned records on first load; stale active records end', async () => {
    const h = harness()
    h.agents.put({
      id: 'cc:live',
      name: 'live',
      provider: 'claude-code',
      topic: 't',
      status: 'idle',
      source: 'claude-code',
      since: 1,
      lastSeen: 1,
      interactive: false,
      unread: 0,
    })
    await h.projects.load()
    expect(h.projects.sessions.list({ scope: 'unassigned' }).map((s) => s.agentId)).toEqual([
      'cc:live',
    ])
    await h.projects.store.flush()
    const h2 = harness({}, h.log.reopen())
    await h2.projects.load()
    expect(h2.projects.sessions.list({})[0]).toMatchObject({ state: 'inactive' })
  })

  it('VR-managed agents with a projectId are assigned (session.started); records restore Agent.projectId', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.putAgent({
      id: 'cc:m',
      managed: { chrome: false, pending: 0, phase: 'running' },
      projectId: prj,
    })
    const s = h.projects.sessions.list({ scope: prj })[0]!
    expect(s).toMatchObject({ origin: 'managed', projectId: prj, assignedBy: 'user' })
    expect(h.projects.store.activityOf(prj).map((a) => a.kind)).toContain('session.started')
    h.removeAgent('cc:m')
    expect(h.projects.store.activityOf(prj).map((a) => a.kind)).toContain('session.ended')
    h.putAgent({ id: 'cc:m', projectId: undefined })
    expect(h.agents.get('cc:m')?.projectId).toBe(prj)
  })
})

describe('SessionObservation.located', () => {
  it('OBS-cwd in a linked repo auto-assigns (common dir) and patches the live agent', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.putAgent({ id: 'cc:1' })
    await h.projects.observation.located('cc:1', 'claude-code', {
      cwd: '/work/shop/packages/web',
      transcriptRef: 'tr_1',
    })
    const s = h.projects.sessions.list({ scope: prj })[0]!
    expect(s).toMatchObject({ projectId: prj, assignedBy: 'auto', hasTranscript: true })
    expect(h.agents.get('cc:1')?.projectId).toBe(prj)
    expect(h.bus.events.some((e) => e.type === 'agent.upserted' && e.agent.projectId === prj)).toBe(
      true,
    )
    expect(h.projects.store.activityOf(prj).map((a) => a.kind)).toContain('session.assigned')
  })

  it('OBS-same basename only → low suggestion, never auto; unknown cwd → nothing', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.repos.set(
      '/elsewhere/shop',
      identity({ commonDirKey: 'x', rootKey: 'y', rootCommit: 'z', remotes: [] }),
    )
    await h.projects.observation.located('cc:2', 'claude-code', { cwd: '/elsewhere/shop' })
    const s = h.projects.sessions.list({ scope: 'unassigned' })[0]!
    expect(s.suggestions).toEqual([
      { projectId: prj, name: 'Shop', rule: 'name', confidence: 'low' },
    ])
    await h.projects.observation.located('cc:3', 'claude-code', { cwd: '/nowhere' })
    expect(
      h.projects.sessions.list({ scope: 'unassigned' }).find((x) => x.agentId === 'cc:3')
        ?.suggestions,
    ).toEqual([])
  })

  it('OBS-workspace key from an observe hook matches a linked repo; user assignment is never overridden', async () => {
    const h = harness()
    const prj = await withProject(h)
    await h.projects.observation.located('cu:1', 'cursor', {
      workspaceKey: FakeRepoIdentity.keyOf('cd-shop'),
    })
    const s = h.projects.sessions.list({ scope: prj })[0]!
    expect(s).toMatchObject({ provider: 'cursor', assignedBy: 'auto' })
    await h.projects.assignment.assign(s.id, null)
    await h.projects.observation.located('cu:1', 'cursor', {
      workspaceKey: FakeRepoIdentity.keyOf('cd-shop'),
    })
    expect(h.projects.sessions.get(s.id).projectId).toBeNull()
    await h.projects.observation.located('cu:2', 'cursor', {
      workspaceKey: 'wk_00000000000000000000000000000000',
    })
    expect(h.projects.sessions.list({}).find((x) => x.agentId === 'cu:2')?.projectId).toBeNull()
  })

  it('OBS-a project created later auto-assigns matching unassigned sessions (rematch)', async () => {
    const h = harness()
    await h.projects.load()
    await h.projects.observation.located('cc:1', 'claude-code', { cwd: '/work/blog' })
    const p = await h.projects.catalog.create({ name: 'Blog', folders: ['/work/blog'] })
    await h.projects.store.flush()
    expect(h.projects.sessions.list({ scope: p.id }).map((s) => s.agentId)).toEqual(['cc:1'])
  })

  it('OBS-never throws when RepoIdentity fails', async () => {
    const h = harness({
      repoIdentity: {
        resolve: () => Promise.reject(new Error('/secret')),
        workspaceKey: () => Promise.reject(new Error('x')),
      },
    })
    await h.projects.load()
    await expect(
      h.projects.observation.located('cc:1', 'claude-code', { cwd: '/work/shop' }),
    ).resolves.toBeUndefined()
  })
})

describe('SessionVault + SessionAssignment', () => {
  it('SV-assign/reassign keeps history; archive requires an ended session; unknown ids → NotFound', async () => {
    const h = harness()
    const a = await withProject(h)
    const b = (await h.projects.catalog.create({ name: 'Blog', folders: [] })).id
    h.putAgent({ id: 'cc:1' })
    const id = h.projects.sessions.list({})[0]!.id
    await h.projects.assignment.assign(id, a)
    const r = await h.projects.assignment.assign(id, b)
    expect(r).toMatchObject({ projectId: b, assignedBy: 'user' })
    expect(h.projects.store.sessions.get(id)!.assignment.history.map((x) => x.projectId)).toEqual([
      null,
      a,
    ])
    expect(h.agents.get('cc:1')?.projectId).toBe(b)
    await expect(h.projects.sessions.archive(id)).rejects.toBeInstanceOf(ValidationError)
    h.removeAgent('cc:1')
    expect((await h.projects.sessions.archive(id)).state).toBe('archived')
    await expect(h.projects.assignment.assign(id, 'prj_unknown00000')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(h.projects.assignment.assign('ses_unknown00000', a)).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(() => h.projects.sessions.get('ses_unknown00000')).toThrow(NotFoundError)
  })

  it('SV-list filters by scope and query, newest first', async () => {
    const h = harness()
    const a = await withProject(h)
    h.putAgent({ id: 'cc:1', name: 'alpha work' })
    h.clock.advance(10)
    h.putAgent({ id: 'cc:2', name: 'beta work' })
    await h.projects.assignment.assign(h.projects.sessions.list({ query: 'alpha' })[0]!.id, a)
    expect(h.projects.sessions.list({}).map((s) => s.title)).toEqual(['beta work', 'alpha work'])
    expect(h.projects.sessions.list({ scope: a }).map((s) => s.title)).toEqual(['alpha work'])
    expect(h.projects.sessions.list({ scope: 'unassigned' }).map((s) => s.title)).toEqual([
      'beta work',
    ])
  })

  it('SV-messages: the provider transcript when readable (paged), else agent-office chat', async () => {
    const h = harness()
    await h.projects.load()
    h.transcripts.set(
      'tr_1',
      Array.from({ length: 5 }, (_, i) => ({
        uuid: `u${i}`,
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        text: `t${i}`,
        ts: i,
        tools: i % 2 ? ['Edit'] : [],
      })),
    )
    await h.projects.observation.located('cc:1', 'claude-code', { transcriptRef: 'tr_1' })
    h.bus.publish({
      type: 'message.changed',
      message: { id: 'c1', agentId: 'cc:1', from: 'user', text: 'chat', ts: 1, state: 'queued' },
    })
    const id = h.projects.sessions.list({})[0]!.id
    const p1 = await h.projects.sessions.messages({ sessionId: id, limit: 2 })
    expect(p1).toMatchObject({
      more: true,
      messages: [
        { id: 'u3', role: 'agent', source: 'transcript', tools: ['Edit'] },
        { id: 'u4', role: 'user' },
      ],
    })
    const p2 = await h.projects.sessions.messages({ sessionId: id, limit: 2, before: 'u3' })
    expect(p2.messages.map((m) => m.id)).toEqual(['u1', 'u2'])
    h.transcripts.fail = true
    const chat = await h.projects.sessions.messages({ sessionId: id, limit: 10 })
    expect(chat).toEqual({
      more: false,
      messages: [{ id: 'c1', role: 'user', text: 'chat', ts: 1, source: 'chat' }],
    })
    const none = harness({ transcripts: undefined })
    await none.projects.load()
    none.putAgent({ id: 'cc:9' })
    for (let i = 0; i < 3; i++)
      none.bus.publish({
        type: 'message.changed',
        message: {
          id: `k${i}`,
          agentId: 'cc:9',
          from: 'agent',
          text: `k${i}`,
          ts: i,
          state: 'replied',
        },
      })
    const sid = none.projects.sessions.list({})[0]!.id
    const page = await none.projects.sessions.messages({ sessionId: sid, limit: 2 })
    expect(page).toMatchObject({ more: true, messages: [{ id: 'k1' }, { id: 'k2' }] })
    expect(
      (
        await none.projects.sessions.messages({ sessionId: sid, limit: 2, before: 'k1' })
      ).messages.map((m) => m.id),
    ).toEqual(['k0'])
  })
})
