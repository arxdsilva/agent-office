import { describe, expect, it } from 'vitest'
import type { PolicyAction, PolicyRule } from './harness-types.ts'
import { compileGlob, compilePolicy, nativeOf, normalizePath, toolClass } from './harness-policy.ts'

const rule = (id: string, r: Omit<PolicyRule, 'id' | 'reason' | 'severity'>): PolicyRule => ({
  id,
  reason: `${id} reason`,
  severity: 'required',
  ...r,
})

const RULES: PolicyRule[] = [
  rule('rul_env', { effect: 'deny', paths: ['.env', '.env.*'], except: ['.env.example'] }),
  rule('rul_outside', { effect: 'deny', tools: ['class:write'], paths: ['@outside'] }),
  rule('rul_secrets', { effect: 'deny', paths: ['secrets/'] }),
  rule('rul_gen', { effect: 'ask', tools: ['class:write'], paths: ['src/gen/**/*.{ts,js}'] }),
  rule('rul_rm', { effect: 'deny', commands: ['rm'] }),
  rule('rul_push', { effect: 'ask', commands: ['git'] }),
  rule('rul_net', { effect: 'deny', tools: ['class:fetch'], hosts: ['*.evil.com'] }),
  rule('rul_mcp', { effect: 'ask', tools: ['mcp__github__*'] }),
  rule('rul_task', { effect: 'deny', tools: ['class:write'], roles: ['Explore'] }),
  rule('rul_codex', { effect: 'deny', tools: ['WebSearch'], providers: ['codex'] }),
  rule('rul_q', { effect: 'ask', tools: ['Read'], paths: ['docs/?.md'] }),
]
const evaluate = compilePolicy(RULES)
const CWD = '/work/shop'
const act = (tool: string, input: Record<string, unknown>, o: Partial<PolicyAction> = {}) =>
  evaluate({ tool, input, cwd: CWD, ...o })

