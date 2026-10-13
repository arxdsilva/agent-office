import { describe, expect, it } from 'vitest'
import { HttpError } from '../common/http/http-json.ts'
import type { OpenCodeServerAccess } from './opencode-history.ts'
import { OpenCodeTranscriptReader } from './opencode-transcripts.ts'

const SENTINEL_PATH = '/Users/alice/.ssh/id_ed25519'
const SENTINEL_OUT = 'TOOL-OUTPUT-CANARY sk-live-1234567890'
const SENTINEL_THINK = 'REASONING-CANARY'

const msg = (id: string, role: 'user' | 'assistant', created: number, parts: unknown[]) => ({
  info: { id, role, sessionID: 'ses_a', time: { created } },
  parts,
})
const MESSAGES = [
  msg('msg_2', 'assistant', 200, [
    { type: 'reasoning', text: SENTINEL_THINK },
    { type: 'text', text: 'I will read the key file.' },
    {
      type: 'tool',
      tool: 'read',
      callID: 'c1',
      state: { status: 'completed', input: { filePath: SENTINEL_PATH }, output: SENTINEL_OUT },
    },
    { type: 'tool', tool: 'mcp_weird name;rm', state: { status: 'completed' } },
    { type: 'step-finish', tokens: {} },
  ]),
  msg('msg_1', 'user', 100, [
    { type: 'text', text: 'please look' },
    { type: 'text', text: 'injected context', synthetic: true },
    { type: 'file', url: `file://${SENTINEL_PATH}` },
  ]),
  msg('msg_3', 'assistant', 300, [{ type: 'text', text: 'y'.repeat(5000) }]),
  msg('msg_4', 'assistant', 400, [{ type: 'step-start' }]),
  { info: { id: 'bad' }, parts: [] },
  msg('msg_5', 'user', 500, [{ type: 'text', text: 'Find the deploy notes' }]),
]

function access(): OpenCodeServerAccess {
  return {
    use: (fn) => fn({ baseUrl: 'http://127.0.0.1:9', headers: { authorization: 'Basic x' } }),
  }
}

const fakeFetch = (data: unknown, seen: string[] = []) =>
  (async (url: string | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(url)} ${JSON.stringify(init?.headers ?? {})}`)
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

const reader = (data: unknown, seen?: string[]) =>
  new OpenCodeTranscriptReader({ servers: access(), fetch: fakeFetch(data, seen) })

describe('OpenCodeTranscriptReader', () => {
  it('pages text parts and tool names only, chronologically, ≤ 4000 chars', async () => {
    const seen: string[] = []
    const r = reader(MESSAGES, seen)
    const page = await r.page('tr_oc_ses_a', { limit: 10 })
    expect(page.more).toBe(false)
    expect(page.messages.map((m) => m.uuid)).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_5'])
    expect(page.messages[0]).toEqual({
      uuid: 'msg_1',
      role: 'user',
      text: 'please look',
      ts: 100,
      tools: [],
    })
    expect(page.messages[1]).toEqual({
      uuid: 'msg_2',
      role: 'assistant',
      text: 'I will read the key file.',
      ts: 200,
      tools: ['Read'],
    })
    expect(page.messages[2]!.text).toHaveLength(4000)
    // Sentinels: no paths, tool input/output, reasoning or synthetic text.
    const all = JSON.stringify(page)
    for (const s of [SENTINEL_PATH, SENTINEL_OUT, SENTINEL_THINK, 'injected context', 'rm'])
      expect(all).not.toContain(s)
    // One read-only GET of the session's messages, with the server's auth header.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^GET http:\/\/127\.0\.0\.1:9\/session\/ses_a\/message /)
    expect(seen[0]).toContain('Basic x')
  })

  it('pages backwards with before/limit', async () => {
    const r = reader(MESSAGES)
    const last = await r.page('tr_oc_ses_a', { limit: 2 })
    expect(last.messages.map((m) => m.uuid)).toEqual(['msg_3', 'msg_5'])
    expect(last.more).toBe(true)
    const prev = await r.page('tr_oc_ses_a', { limit: 2, before: 'msg_3' })
    expect(prev.messages.map((m) => m.uuid)).toEqual(['msg_1', 'msg_2'])
    expect(prev.more).toBe(false)
    expect((await r.page('tr_oc_ses_a', { limit: 2, before: 'msg_unknown' })).messages).toEqual([])
  })

  it('searches message text', async () => {
    const r = reader(MESSAGES)
    expect(await r.search('tr_oc_ses_a', 'DEPLOY', 5)).toEqual([
      { uuid: 'msg_5', snippet: 'Find the deploy notes' },
    ])
    expect(await r.search('tr_oc_ses_a', '  ', 5)).toEqual([])
    expect(await r.search('tr_oc_ses_a', 'y', 0)).toEqual([])
    const long = await r.search('tr_oc_ses_a', 'yyy', 1)
    expect(long[0]!.snippet.length).toBeLessThanOrEqual(200)
  })

  it('reads nothing for foreign or malformed refs and on server errors', async () => {
    const seen: string[] = []
    const r = reader(MESSAGES, seen)
    for (const ref of ['tr_abc', 'tr_go_ses_a', 'tr_oc_../../x'])
      expect(await r.page(ref, { limit: 5 })).toEqual({ messages: [], more: false })
    expect(seen).toEqual([])
    const failing = new OpenCodeTranscriptReader({
      servers: { use: () => Promise.reject(new HttpError('network')) },
    })
    expect(await failing.page('tr_oc_ses_a', { limit: 5 })).toEqual({ messages: [], more: false })
    expect(await reader({ not: 'an array' }).page('tr_oc_ses_a', { limit: 5 })).toEqual({
      messages: [],
      more: false,
    })
  })
})
