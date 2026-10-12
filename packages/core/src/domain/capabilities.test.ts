import type { Capability } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import {
  builtinDecls,
  mcpDecl,
  classifyUse,
  declare,
  MAX_SEES,
  MAX_TOOLS,
  mergeUse,
  parseTarget,
  prettifyServer,
  seesLine,
  sortCapabilities,
  withActive,
} from './capabilities.ts'

const CC = 'claude-code'

describe('classifyUse: built-in adapters (docs/capabilities.md §2)', () => {
  it.each([
    ['Read', 'fs', 'filesystem', 'Filesystem'],
    ['Edit', 'fs', 'filesystem', 'Filesystem'],
    ['Write', 'fs', 'filesystem', 'Filesystem'],
    ['MultiEdit', 'fs', 'filesystem', 'Filesystem'],
    ['Glob', 'fs', 'filesystem', 'Filesystem'],
    ['Grep', 'fs', 'filesystem', 'Filesystem'],
    ['NotebookEdit', 'fs', 'filesystem', 'Filesystem'],
    ['LS', 'fs', 'filesystem', 'Filesystem'],
    ['Bash', 'shell', 'shell', 'Shell'],
    ['BashOutput', 'shell', 'shell', 'Shell'],
    ['KillShell', 'shell', 'shell', 'Shell'],
    ['WebFetch', 'web', 'web', 'Web'],
    ['WebSearch', 'web', 'web', 'Web'],
    ['Agent', 'subagents', 'subagents', 'Subagents'],
    ['Task', 'subagents', 'subagents', 'Subagents'],
  ])('%s → %s', (tool, id, kind, label) => {
    expect(classifyUse(CC, tool)).toEqual({ id, category: 'adapter', kind, label, tool })
  })

  it('a project target keeps file tools on the Filesystem adapter', () => {
    expect(classifyUse(CC, 'Grep', 'project:workspace')?.id).toBe('fs')
  })

  it('harness tools and unknown Claude Code tools are not capabilities', () => {
    for (const t of ['TodoWrite', 'ExitPlanMode', 'AskUserQuestion', 'ToolSearch', 'Whatever'])
      expect(classifyUse(CC, t)).toBeNull()
    expect(classifyUse('langgraph', 'TodoWrite')).toBeNull()
  })

  it('Skill without a valid skill target is not a capability', () => {
    expect(classifyUse(CC, 'Skill')).toBeNull()
    expect(classifyUse(CC, 'Skill', 'host:x.com')).toBeNull()
  })
})

describe('classifyUse: MCP servers', () => {
  it('maps mcp__<server>__<tool> to mcp:<server> with a prettified label', () => {
    expect(classifyUse(CC, 'mcp__claude_ai_Google_Drive__search_files')).toEqual({
      id: 'mcp:claude_ai_Google_Drive',
      category: 'adapter',
      kind: 'mcp',
      label: 'Google Drive',
      tool: 'search_files',
    })
    expect(classifyUse(CC, 'mcp__github__create_issue')).toMatchObject({
      id: 'mcp:github',
      label: 'Github',
      tool: 'create_issue',
    })
  })

  it('database-like server names are kind database', () => {
    for (const s of ['postgres', 'my-sqlite', 'mongoDB', 'redis_cache', 'analytics_db'])
      expect(classifyUse(CC, `mcp__${s}__query`)?.kind).toBe('database')
  })

  it('malformed mcp names fall through', () => {
    expect(classifyUse(CC, 'mcp__nope')).toBeNull()
  })
})

