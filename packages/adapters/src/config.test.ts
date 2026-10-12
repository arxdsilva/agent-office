import { describe, expect, it } from 'vitest'
import { loadEnv } from './config.ts'

describe('loadEnv', () => {
  it('uses safe defaults and no overrides', () => {
    expect(loadEnv({}, '/home/u')).toEqual({
      host: '127.0.0.1',
      allowedHosts: [],
      home: '/home/u/.agent-office',
      claudeProjectsDir: '/home/u/.claude/projects',
      claudeSettingsFile: '/home/u/.claude/settings.json',
      claudeHome: '/home/u/.claude',
      claudeConfigFile: '/home/u/.claude.json',
      overrides: {},
      sweep: {},
    })
  })

  it('reads overrides and expands ~', () => {
    const c = loadEnv(
      {
        PORT: '9000',
        HOST: '0.0.0.0',
        ALLOWED_HOSTS: 'office.lan:9000, box:9000',
        AGENT_OFFICE_HOME: '~/ao',
        CLAUDE_PROJECTS_DIR: '~/cc',
        CLAUDE_SETTINGS_FILE: '/tmp/s.json',
        AGENT_OFFICE_CLAUDE: '0',
        AGENT_OFFICE_MOCK: '1',
        IDLE_AFTER_MS: '5',
        EXPIRE_AFTER_MS: '10',
      },
      '/home/u',
    )
    expect(c).toMatchObject({
      host: '0.0.0.0',
      allowedHosts: ['office.lan:9000', 'box:9000'],
      home: '/home/u/ao',
      claudeProjectsDir: '/home/u/cc',
      claudeSettingsFile: '/tmp/s.json',
      overrides: { port: 9000, claudeAdapter: false, mock: true },
      sweep: { idleAfterMs: 5, expireAfterMs: 10 },
    })
  })

  it('Claude home and config follow the projects dir unless set explicitly', () => {
    expect(loadEnv({ CLAUDE_PROJECTS_DIR: '/t/c/projects' }, '/home/u')).toMatchObject({
      claudeHome: '/t/c',
      claudeConfigFile: '/t/.claude.json',
    })
    expect(
      loadEnv({ CLAUDE_HOME: '~/ch', CLAUDE_CONFIG_FILE: '/t/cfg.json' }, '/home/u'),
    ).toMatchObject({ claudeHome: '/home/u/ch', claudeConfigFile: '/t/cfg.json' })
  })

  it('rejects invalid numbers', () => {
    expect(() => loadEnv({ PORT: 'abc' }, '/h')).toThrow(/PORT/)
  })
})
