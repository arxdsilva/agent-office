// `target` extraction (docs/capabilities.md §3) and the privacy guarantees that come with it.
// Every fixture path, URL and command below is invented; several look like secrets on purpose.
import { describe, expect, it } from 'vitest'
import { assistant } from './fixtures.ts'
import { lineToEvent, newParseContext } from './line-mapper.ts'

const HOME = '/home/dev/.claude'
const CWD = '/home/dev/projects/shop' // the fixtures' session cwd
const ctx = () => newParseContext({ claudeHome: HOME, projectsDir: `${HOME}/projects` })
const use = (name: string, input: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  lineToEvent(assistant([{ type: 'tool_use', name, input }], over), ctx())

describe('lineToEvent: target', () => {
  it('file tools target the project basename, never the file path', () => {
    for (const name of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(use(name, { file_path: `${CWD}/src/db/credentials.ts` })?.target).toBe('project:shop')
    expect(use('Glob', { pattern: '**/*.env', path: CWD })?.target).toBe('project:shop')
    expect(use('Grep', { pattern: 'API_KEY=sk-live' })?.target).toBe('project:shop')
    expect(use('LS', { path: '/etc' })?.target).toBe('project:shop')
  })

  it('WebFetch targets the hostname only; WebSearch has no target', () => {
    expect(
      use('WebFetch', {
        url: 'https://user:hunter2@api.example.com:8443/v1/keys?token=sk-abc#frag',
      })?.target,
    ).toBe('host:api.example.com')
    expect(use('WebFetch', { url: 'not a url' })?.target).toBeUndefined()
    expect(use('WebFetch', { url: 'http://[::1]:3000/x' })?.target).toBeUndefined()
    expect(use('WebFetch', {})?.target).toBeUndefined()
    expect(use('WebSearch', { query: 'my secret query' })?.target).toBeUndefined()
  })

  it('Bash targets the first command word when it is a plain word', () => {
    expect(use('Bash', { command: 'git push https://tok:ghp_secret@github.com/x' })?.target).toBe(
      'cmd:git',
    )
    expect(use('Bash', { command: '  pnpm   test --filter core' })?.target).toBe('cmd:pnpm')
    for (const command of [
      'AWS_SECRET_ACCESS_KEY=abc aws s3 ls',
      '/usr/local/bin/deploy --prod',
      'Make all',
      'averyveryverylongcommandname',
      '$(cat ~/.ssh/id_rsa)',
      '',
    ])
      expect(use('Bash', { command })?.target).toBeUndefined()
    expect(use('Bash', {})?.target).toBeUndefined()
    expect(use('BashOutput', { bash_id: 'b1' })?.target).toBeUndefined()
  })

  it('Skill targets the skill name; bad names are dropped', () => {
    expect(use('Skill', { skill: 'run-office' })?.target).toBe('skill:run-office')
    expect(use('Skill', { skill: 'marketing:seo-audit', args: 'secret args' })?.target).toBe(
      'skill:marketing:seo-audit',
    )
    expect(use('Skill', { skill: '../../etc/passwd' })?.target).toBeUndefined()
    expect(use('Skill', { skill: 'x'.repeat(81) })?.target).toBeUndefined()
    expect(use('Skill', {})?.target).toBeUndefined()
  })

  it('Read of a rule file targets the rule (project and user scopes)', () => {
    expect(use('Read', { file_path: `${CWD}/CLAUDE.md` })?.target).toBe('rule:project:CLAUDE.md')
    expect(use('Read', { file_path: `${CWD}/AGENTS.md` })?.target).toBe('rule:project:AGENTS.md')
    expect(use('Read', { file_path: `${CWD}/.claude/rules/TESTING.md` })?.target).toBe(
      'rule:project:TESTING.md',
    )
    expect(use('Read', { file_path: `${HOME}/CLAUDE.md` })?.target).toBe('rule:user:CLAUDE.md')
    expect(use('Read', { file_path: `${HOME}/rules/style.md` })?.target).toBe('rule:user:style.md')
    // A relative path resolves against the session cwd.
    expect(use('Read', { file_path: '.claude/rules/ARCH.md' })?.target).toBe('rule:project:ARCH.md')
  })

  it('Read of a SKILL.md targets the skill, and of a memory file the memory slug', () => {
    expect(use('Read', { file_path: `${HOME}/skills/run-office/SKILL.md` })?.target).toBe(
      'skill:run-office',
    )
    expect(
      use('Read', { file_path: `${HOME}/plugins/cache/x/skills/seo-audit/SKILL.md` })?.target,
    ).toBe('skill:seo-audit')
    expect(
      use('Read', {
        file_path: `${HOME}/projects/-home-dev-projects-shop/memory/agent-office-project.md`,
      })?.target,
    ).toBe('memory:agent-office-project')
  })

  it('other or look-alike files fall back to the project target', () => {
    for (const file_path of [
      `${CWD}/docs/CLAUDE.md`,
      `${CWD}/.claude/rules/nested/x.md`,
      `${CWD}/.claude/rules/notes.txt`,
      `${CWD}/.claude/rules/../../secrets.md`,
      `${HOME}/rules/.hidden.md`,
      `${HOME}/projects/p/memory/sub/x.md`,
      `/elsewhere/SKILL.md`,
    ])
      expect(use('Read', { file_path })?.target).toBe('project:shop')
  })

  it('editing a rule or skill file is plain project (filesystem) use', () => {
    expect(use('Edit', { file_path: `${CWD}/CLAUDE.md` })?.target).toBe('project:shop')
    expect(use('Write', { file_path: `${HOME}/skills/x/SKILL.md` })?.target).toBe('project:shop')
  })

  it('without known Claude paths, user rules and memory are not recognized', () => {
    const e = lineToEvent(
      assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `${HOME}/CLAUDE.md` } }]),
      newParseContext(),
    )
    expect(e?.target).toBe('project:shop')
  })

  it('MCP and subagent tools carry no target', () => {
    expect(
      use('mcp__claude_ai_Gmail__search_threads', { query: 'from:boss' })?.target,
    ).toBeUndefined()
    expect(use('Agent', { prompt: 'secret plan' })?.target).toBeUndefined()
  })

  it('a cwd basename with control characters is dropped', () => {
    expect(use('Read', { file_path: 'x' }, { cwd: '/tmp/bad\nname' })?.target).toBeUndefined()
  })

  it('records the session cwd (never emitted) for capability discovery', () => {
    const c = ctx()
    lineToEvent(assistant([{ type: 'text', text: 'hi' }]), c)
    expect([...c.cwds.keys()]).toEqual([CWD])
  })
})