describe('classifyUse: skills and rules', () => {
  it('Skill + skill:<name> → the skill (plugin prefix kept, plugin scope)', () => {
    expect(classifyUse(CC, 'Skill', 'skill:run-office')).toEqual({
      id: 'skill:run-office',
      category: 'skill',
      kind: 'skill',
      label: 'run-office',
    })
    expect(classifyUse(CC, 'Skill', 'skill:marketing:seo-audit')).toMatchObject({
      id: 'skill:marketing:seo-audit',
      label: 'marketing:seo-audit',
      scope: 'plugin',
    })
  })

  it('Read of a SKILL.md, a rule or a memory entry consults it instead of the Filesystem', () => {
    expect(classifyUse(CC, 'Read', 'skill:run-office')?.id).toBe('skill:run-office')
    expect(classifyUse(CC, 'Read', 'rule:project:TESTING.md')).toEqual({
      id: 'rule:project:TESTING.md',
      category: 'rule',
      kind: 'rule',
      label: 'TESTING.md',
      scope: 'project',
    })
    expect(classifyUse(CC, 'Read', 'rule:project:CLAUDE.md')).toMatchObject({
      kind: 'project-rules',
      label: 'CLAUDE.md (project)',
      scope: 'project',
    })
    expect(classifyUse(CC, 'Read', 'rule:project:AGENTS.md')?.kind).toBe('project-rules')
    expect(classifyUse(CC, 'Read', 'rule:user:CLAUDE.md')).toMatchObject({
      kind: 'user-rules',
      label: 'CLAUDE.md (you)',
      scope: 'user',
    })
    expect(classifyUse(CC, 'Read', 'rule:user:style.md')).toMatchObject({
      kind: 'rule',
      scope: 'user',
    })
    expect(classifyUse(CC, 'Read', 'memory:agent-office-project')).toEqual({
      id: 'memory:agent-office-project',
      category: 'rule',
      kind: 'memory',
      label: 'agent-office-project',
    })
  })

  it('editing a rule, skill or memory file is filesystem use (editing is not consulting)', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit'])
      for (const t of ['rule:project:TESTING.md', 'skill:x', 'memory:y'])
        expect(classifyUse(CC, tool, t)?.id).toBe('fs')
  })
})

describe('classifyUse: generic providers', () => {
  it('an unknown tool from another provider is adapter api:<tool>', () => {
    expect(classifyUse('langgraph', 'vector_search')).toEqual({
      id: 'api:vector_search',
      category: 'adapter',
      kind: 'api',
      label: 'vector_search',
      tool: 'vector_search',
    })
  })

  it('built-in names still classify for any provider', () => {
    expect(classifyUse('openai-agents', 'WebFetch')?.id).toBe('web')
  })

  it('an explicit capability wins and its kind is derived from the id', () => {
    expect(classifyUse('langgraph', 'query', undefined, 'mcp:postgres')).toMatchObject({
      id: 'mcp:postgres',
      kind: 'database',
      label: 'Postgres',
      tool: 'query',
    })
    expect(classifyUse('langgraph', 'run', undefined, 'skill:triage')).toMatchObject({
      id: 'skill:triage',
      category: 'skill',
    })
    expect(classifyUse('langgraph', 'x', undefined, 'rule:user:CLAUDE.md')?.kind).toBe('user-rules')
    expect(classifyUse('langgraph', 'x', undefined, 'memory:m1')?.kind).toBe('memory')
    expect(classifyUse('langgraph', 'x', undefined, 'api:crm')).toMatchObject({
      id: 'api:crm',
      kind: 'api',
      label: 'crm',
    })
    expect(classifyUse('langgraph', 'x', undefined, 'shell')?.kind).toBe('shell')
    expect(classifyUse(CC, 'TodoWrite', undefined, 'web')?.id).toBe('web')
    expect(classifyUse('langgraph', 'x', undefined, 'crm-sync')).toMatchObject({
      id: 'crm-sync',
      category: 'adapter',
      kind: 'other',
      label: 'crm-sync',
    })
  })

  it('an explicit capability with control characters or bad forms is ignored', () => {
    expect(classifyUse('langgraph', 'x', undefined, 'bad id\n')?.id).toBe('api:x')
    expect(classifyUse('langgraph', 'x', undefined, 'rule:team:x.md')?.id).toBe('api:x')
  })
})

