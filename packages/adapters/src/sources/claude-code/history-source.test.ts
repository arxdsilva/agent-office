import { historySourceContract } from '@agent-office/core/testing'
import { describe, expect, it } from 'vitest'
import { assistant, iso, user } from './fixtures.ts'
import { ClaudeHistorySource } from './history-source.ts'
import { ClaudeTranscriptReader } from './transcript-reader.ts'
import { MemoryTranscriptFiles, TranscriptRefs } from './transcript-files.ts'

const DIR = '/home/dev/.claude/projects'
const SECRET_PATH = '/home/dev/SENTINEL-secret-project'
const SECRET_TEXT = 'SENTINEL-message-secret'

const line = (type: string, sessionId: string, over: Record<string, unknown>) =>
  JSON.stringify({ type, sessionId, ...over })

function setup() {
  const files = new MemoryTranscriptFiles()
  const refs = new TranscriptRefs()
  files.write(
    `${DIR}/-home-dev-shop/old-1.jsonl`,
    [
      user(SECRET_TEXT, { sessionId: 'old-1', cwd: SECRET_PATH, timestamp: iso(0) }),
      assistant([{ type: 'text', text: 'ok' }], { sessionId: 'old-1', timestamp: iso(1000) }),
      line('ai-title', 'old-1', { aiTitle: 'Fix the login bug' }),
    ].join('\n') + '\n',
    1_000,
  )
  files.write(
    `${DIR}/-home-dev-blog/new-2.jsonl`,
    [
      user('hi', { sessionId: 'new-2', cwd: '/home/dev/blog', timestamp: iso(5000) }),
      line('ai-title', 'new-2', { aiTitle: 'AI title' }),
      line('custom-title', 'new-2', { customTitle: 'x'.repeat(200) }),
    ].join('\n') + '\n',
    9_000,
  )
  files.write(`${DIR}/-home-dev-blog/broken-3.jsonl`, 'not json at all\n', 5_000)
  files.write(`${DIR}/-home-dev-blog/locked-4.jsonl`, user('x', { sessionId: 'locked-4' }), 8_000)
  files.failReads(`${DIR}/-home-dev-blog/locked-4.jsonl`)
  files.write(`${DIR}/-home-dev-blog/notes.txt`, 'ignored', 9_500)
  files.write(`${DIR}/-home-dev-blog/bad id.jsonl`, user('x'), 9_600)
  return { files, refs, src: new ClaudeHistorySource({ dir: DIR, files, refs }) }
}

describe('ClaudeHistorySource', () => {
  it('CH-list: newest first, id/cwd/timestamps/title only; unreadable files skipped', async () => {
    const { src } = setup()
    const all = await src.list({ limit: 10 })
    expect(all.map((p) => p.providerSessionId)).toEqual(['new-2', 'old-1'])
    const [n, o] = all
    expect(n).toMatchObject({ provider: 'claude-code', cwd: '/home/dev/blog', lastSeenAt: 9_000 })
    expect(n!.title.length).toBeLessThanOrEqual(80) // custom title wins and is clipped
    expect(o).toMatchObject({ title: 'Fix the login bug', cwd: SECRET_PATH, lastSeenAt: 1_000 })
    expect(o!.startedAt).toBe(Date.parse(iso(0)))
    expect(o!.transcriptRef).toMatch(/^tr_[a-f0-9]{24}$/)
  })

  it('CH-list: the limit caps the result', async () => {
    const { src } = setup()
    expect(await src.list({ limit: 1 })).toHaveLength(1)
    expect(await src.list({ limit: 0 })).toEqual([])
  })

  it('CH-list: refs page the transcript; nothing but metadata is in the listing (no-leak)', async () => {
    const { src, files, refs } = setup()
    const all = await src.list({ limit: 10 })
    const o = all.find((p) => p.providerSessionId === 'old-1')!
    expect(JSON.stringify(all.map((p) => p.title))).not.toContain(SECRET_TEXT)
    const { transcriptRef: _r, cwd: _c, ...rest } = o
    expect(JSON.stringify(rest)).not.toContain(SECRET_PATH)
    expect(JSON.stringify(rest)).not.toContain(SECRET_TEXT)
    // the ref is what TranscriptReader pages later; the content is read on demand, never copied
    expect(refs.resolve(o.transcriptRef)).toBe(`${DIR}/-home-dev-shop/old-1.jsonl`)
    expect(new ClaudeTranscriptReader({ refs, files })).toBeDefined()
  })

  it('CH-list: falls back to the folder name, then a generic title; honours enabled()', async () => {
    const files = new MemoryTranscriptFiles()
    const refs = new TranscriptRefs()
    files.write(`${DIR}/p/a.jsonl`, user('x', { sessionId: 'a', cwd: '/w/shop' }) + '\n', 1)
    files.write(
      `${DIR}/p/b.jsonl`,
      JSON.stringify({ type: 'summary', timestamp: iso(0) }) + '\n',
      2,
    )
    const on = new ClaudeHistorySource({ dir: DIR, files, refs, enabled: () => true })
    const got = await on.list({ limit: 5 })
    expect(got.find((p) => p.providerSessionId === 'a')!.title).toBe('shop')
    expect(got.find((p) => p.providerSessionId === 'b')!.title).toBe('Claude Code session')
    const off = new ClaudeHistorySource({ dir: DIR, files, refs, enabled: async () => false })
    expect(await off.list({ limit: 5 })).toEqual([])
  })

  it('CH-list: a missing projects dir lists nothing', async () => {
    const src = new ClaudeHistorySource({
      dir: '/nope',
      files: new MemoryTranscriptFiles(),
      refs: new TranscriptRefs(),
    })
    expect(await src.list({ limit: 5 })).toEqual([])
  })
})

historySourceContract('ClaudeHistorySource', async () => {
  const files = new MemoryTranscriptFiles()
  for (const [i, id] of ['a-1', 'b-2', 'c-3'].entries())
    files.write(
      `${DIR}/p/${id}.jsonl`,
      [
        user('SENTINEL-SECRET-123', { sessionId: id, cwd: '/w/x', timestamp: iso(i) }),
        line('ai-title', id, { aiTitle: `Title ${id}` }),
      ].join('\n') + '\n',
      (i + 1) * 1000,
    )
  return {
    source: new ClaudeHistorySource({ dir: DIR, files, refs: new TranscriptRefs() }),
    total: 3,
    secret: 'SENTINEL-SECRET-123',
  }
})
