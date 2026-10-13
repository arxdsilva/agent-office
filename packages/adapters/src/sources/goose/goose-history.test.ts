import { describe, expect, it } from 'vitest'
import { GOOSE_ID, GooseHistorySource, GooseTranscriptReader } from './goose-history.ts'
import type { GooseCli } from './goose-cli.ts'
import { nodeGooseCli } from './goose-cli.ts'

// Shaped like `goose session list --format json` (1.54.0) with invented content.
const row = (over: Record<string, unknown> = {}) => ({
  id: '20260101_1',
  working_dir: '/work/shop',
  name: 'Invented task: list files',
  user_set_name: false,
  session_type: 'user',
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-01-01T10:05:00Z',
  message_count: 2,
  last_message_at: '2026-01-01T10:04:00Z',
  archived_at: null,
  ...over,
})
const cliOf =
  (out: string, calls: string[][] = []): GooseCli =>
  async (args) => {
    calls.push(args)
    return out
  }
const failing: GooseCli = async () => {
  throw new Error('goose failed')
}

describe('GooseHistorySource', () => {
  it('GH-list: maps sessions to metadata with a tr_go_ ref, newest first', async () => {
    const calls: string[][] = []
    const src = new GooseHistorySource({
      cli: cliOf(
        JSON.stringify([
          row({ id: '20260101_1' }),
          row({ id: '20260102_1', name: 'x'.repeat(200), last_message_at: '2026-01-02T00:00:00Z' }),
        ]),
        calls,
      ),
    })
    const past = await src.list({ limit: 5 })
    expect(calls).toEqual([['session', 'list', '--format', 'json', '--limit', '5']])
    expect(past.map((p) => p.providerSessionId)).toEqual(['20260102_1', '20260101_1'])
    expect(past[1]).toEqual({
      provider: 'goose',
      providerSessionId: '20260101_1',
      transcriptRef: 'tr_go_20260101_1',
      cwd: '/work/shop',
      title: 'Invented task: list files',
      startedAt: Date.parse('2026-01-01T10:00:00Z'),
      lastSeenAt: Date.parse('2026-01-01T10:04:00Z'),
    })
    expect(past[0]!.title.length).toBeLessThanOrEqual(80)
  })

  it('GH-list: skips archived, malformed and unsafe ids; honours the limit', async () => {
    const src = new GooseHistorySource({
      cli: cliOf(
        JSON.stringify([
          row({ id: 'a1' }),
          row({ id: 'a2', archived_at: '2026-02-01T00:00:00Z' }),
          row({ id: '--evil' }),
          row({ id: 'has space' }),
          { name: 'no id' },
          'junk',
          row({ id: 'a3' }),
          row({ id: 'a4' }),
        ]),
      ),
    })
    expect((await src.list({ limit: 2 })).map((p) => p.providerSessionId).sort()).toEqual([
      'a1',
      'a3',
    ])
  })

  it('GH-list: nothing when disabled, missing, unreadable or not a list', async () => {
    expect(await new GooseHistorySource({ cli: failing }).list({ limit: 5 })).toEqual([])
    expect(await new GooseHistorySource({ cli: cliOf('not json') }).list({ limit: 5 })).toEqual([])
    expect(await new GooseHistorySource({ cli: cliOf('{}') }).list({ limit: 5 })).toEqual([])
    const off = new GooseHistorySource({
      cli: cliOf(JSON.stringify([row()])),
      enabled: () => false,
    })
    expect(await off.list({ limit: 5 })).toEqual([])
    expect(await new GooseHistorySource({ cli: cliOf('[]') }).list({ limit: 0 })).toEqual([])
  })

  it('GH-list: falls back to updated_at and a default title', async () => {
    const src = new GooseHistorySource({
      cli: cliOf(JSON.stringify([row({ last_message_at: undefined, name: undefined })])),
    })
    const [p] = await src.list({ limit: 1 })
    expect(p).toMatchObject({
      title: 'goose session',
      lastSeenAt: Date.parse('2026-01-01T10:05:00Z'),
    })
  })

  it('GH-id: ids never start with a dash or carry spaces', () => {
    expect(GOOSE_ID.test('20260101_1')).toBe(true)
    expect(GOOSE_ID.test('-x')).toBe(false)
    expect(GOOSE_ID.test('a b')).toBe(false)
  })
})

