import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({}, '/home/u')).toEqual({
      port: 4317,
      host: '127.0.0.1',
      claudeProjectsDir: '/home/u/.claude/projects',
      claudeEnabled: true,
      mockEnabled: false,
      idleAfterMs: 60_000,
      expireAfterMs: 600_000,
      home: '/home/u/.agent-office',
      allowedHosts: [],
    })
  })

  it('reads overrides and expands ~', () => {
    const c = loadConfig(
      {
        PORT: '9000',
        HOST: '0.0.0.0',
        CLAUDE_PROJECTS_DIR: '~/cc',
        AGENT_OFFICE_CLAUDE: '0',
        AGENT_OFFICE_MOCK: '1',
        IDLE_AFTER_MS: '5',
        EXPIRE_AFTER_MS: '10',
        AGENT_OFFICE_HOME: '/srv/ao',
        ALLOWED_HOSTS: 'office.lan:9000, box:9000',
      },
      '/home/u',
    )
    expect(c).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      claudeProjectsDir: '/home/u/cc',
      claudeEnabled: false,
      mockEnabled: true,
      idleAfterMs: 5,
      expireAfterMs: 10,
      home: '/srv/ao',
      allowedHosts: ['office.lan:9000', 'box:9000'],
    })
  })

  it('rejects invalid numbers', () => {
    expect(() => loadConfig({ PORT: 'abc' }, '/h')).toThrow(/PORT/)
  })
})
