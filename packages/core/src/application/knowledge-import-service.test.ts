import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError } from '../domain/errors.ts'
import type { PastSession, TranscriptMessage } from '../ports/driven.ts'

// Invented content only. Each past session has a transcript whose last agent reply holds a marker.
const past = (id: string, over: Partial<PastSession> = {}): PastSession => ({
  provider: 'claude-code',
  providerSessionId: id,
  transcriptRef: `tr_${id}`,
  cwd: '/work/shop',
  title: `Invented task ${id}`,
  startedAt: 1000,
  lastSeenAt: 61_000,
  ...over,
})
const said = (uuid: string, role: 'user' | 'assistant', text: string): TranscriptMessage => ({
  uuid,
  role,
  text,
  ts: 1,
  tools: [],
})
const MCP = (projectId: string) => ({
  kind: 'mcp' as const,
  projectId,
  sessionId: 'ses_reader000001',
  provider: 'codex',
  tokenId: 'tok_reader000001',
  access: 'read' as const,
})
/** Every pending promise chain finishes before a macrotask (all fakes are in memory). */
// The core has no host globals; tests may still yield one macrotask.
const settle = () =>
  new Promise((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(
      () => r(undefined),
      0,
    ),
  )

async function setup(sessions: PastSession[] = [past('aaa'), past('bbb', { cwd: '/work/blog' })]) {
  const h = harness()
  const prj = await withProject(h)
  h.history.set(sessions)
  for (const s of sessions)
    h.transcripts.set(s.transcriptRef, [
      said(`${s.providerSessionId}-1`, 'user', 'please do the invented thing'),
      said(`${s.providerSessionId}-2`, 'assistant', `Done: marker-${s.providerSessionId}`),
    ])
  const k = h.projects.knowledge
  const imported = () =>
    [...h.projects.store.memory.values()].filter((m) => m.provenance.origin === 'session-import')
  const sessionOf = (id: string) =>
    [...h.projects.store.sessions.values()].find((r) => r.agentId === `cc:${id}`)!
  return { h, prj, k, imported, sessionOf }
}

describe('KnowledgeImportService (docs/projects.md §8b)', () => {
  it('KI-off: runAll and sync do nothing while the setting is off', async () => {
    const { h, k, imported } = await setup()
    expect(await k.runAll()).toEqual({ imported: 0, skipped: 0, added: 0 })
    await h.projects.history.importHistory({ limit: 10 })
    for (const r of h.projects.store.sessions.values()) await k.sync(r.id)
    expect(imported()).toEqual([])
    expect(k.status()).toEqual({ on: false, imported: 0, added: 0 })
    expect(h.scheduler.jobs).toEqual([])
  })

  it('KI-on: past Claude sessions are imported, each with one approved item; others skipped', async () => {
    const { h, prj, k, imported, sessionOf } = await setup([
      past('aaa'),
      past('bbb', { cwd: '/work/nowhere' }),
      past('ccc', { provider: 'codex' }),
    ])
    h.clock.t = 2_000_000
    expect(await k.runAll()).toEqual({ imported: 0, skipped: 0, added: 0 })
    // Enabling runs an import at once.
    k.setEnabled(true, 1_500_000)
    await settle()
    const items = imported()
    expect(items).toHaveLength(2)
    const a = items.find((m) => m.provenance.sessionId === sessionOf('aaa').id)!
    expect(a).toMatchObject({
      projectId: prj,
      scope: 'project',
      kind: 'note',
      state: 'approved',
      title: 'Session: Invented task aaa',
      provenance: { origin: 'session-import', createdBy: 'auto-import', reviewedAt: 1_500_000 },
    })
    expect(a.body).toContain('marker-aaa')
    // Only the summary reply is kept (never the user's prompt), and the record got its summary.
    expect(a.body).not.toContain('please do')
    expect(sessionOf('aaa').summary).toMatchObject({ source: 'last-replies' })
    // The unmatched one stays unassigned: session scope, readable by no agent.
    const b = items.find((m) => m.provenance.sessionId === sessionOf('bbb').id)!
    expect(b).toMatchObject({ projectId: null, scope: 'session' })
    // Agents of the project can read A's item; the vault view links it.
    expect(h.projects.memory.readable(MCP(prj)).map((m) => m.id)).toEqual([a.id])
    expect(h.projects.sessions.get(sessionOf('aaa').id).knowledgeMemoryId).toBe(a.id)
    // One aggregated activity per project.
    const acts = h.projects.store.activityOf(prj).filter((e) => e.kind === 'memory.imported')
    expect(acts).toHaveLength(1)
    expect(acts[0]!.text).toBe('Imported 1 session summary')
    expect(k.status()).toEqual({ on: true, lastRunAt: 2_000_000, imported: 2, added: 2 })
  })

  it('KI-idempotent across runs; a changed summary is a new version', async () => {
    const { h, k, imported, sessionOf } = await setup()
    k.setEnabled(true, 1)
    await k.runAll()
    const second = await k.runAll()
    expect(second).toMatchObject({ imported: 0, added: 0 })
    expect(imported()).toHaveLength(2)
    const r = sessionOf('aaa')
    await h.projects.store.putSession({
      ...r,
      summary: { text: 'Invented task aaa\n• A newer reply', source: 'last-replies' },
    })
    await k.sync(r.id)
    const item = h.projects.store.knowledgeOf(r.id)!
    expect(item).toMatchObject({ version: 2, body: 'Invented task aaa\n• A newer reply' })
    expect(imported()).toHaveLength(2)
  })

  it('KI-rehome: unassigned → session scope; assigned → project (tombstone); reload resolves it', async () => {
    const { h, prj, k, sessionOf } = await setup([past('bbb', { cwd: '/work/nowhere' })])
    k.setEnabled(true, 1)
    await k.runAll()
    const r = sessionOf('bbb')
    expect(h.projects.store.knowledgeOf(r.id)).toMatchObject({ projectId: null, scope: 'session' })
    // The user assigns it: onAssigned re-homes the item (a new version in the project partition).
    await h.projects.assignment.assign(r.id, prj)
    await settle()
    await h.projects.store.flush()
    const moved = h.projects.store.knowledgeOf(r.id)!
    expect(moved).toMatchObject({ version: 2, projectId: prj, scope: 'project' })
    const catalog = h.log.storage.get('catalog')!.filter((x) => x.t === 'memory')
    expect(catalog.map((x) => x.data.state)).toEqual(['approved', 'superseded'])
    // A restart over the same vault resolves the lineage to the newest version.
    const h2 = harness({}, h.log.reopen())
    await h2.projects.load()
    expect(h2.projects.store.knowledgeOf(r.id)).toMatchObject({ version: 2, projectId: prj })
    expect(h2.projects.memory.readable(MCP(prj)).map((m) => m.id)).toEqual([moved.id])
  })

  it('KI-cap: at most 200 per project; the oldest are superseded and not recreated', async () => {
    const many = Array.from({ length: 203 }, (_, i) =>
      past(`s${String(i).padStart(3, '0')}`, { lastSeenAt: 10_000 + i }),
    )
    const { h, prj, k, imported } = await setup(many)
    k.setEnabled(true, 1)
    let n = 0
    // Each creation gets a later time, so "oldest" is well defined.
    const now = h.clock.now.bind(h.clock)
    h.clock.now = () => now() + n++
    await settle()
    expect(k.status()).toMatchObject({ imported: 203, added: 203 })
    const live = imported().filter((m) => m.projectId === prj && m.state === 'approved')
    expect(live).toHaveLength(200)
    const capped = imported().filter((m) => m.state === 'superseded')
    expect(capped).toHaveLength(3)
    expect(capped.every((m) => m.supersededBy === 'cap')).toBe(true)
    // The superseded ones are the oldest items.
    const oldestLive = Math.min(...live.map((m) => m.provenance.createdAt))
    expect(capped.every((m) => m.provenance.createdAt < oldestLive)).toBe(true)
    expect((await k.runAll()).added).toBe(0)
    expect(imported()).toHaveLength(203)
  })

  it('KI-remove: rejects them (user only), drops them from search, and they are never recreated', async () => {
    const { h, prj, k, imported, sessionOf } = await setup()
    k.setEnabled(true, 1)
    await k.runAll()
    const memoryHits = async () =>
      (await h.projects.search.search({ query: 'marker-aaa' })).filter((x) => x.kind === 'memory')
    expect(await memoryHits()).toHaveLength(1)
    await expect(
      h.projects.knowledge.removeImported(prj, {
        kind: 'runtime',
        provider: 'codex',
        projectId: prj,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    // One project only: the unassigned item stays.
    expect(await k.removeImported(prj)).toEqual({ removed: 1 })
    expect(imported().filter((m) => m.state === 'approved')).toHaveLength(1)
    expect(h.projects.memory.readable(MCP(prj))).toEqual([])
    expect(await memoryHits()).toEqual([])
    expect(sessionOf('aaa').knowledgeRemovedAt).toBeDefined()
    expect(h.projects.sessions.get(sessionOf('aaa').id).knowledgeMemoryId).toBeUndefined()
    // All projects (and unassigned).
    expect(await k.removeImported()).toEqual({ removed: 1 })
    expect(await k.removeImported()).toEqual({ removed: 0 })
    expect(await k.runAll()).toMatchObject({ added: 0 })
    await k.sync(sessionOf('aaa').id)
    expect(imported().filter((m) => m.state === 'approved')).toEqual([])
    // After a restart too.
    await h.projects.store.flush()
    const h2 = harness({}, h.log.reopen())
    h2.history.set([past('aaa'), past('bbb', { cwd: '/work/blog' })])
    await h2.projects.load()
    h2.projects.knowledge.setEnabled(true, 1)
    await h2.projects.knowledge.runAll()
    expect([...h2.projects.store.memory.values()].filter((m) => m.state === 'approved')).toEqual([])
    const acts = h.projects.store.activityOf(prj).filter((e) => e.kind === 'memory.rejected')
    expect(acts.map((e) => e.text)).toEqual(['Removed 1 auto-imported summary'])
  })

  it('KI-remove: a session that ends again after removal is imported again', async () => {
    const { h, k, sessionOf } = await setup([past('aaa')])
    k.setEnabled(true, 1)
    await k.runAll()
    await k.removeImported()
    const r = sessionOf('aaa')
    h.clock.advance(60_000)
    await h.projects.store.putSession({ ...r, endedAt: h.clock.now(), lastSeenAt: h.clock.now() })
    await k.sync(r.id)
    expect(h.projects.store.knowledgeOf(r.id)).toMatchObject({ state: 'approved', version: 1 })
  })

  it('KI-schedule: runs on enabling and every 10 minutes; cancelled when turned off', async () => {
    const { h, k, imported } = await setup([past('aaa')])
    k.setEnabled(true, 1)
    await settle()
    expect(imported()).toHaveLength(1)
    expect(h.scheduler.jobs.map((j) => j.ms)).toEqual([600_000])
    // Enabling twice does not schedule twice.
    k.setEnabled(true, 1)
    expect(h.scheduler.jobs.filter((j) => !j.cancelled)).toHaveLength(1)
    h.history.set([past('aaa'), past('ddd')])
    h.transcripts.set('tr_ddd', [said('d', 'assistant', 'Done: marker-ddd')])
    h.scheduler.runAll()
    await settle()
    expect(imported()).toHaveLength(2)
    k.setEnabled(false, 1)
    expect(h.scheduler.jobs.every((j) => j.cancelled)).toBe(true)
    expect(k.status().on).toBe(false)
  })

  it('KI-single-flight: overlapping runs share one queued rerun', async () => {
    const { h, k } = await setup([past('aaa')])
    let lists = 0
    const list = h.history.list.bind(h.history)
    h.history.list = async (o) => {
      lists++
      return list(o)
    }
    k.setEnabled(true, 1)
    const a = k.runAll()
    const b = k.runAll()
    const c = k.runAll()
    expect(b).toBe(c)
    await Promise.all([a, b, c])
    // enable (1) + one queued rerun (1); the third call joined the queued one.
    expect(lists).toBe(2)
  })

  it('KI-robust: no history source, unreadable transcripts and empty replies make no item', async () => {
    const h = harness({ history: undefined })
    await withProject(h)
    const k = h.projects.knowledge
    k.setEnabled(true, 1)
    expect(await k.runAll()).toEqual({ imported: 0, skipped: 0, added: 0 })
    // An observed Claude session that ended without replies and without a transcript.
    h.putAgent({ id: 'cc:quiet', name: 'quiet', status: 'thinking' })
    h.putAgent({ id: 'cc:quiet', status: 'done' })
    await settle()
    const r = h.projects.store.sessionByAgent('cc:quiet')!
    expect(r.state).toBe('inactive')
    await k.sync(r.id)
    await k.sync('ses_unknown00000')
    // A transcript that cannot be read.
    await h.projects.store.putSession({ ...r, transcriptRef: 'tr_gone' })
    h.transcripts.fail = true
    await k.sync(r.id)
    h.transcripts.fail = false
    // A transcript with no agent text.
    h.transcripts.set('tr_gone', [said('u', 'user', 'only a prompt')])
    await k.sync(r.id)
    expect(
      [...h.projects.store.memory.values()].filter((m) => m.provenance.origin === 'session-import'),
    ).toEqual([])
  })

  it('KI-ended: an observed Claude session ending feeds its item through onEnded', async () => {
    const h = harness()
    const prj = await withProject(h)
    h.projects.knowledge.setEnabled(true, 1)
    await settle()
    h.putAgent({ id: 'cc:live', name: 'live', status: 'thinking' })
    await h.projects.observation.located('cc:live', 'claude-code', {
      cwd: '/work/shop',
      transcriptRef: 'tr_live',
    })
    h.transcripts.set('tr_live', [said('l1', 'assistant', 'Shipped the invented fix')])
    h.putAgent({ id: 'cc:live', status: 'done' })
    await settle()
    const r = h.projects.store.sessionByAgent('cc:live')!
    expect(r.projectId).toBe(prj)
    // No agent-office chat replies: the summary came from the transcript.
    expect(r.summary?.text).toContain('Shipped the invented fix')
    expect(h.projects.store.knowledgeOf(r.id)).toMatchObject({ projectId: prj, state: 'approved' })
  })

  it('KI-authz (§3.4): own project only; never another project or unassigned; policy none; removal', async () => {
    const { h, prj, k, sessionOf } = await setup([
      past('aaa'),
      past('bbb', { cwd: '/work/blog' }),
      past('ccc', { cwd: '/work/nowhere' }),
    ])
    const blog = (await h.projects.catalog.create({ name: 'Blog', folders: ['/work/blog'] })).id
    k.setEnabled(true, 1)
    await settle()
    const own = h.projects.store.knowledgeOf(sessionOf('aaa').id)!
    const theirs = h.projects.store.knowledgeOf(sessionOf('bbb').id)!
    const loose = h.projects.store.knowledgeOf(sessionOf('ccc').id)!
    expect([own.projectId, theirs.projectId, loose.projectId]).toEqual([prj, blog, null])
    const ids = (pid: string) => h.projects.memory.readable(MCP(pid)).map((m) => m.id)
    // A reads A's item only; B reads B's only; nobody reads the unassigned one.
    expect(ids(prj)).toEqual([own.id])
    expect(ids(blog)).toEqual([theirs.id])
    expect(ids(prj)).not.toContain(loose.id)
    // A token of project A presented for B's data is denied by the boundary.
    expect(
      h.projects.memory.readable({ ...MCP(prj), projectId: blog }).map((m) => m.id),
    ).not.toContain(own.id)
    // Policy none → nothing.
    const pol = h.projects.catalog.get(prj).policy
    await h.projects.catalog.update({
      projectId: prj,
      policy: { ...pol, providers: { ...pol.providers, codex: 'none' } },
    })
    expect(ids(prj)).toEqual([])
    // After removeImported → nothing.
    await k.removeImported(blog)
    expect(ids(blog)).toEqual([])
  })

  it('KI-filter: memory.list honours the origin filter', async () => {
    const { h, prj, k } = await setup([past('aaa')])
    await h.projects.memory.create({
      projectId: prj,
      scope: 'project',
      kind: 'note',
      title: 'Mine',
      body: 'b',
    })
    k.setEnabled(true, 1)
    await settle()
    expect(h.projects.memory.list({ scope: prj }).length).toBe(2)
    expect(
      h.projects.memory.list({ scope: prj, origin: 'session-import' }).map((m) => m.title),
    ).toEqual(['Session: Invented task aaa'])
    expect(h.projects.memory.list({ scope: prj, origin: 'user' }).map((m) => m.title)).toEqual([
      'Mine',
    ])
  })
})
