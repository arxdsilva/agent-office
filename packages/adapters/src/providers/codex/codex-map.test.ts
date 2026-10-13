import { describe, expect, it } from 'vitest'
import {
  approvalToPermission,
  commandHead,
  decisionToCodex,
  elicitationToPermission,
  itemEvent,
  modePreset,
  replySnippet,
  sandboxPolicy,
  turnCompletedEvent,
} from './codex-map.ts'

const SECRET_CMD =
  '/bin/zsh -lc \'curl -H "Authorization: Bearer sk-SENTINEL" https://x.test/u?token=abc > /Users/alice/secret.txt\''

describe('itemEvent', () => {
  it('maps item kinds to status/tool only (no command text, paths or diffs)', () => {
    expect(
      itemEvent({ type: 'reasoning', id: 'r', summary: ['plans /Users/alice'] }, 'started'),
    ).toEqual({
      status: 'thinking',
    })
    const cmd = itemEvent(
      { type: 'commandExecution', id: 'c', command: SECRET_CMD, cwd: '/Users/alice' },
      'started',
    )
    expect(cmd).toEqual({ status: 'tool', tool: 'Bash', target: 'cmd:curl' })
    const edit = itemEvent(
      {
        type: 'fileChange',
        id: 'f',
        changes: [{ path: '/Users/alice/a.ts', diff: '+sk-SENTINEL' }],
      },
      'started',
    )
    expect(edit).toEqual({ status: 'tool', tool: 'Edit' })
    expect(itemEvent({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't' }, 'started')).toEqual({
      status: 'tool',
      tool: 'mcp',
    })
    expect(
      itemEvent({ type: 'webSearch', id: 'w', query: 'alice@example.com' }, 'started'),
    ).toEqual({
      status: 'tool',
      tool: 'WebSearch',
    })
    expect(JSON.stringify([cmd, edit])).not.toMatch(/SENTINEL|alice|token/)
  })

  it('returns to thinking after a tool item and ignores everything else', () => {
    expect(itemEvent({ type: 'commandExecution', id: 'c', command: 'ls' }, 'completed')).toEqual({
      status: 'thinking',
    })
    expect(itemEvent({ type: 'agentMessage', id: 'a', text: 'hi' }, 'started')).toBeUndefined()
    expect(itemEvent({ type: 'agentMessage', id: 'a', text: 'hi' }, 'completed')).toBeUndefined()
    expect(itemEvent({ type: 'userMessage', id: 'u' }, 'started')).toBeUndefined()
    expect(itemEvent({ type: 'reasoning', id: 'r' }, 'completed')).toBeUndefined()
  })
})

describe('commandHead', () => {
  it.each([
    ['git status --porcelain', 'git'],
    ["/bin/zsh -lc 'pnpm test'", 'pnpm'],
    ['bash -c "make check"', 'make'],
    ['/usr/bin/git log', undefined],
    ['FOO=bar node x.js', undefined],
    ['', undefined],
    ['UPPER', undefined],
  ])('%j → %s', (cmd, want) => expect(commandHead(cmd)).toBe(want))
})

describe('turnCompletedEvent', () => {
  it('maps the turn status', () => {
    expect(turnCompletedEvent('completed', 'Done: all tests pass')).toEqual({
      status: 'waiting',
      text: 'Done: all tests pass',
    })
    expect(turnCompletedEvent('completed', '')).toEqual({ status: 'waiting' })
    expect(turnCompletedEvent('interrupted', 'x')).toEqual({ status: 'idle' })
    expect(turnCompletedEvent('failed', 'x')).toEqual({ status: 'error' })
    expect(turnCompletedEvent('inProgress', 'x')).toBeUndefined()
  })

  it('keeps the bubble snippet to 80 characters on one line', () => {
    const s = replySnippet('line one\n' + 'y'.repeat(200))
    expect(s.length).toBeLessThanOrEqual(80)
    expect(s).not.toContain('\n')
  })
})

