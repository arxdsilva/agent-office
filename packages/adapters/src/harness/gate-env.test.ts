import { describe, expect, it } from 'vitest'
import { gateEnv } from './gate-env.ts'

describe('gateEnv', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/a',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    TERM: 'xterm',
    SHELL: '/bin/zsh',
    USER: 'a',
    LOGNAME: 'a',
    NODE_OPTIONS: '--require /evil.js',
    AGENT_OFFICE_TOKEN: 'sentinel-1',
    agent_office_home: '/x',
    FOO_SECRET: 'sentinel-2',
    X_API_KEY: 'sentinel-3',
    GITHUB_TOKEN: 's4',
    DB_PASSWORD: 's5',
    PGPASSWD: 's6',
    AWS_CREDENTIALS: 's7',
    NPM_AUTH: 's8',
    COOKIE_JAR: 's9',
    SSH_AUTH_SOCK: '/tmp/ssh',
    TMUX_SESSION: 's10',
    EDITOR: 'vim',
    EMPTY: undefined,
  }

  it('keeps the basics and drops our variables and anything credential-like', () => {
    const env = gateEnv(base)
    for (const k of [
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'TERM',
      'SHELL',
      'USER',
      'LOGNAME',
      'EDITOR',
    ])
      expect(env[k]).toBe(base[k as keyof typeof base])
    for (const k of [
      'NODE_OPTIONS',
      'AGENT_OFFICE_TOKEN',
      'agent_office_home',
      'FOO_SECRET',
      'X_API_KEY',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      'PGPASSWD',
      'AWS_CREDENTIALS',
      'NPM_AUTH',
      'COOKIE_JAR',
      'SSH_AUTH_SOCK',
      'TMUX_SESSION',
      'EMPTY',
    ])
      expect(env).not.toHaveProperty(k)
    expect(Object.values(env).join(' ')).not.toMatch(/sentinel/)
  })

  it('marks the run as CI and as a gate', () => {
    const env = gateEnv({ PATH: '/bin', AGENT_OFFICE_GATE: '0', CI: '' })
    expect(env.CI).toBe('1')
    expect(env.AGENT_OFFICE_GATE).toBe('1')
  })
})