describe('parseTarget (privacy grammar, §3)', () => {
  it('accepts only the documented forms', () => {
    expect(parseTarget('project:workspace')).toEqual({ form: 'project', value: 'workspace' })
    expect(parseTarget('host:github.com')).toEqual({ form: 'host', value: 'github.com' })
    expect(parseTarget('cmd:git')).toEqual({ form: 'cmd', value: 'git' })
    expect(parseTarget('skill:plugin:x')).toEqual({ form: 'skill', value: 'plugin:x' })
    expect(parseTarget('rule:user:CLAUDE.md')).toEqual({
      form: 'rule',
      value: 'CLAUDE.md',
      scope: 'user',
    })
    expect(parseTarget('memory:m-1')).toEqual({ form: 'memory', value: 'm-1' })
  })

  it.each([
    undefined,
    '',
    'project:/home/dev/secret',
    'project:a/b',
    'host:https://x.com/?token=abc',
    'cmd:rm -rf /',
    'cmd:Git',
    'rule:project:../../etc/passwd',
    'rule:team:x.md',
    'memory:a b',
    'url:https://x.com',
    'skill:a/b',
  ])('rejects %s', (t) => {
    expect(parseTarget(t)).toBeUndefined()
  })
})

describe('prettifyServer', () => {
  it('strips prefixes, splits and title-cases, keeping all-caps words', () => {
    expect(prettifyServer('claude_ai_Google_Drive')).toBe('Google Drive')
    expect(prettifyServer('github')).toBe('Github')
    expect(prettifyServer('plugin_marketing_slack')).toBe('Marketing Slack')
    expect(prettifyServer('my-API_server')).toBe('My API Server')
    expect(prettifyServer('claude_ai_')).toBe('claude_ai_')
  })
})

describe('seesLine', () => {
  it('turns safe targets into short scope lines', () => {
    expect(seesLine('project:workspace')).toBe('project: workspace')
    expect(seesLine('host:github.com')).toBe('host: github.com')
    expect(seesLine('cmd:git')).toBe('cmd: git')
    expect(seesLine('skill:x')).toBeUndefined()
    expect(seesLine('project:/etc')).toBeUndefined()
    expect(seesLine(undefined)).toBeUndefined()
  })
})

describe('mergeUse', () => {
  const ref = classifyUse(CC, 'Bash', 'cmd:git')!

  it('creates an observed capability on first use', () => {
    const c = mergeUse(undefined, CC, ref, { tool: 'Bash', target: 'cmd:git', now: 5 })
    expect(c).toEqual({
      id: 'shell',
      provider: CC,
      category: 'adapter',
      kind: 'shell',
      label: 'Shell',
      sees: ['cmd: git'],
      tools: ['Bash'],
      declared: false,
      calls: 1,
      lastUsedAt: 5,
      active: [],
    })
  })

  it('counts calls, dedups and keeps the most recent first', () => {
    let c = mergeUse(undefined, CC, ref, { tool: 'Bash', target: 'cmd:git', now: 1 })
    c = mergeUse(c, CC, ref, { tool: 'BashOutput', target: 'cmd:pnpm', now: 2 })
    c = mergeUse(c, CC, ref, { tool: 'Bash', target: 'cmd:git', now: 3 })
    expect(c.calls).toBe(3)
    expect(c.lastUsedAt).toBe(3)
    expect(c.tools).toEqual(['Bash', 'BashOutput'])
    expect(c.sees).toEqual(['cmd: git', 'cmd: pnpm'])
  })

  it('caps sees and tools', () => {
    let c: Capability | undefined
    for (let i = 0; i < 40; i++)
      c = mergeUse(c, CC, ref, { tool: `T${i}`, target: `cmd:c${i}`, now: i })
    expect(c!.sees).toHaveLength(MAX_SEES)
    expect(c!.tools).toHaveLength(MAX_TOOLS)
    expect(c!.sees[0]).toBe('cmd: c39')
  })

  it('keeps declared metadata (label, kind, declared) on use', () => {
    const d = declare(undefined, CC, {
      id: 'mcp:pg',
      category: 'adapter',
      kind: 'database',
      label: 'Warehouse',
    })
    const c = mergeUse(d, CC, classifyUse(CC, 'mcp__pg__query')!, { tool: 'query', now: 9 })
    expect(c).toMatchObject({ label: 'Warehouse', kind: 'database', declared: true, calls: 1 })
    expect(c.tools).toEqual(['query'])
  })

  it('skills and rules record calls but no tools or sees', () => {
    const r = classifyUse(CC, 'Read', 'rule:project:TESTING.md')!
    const c = mergeUse(undefined, CC, r, {
      tool: 'Read',
      target: 'rule:project:TESTING.md',
      now: 1,
    })
    expect(c).toMatchObject({ calls: 1, tools: [], sees: [], scope: 'project' })
  })
})

