import { describe, expect, it } from 'vitest'
import {
  chooseOption,
  DEFAULT_TOOL_KINDS,
  messageChunk,
  modelChoice,
  modeChoice,
  permissionRequest,
  replySnippet,
  shortModeId,
  stopReasonOutcome,
  toolName,
  updateEvent,
} from './acp-map.ts'

const SECRET = '/Users/alice/secret-project/.env'

describe('toolName', () => {
  it('maps every ACP tool kind through the default map', () => {
    expect(toolName('read')).toBe('Read')
    expect(toolName('edit')).toBe('Edit')
    expect(toolName('delete')).toBe('Edit')
    expect(toolName('move')).toBe('Edit')
    expect(toolName('search')).toBe('Grep')
    expect(toolName('execute')).toBe('Bash')
    expect(toolName('fetch')).toBe('WebFetch')
    expect(toolName('other')).toBe('Tool')
    expect(DEFAULT_TOOL_KINDS.think).toBeUndefined()
  })

  it('thinks for think, falls back to Tool for unknown or missing kinds', () => {
    expect(toolName('think')).toBeUndefined()
    expect(toolName('switch_mode')).toBe('Tool')
    expect(toolName(undefined)).toBe('Tool')
    expect(toolName(42)).toBe('Tool')
  })

  it('lets a profile override kinds', () => {
    expect(toolName('fetch', { fetch: 'WebSearch' })).toBe('WebSearch')
    expect(toolName('read', { fetch: 'WebSearch' })).toBe('Read')
  })
})

