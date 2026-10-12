import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportActivity } from '@agent-office/core'
import { FakeClock, ManualScheduler } from '@agent-office/core/testing'
import type { AgentEvent } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { makeOffice } from '../../../test/support.ts'
import { assistant, iso, T0, user } from './fixtures.ts'
import { ClaudeCodeTailer } from './tailer.ts'
import { MemoryTranscriptFiles, NodeTranscriptFiles } from './transcript-files.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function tailer(o: { dir: string; activity: ReportActivity; expireAfterMs: number; now: number; scheduler?: ManualScheduler; files?: MemoryTranscriptFiles }) {
  return new ClaudeCodeTailer({
    dir: o.dir,
    files: o.files ?? new NodeTranscriptFiles(),
    activity: o.activity,
    clock: new FakeClock(o.now),
    scheduler: o.scheduler ?? new ManualScheduler(),
    expireAfterMs: o.expireAfterMs,
  })
}

describe('ClaudeCodeTailer (node file system)', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'ao-cc-'))
    const project = join(dir, '-home-dev-projects-shop')
    mkdirSync(project)
    const file = join(project, 'sess-1234abcd.jsonl')
    const { office, scheduler } = makeOffice({ policy: { expireAfterMs: 1e15 } })
    cleanups.push(() => scheduler.dispose())
    const store = office.query
    const src = tailer({ dir, activity: office.activity, expireAfterMs: 1e15, now: T0 + 1000 })
    return { dir, project, file, store, src, office }
  }

  it('reads new lines as they are appended, including lines split across reads', async () => {
    const { file, store, src } = fixture()
    writeFileSync(file, user('hi') + '\n')
    await src.tick()
    expect(store.agent('cc:sess-1234abcd')?.status).toBe('thinking')

    const line = assistant([{ type: 'tool_use', name: 'Edit', input: {} }], { timestamp: iso(10) })
    appendFileSync(file, line.slice(0, 20))
    await src.tick()
    appendFileSync(file, line.slice(20) + '\n')
    await src.tick()
    expect(store.agent('cc:sess-1234abcd')).toMatchObject({ status: 'tool', tool: 'Edit' })
  })

  it('finds the title even when it is before the 64KB tail window', async () => {
    const { file, store, src } = fixture()
    const filler = user('x'.repeat(1000))
    const lines = [
      user('start'),
      JSON.stringify({ type: 'ai-title', sessionId: 'sess-1234abcd', aiTitle: 'Old title' }),
    ]
    for (let i = 0; i < 100; i++) lines.push(filler)
    lines.push(assistant([{ type: 'text', text: 'ok' }], { timestamp: iso(50) }, 'end_turn'))
    writeFileSync(file, lines.join('\n') + '\n')
    await src.tick()
    expect(store.agent('cc:sess-1234abcd')).toMatchObject({ topic: 'Old title', status: 'waiting' })
  })

  it('starts over when a file is truncated', async () => {
    const { file, store, src } = fixture()
    writeFileSync(file, user('one') + '\n' + user('two') + '\n')
    await src.tick()
    truncateSync(file, 0)
    writeFileSync(
      file,
      assistant([{ type: 'tool_use', name: 'Grep', input: {} }], { timestamp: iso(99) }) + '\n',
    )
    await src.tick()
    expect(store.agent('cc:sess-1234abcd')?.tool).toBe('Grep')
  })

  it('reads subagent transcripts and their meta files', async () => {
    const { project, store, src } = fixture()
    const subDir = join(project, 'sess-1234abcd', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-a1b2c3d4e5.meta.json'),
      JSON.stringify({ agentType: 'Plan', description: 'Plan it' }),
    )
    writeFileSync(
      join(subDir, 'agent-a1b2c3d4e5.jsonl'),
      user('go', { isSidechain: true, agentId: 'a1b2c3d4e5' }) + '\n',
    )
    await src.tick()
    expect(store.agent('cc:a1b2c3d4e5')).toMatchObject({ name: 'Plan', parentId: 'cc:sess-1234abcd' })
  })

  it('ignores files not modified within the expiry window and survives a missing dir', async () => {
    const { file, store, office } = fixture()
    writeFileSync(file, user('old') + '\n')
    const old = new Date(T0 - 3_600_000)
    utimesSync(file, old, old)
    const src = tailer({ dir: join(file, '..', '..'), activity: office.activity, expireAfterMs: 60_000, now: T0 })
    await src.tick()
    expect(store.agents()).toEqual([])
    const missing = tailer({ dir: '/definitely/not/here', activity: office.activity, expireAfterMs: 1, now: T0 })
    await expect(missing.tick()).resolves.toBeUndefined()
  })

  it('drops events older than the expiry window', async () => {
    const { file, store, office } = fixture()
    writeFileSync(file, user('ancient', { timestamp: iso(-3_600_000) }) + '\n')
    const src = tailer({ dir: join(file, '..', '..'), activity: office.activity, expireAfterMs: 60_000, now: T0 })
    await src.tick()
    expect(store.agents()).toEqual([])
  })

  it('start/stop schedule and cancel polling', async () => {
    const { src } = fixture()
    const scheduler = new ManualScheduler()
    const s = tailer({ dir: '/nowhere', activity: { report: () => 0 }, expireAfterMs: 1, now: T0, scheduler })
    s.start(10)
    expect(scheduler.jobs).toHaveLength(1)
    scheduler.runAll()
    s.stop()
    expect(scheduler.jobs[0]!.cancelled).toBe(true)
  })
})

describe('ClaudeCodeTailer (in-memory files)', () => {
  it('reads appended lines through the TranscriptFiles port, without touching disk', async () => {
    const files = new MemoryTranscriptFiles()
    const got: AgentEvent[] = []
    const t = tailer({ dir: '/p', activity: { report: (e) => (got.push(...e), e.length) }, expireAfterMs: 1e15, now: T0, files })
    files.write('/p/proj/sess-1234abcd.jsonl', user('hi') + '\n', T0)
    await t.tick()
    files.append('/p/proj/sess-1234abcd.jsonl', assistant([{ type: 'tool_use', name: 'Read', input: {} }], { timestamp: iso(5) }) + '\n', T0)
    await t.tick()
    expect(got.map((e) => e.status)).toEqual(['thinking', 'tool'])
  })

  it('logs unreadable files once and keeps going', async () => {
    const files = new MemoryTranscriptFiles()
    const warnings: string[] = []
    const t = new ClaudeCodeTailer({
      dir: '/p', files, activity: { report: () => 0 }, clock: new FakeClock(T0), scheduler: new ManualScheduler(),
      expireAfterMs: 1e15, log: { info: () => {}, warn: (m) => warnings.push(m) },
    })
    files.write('/p/proj/s.jsonl', 'x\n', T0)
    files.failReads('/p/proj/s.jsonl')
    await t.tick()
    await t.tick()
    expect(warnings).toHaveLength(1)
  })
})