describe('compilePolicy', () => {
  it.each<[string, string, Record<string, unknown>, Partial<PolicyAction>, string, string[]]>([
    ['read .env', 'Read', { file_path: '/work/shop/.env' }, {}, 'deny', ['rul_env']],
    ['edit .env.local', 'Edit', { file_path: '.env.local' }, {}, 'deny', ['rul_env']],
    ['example carve-out', 'Read', { file_path: '.env.example' }, {}, 'allow', []],
    ['nested .env', 'Read', { file_path: 'pkg/a/.env' }, {}, 'deny', ['rul_env']],
    ['write outside', 'Write', { file_path: '/etc/passwd' }, {}, 'deny', ['rul_outside']],
    ['read outside ok', 'Read', { file_path: '/etc/hosts' }, {}, 'allow', []],
    ['traversal', 'Edit', { file_path: '../../etc/passwd' }, {}, 'deny', ['rul_outside']],
    ['abs traversal', 'Edit', { file_path: '/work/shop/a/../../x' }, {}, 'deny', ['rul_outside']],
    ['sibling prefix', 'Edit', { file_path: '/work/shop2/x' }, {}, 'deny', ['rul_outside']],
    ['dot segments stay in', 'Edit', { file_path: './a/./b.ts' }, {}, 'allow', []],
    ['secrets dir', 'Read', { file_path: 'secrets/k.pem' }, {}, 'deny', ['rul_secrets']],
    ['secrets file prefix only', 'Read', { file_path: 'secretsx/k' }, {}, 'allow', []],
    ['gen ask', 'Edit', { file_path: 'src/gen/a/b.ts' }, {}, 'ask', ['rul_gen']],
    ['gen braces js', 'Write', { file_path: 'src/gen/x.js' }, {}, 'ask', ['rul_gen']],
    ['gen other ext', 'Write', { file_path: 'src/gen/x.css' }, {}, 'allow', []],
    ['gen read ok', 'Read', { file_path: 'src/gen/x.ts' }, {}, 'allow', []],
    ['notebook path', 'NotebookEdit', { notebook_path: 'src/gen/n.ts' }, {}, 'ask', ['rul_gen']],
    ['multi path any', 'MultiEdit', { file_paths: ['a.ts', '.env'] }, {}, 'deny', ['rul_env']],
    ['grep path', 'Grep', { path: 'secrets' }, {}, 'deny', ['rul_secrets']],
    ['rm', 'Bash', { command: 'rm -rf x' }, {}, 'deny', ['rul_rm']],
    ['sudo rm', 'Bash', { command: 'FOO=1 sudo rm -rf x' }, {}, 'deny', ['rul_rm']],
    ['bash -c rm', 'Bash', { command: 'bash -c "rm x"' }, {}, 'deny', ['rul_rm']],
    ['chain rm', 'Bash', { command: 'ls && /bin/rm x' }, {}, 'deny', ['rul_rm']],
    ['git ask', 'Bash', { command: 'git push' }, {}, 'ask', ['rul_push']],
    ['rm beats git ask', 'Bash', { command: 'git add . ; rm x' }, {}, 'deny', ['rul_rm']],
    ['ls ok', 'Bash', { command: 'ls -la' }, {}, 'allow', []],
    ['subst with rm denies', 'Bash', { command: 'echo $(rm x)' }, {}, 'deny', ['rul_rm']],
    ['subst opaque', 'Bash', { command: 'echo $(ls)' }, {}, 'ask', ['harness:opaque-command']],
    ['backtick opaque', 'Bash', { command: 'echo `ls`' }, {}, 'ask', ['harness:opaque-command']],
    ['eval opaque', 'Bash', { command: 'eval x' }, {}, 'ask', ['harness:opaque-command']],
    ['quote opaque', 'Bash', { command: 'echo "x' }, {}, 'ask', ['harness:opaque-command']],
    ['rm in quotes is text', 'Bash', { command: 'echo "rm x"' }, {}, 'allow', []],
    ['evil host', 'WebFetch', { url: 'https://api.evil.com/x' }, {}, 'deny', ['rul_net']],
    ['bare evil', 'WebFetch', { url: 'https://evil.com/x' }, {}, 'allow', []],
    ['good host', 'WebFetch', { url: 'https://example.com' }, {}, 'allow', []],
    ['mcp push', 'mcp__github__push', {}, {}, 'ask', ['rul_mcp']],
    ['other mcp', 'mcp__linear__list', {}, {}, 'allow', []],
    [
      'explore writes',
      'Write',
      { file_path: 'a.ts' },
      { agentRole: 'Explore' },
      'deny',
      ['rul_task'],
    ],
    ['main writes', 'Write', { file_path: 'a.ts' }, { agentRole: 'main' }, 'allow', []],
    ['explore reads', 'Read', { file_path: 'a.ts' }, { agentRole: 'Explore' }, 'allow', []],
    ['codex search', 'WebSearch', { query: 'x' }, { provider: 'codex' }, 'deny', ['rul_codex']],
    ['claude search', 'WebSearch', { query: 'x' }, { provider: 'claude-code' }, 'allow', []],
    ['? glob', 'Read', { file_path: 'docs/a.md' }, {}, 'ask', ['rul_q']],
    ['? glob one char', 'Read', { file_path: 'docs/ab.md' }, {}, 'allow', []],
    [
      'windows abs',
      'Edit',
      { file_path: 'C:\\Work\\Shop\\.env' },
      { cwd: 'c:\\work\\shop' },
      'deny',
      ['rul_env'],
    ],
    [
      'windows outside',
      'Edit',
      { file_path: 'D:\\x' },
      { cwd: 'C:\\work\\shop' },
      'deny',
      ['rul_outside'],
    ],
    ['home tilde', 'Write', { file_path: '~/.ssh/id' }, {}, 'deny', ['rul_outside']],
  ])('%s', (_n, tool, input, o, action, ids) => {
    const d = act(tool, input, o)
    expect(d.action).toBe(action)
    expect(d.ruleIds).toEqual(ids)
  })

  it('exec decisions are heuristic, file decisions exact, reasons from the rule', () => {
    expect(act('Bash', { command: 'ls' }).basis).toBe('heuristic')
    expect(act('Bash', { command: 'rm x' })).toMatchObject({
      basis: 'heuristic',
      reason: 'rul_rm reason',
    })
    expect(act('Read', { file_path: '.env' }).basis).toBe('exact')
  })

  it('opaque commands are fine when no command rule exists; a policy error is a deny', () => {
    const none = compilePolicy([rule('rul_x', { effect: 'deny', tools: ['Write'] })])
    expect(none({ tool: 'Bash', input: { command: 'echo $(x)' }, cwd: CWD }).action).toBe('allow')
    const bad = compilePolicy([rule('rul_x', { effect: 'deny', paths: ['x'.repeat(201)] })])
    expect(bad({ tool: 'Read', input: {}, cwd: CWD })).toMatchObject({
      action: 'deny',
      reason: 'policy error',
    })
    const throwing = compilePolicy(RULES)
    const input = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom')
        },
      },
    )
    expect(throwing({ tool: 'Read', input, cwd: CWD })).toMatchObject({
      action: 'deny',
      reason: 'policy error',
    })
  })

  it('a rule with no matcher matches nothing', () => {
    const e = compilePolicy([rule('rul_x', { effect: 'deny' })])
    expect(e({ tool: 'Write', input: { file_path: 'a' }, cwd: CWD }).action).toBe('allow')
  })
})

describe('helpers', () => {
  it('normalizePath', () => {
    expect(normalizePath('/work/shop/a/b', '/work/shop/')).toBe('a/b')
    expect(normalizePath('/work/shop', '/work/shop')).toBe('.')
    expect(normalizePath('a/../../b', '/w')).toBe('@outside')
    expect(normalizePath('/x', '')).toBe('@outside')
  })
  it('compileGlob escapes regex characters and supports ** and {a,b}', () => {
    expect(compileGlob('a+b(c).ts').test('a+b(c).ts')).toBe(true)
    expect(compileGlob('a+b(c).ts').test('aab(c).ts')).toBe(false)
    expect(compileGlob('src/**').test('src/a/b')).toBe(true)
    expect(compileGlob('**/x').test('x')).toBe(true)
    expect(compileGlob('{a,b}/*').test('b/c')).toBe(true)
    expect(compileGlob('a{b').test('a{b')).toBe(true)
  })
  it('toolClass', () => {
    expect(toolClass('Edit')).toBe('write')
    expect(toolClass('Task')).toBe('agent')
    expect(toolClass('mcp__a__b')).toBe('mcp')
    expect(toolClass('Other')).toBeUndefined()
  })
  it('nativeOf extracts the statically enforceable parts', () => {
    expect(nativeOf(RULES, 'prefer')).toEqual({
      deniedTools: [],
      denyPaths: ['secrets/'],
      askPaths: [],
      denyCommands: ['rm'],
      askCommands: ['git'],
      fsIsolation: 'prefer',
    })
    expect(
      nativeOf([rule('rul_a', { effect: 'deny', tools: ['class:fetch', 'mcp__x__*'] })], 'off')
        .deniedTools,
    ).toEqual(['WebFetch', 'WebSearch', 'mcp__x__*'])
  })
})