describe('lineToEvent: privacy (no path, URL, argument or content leaks)', () => {
  const SECRETS = [
    'hunter2',
    'sk-abc',
    'sk-live',
    'ghp_secret',
    'token=',
    'credentials',
    '/home/dev',
    'id_rsa',
    'from:boss',
    'secret plan',
    'secret args',
    'AWS_SECRET',
    '8443',
    'BEGIN PRIVATE KEY',
  ]
  const calls: [string, Record<string, unknown>][] = [
    ['Read', { file_path: '/home/dev/projects/shop/src/db/credentials.ts' }],
    ['Read', { file_path: '/home/dev/.claude/projects/p/memory/secret-plan.md' }],
    ['Write', { file_path: '/home/dev/.ssh/id_rsa', content: '-----BEGIN PRIVATE KEY-----' }],
    ['Edit', { file_path: '/home/dev/x', old_string: 'sk-live-1', new_string: 'sk-live-2' }],
    ['Grep', { pattern: 'API_KEY=sk-live', path: '/home/dev/projects/shop' }],
    ['WebFetch', { url: 'https://user:hunter2@api.example.com:8443/v1/keys?token=sk-abc' }],
    ['WebSearch', { query: 'from:boss secret plan' }],
    ['Bash', { command: 'git push https://tok:ghp_secret@github.com/x', description: 'Push' }],
    ['Bash', { command: 'AWS_SECRET_ACCESS_KEY=abc aws s3 ls' }],
    ['Skill', { skill: 'run-office', args: 'secret args' }],
    ['mcp__claude_ai_Gmail__search_threads', { query: 'from:boss' }],
    ['Agent', { prompt: 'secret plan', description: 'Explore' }],
  ]

  it.each(calls)('%s emits none of the secret-looking input', (name, input) => {
    const json = JSON.stringify(use(name, input))
    for (const s of SECRETS) expect(json).not.toContain(s)
  })
})
