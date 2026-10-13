import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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

function tailer(o: {
  dir: string
  activity: ReportActivity
  expireAfterMs: number
  now: number
  scheduler?: ManualScheduler
  files?: MemoryTranscriptFiles
  skip?: (sessionId: string) => boolean
}) {
  return new ClaudeCodeTailer({
    dir: o.dir,
    files: o.files ?? new NodeTranscriptFiles(),
    activity: o.activity,
    clock: new FakeClock(o.now),
    scheduler: o.scheduler ?? new ManualScheduler(),
    expireAfterMs: o.expireAfterMs,
    ...(o.skip ? { skip: o.skip } : {}),
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
    expect(store.agent('cc:a1b2c3d4e5')).toMatchObject({
      name: 'Plan',
      parentId: 'cc:sess-1234abcd',
    })
  })

  it('TL-skip skips the transcripts of managed sessions, subagents included', async () => {
    const { dir, project, file, office } = fixture()
    let managed = true
    const src = tailer({
      dir,
      activity: office.activity,
      expireAfterMs: 1e15,
      now: T0 + 1000,
      skip: (sid) => managed && sid === 'sess-1234abcd',
    })
    writeFileSync(file, user('hi') + '\n')
    const subDir = join(project, 'sess-1234abcd', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-a1b2c3d4e5.jsonl'),
      user('go', { isSidechain: true, agentId: 'a1b2c3d4e5' }) + '\n',
    )
    await src.tick()
    expect(office.query.agents()).toEqual([])
    // Once the session is no longer managed, its transcript is read like any other.
    managed = false
    await src.tick()
    expect(office.query.agent('cc:sess-1234abcd')).toBeDefined()
    expect(office.query.agent('cc:a1b2c3d4e5')).toBeDefined()
  })

  it('ignores files not modified within the expiry window and survives a missing dir', async () => {
    const { file, store, office } = fixture()
    writeFileSync(file, user('old') + '\n')
    const old = new Date(T0 - 3_600_000)
    utimesSync(file, old, old)
    const src = tailer({
      dir: join(file, '..', '..'),
      activity: office.activity,
      expireAfterMs: 60_000,
      now: T0,
    })
    await src.tick()
    expect(store.agents()).toEqual([])
    const missing = tailer({
      dir: '/definitely/not/here',
      activity: office.activity,
      expireAfterMs: 1,
      now: T0,
    })
    await expect(missing.tick()).resolves.toBeUndefined()
  })

  it('drops events older than the expiry window', async () => {
    const { file, store, office } = fixture()
    writeFileSync(file, user('ancient', { timestamp: iso(-3_600_000) }) + '\n')
    const src = tailer({
      dir: join(file, '..', '..'),
      activity: office.activity,
      expireAfterMs: 60_000,
      now: T0,
    })
    await src.tick()
    expect(store.agents()).toEqual([])
  })

  it('start/stop schedule and cancel polling', async () => {
    const { src } = fixture()
    const scheduler = new ManualScheduler()
    const s = tailer({
      dir: '/nowhere',
      activity: { report: () => 0 },
      expireAfterMs: 1,
      now: T0,
      scheduler,
    })
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
    const t = tailer({
      dir: '/p',
      activity: { report: (e) => (got.push(...e), e.length) },
      expireAfterMs: 1e15,
      now: T0,
      files,
    })
    files.write('/p/proj/sess-1234abcd.jsonl', user('hi') + '\n', T0)
    await t.tick()
    files.append(
      '/p/proj/sess-1234abcd.jsonl',
      assistant([{ type: 'tool_use', name: 'Read', input: {} }], { timestamp: iso(5) }) + '\n',
      T0,
    )
    await t.tick()
    expect(got.map((e) => e.status)).toEqual(['thinking', 'tool'])
  })

  it('logs unreadable files once and keeps going', async () => {
    const files = new MemoryTranscriptFiles()
    const warnings: string[] = []
    const t = new ClaudeCodeTailer({
      dir: '/p',
      files,
      activity: { report: () => 0 },
      clock: new FakeClock(T0),
      scheduler: new ManualScheduler(),
      expireAfterMs: 1e15,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    })
    files.write('/p/proj/s.jsonl', 'x\n', T0)
    files.failReads('/p/proj/s.jsonl')
    await t.tick()
    await t.tick()
    expect(warnings).toHaveLength(1)
  })
})

