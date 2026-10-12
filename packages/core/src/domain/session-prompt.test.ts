import { describe, expect, it } from 'vitest'
import {
  allowKey,
  composePrompt,
  contextChips,
  MODE_LABELS,
  modeOf,
  summarizeToolRequest,
  toolHint,
} from './session-prompt.ts'

const msg = (o: Partial<Parameters<typeof composePrompt>[0]> = {}) => ({
  text: 'review these',
  context: [],
  use: [],
  ...o,
})

describe('composePrompt', () => {
  it('CP-1 returns the text unchanged without extras', () => {
    expect(composePrompt(msg())).toBe('review these')
  })

  it('CP-2 lists files and folders with absolute paths after a separator', () => {
    const out = composePrompt(
      msg({
        context: [
          {
            kind: 'folder',
            path: '/u/code/shop/src/auth',
            label: 'auth',
            hint: '~/code/shop/src/auth',
          },
          { kind: 'file', path: '/u/code/shop/README.md', label: 'README.md', hint: '~/x' },
        ],
      }),
    )
    expect(out).toBe(
      [
        'review these',
        '',
        '---',
        'Context from agent-office (the user attached these; read them as needed):',
        '- folder: /u/code/shop/src/auth',
        '- file: /u/code/shop/README.md',
      ].join('\n'),
    )
  })

  it('CP-3 names the tools to use', () => {
    const out = composePrompt(
      msg({
        use: [
          { id: 'mcp:claude-in-chrome', label: 'Chrome browser' },
          { id: 'skill:run-office', label: 'run-office' },
          { id: 'shell', label: 'Shell' },
        ],
      }),
    )
    expect(out).toBe(
      'review these\n\n---\nUse these tools for this request: claude-in-chrome (mcp__claude-in-chrome__*), skill run-office, Shell (Bash).',
    )
  })

  it('CP-4 caps at 10 paths and 5 tools', () => {
    const context = Array.from({ length: 12 }, (_, i) => ({
      kind: 'file' as const,
      path: `/p/${i}`,
      label: `${i}`,
      hint: `${i}`,
    }))
    const use = Array.from({ length: 7 }, (_, i) => ({ id: `mcp:s${i}`, label: `s${i}` }))
    const out = composePrompt(msg({ context, use }))
    expect(out.match(/^- file:/gm)).toHaveLength(10)
    expect(out).toContain('s4 (mcp__s4__*)')
    expect(out).not.toContain('s5')
  })
})

describe('toolHint', () => {
  it('covers built-ins, apis and unknown ids', () => {
    expect(toolHint({ id: 'web', label: 'Web' })).toBe('Web (WebFetch, WebSearch)')
    expect(toolHint({ id: 'subagents', label: 'Subagents' })).toBe('Subagents (Task)')
    expect(toolHint({ id: 'api:chat', label: 'Chat' })).toBe('Chat API')
    expect(toolHint({ id: 'weird', label: 'Weird' })).toBe('Weird')
  })
})

describe('contextChips', () => {
  it('turns context and tools into display chips without paths', () => {
    const chips = contextChips(
      msg({
        context: [{ kind: 'folder', path: '/abs/auth', label: 'auth', hint: '~/auth' }],
        use: [{ id: 'mcp:claude-in-chrome', label: 'Chrome browser' }],
      }),
    )
    expect(chips).toEqual([
      { kind: 'folder', label: 'auth', hint: '~/auth' },
      { kind: 'capability', label: 'Chrome browser', hint: 'mcp:claude-in-chrome' },
    ])
    expect(JSON.stringify(chips)).not.toContain('/abs')
  })

  it('returns undefined when there is nothing attached', () => {
    expect(contextChips(msg())).toBeUndefined()
  })
})

describe('summarizeToolRequest', () => {
  const cwd = '/u/code/shop'

  it('SR-1 Bash: first line, capped at 120', () => {
    expect(summarizeToolRequest('Bash', { command: 'pnpm test\necho secret' }, cwd)).toEqual({
      tool: 'Bash',
      summary: 'pnpm test',
    })
    const long = summarizeToolRequest('Bash', { command: 'x'.repeat(300) }, cwd)
    expect(long.summary).toHaveLength(120)
  })

  it('SR-2 Edit: cwd-relative inside, basename outside', () => {
    expect(summarizeToolRequest('Edit', { file_path: '/u/code/shop/src/a.ts' }, cwd).summary).toBe(
      'src/a.ts',
    )
    expect(summarizeToolRequest('Write', { file_path: '/etc/secret/passwd' }, cwd).summary).toBe(
      'passwd',
    )
    expect(summarizeToolRequest('Read', { file_path: 'rel/b.ts' }, cwd).summary).toBe('rel/b.ts')
  })

  it('SR-3 Glob/Grep: the pattern', () => {
    expect(summarizeToolRequest('Glob', { pattern: '**/*.ts' }, cwd).summary).toBe('**/*.ts')
    expect(summarizeToolRequest('Grep', { pattern: 'TODO' }, cwd).summary).toBe('TODO')
  })

  it('SR-4 WebFetch: host only, never the path or query', () => {
    const s = summarizeToolRequest('WebFetch', { url: 'https://example.com/a/b?token=x' }, cwd)
    expect(s.summary).toBe('example.com')
    expect(summarizeToolRequest('WebFetch', { url: 'not a url' }, cwd).summary).toBe('')
  })

  it('SR-5 MCP: server · tool', () => {
    expect(summarizeToolRequest('mcp__claude-in-chrome__navigate', { url: 'x' }, cwd)).toEqual({
      tool: 'MCP',
      summary: 'claude-in-chrome · navigate',
    })
  })

  it('SR-6 unknown tool: name only, control characters stripped', () => {
    expect(summarizeToolRequest('Fancy\u0007Tool', { secret: 'x' }, cwd)).toEqual({
      tool: 'FancyTool',
      summary: '',
    })
    expect(summarizeToolRequest('Bash', null, cwd).summary).toBe('')
  })
})

describe('modeOf', () => {
  it('narrows only known modes', () => {
    expect(modeOf('plan')).toBe('plan')
    expect(modeOf('yolo')).toBeUndefined()
    expect(modeOf(3)).toBeUndefined()
    expect(MODE_LABELS.acceptEdits).toBe('Accept edits')
  })
})

describe('allowKey', () => {
  it('matches Bash by first word, other tools by name', () => {
    expect(allowKey('Bash', { command: '  pnpm test --watch' })).toBe('Bash:pnpm')
    expect(allowKey('Bash', {})).toBe('Bash:')
    expect(allowKey('Edit', { file_path: 'a' })).toBe('Edit')
  })
})
