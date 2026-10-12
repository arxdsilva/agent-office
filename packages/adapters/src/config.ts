import { join } from 'node:path'
import type { SweepPolicy } from '@agent-office/core'
import type { Settings } from '@agent-office/shared'

/**
 * Environment-level configuration: file locations plus dev/test overrides. User-facing values
 * (port, notifications, …) live in Settings; env overrides win for this run only.
 */
export interface EnvConfig {
  host: string
  allowedHosts: string[]
  /** Token directory shared with the hook script. */
  home: string
  claudeProjectsDir: string
  claudeSettingsFile: string
  overrides: Partial<Pick<Settings, 'port' | 'claudeAdapter' | 'mock'>>
  sweep: Partial<SweepPolicy>
}

export function loadEnv(env: Record<string, string | undefined>, home: string): EnvConfig {
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
  const num = (name: string): number | undefined => {
    const v = env[name]
    if (v === undefined || v === '') return undefined
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${v}"`)
    return n
  }
  const flag = (name: string): boolean | undefined => (env[name] === undefined ? undefined : env[name] === '1')
  const port = num('PORT')
  const claudeAdapter = flag('AGENT_OFFICE_CLAUDE')
  const mock = flag('AGENT_OFFICE_MOCK')
  const idleAfterMs = num('IDLE_AFTER_MS')
  const expireAfterMs = num('EXPIRE_AFTER_MS')
  return {
    host: env.HOST || '127.0.0.1',
    allowedHosts: (env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    home: expand(env.AGENT_OFFICE_HOME || '~/.agent-office'),
    claudeProjectsDir: expand(env.CLAUDE_PROJECTS_DIR || '~/.claude/projects'),
    claudeSettingsFile: expand(env.CLAUDE_SETTINGS_FILE || '~/.claude/settings.json'),
    overrides: {
      ...(port !== undefined ? { port } : {}),
      ...(claudeAdapter !== undefined ? { claudeAdapter } : {}),
      ...(mock !== undefined ? { mock } : {}),
    },
    sweep: {
      ...(idleAfterMs !== undefined ? { idleAfterMs } : {}),
      ...(expireAfterMs !== undefined ? { expireAfterMs } : {}),
    },
  }
}
