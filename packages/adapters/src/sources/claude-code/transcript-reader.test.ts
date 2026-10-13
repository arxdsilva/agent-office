import { describe, expect, it } from 'vitest'
import { assistant, iso, user } from './fixtures.ts'
import { ClaudeTranscriptReader } from './transcript-reader.ts'
import { MemoryTranscriptFiles, TranscriptRefs } from './transcript-files.ts'

const SECRET_IN = 'SENTINEL-tool-input-secret'
const SECRET_OUT = 'SENTINEL-tool-output-secret'
const SECRET_THINK = 'SENTINEL-thinking-secret'
const PATH = '/home/dev/SENTINEL-path/x'

function setup(lines: string[]) {
  const files = new MemoryTranscriptFiles()
  const refs = new TranscriptRefs()
  const path = '/h/.claude/projects/p/s.jsonl'
  files.write(path, lines.join('\n') + '\n', 0)
  return { reader: new ClaudeTranscriptReader({ refs, files }), ref: refs.register(path), files }
}
const withId = (line: string, uuid: string, ts = 0) => {
  const d = JSON.parse(line)
  return JSON.stringify({ ...d, uuid, timestamp: iso(ts) })
}

const transcript = () => [
  withId(user('hello there'), 'u1', 1),
  withId(
    assistant([
      { type: 'thinking', thinking: SECRET_THINK },
      { type: 'text', text: 'Reading the file' },
      { type: 'tool_use', name: 'Read', input: { file_path: PATH, secret: SECRET_IN } },
    ]),
    'a1',
    2,
  ),
  withId(user([{ type: 'tool_result', tool_use_id: 't', content: SECRET_OUT }]), 'u2', 3),
  withId(assistant([{ type: 'text', text: 'Done: the answer is 42' }]), 'a2', 4),
  withId(user('side', { isSidechain: true }), 'sc', 5),
  withId(user('meta', { isMeta: true }), 'meta', 6),
  JSON.stringify({ type: 'summary', summary: 'x' }),
  'not json',
  JSON.stringify({ type: 'user', uuid: 'weird', message: { content: 5 } }),
]

describe('ClaudeTranscriptReader', () => {
  it('returns text blocks and tool names only, newest last, and skips the rest', async () => {
    const { reader, ref } = setup(transcript())
    const { messages, more } = await reader.page(ref, { limit: 50 })
    expect(more).toBe(false)
    expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'a2'])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Reading the file',
      tools: ['Read'],
    })
    const all = JSON.stringify(messages)
    for (const s of [SECRET_IN, SECRET_OUT, SECRET_THINK, PATH]) expect(all).not.toContain(s)
  })

  it('pages backwards by uuid', async () => {
    const { reader, ref } = setup(transcript())
    const p1 = await reader.page(ref, { limit: 2 })
    expect(p1.messages.map((m) => m.uuid)).toEqual(['a1', 'a2'])
    expect(p1.more).toBe(true)
    const p2 = await reader.page(ref, { before: 'a1', limit: 2 })
    expect(p2.messages.map((m) => m.uuid)).toEqual(['u1'])
    expect(p2.more).toBe(false)
    expect((await reader.page(ref, { before: 'unknown', limit: 2 })).messages).toEqual([])
  })

  it('caps text at 4000 chars', async () => {
    const { reader, ref } = setup([withId(user('x'.repeat(9000)), 'big')])
    expect((await reader.page(ref, { limit: 1 })).messages[0]!.text).toHaveLength(4000)
  })

  it('searches text only with short snippets', async () => {
    const { reader, ref } = setup([
      ...transcript(),
      withId(
        assistant([{ type: 'text', text: `${'a'.repeat(500)} needle ${'b'.repeat(500)}` }]),
        'long',
      ),
    ])
    expect(await reader.search(ref, 'ANSWER is', 5)).toEqual([
      { uuid: 'a2', snippet: 'Done: the answer is 42' },
    ])
    const [hit] = await reader.search(ref, 'needle', 5)
    expect(hit!.snippet.length).toBeLessThanOrEqual(200)
    expect(hit!.snippet).toContain('needle')
    for (const s of [SECRET_IN, SECRET_OUT, SECRET_THINK])
      expect(await reader.search(ref, s, 5)).toEqual([])
    expect(await reader.search(ref, '', 5)).toEqual([])
    expect(await reader.search(ref, 'e', 1)).toHaveLength(1)
  })

  it('returns nothing for unknown refs and unreadable files', async () => {
    const { reader, ref, files } = setup(transcript())
    expect(await reader.page('tr_unknown', { limit: 5 })).toEqual({ messages: [], more: false })
    files.failReads('/h/.claude/projects/p/s.jsonl')
    expect((await reader.page(ref, { limit: 5 })).messages).toEqual([])
  })
})
