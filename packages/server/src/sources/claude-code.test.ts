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
import { describe, expect, it } from 'vitest'
import { AgentStore } from '../store.ts'
import { ClaudeCodeSource, lineToEvent, newParseContext } from './claude-code.ts'

// Fixtures mirror the shape of real Claude Code transcripts; all content is invented.
const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString()
const base = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1234abcd',
  cwd: '/home/dev/projects/shop',
  timestamp: iso(),
  isSidechain: false,
  ...over,
})
const assistant = (
  content: unknown[],
  over: Record<string, unknown> = {},
  stop_reason: string | null = null,
) =>
  JSON.stringify({
    type: 'assistant',
    ...base(over),
    message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason },
  })
const user = (content: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', ...base(over), message: { role: 'user', content } })

describe('lineToEvent', () => {
  it('maps tool_use to status tool with the tool name and Bash description', () => {
    const ctx = newParseContext()
    const e = lineToEvent(
      assistant([
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm test', description: 'Run unit tests' },
        },
      ]),
      ctx,
    )
    expect(e).toMatchObject({
      agentId: 'cc:sess-1234abcd',
      provider: 'claude-code',
      source: 'claude-code',
      name: 'shop',
      topic: 'shop',
      model: 'claude-opus-5-5',
      status: 'tool',
      tool: 'Bash',
      text: 'Run unit tests',
      ts: T0,
    })
  })

  it('uses the last tool_use when several are present and truncates long descriptions', () => {
    const e = lineToEvent(
      assistant([
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'tool_use', name: 'Agent', input: { description: 'x'.repeat(200) } },
      ]),
      newParseContext(),
    )
    expect(e?.tool).toBe('Agent')
    expect(e?.text).toHaveLength(80)
  })

  it('maps a final answer (end_turn) to waiting and other text to thinking', () => {
    const ctx = newParseContext()
    expect(
      lineToEvent(assistant([{ type: 'text', text: 'Done!' }], {}, 'end_turn'), ctx),
    ).toMatchObject({
      status: 'waiting',
      text: '',
    })
    expect(lineToEvent(assistant([{ type: 'thinking', thinking: '…' }]), ctx)?.status).toBe(
      'thinking',
    )
  })

  it('maps user prompts and tool results to thinking, flagging tool errors', () => {
    const ctx = newParseContext()
    expect(lineToEvent(user('please fix the bug'), ctx)?.status).toBe('thinking')
    expect(lineToEvent(user([{ type: 'tool_result', content: 'ok' }]), ctx)).toMatchObject({
      status: 'thinking',
      text: '',
    })
    expect(
      lineToEvent(user([{ type: 'tool_result', is_error: true, content: 'boom' }]), ctx)?.text,
    ).toBe('tool error')
  })

  it('remembers session titles; custom-title beats ai-title', () => {
    const ctx = newParseContext()
    lineToEvent(user('hi'), ctx)
    const ai = lineToEvent(
      JSON.stringify({ type: 'ai-title', sessionId: 'sess-1234abcd', aiTitle: 'Fix checkout' }),
      ctx,
    )
    expect(ai).toMatchObject({ agentId: 'cc:sess-1234abcd', topic: 'Fix checkout', ts: T0 })
    lineToEvent(
      JSON.stringify({
        type: 'custom-title',
        sessionId: 'sess-1234abcd',
        customTitle: 'Checkout v2',
      }),
      ctx,
    )
    lineToEvent(
      JSON.stringify({ type: 'ai-title', sessionId: 'sess-1234abcd', aiTitle: 'Later AI title' }),
      ctx,
    )
    expect(lineToEvent(user('again'), ctx)?.topic).toBe('Checkout v2')
  })

  it('holds a title back until the session has a timestamp', () => {
    const ctx = newParseContext()
    expect(
      lineToEvent(JSON.stringify({ type: 'ai-title', sessionId: 's', aiTitle: 'Early' }), ctx),
    ).toBeNull()
    expect(lineToEvent(user('hi', { sessionId: 's' }), ctx)?.topic).toBe('Early')
  })

  it('maps sidechain lines to the subagent with its parent and meta', () => {
    const ctx = newParseContext()
    ctx.meta.set('a1b2c3d4e5', { agentType: 'Explore', description: 'Find the auth code' })
    const e = lineToEvent(
      assistant([{ type: 'tool_use', name: 'Grep', input: {} }], {
        isSidechain: true,
        agentId: 'a1b2c3d4e5',
      }),
      ctx,
    )
    expect(e).toMatchObject({
      agentId: 'cc:a1b2c3d4e5',
      parentId: 'cc:sess-1234abcd',
      name: 'Explore',
      kind: 'Explore',
      text: 'Find the auth code',
      status: 'tool',
    })
  })

  it('names subagents without meta by a short id', () => {
    const e = lineToEvent(
      user('task', { isSidechain: true, agentId: 'a1b2c3d4e5' }),
      newParseContext(),
    )
    expect(e?.name).toBe('sub·a1b2c3')
  })

  it('skips <synthetic> models', () => {
    const line = JSON.stringify({
      type: 'assistant',
      ...base(),
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] },
    })
    expect(lineToEvent(line, newParseContext())?.model).toBeUndefined()
  })

  it('returns null for other line types, bad JSON, or missing sessionId', () => {
    const ctx = newParseContext()
    expect(lineToEvent('{"type":"attachment","sessionId":"s"}', ctx)).toBeNull()
    expect(lineToEvent('not json', ctx)).toBeNull()
    expect(lineToEvent(JSON.stringify({ type: 'user', message: { content: 'x' } }), ctx)).toBeNull()
    expect(lineToEvent('', ctx)).toBeNull()
  })
})