describe('GooseTranscriptReader', () => {
  const doc = {
    id: '20260101_1',
    working_dir: '/secret/home/me',
    conversation: [
      {
        id: 'm1',
        role: 'user',
        created: 1767261600,
        content: [{ type: 'text', text: 'Invented question' }],
      },
      {
        id: 'm2',
        role: 'assistant',
        created: 1767261605,
        content: [
          { type: 'text', text: 'Invented answer about pnpm' },
          {
            type: 'toolRequest',
            id: 't1',
            toolCall: { value: { name: 'developer__shell', arguments: { command: 'ls /secret' } } },
          },
          { type: 'toolResponse', id: 't1', toolResult: { value: [{ text: 'SECRET OUTPUT' }] } },
          { type: 'thinking', thinking: 'secret thought' },
        ],
      },
      {
        id: 'm3',
        role: 'assistant',
        created: 1,
        content: [{ type: 'text', text: 'hidden' }],
        metadata: { userVisible: false },
      },
      { id: 'm4', role: 'system', created: 1, content: [{ type: 'text', text: 'system' }] },
      { id: 'm5', role: 'assistant', created: 1, content: [{ type: 'image' }] },
    ],
  }

  it('GT-page: text blocks and tool names only, newest last', async () => {
    const calls: string[][] = []
    const r = new GooseTranscriptReader({ cli: cliOf(JSON.stringify(doc), calls) })
    const page = await r.page('tr_go_20260101_1', { limit: 10 })
    expect(calls).toEqual([['session', 'export', '--session-id=20260101_1', '--format', 'json']])
    expect(page).toEqual({
      more: false,
      messages: [
        { uuid: 'm1', role: 'user', text: 'Invented question', ts: 1767261600000, tools: [] },
        {
          uuid: 'm2',
          role: 'assistant',
          text: 'Invented answer about pnpm',
          ts: 1767261605000,
          tools: ['developer__shell'],
        },
      ],
    })
    expect(JSON.stringify(page)).not.toMatch(/secret|SECRET|ls \//i)
  })

  it('GT-page: paging with before and more', async () => {
    const r = new GooseTranscriptReader({ cli: cliOf(JSON.stringify(doc)) })
    expect((await r.page('tr_go_20260101_1', { limit: 1 })).messages.map((m) => m.uuid)).toEqual([
      'm2',
    ])
    const older = await r.page('tr_go_20260101_1', { before: 'm2', limit: 5 })
    expect(older.messages.map((m) => m.uuid)).toEqual(['m1'])
    expect((await r.page('tr_go_20260101_1', { before: 'nope', limit: 5 })).messages).toEqual([])
  })

  it('GT-search: finds a snippet; empty queries and limits find nothing', async () => {
    const r = new GooseTranscriptReader({ cli: cliOf(JSON.stringify(doc)) })
    const hits = await r.search('tr_go_20260101_1', 'PNPM', 5)
    expect(hits).toEqual([{ uuid: 'm2', snippet: expect.stringContaining('pnpm') }])
    expect(await r.search('tr_go_20260101_1', '  ', 5)).toEqual([])
    expect(await r.search('tr_go_20260101_1', 'pnpm', 0)).toEqual([])
  })

  it('GT-ref: foreign or unsafe refs never reach the CLI; a failing CLI reads as empty', async () => {
    const calls: string[][] = []
    const r = new GooseTranscriptReader({ cli: cliOf('{}', calls) })
    for (const ref of ['tr_abc', 'tr_go_--evil', 'tr_go_', 'tr_go_a b'])
      expect(await r.page(ref, { limit: 5 })).toEqual({ messages: [], more: false })
    expect(calls).toEqual([])
    const bad = new GooseTranscriptReader({ cli: failing })
    expect(await bad.page('tr_go_20260101_1', { limit: 5 })).toEqual({ messages: [], more: false })
    const junk = new GooseTranscriptReader({ cli: cliOf('nope') })
    expect((await junk.page('tr_go_1', { limit: 5 })).messages).toEqual([])
  })
})

describe('nodeGooseCli', () => {
  it('runs a binary without a shell and rejects on failure', async () => {
    const ok = nodeGooseCli({ bin: process.execPath })
    expect(await ok(['-e', 'process.stdout.write("hi")'])).toBe('hi')
    await expect(ok(['-e', 'process.exit(3)'])).rejects.toThrow('goose failed')
    await expect(nodeGooseCli({ bin: '/no/such/goose' })(['x'])).rejects.toThrow()
  })
})