describe('ClaudeCodeTailer: active cwds and Claude paths (capability discovery)', () => {
  function setup(now = T0 + 10) {
    const files = new MemoryTranscriptFiles()
    const got: AgentEvent[] = []
    const seen: string[] = []
    const clock = new FakeClock(now)
    const t = new ClaudeCodeTailer({
      dir: '/h/.claude/projects',
      files,
      activity: { report: (e) => (got.push(...e), e.length) },
      clock,
      scheduler: new ManualScheduler(),
      expireAfterMs: 1_000,
      onNewCwd: (cwd) => seen.push(cwd),
    })
    return { files, got, seen, clock, t }
  }

  it('exposes recent session cwds and announces each new one once', async () => {
    const { files, seen, clock, t } = setup()
    const f = '/h/.claude/projects/-home-dev-projects-shop/s.jsonl'
    files.write(f, user('hi') + '\n' + user('again') + '\n', T0)
    await t.tick()
    expect(t.activeCwds()).toEqual(['/home/dev/projects/shop'])
    expect(seen).toEqual(['/home/dev/projects/shop'])
    files.append(f, user('third', { cwd: '/home/dev/projects/web' }) + '\n', T0)
    await t.tick()
    expect(seen).toEqual(['/home/dev/projects/shop', '/home/dev/projects/web'])
    // Sessions that went quiet longer than expireAfterMs are no longer active.
    clock.advance(5_000)
    expect(t.activeCwds()).toEqual([])
  })

  it('recognizes user rules under the Claude home derived from the projects dir', async () => {
    const { files, got, t } = setup()
    files.write(
      '/h/.claude/projects/p/s.jsonl',
      assistant([
        { type: 'tool_use', name: 'Read', input: { file_path: '/h/.claude/rules/style.md' } },
      ]) + '\n',
      T0,
    )
    await t.tick()
    expect(got[0]?.target).toBe('rule:user:style.md')
  })
})

describe('ClaudeCodeTailer: onSessionLocated', () => {
  function build() {
    const files = new MemoryTranscriptFiles()
    const located: [string, string, string][] = []
    const events: AgentEvent[] = []
    const t = new ClaudeCodeTailer({
      dir: '/h/.claude/projects',
      files,
      activity: { report: (e) => (events.push(...e), e.length) },
      clock: new FakeClock(T0 + 10),
      scheduler: new ManualScheduler(),
      expireAfterMs: 1_000,
      onSessionLocated: (...a) => located.push(a),
    })
    return { files, located, events, t }
  }

  it('fires once per top-level session with an opaque ref and never leaks the cwd', async () => {
    const { files, located, events, t } = build()
    const f = '/h/.claude/projects/p/sess-1.jsonl'
    files.write(f, user('hi') + '\n' + user('again') + '\n', T0)
    files.write('/h/.claude/projects/p/sess-1/subagents/agent-a1.jsonl', user('sub') + '\n', T0)
    await t.tick()
    await t.tick()
    expect(located).toHaveLength(1)
    const [sid, cwd, ref] = located[0]!
    expect(sid).toBe('sess-1')
    expect(cwd).toBe('/home/dev/projects/shop')
    expect(ref).toMatch(/^tr_[0-9a-f]{24}$/)
    expect(ref).not.toContain('sess-1')
    expect(t.refs.resolve(ref)).toBe(f)
    expect(JSON.stringify(events)).not.toContain('/home/dev')
  })

  it('waits for a line that carries a cwd and ignores malformed ones', async () => {
    const { files, located, t } = build()
    const f = '/h/.claude/projects/p/s2.jsonl'
    files.write(f, '{"cwd": broken\n' + JSON.stringify({ type: 'x', cwd: 5 }) + '\n', T0)
    await t.tick()
    expect(located).toHaveLength(0)
    files.append(f, user('ok') + '\n', T0)
    await t.tick()
    expect(located).toHaveLength(1)
  })
})

