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
      task: 'Find the auth code',
      text: '',
      status: 'tool',
    })
  })

  it('LM-task: every sidechain line carries the same task; tool lines change text/tool only', () => {
    const ctx = newParseContext()
    ctx.meta.set('a1', { agentType: 'Explore', description: 'Map the auth flow' })
    const side = { isSidechain: true, agentId: 'a1' }
    const first = lineToEvent(user('prompt', side), ctx)
    const tool = lineToEvent(
      assistant([{ type: 'tool_use', name: 'Grep', input: { description: 'Search login' } }], side),
      ctx,
    )
    expect(first?.task).toBe('Map the auth flow')
    expect(tool).toMatchObject({ task: 'Map the auth flow', tool: 'Grep', text: 'Search login' })
  })

  it('LM-task: cleans the description (control chars, whitespace) and caps it at 120', () => {
    const ctx = newParseContext()
    ctx.meta.set('a1', { description: `  a\u0000b\n\n  c\t${'x'.repeat(300)}` })
    const e = lineToEvent(user('p', { isSidechain: true, agentId: 'a1' }), ctx)
    expect(e?.task?.length).toBeLessThanOrEqual(120)
    expect(e?.task?.startsWith('ab c x')).toBe(true)
  })

  it('LM-end: a sidechain end_turn / stop_sequence is done + completed; main sessions keep waiting', () => {
    const side = { isSidechain: true, agentId: 'a1' }
    for (const stop of ['end_turn', 'stop_sequence']) {
      expect(
        lineToEvent(assistant([{ type: 'text', text: 'ok' }], side, stop), newParseContext()),
      ).toMatchObject({ status: 'done', ended: 'completed' })
    }
    const main = lineToEvent(
      assistant([{ type: 'text', text: 'ok' }], {}, 'end_turn'),
      newParseContext(),
    )
    expect(main?.status).toBe('waiting')
    expect(main).not.toHaveProperty('ended')
  })

  it('LM-end: a sidechain tool_use or tool error never sets ended', () => {
    const side = { isSidechain: true, agentId: 'a1' }
    const ctx = newParseContext()
    const tool = lineToEvent(
      assistant([{ type: 'tool_use', name: 'Bash', input: {} }], side, 'end_turn'),
      ctx,
    )
    expect(tool?.status).toBe('tool')
    expect(tool).not.toHaveProperty('ended')
    const err = lineToEvent(
      user([{ type: 'tool_result', is_error: true, content: 'boom' }], side),
      ctx,
    )
    expect(err?.text).toBe('tool error')
    expect(err).not.toHaveProperty('ended')
  })

  it('LM-sentinel: the subagent prompt never reaches an event; the task is capped', () => {
    const ctx = newParseContext()
    ctx.meta.set('a1', { agentType: 'Explore', description: 'd'.repeat(300) })
    const side = { isSidechain: true, agentId: 'a1' }
    const events = [
      lineToEvent(user('Please do SECRET_PROMPT_7f3a now', side), ctx),
      lineToEvent(assistant([{ type: 'text', text: 'working' }], side), ctx),
      lineToEvent(assistant([{ type: 'text', text: 'done' }], side, 'end_turn'), ctx),
    ]
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain('SECRET_PROMPT_7f3a')
      expect(e?.task?.length).toBeLessThanOrEqual(120)
    }
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

describe('lineToEvent: AskUserQuestion (invented content)', () => {
  const ask = (id = 'toolu_q1') => ({
    type: 'tool_use',
    id,
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which colour should the banner use?',
          header: 'Banner',
          options: [
            { label: 'Teal', description: 'Matches the logo' },
            { label: 'Amber', description: 'Higher contrast' },
          ],
          multiSelect: false,
        },
      ],
    },
  })
  const QUESTION = {
    prompts: [
      {
        question: 'Which colour should the banner use?',
        header: 'Banner',
        options: [
          { label: 'Teal', description: 'Matches the logo' },
          { label: 'Amber', description: 'Higher contrast' },
        ],
        multiSelect: false,
      },
    ],
  }

  it('LM-q1: a question → waiting with the bounded question; its tool_result clears it', () => {
    const ctx = newParseContext()
    expect(lineToEvent(assistant([ask()]), ctx)).toMatchObject({
      agentId: 'cc:sess-1234abcd',
      status: 'waiting',
      tool: 'AskUserQuestion',
      text: 'Asking you a question',
      question: QUESTION,
    })
    // An unrelated result (a parallel tool) does not clear it.
    const other = lineToEvent(
      user([{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'ok' }], {
        timestamp: iso(1),
      }),
      ctx,
    )
    expect(other && 'question' in other).toBe(false)
    const done = lineToEvent(
      user([{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'User answered: Teal' }], {
        timestamp: iso(2),
      }),
      ctx,
    )
    expect(done).toMatchObject({ status: 'thinking', question: null })
    expect(JSON.stringify(done)).not.toContain('Teal')
    // Cleared once only.
    const later = lineToEvent(
      user([{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'x' }], { timestamp: iso(3) }),
      ctx,
    )
    expect(later && 'question' in later).toBe(false)
  })

  it('LM-q2: a new prompt from the user while a question is pending clears it (abandoned)', () => {
    const ctx = newParseContext()
    lineToEvent(assistant([ask()]), ctx)
    expect(lineToEvent(user('never mind, use teal', { timestamp: iso(1) }), ctx)).toMatchObject({
      question: null,
    })
  })

  it('LM-q3: other tool inputs stay unread next to a question (sentinel never leaks)', () => {
    const ctx = newParseContext()
    const e = lineToEvent(
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_b',
          name: 'Bash',
          input: { command: 'echo SENTINEL-CMD', description: 'SENTINEL-DESC' },
        },
        ask(),
      ]),
      ctx,
    )
    expect(e).toMatchObject({ status: 'waiting', tool: 'AskUserQuestion', question: QUESTION })
    expect(JSON.stringify(e)).not.toMatch(/SENTINEL/)
    // The question block wins even when it is not the last tool_use.
    const f = lineToEvent(
      assistant(
        [
          ask('toolu_q2'),
          {
            type: 'tool_use',
            id: 'toolu_c',
            name: 'Bash',
            input: { command: 'SENTINEL-CMD2', description: 'SENTINEL-DESC2' },
          },
        ],
        {
          timestamp: iso(1),
        },
      ),
      ctx,
    )
    expect(f).toMatchObject({ tool: 'AskUserQuestion', question: QUESTION })
    expect(JSON.stringify(f)).not.toMatch(/SENTINEL/)
  })

  it('LM-q4: an invalid AskUserQuestion input is an ordinary tool event', () => {
    const e = lineToEvent(
      assistant([{ type: 'tool_use', id: 'x', name: 'AskUserQuestion', input: { questions: [] } }]),
      newParseContext(),
    )
    expect(e).toMatchObject({ status: 'tool', tool: 'AskUserQuestion' })
    expect(e && 'question' in e).toBe(false)
  })

  it('LM-q5: a subagent question stays on the child and does not end it', () => {
    const ctx = newParseContext()
    const side = { isSidechain: true, agentId: 'a1' }
    const e = lineToEvent(assistant([ask()], side, 'tool_use'), ctx)
    expect(e).toMatchObject({
      agentId: 'cc:a1',
      parentId: 'cc:sess-1234abcd',
      status: 'waiting',
      question: QUESTION,
    })
    expect(e?.ended).toBeUndefined()
    // The parent's next line does not clear the child's question.
    const p = lineToEvent(user('hello', { timestamp: iso(1) }), ctx)
    expect(p && 'question' in p).toBe(false)
    const c = lineToEvent(
      user([{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'ok' }], {
        ...side,
        timestamp: iso(2),
      }),
      ctx,
    )
    expect(c).toMatchObject({ agentId: 'cc:a1', question: null })
  })
})
