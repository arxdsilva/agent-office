import { describe, expect, it } from 'vitest'
import { lineToEvent, newParseContext } from './line-mapper.ts'
import { assistant, base, iso, T0, user } from './fixtures.ts'

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

  it('takes the permission mode from user lines, ignoring unknown values and sidechains (LM-mode)', () => {
    const ctx = newParseContext()
    expect(lineToEvent(user('plan it', { permissionMode: 'plan' }), ctx)?.permissionMode).toBe(
      'plan',
    )
    expect(lineToEvent(user('go', { permissionMode: 'yolo' }), ctx)).not.toHaveProperty(
      'permissionMode',
    )
    expect(lineToEvent(user('go', { permissionMode: 42 }), ctx)).not.toHaveProperty(
      'permissionMode',
    )
    expect(lineToEvent(user('go'), ctx)).not.toHaveProperty('permissionMode')
    const sub = lineToEvent(
      user('task', { isSidechain: true, agentId: 'a1b2c3d4e5', permissionMode: 'plan' }),
      ctx,
    )
    expect(sub?.agentId).toBe('cc:a1b2c3d4e5')
    expect(sub).not.toHaveProperty('permissionMode')
    expect(
      lineToEvent(assistant([{ type: 'text', text: 'hi' }], { permissionMode: 'plan' }), ctx),
    ).not.toHaveProperty('permissionMode')
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