describe('approvalToPermission', () => {
  it('normalizes a command approval to Bash with the command for the summarizer', () => {
    expect(
      approvalToPermission('command', { command: 'git push' }, undefined, '/work/app'),
    ).toEqual({ tool: 'Bash', input: { command: 'git push' }, cwd: '/work/app' })
    // Older servers leave `command` off the request: fall back to the started item.
    expect(
      approvalToPermission(
        'command',
        { command: null },
        { type: 'commandExecution', id: 'c', command: 'ls' },
        '/w',
      ),
    ).toEqual({ tool: 'Bash', input: { command: 'ls' }, cwd: '/w' })
    expect(approvalToPermission('command', {}, undefined, '/w').input).toEqual({ command: '' })
  })

  it('normalizes a file change to Edit with the first changed path', () => {
    const item = {
      type: 'fileChange',
      id: 'f',
      changes: [
        { path: '/work/app/src/a.ts', diff: '+x', kind: { type: 'update' } },
        { path: '/work/app/b.ts' },
      ],
    }
    expect(approvalToPermission('fileChange', {}, item, '/work/app')).toEqual({
      tool: 'Edit',
      input: { file_path: '/work/app/src/a.ts' },
      cwd: '/work/app',
    })
    expect(approvalToPermission('fileChange', {}, undefined, '/w').input).toEqual({ file_path: '' })
  })
})

describe('elicitationToPermission', () => {
  const tool = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
    threadId: 't',
    serverName: 'agent-office',
    mode: 'form',
    message: 'Allow the agent-office MCP server to run tool "search_memory"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], ...meta },
    ...over,
  })

  it('maps a tool approval from our server to an mcp__ tool without its arguments', () => {
    expect(elicitationToPermission(tool(), 'agent-office', '/w')).toEqual({
      tool: 'mcp__agent-office__search_memory',
      input: {},
      cwd: '/w',
    })
    // `tool_title` wins over the message when present.
    expect(
      elicitationToPermission(
        tool({ message: 'x' }, { tool_title: 'search_memory' }),
        'agent-office',
        '/w',
      )?.tool,
    ).toBe('mcp__agent-office__search_memory')
  })

  it('refuses other servers, other kinds, URL elicitations and odd tool names', () => {
    expect(elicitationToPermission(tool(), undefined, '/w')).toBeUndefined()
    expect(
      elicitationToPermission(tool({ serverName: 'evil' }), 'agent-office', '/w'),
    ).toBeUndefined()
    expect(
      elicitationToPermission(tool({}, { codex_approval_kind: 'other' }), 'agent-office', '/w'),
    ).toBeUndefined()
    expect(elicitationToPermission(tool({ _meta: null }), 'agent-office', '/w')).toBeUndefined()
    expect(elicitationToPermission(tool({ mode: 'url' }), 'agent-office', '/w')).toBeUndefined()
    expect(
      elicitationToPermission(tool({ message: 'run tool "a b; rm -rf /"?' }), 'agent-office', '/w'),
    ).toBeUndefined()
    expect(
      elicitationToPermission(tool({ message: 'no tool' }), 'agent-office', '/w'),
    ).toBeUndefined()
  })
})

describe('decisionToCodex', () => {
  it('never answers acceptForSession', () => {
    expect(decisionToCodex({ behavior: 'allow' })).toBe('accept')
    expect(decisionToCodex({ behavior: 'deny', message: 'no' })).toBe('decline')
    expect(decisionToCodex('cancel')).toBe('cancel')
  })
})

describe('mode presets', () => {
  it('maps the four presets to approval policy and sandbox (docs §5.1)', () => {
    expect(modePreset('read-only')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(modePreset('ask')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    expect(modePreset('auto')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(modePreset('full-access')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    expect(modePreset('nope')).toBeUndefined()
  })

  it('builds the per-turn sandbox policy (extra folders as writable roots)', () => {
    expect(sandboxPolicy('read-only', ['/x'])).toEqual({ type: 'readOnly' })
    expect(sandboxPolicy('workspace-write', [])).toEqual({ type: 'workspaceWrite' })
    expect(sandboxPolicy('workspace-write', ['/x'])).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/x'],
    })
    expect(sandboxPolicy('danger-full-access', [])).toEqual({ type: 'dangerFullAccess' })
  })
})
