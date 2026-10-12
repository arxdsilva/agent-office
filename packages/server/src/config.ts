import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  host: string
  claudeProjectsDir: string
  claudeEnabled: boolean
  mockEnabled: boolean
  idleAfterMs: number
  expireAfterMs: number
  /** Directory holding the token file. */
  home: string
  /** Extra host:port values accepted when binding beyond localhost. */
  allowedHosts: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
  const num = (name: string, fallback: number) => {
    const v = env[name]
    if (v === undefined || v === '') return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0)
      throw new Error(`${name} must be a non-negative integer, got "${v}"`)
    return n
  }
  return {
    port: num('PORT', 4317),
    host: env.HOST || '127.0.0.1',
    claudeProjectsDir: expand(env.CLAUDE_PROJECTS_DIR || '~/.claude/projects'),
    claudeEnabled: env.AGENT_OFFICE_CLAUDE !== '0',
    mockEnabled: env.AGENT_OFFICE_MOCK === '1',
    idleAfterMs: num('IDLE_AFTER_MS', 60_000),
    expireAfterMs: num('EXPIRE_AFTER_MS', 600_000),
    home: expand(env.AGENT_OFFICE_HOME || '~/.agent-office'),
    allowedHosts: (env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  }
}