describe('ClaudeCodeTailer: stale cwds', () => {
  it('does not announce cwds whose sessions are already expired', async () => {
    const files = new MemoryTranscriptFiles()
    const seen: string[] = []
    const t = new ClaudeCodeTailer({
      dir: '/h/.claude/projects',
      files,
      activity: { report: () => 0 },
      clock: new FakeClock(T0 + 10_000),
      scheduler: new ManualScheduler(),
      expireAfterMs: 1_000,
      onNewCwd: (cwd) => seen.push(cwd),
    })
    files.write('/h/.claude/projects/p/s.jsonl', user('old') + '\n', T0 + 10_000)
    await t.tick()
    expect(seen).toEqual([])
    expect(t.activeCwds()).toEqual([])
  })
})

describe('ClaudeCodeTailer: stats (Connect panel)', () => {
  function setup(onStats?: (s: { projectsDirFound: boolean; activeSessions: number }) => void) {
    const files = new MemoryTranscriptFiles()
    const t = new ClaudeCodeTailer({
      dir: '/h/.claude/projects',
      files,
      activity: { report: () => 0 },
      clock: new FakeClock(T0 + 10_000),
      scheduler: new ManualScheduler(),
      expireAfterMs: 5_000,
      ...(onStats ? { onStats } : {}),
    })
    return { files, t }
  }

  it('reports nothing before the first tick', () => {
    expect(setup().t.stats()).toEqual({ projectsDirFound: false, activeSessions: 0 })
  })

  it('reports a missing projects dir', async () => {
    const { t } = setup()
    await t.tick()
    expect(t.stats()).toEqual({ projectsDirFound: false, activeSessions: 0 })
  })

  it('counts fresh top-level sessions only (stale and subagent files are excluded)', async () => {
    const { files, t } = setup()
    files.write('/h/.claude/projects/a/s1.jsonl', user('hi') + '\n', T0 + 9_000)
    files.write('/h/.claude/projects/b/s2.jsonl', user('hi') + '\n', T0 + 9_500)
    files.write('/h/.claude/projects/b/old.jsonl', user('hi') + '\n', T0)
    files.write('/h/.claude/projects/b/s2/subagents/agent-x.jsonl', user('hi') + '\n', T0 + 9_500)
    await t.tick()
    expect(t.stats()).toEqual({ projectsDirFound: true, activeSessions: 2 })
  })

  it('fires onStats only when the stats change', async () => {
    const seen: unknown[] = []
    const { files, t } = setup((s) => seen.push(s))
    await t.tick()
    await t.tick()
    expect(seen).toEqual([])
    files.write('/h/.claude/projects/a/s1.jsonl', user('hi') + '\n', T0 + 9_000)
    await t.tick()
    await t.tick()
    expect(seen).toEqual([{ projectsDirFound: true, activeSessions: 1 }])
  })
})

describe('TranscriptFiles.stat isDir', () => {
  it('reports directories on the node and in-memory implementations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-cc-dir-'))
    writeFileSync(join(dir, 'f.jsonl'), 'x')
    const node = new NodeTranscriptFiles()
    expect((await node.stat(dir))?.isDir).toBe(true)
    expect((await node.stat(join(dir, 'f.jsonl')))?.isDir).toBe(false)
    const mem = new MemoryTranscriptFiles()
    mem.write('/d/f.jsonl', 'x', T0)
    expect((await mem.stat('/d'))?.isDir).toBe(true)
    expect((await mem.stat('/d/f.jsonl'))?.isDir).toBe(false)
  })
})
