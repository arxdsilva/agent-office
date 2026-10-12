import { posix, win32 } from 'node:path'

export interface ResolveClaudeOptions {
  env: Record<string, string | undefined>
  home: string
  platform: string
  /** Injected so the lookup stays pure (fs.existsSync in production). */
  exists: (path: string) => boolean
}

/**
 * Finds an installed Claude Code CLI for packaged builds (which ship without the SDK's bundled
 * binary). Order: CLAUDE_CODE_PATH, each PATH entry, then the usual install locations (GUI apps
 * often start with a minimal PATH). undefined → leave the SDK option unset.
 */
export function resolveClaudeExecutable(o: ResolveClaudeOptions): string | undefined {
  const win = o.platform === 'win32'
  const path = win ? win32 : posix
  const bin = win ? 'claude.exe' : 'claude'
  const explicit = o.env.CLAUDE_CODE_PATH
  if (explicit && o.exists(explicit)) return explicit
  const pathVar = o.env.PATH ?? o.env.Path ?? ''
  const dirs = pathVar.split(win ? ';' : ':').filter(Boolean)
  const local = o.env.LOCALAPPDATA
  const fallback = win
    ? [
        path.join(o.home, '.local', 'bin'),
        path.join(o.home, '.claude', 'local'),
        ...(local
          ? [path.join(local, 'Programs', 'claude'), path.join(local, 'AnthropicClaude')]
          : []),
      ]
    : [
        path.join(o.home, '.local', 'bin'),
        path.join(o.home, '.claude', 'local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]
  for (const dir of [...dirs, ...fallback]) {
    const candidate = path.join(dir, bin)
    if (o.exists(candidate)) return candidate
  }
  return undefined
}