describe('updateEvent', () => {
  it('thought chunks and plans are thinking, with no text forwarded', () => {
    const t = updateEvent({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: `secret thought ${SECRET}` },
    })
    expect(t).toEqual({ status: 'thinking' })
    const p = updateEvent({
      sessionUpdate: 'plan',
      entries: [{ content: `plan ${SECRET}`, priority: 'high', status: 'pending' }],
    })
    expect(p).toEqual({ status: 'thinking' })
  })

  it('a tool call becomes a tool event; the raw title and input never leave', () => {
    const e = updateEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: `cat ${SECRET}`,
      kind: 'execute',
      rawInput: { command: `cat ${SECRET}` },
      locations: [{ path: SECRET }],
    })
    expect(e).toEqual({ status: 'tool', tool: 'Bash' })
    expect(JSON.stringify(e)).not.toContain('secret')
  })

  it('a think tool call is thinking', () => {
    expect(
      updateEvent({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind: 'think' }),
    ).toEqual({
      status: 'thinking',
    })
  })

  it('tool updates: completed/failed are thinking, in-progress is nothing', () => {
    expect(
      updateEvent({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' }),
    ).toEqual({
      status: 'thinking',
    })
    expect(
      updateEvent({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed' }),
    ).toEqual({
      status: 'thinking',
    })
    expect(
      updateEvent({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' }),
    ).toBeUndefined()
  })

  it('a mode update is not a status patch (the runner reports modeId)', () => {
    expect(
      updateEvent({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
    ).toBeUndefined()
  })

  it('shortModeId maps native ids back to profile ids', () => {
    const modes = [{ id: 'agent', label: 'Agent', native: 'https://x/session-modes#agent' }]
    expect(shortModeId('https://x/session-modes#agent', modes)).toBe('agent')
    expect(shortModeId('zzz', modes)).toBeUndefined()
    expect(shortModeId('plan', undefined)).toBe('plan')
    expect(shortModeId('x'.repeat(61), undefined)).toBeUndefined()
  })

  it('message chunks, unknown kinds and garbage map to nothing', () => {
    expect(
      updateEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
    ).toBeUndefined()
    expect(
      updateEvent({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    ).toBeUndefined()
    expect(updateEvent({ sessionUpdate: 'usage_update' })).toBeUndefined()
    expect(updateEvent(null)).toBeUndefined()
    expect(updateEvent('x')).toBeUndefined()
  })
})

describe('messageChunk', () => {
  it('returns text and message id of agent message chunks only', () => {
    expect(
      messageChunk({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
        messageId: 'm1',
      }),
    ).toEqual({ text: 'hi', messageId: 'm1' })
    expect(
      messageChunk({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
    ).toEqual({
      text: 'hi',
    })
    expect(
      messageChunk({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }),
    ).toBeUndefined()
    expect(
      messageChunk({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'me' } }),
    ).toBeUndefined()
    expect(messageChunk(undefined)).toBeUndefined()
  })
})

describe('replySnippet', () => {
  it('is one line of at most 80 characters', () => {
    expect(replySnippet('  a\n b  ')).toBe('a b')
    const s = replySnippet('x'.repeat(200))
    expect(s.length).toBe(80)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('stopReasonOutcome', () => {
  it('end_turn → waiting with a snippet and the reply as result', () => {
    expect(stopReasonOutcome('end_turn', 'All done.')).toEqual({
      event: { status: 'waiting', text: 'All done.' },
      result: { text: 'All done.', isError: false },
    })
    expect(stopReasonOutcome('end_turn', '')).toEqual({
      event: { status: 'waiting' },
      result: { text: '', isError: false },
    })
  })

  it('cancelled → idle, refusal → error, limits → waiting', () => {
    expect(stopReasonOutcome('cancelled', 'part')).toEqual({
      event: { status: 'idle' },
      result: { text: '', isError: false },
    })
    expect(stopReasonOutcome('refusal', '')).toEqual({
      event: { status: 'error' },
      result: { text: '', isError: true },
    })
    expect(stopReasonOutcome('max_tokens', 'long')).toEqual({
      event: { status: 'waiting', text: 'long' },
      result: { text: 'long', isError: false },
    })
    expect(stopReasonOutcome('max_turn_requests', '').event).toEqual({ status: 'waiting' })
    expect(stopReasonOutcome('something_new', 'x').event).toEqual({ status: 'waiting', text: 'x' })
  })

  it('caps the reply at 4000 characters', () => {
    expect(stopReasonOutcome('end_turn', 'y'.repeat(5000)).result.text.length).toBe(4000)
  })
})

describe('permissionRequest', () => {
  const cwd = '/work/app'
  it('Bash: command from rawInput only, never the title', () => {
    const p = permissionRequest(
      {
        sessionId: 's',
        toolCall: {
          toolCallId: 't',
          kind: 'execute',
          title: `run ${SECRET}`,
          rawInput: { command: 'ls -la' },
        },
        options: [],
      },
      cwd,
    )
    expect(p).toEqual({ tool: 'Bash', input: { command: 'ls -la' }, cwd })
  })

  it('Bash: an argv array is joined; no command at all gives an empty one', () => {
    const argv = permissionRequest(
      {
        toolCall: { toolCallId: 't', kind: 'execute', rawInput: { command: ['git', 'status'] } },
        options: [],
      },
      cwd,
    )
    expect(argv.input).toEqual({ command: 'git status' })
    const none = permissionRequest(
      { toolCall: { toolCallId: 't', kind: 'execute', title: SECRET }, options: [] },
      cwd,
    )
    expect(none.input).toEqual({ command: '' })
  })

  it('Edit/Read: every location in file_paths, file_path = the first', () => {
    const e = permissionRequest(
      {
        toolCall: {
          toolCallId: 't',
          kind: 'edit',
          locations: [{ path: '/work/app/a.ts' }, { path: '/b' }],
        },
        options: [],
      },
      cwd,
    )
    expect(e).toEqual({
      tool: 'Edit',
      input: { file_path: '/work/app/a.ts', file_paths: ['/work/app/a.ts', '/b'] },
      cwd,
    })
    const r = permissionRequest({ toolCall: { toolCallId: 't', kind: 'read' }, options: [] }, cwd)
    expect(r).toEqual({ tool: 'Read', input: { file_path: '', file_paths: [] }, cwd })
    const junk = permissionRequest(
      {
        toolCall: { toolCallId: 't', kind: 'edit', locations: [null, { path: 3 }, { path: '/c' }] },
        options: [],
      },
      cwd,
    )
    expect(junk.input).toEqual({ file_path: '/c', file_paths: ['/c'] })
  })

  it('Grep/WebFetch keep only the field the summary shows; other tools get no input', () => {
    expect(
      permissionRequest(
        {
          toolCall: {
            toolCallId: 't',
            kind: 'search',
            rawInput: { pattern: 'TODO', path: SECRET },
          },
          options: [],
        },
        cwd,
      ).input,
    ).toEqual({ pattern: 'TODO' })
    expect(
      permissionRequest(
        {
          toolCall: {
            toolCallId: 't',
            kind: 'fetch',
            rawInput: { url: 'https://example.com/a?b' },
          },
          options: [],
        },
        cwd,
      ).input,
    ).toEqual({ url: 'https://example.com/a?b' })
    expect(
      permissionRequest(
        { toolCall: { toolCallId: 't', kind: 'other', rawInput: { x: SECRET } }, options: [] },
        cwd,
      ),
    ).toEqual({ tool: 'Tool', input: {}, cwd })
  })

  it('uses the kind of the earlier tool_call when the request has none', () => {
    const p = permissionRequest(
      { toolCall: { toolCallId: 't9', rawInput: { command: 'pwd' } }, options: [] },
      cwd,
      { knownKind: 'execute' },
    )
    expect(p.tool).toBe('Bash')
  })

  it('a think request is a generic Tool, and garbage gives a safe Tool', () => {
    expect(
      permissionRequest({ toolCall: { toolCallId: 't', kind: 'think' }, options: [] }, cwd).tool,
    ).toBe('Tool')
    expect(permissionRequest(null, cwd)).toEqual({ tool: 'Tool', input: {}, cwd })
  })
})

describe('chooseOption', () => {
  const all = [
    { optionId: 'aa', name: 'Always', kind: 'allow_always' },
    { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
    { optionId: 'ra', name: 'Never', kind: 'reject_always' },
  ]
  const sel = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } })
  const cancelled = { outcome: { outcome: 'cancelled' } }

  it('allow → allow_once; deny → reject_once; cancel → cancelled', () => {
    expect(chooseOption(all, { behavior: 'allow' })).toEqual(sel('a1'))
    expect(chooseOption(all, { behavior: 'deny', message: 'no' })).toEqual(sel('r1'))
    expect(chooseOption(all, 'cancel')).toEqual(cancelled)
  })

  it('never picks allow_always: with only that option, allow becomes a reject', () => {
    const onlyAlways = [all[0]!, all[3]!]
    expect(chooseOption(onlyAlways, { behavior: 'allow' })).toEqual(sel('ra'))
    expect(chooseOption([all[0]!], { behavior: 'allow' })).toEqual(cancelled)
  })

  it('allow falls back to another allow kind that is not allow_always', () => {
    const odd = [{ optionId: 'x', name: 'Yes', kind: 'allow_session' }, all[0]!]
    expect(chooseOption(odd, { behavior: 'allow' })).toEqual(sel('x'))
  })

  it('deny falls back to reject_always, then cancelled', () => {
    expect(chooseOption([all[1]!, all[3]!], { behavior: 'deny', message: 'n' })).toEqual(sel('ra'))
    expect(chooseOption([all[1]!], { behavior: 'deny', message: 'n' })).toEqual(cancelled)
    expect(chooseOption('garbage', { behavior: 'deny', message: 'n' })).toEqual(cancelled)
  })
})

describe('modelChoice', () => {
  it('prefers a model config option (stable API) and flattens groups', () => {
    const c = modelChoice({
      configOptions: [
        { id: 'mode', category: 'mode', type: 'select', currentValue: 'agent', options: [] },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'auto',
          options: [
            {
              group: 'g',
              name: 'G',
              options: [{ value: 'auto', name: 'Auto', description: 'Pick one' }],
            },
            { group: 'h', name: 'H', options: [{ value: 'big', name: 'Big' }] },
          ],
        },
      ],
      models: { currentModelId: 'x', availableModels: [{ modelId: 'x', name: 'X' }] },
    })
    expect(c).toEqual({
      via: 'config',
      configId: 'model',
      models: [
        { id: 'auto', label: 'Auto', description: 'Pick one' },
        { id: 'big', label: 'Big' },
      ],
    })
  })

  it('falls back to the session models (session/set_model), else none', () => {
    expect(
      modelChoice({
        models: {
          currentModelId: 'x',
          availableModels: [{ modelId: 'x', name: 'X', description: 'd' }],
        },
      }),
    ).toEqual({ via: 'set_model', models: [{ id: 'x', label: 'X', description: 'd' }] })
    expect(modelChoice({ sessionId: 's' })).toBeUndefined()
    expect(modelChoice({ models: { availableModels: [] } })).toBeUndefined()
    expect(modelChoice(null)).toBeUndefined()
  })
})

describe('modeChoice', () => {
  it('reads the stable modes field', () => {
    expect(
      modeChoice({ modes: { currentModeId: 'a', availableModes: [{ id: 'a' }, { id: 'b' }, {}] } }),
    ).toEqual({ ids: ['a', 'b'], current: 'a' })
    expect(modeChoice({ modes: {} })).toEqual({ ids: [] })
  })

  it('falls back to a "mode" select config option (OpenCode 1.19, Kilo 7.8)', () => {
    const configOptions = [
      { id: 'model', category: 'model', type: 'select', options: [{ value: 'm' }] },
      {
        id: 'mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [{ value: 'build' }, { value: 'plan' }, { name: 'no value' }],
      },
    ]
    expect(modeChoice({ configOptions })).toEqual({
      ids: ['build', 'plan'],
      current: 'build',
      configId: 'mode',
    })
    expect(
      modeChoice({ configOptions: [{ id: 'mode', category: 'mode', type: 'select' }] }),
    ).toEqual({ ids: [], configId: 'mode' })
  })

  it('has no modes otherwise', () => {
    expect(modeChoice(undefined)).toEqual({ ids: [] })
    expect(modeChoice({ configOptions: [{ category: 'mode', type: 'select' }] })).toEqual({
      ids: [],
    })
  })
})
