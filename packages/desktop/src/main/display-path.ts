type PlatformPath = typeof nodePath.posix
import * as nodePath from 'node:path'

/**
 * A path safe to show in the renderer: NEVER absolute.
 * Inside home -> `~/…`; elsewhere the last two segments prefixed with `…/`; root or empty -> `…`.
 */
export function displayPathOf(path: string, home: string, p: PlatformPath = nodePath): string {
  const norm = (s: string) => (p.sep === '\\' ? s.toLowerCase() : s)
  if (home && path !== home && norm(path).startsWith(norm(home.replace(/[\\/]+$/, '')) + p.sep)) {
    return `~${path.slice(home.replace(/[\\/]+$/, '').length)}`
  }
  if (path === home && home) return '~'
  const parts = path.split(/[\\/]+/).filter((s) => s && !/^[A-Za-z]:$/.test(s))
  if (parts.length === 0) return '…'
  return `…${p.sep}${parts.slice(-2).join(p.sep)}`
}

/** `~`-abbreviates paths under home; others (a user-set AGENT_OFFICE_HOME) stay whole so snippets work. */
export function abbreviateForSnippet(path: string, home: string): string {
  return path.startsWith(home + nodePath.sep) ? `~${path.slice(home.length)}` : path
}
