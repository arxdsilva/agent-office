import { describe, expect, it } from 'vitest'
import { resolveClaudeExecutable } from './claude-executable.ts'

const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p)

describe('resolveClaudeExecutable', () => {
  const home = '/Users/me'

  it('prefers CLAUDE_CODE_PATH when it exists', () => {
    const exists = only('/custom/claude', '/usr/bin/claude')
    expect(
      resolveClaudeExecutable({
        env: { CLAUDE_CODE_PATH: '/custom/claude', PATH: '/usr/bin' },
        home,
        platform: 'darwin',
        exists,
      }),
    ).toBe('/custom/claude')
  })

  it('ignores a CLAUDE_CODE_PATH that does not exist and searches PATH in order', () => {
    expect(
      resolveClaudeExecutable({
        env: { CLAUDE_CODE_PATH: '/gone', PATH: '/a::/b:/c' },
        home,
        platform: 'linux',
        exists: only('/b/claude', '/c/claude'),
      }),
    ).toBe('/b/claude')
  })

  it('falls back to the usual install locations (GUI apps get a minimal PATH)', () => {
    const at = (p: string) =>
      resolveClaudeExecutable({
        env: { PATH: '/usr/bin' },
        home,
        platform: 'darwin',
        exists: only(p),
      })
    expect(at('/Users/me/.local/bin/claude')).toBe('/Users/me/.local/bin/claude')
    expect(at('/Users/me/.claude/local/claude')).toBe('/Users/me/.claude/local/claude')
    expect(at('/opt/homebrew/bin/claude')).toBe('/opt/homebrew/bin/claude')
    expect(at('/usr/local/bin/claude')).toBe('/usr/local/bin/claude')
  })

  it('uses claude.exe, ; separators and %LOCALAPPDATA% on Windows', () => {
    const win = (exists: (p: string) => boolean, env: Record<string, string> = {}) =>
      resolveClaudeExecutable({
        env: { Path: 'C:\\tools;C:\\bin', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ...env },
        home: 'C:\\Users\\me',
        platform: 'win32',
        exists,
      })
    expect(win(only('C:\\bin\\claude.exe'))).toBe('C:\\bin\\claude.exe')
    expect(win(only('C:\\Users\\me\\.local\\bin\\claude.exe'))).toBe(
      'C:\\Users\\me\\.local\\bin\\claude.exe',
    )
    expect(win(only('C:\\Users\\me\\AppData\\Local\\Programs\\claude\\claude.exe'))).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\claude\\claude.exe',
    )
  })

  it('returns undefined when nothing is found', () => {
    expect(
      resolveClaudeExecutable({ env: {}, home, platform: 'darwin', exists: () => false }),
    ).toBeUndefined()
  })
})