describe('declare', () => {
  it('marks declared, merges sees/tools and keeps usage counters', () => {
    const used = mergeUse(undefined, CC, classifyUse(CC, 'WebFetch', 'host:a.com')!, {
      tool: 'WebFetch',
      target: 'host:a.com',
      now: 4,
    })
    const c = declare(withActive(used, 'ag1', true), CC, {
      id: 'web',
      category: 'adapter',
      kind: 'web',
      label: 'Web',
      sees: ['host: b.com', 'host: a.com'],
      tools: ['WebSearch'],
    })
    expect(c).toMatchObject({
      declared: true,
      calls: 1,
      lastUsedAt: 4,
      active: ['ag1'],
      sees: ['host: b.com', 'host: a.com'],
      tools: ['WebSearch', 'WebFetch'],
    })
  })

  it('takes summary and scope from the declaration, never a summary for memory', () => {
    const s = declare(undefined, CC, {
      id: 'skill:x',
      category: 'skill',
      kind: 'skill',
      label: 'x',
      summary: 'Does x',
      scope: 'user',
    })
    expect(s).toMatchObject({ summary: 'Does x', scope: 'user' })
    const again = declare(s, CC, { id: 'skill:x', category: 'skill', kind: 'skill', label: 'x' })
    expect(again.summary).toBeUndefined()
    expect(again.scope).toBeUndefined()
    const m = declare(undefined, CC, {
      id: 'memory:m',
      category: 'rule',
      kind: 'memory',
      label: 'Me',
      summary: 'private fact',
    })
    expect(m.summary).toBeUndefined()
  })

  it('skills and rules never carry sees or tools', () => {
    const r = declare(undefined, CC, {
      id: 'rule:project:A.md',
      category: 'rule',
      kind: 'rule',
      label: 'A.md',
      sees: ['x'],
      tools: ['y'],
    })
    expect(r).toMatchObject({ sees: [], tools: [] })
  })
})

describe('withActive / sortCapabilities', () => {
  it('adds and removes an agent id without duplicates', () => {
    const c = declare(undefined, CC, {
      id: 'fs',
      category: 'adapter',
      kind: 'filesystem',
      label: 'F',
    })
    const on = withActive(withActive(c, 'a', true), 'a', true)
    expect(on.active).toEqual(['a'])
    expect(withActive(on, 'a', false).active).toEqual([])
    expect(withActive(c, 'zz', false)).toBe(c)
  })

  it('sorts adapters, then skills, then rules, then by id', () => {
    const mk = (id: string, category: Capability['category']) =>
      declare(undefined, CC, { id, category, kind: 'other', label: id })
    const out = sortCapabilities([
      mk('rule:project:B.md', 'rule'),
      mk('skill:b', 'skill'),
      mk('web', 'adapter'),
      mk('skill:a', 'skill'),
      mk('fs', 'adapter'),
    ]).map((c) => c.id)
    expect(out).toEqual(['fs', 'web', 'skill:a', 'skill:b', 'rule:project:B.md'])
  })
})

describe('mcpDecl / builtinDecls', () => {
  it('declares an MCP server by name with kind and label', () => {
    expect(mcpDecl('claude_ai_Gmail')).toEqual({
      id: 'mcp:claude_ai_Gmail',
      category: 'adapter',
      kind: 'mcp',
      label: 'Gmail',
    })
    expect(mcpDecl('pg-db').kind).toBe('database')
  })

  it('declares the four built-in adapters', () => {
    expect(builtinDecls().map((d) => [d.id, d.kind, d.label])).toEqual([
      ['fs', 'filesystem', 'Filesystem'],
      ['shell', 'shell', 'Shell'],
      ['web', 'web', 'Web'],
      ['subagents', 'subagents', 'Subagents'],
    ])
  })
})