describe('ClaudeCodeSource', () => {
  const opts = { idleAfterMs: 1e12, expireAfterMs: 1e12, doneTtlMs: 1e12, interactiveTtlMs: 1e12 }

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'ao-cc-'))
    const project = join(dir, '-home-dev-projects-shop')
    mkdirSync(project)
    const file = join(project, 'sess-1234abcd.jsonl')
    const store = new AgentStore(opts)
    const src = new ClaudeCodeSource({ dir, store, expireAfterMs: 1e12, now: () => T0 + 1000 })
    return { dir, project, file, store, src }
  }

  it('reads new lines as they are appended, including lines split across reads', async () => {
    const { file, store, src } = fixture()
    writeFileSync(file, user('hi') + '\n')
    await src.tick()
    expect(store.get('cc:sess-1234abcd')?.status).toBe('thinking')

    const line = assistant([{ type: 'tool_use', name: 'Edit', input: {} }], { timestamp: iso(10) })
    appendFileSync(file, line.slice(0, 20))
    await src.tick()
    appendFileSync(file, line.slice(20) + '\n')
    await src.tick()
    expect(store.get('cc:sess-1234abcd')).toMatchObject({ status: 'tool', tool: 'Edit' })
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
    expect(store.get('cc:sess-1234abcd')).toMatchObject({ topic: 'Old title', status: 'waiting' })
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
    expect(store.get('cc:sess-1234abcd')?.tool).toBe('Grep')
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
    expect(store.get('cc:a1b2c3d4e5')).toMatchObject({ name: 'Plan', parentId: 'cc:sess-1234abcd' })
  })

  it('ignores files not modified within the expiry window and survives a missing dir', async () => {
    const { file, store } = fixture()
    writeFileSync(file, user('old') + '\n')
    const old = new Date(T0 - 3_600_000)
    utimesSync(file, old, old)
    const src = new ClaudeCodeSource({
      dir: join(file, '..', '..'),
      store,
      expireAfterMs: 60_000,
      now: () => T0,
    })
    await src.tick()
    expect(store.list()).toEqual([])
    const missing = new ClaudeCodeSource({
      dir: '/definitely/not/here',
      store,
      expireAfterMs: 1,
      now: () => T0,
    })
    await expect(missing.tick()).resolves.toBeUndefined()
  })

  it('drops events older than the expiry window', async () => {
    const { file, store } = fixture()
    writeFileSync(file, user('ancient', { timestamp: iso(-3_600_000) }) + '\n')
    const src = new ClaudeCodeSource({
      dir: join(file, '..', '..'),
      store,
      expireAfterMs: 60_000,
      now: () => T0,
    })
    await src.tick()
    expect(store.list()).toEqual([])
  })

  it('start/stop schedule and cancel polling', async () => {
    const { src } = fixture()
    src.start(10)
    await new Promise((r) => setTimeout(r, 30))
    src.stop()
  })
})
