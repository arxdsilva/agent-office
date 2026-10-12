import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CapabilityDecl } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeKnowledgeReader, encodeCwd } from './claude-knowledge-reader.ts'

// A temp-dir fixture tree shaped like ~/.claude plus one project. All content is invented.
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'ao-know-'))
  const home = join(root, 'claude')
  const cwd = join(root, 'work', 'shop')
  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const reader = () => new ClaudeKnowledgeReader({ claudeHome: home })
  return { root, home, cwd, put, reader }
}

const skillMd = (name: string, description: string, body = 'Body text.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`
const byId = (ds: CapabilityDecl[], id: string) => ds.find((d) => d.id === id)

describe('ClaudeKnowledgeReader: skills', () => {
  it('reads user, project and plugin skills with name and a 160-char summary', async () => {
    const t = tree()
    t.put(join(t.home, 'skills/run-office/SKILL.md'), skillMd('run-office', 'Launch the app.'))
    t.put(
      join(t.cwd, '.claude/skills/scene-change/SKILL.md'),
      skillMd('scene-change', 'x'.repeat(300)),
    )
    t.put(
      join(t.home, 'plugins/synced/abc/marketing~g2/.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'marketing', author: { email: 'someone@example.com' } }),
    )
    t.put(
      join(t.home, 'plugins/synced/abc/marketing~g2/skills/seo-audit/SKILL.md'),
      skillMd('seo-audit', '"Audit SEO."'),
    )
    // No plugin.json: the plugin name comes from the directory (minus any ~suffix).
    t.put(
      join(t.home, 'plugins/cache/tinyfish~g2/skills/fetch/SKILL.md'),
      skillMd('fetch', 'Fetch.'),
    )
    const ds = await t.reader().read([t.cwd])
    expect(byId(ds, 'skill:run-office')).toEqual({
      id: 'skill:run-office',
      category: 'skill',
      kind: 'skill',
      label: 'run-office',
      summary: 'Launch the app.',
      scope: 'user',
    })
    expect(byId(ds, 'skill:scene-change')).toMatchObject({ scope: 'project' })
    expect(byId(ds, 'skill:scene-change')!.summary).toHaveLength(160)
    expect(byId(ds, 'skill:marketing:seo-audit')).toMatchObject({
      label: 'marketing:seo-audit',
      summary: 'Audit SEO.',
      scope: 'plugin',
    })
    expect(byId(ds, 'skill:tinyfish:fetch')).toBeDefined()
    expect(JSON.stringify(ds)).not.toContain('someone@example.com')
  })

  it('falls back to the directory name, parses folded descriptions, skips bad names', async () => {
    const t = tree()
    t.put(join(t.home, 'skills/plain/SKILL.md'), 'No frontmatter here.\n')
    t.put(
      join(t.home, 'skills/folded/SKILL.md'),
      '---\nname: folded\ndescription: >\n  First line\n  second line.\n---\nBody\n',
    )
    t.put(join(t.home, 'skills/bad/SKILL.md'), skillMd('bad name!', 'x'))
    const ds = await t.reader().read([])
    expect(byId(ds, 'skill:plain')).toMatchObject({ label: 'plain' })
    expect(byId(ds, 'skill:plain')).not.toHaveProperty('summary')
    expect(byId(ds, 'skill:folded')!.summary).toBe('First line second line.')
    expect(ds.some((d) => d.label === 'bad name!')).toBe(false)
  })

  it('ignores trash and marketplace listings (not installed)', async () => {
    const t = tree()
    t.put(join(t.home, 'plugins/.trash/1/x/skills/old/SKILL.md'), skillMd('old', 'x'))
    t.put(
      join(t.home, 'plugins/marketplaces/m/plugins/p/skills/listed/SKILL.md'),
      skillMd('listed', 'x'),
    )
    expect(await t.reader().read([])).toEqual([])
  })
})

describe('ClaudeKnowledgeReader: rules', () => {
  it('reads project and user rules with title and first prose sentence', async () => {
    const t = tree()
    t.put(
      join(t.cwd, 'CLAUDE.md'),
      '# CLAUDE.md\n\n@AGENTS.md\n\n| a | b |\n\nThis **project** uses `make`. More text.\n',
    )
    t.put(
      join(t.cwd, 'AGENTS.md'),
      '# Guide\n\n```sh\nmake\n```\n\n- a list\n\nRead [the docs](x.md) first!\n',
    )
    t.put(
      join(t.cwd, '.claude/rules/TESTING.md'),
      '# Testing rule — TDD\n\nWrite a failing test first.\n',
    )
    t.put(join(t.cwd, '.claude/rules/notes.txt'), 'not a rule')
    t.put(join(t.home, 'CLAUDE.md'), 'No heading, just prose here.\n')
    t.put(join(t.home, 'rules/style.md'), '---\nx: 1\n---\n## Sub\n\nKeep it short.\n')
    const ds = await t.reader().read([t.cwd])
    expect(byId(ds, 'rule:project:CLAUDE.md')).toEqual({
      id: 'rule:project:CLAUDE.md',
      category: 'rule',
      kind: 'project-rules',
      label: 'CLAUDE.md (shop)',
      summary: 'This project uses make.',
      scope: 'project',
    })
    expect(byId(ds, 'rule:project:AGENTS.md')).toMatchObject({
      kind: 'project-rules',
      label: 'AGENTS.md (shop)',
      summary: 'Read the docs first!',
    })
    expect(byId(ds, 'rule:project:TESTING.md')).toMatchObject({
      kind: 'rule',
      label: 'Testing rule — TDD',
      summary: 'Write a failing test first.',
    })
    expect(byId(ds, 'rule:user:CLAUDE.md')).toMatchObject({
      kind: 'user-rules',
      label: 'CLAUDE.md (you)',
      summary: 'No heading, just prose here.',
      scope: 'user',
    })
    expect(byId(ds, 'rule:user:style.md')).toMatchObject({
      label: 'style.md',
      summary: 'Keep it short.',
    })
    expect(ds.some((d) => d.id.includes('notes'))).toBe(false)
    // Project rules first, then user rules.
    expect(ds.filter((d) => d.category === 'rule').map((d) => d.scope)).toEqual([
      'project',
      'project',
      'project',
      'user',
      'user',
    ])
  })
})

describe('ClaudeKnowledgeReader: memory', () => {
  it('reads only the frontmatter name of memory entries, never a summary or body', async () => {
    const t = tree()
    const mem = join(t.home, 'projects', encodeCwd(t.cwd), 'memory')
    t.put(
      join(mem, 'agent-office-project.md'),
      '---\nname: agent-office project\ndescription: Private fact about the user\n---\nSecret body text\n',
    )
    t.put(join(mem, 'MEMORY.md'), '- [index](x.md) — an index without frontmatter\n')
    const ds = await t.reader().read([t.cwd])
    expect(ds.filter((d) => d.kind === 'memory')).toEqual([
      {
        id: 'memory:agent-office-project',
        category: 'rule',
        kind: 'memory',
        label: 'agent-office project',
      },
    ])
    const json = JSON.stringify(ds)
    expect(json).not.toContain('Private fact')
    expect(json).not.toContain('Secret body')
  })

  it('encodes the cwd the way Claude Code names project dirs', () => {
    expect(encodeCwd('/Users/a.b/my_proj')).toBe('-Users-a-b-my-proj')
  })
})

describe('ClaudeKnowledgeReader: limits', () => {
  it('caps skills at 48, rules at 24 and memory at 24', async () => {
    const t = tree()
    for (let i = 0; i < 60; i++) t.put(join(t.home, `skills/s${i}/SKILL.md`), skillMd(`s${i}`, 'x'))
    for (let i = 0; i < 30; i++) t.put(join(t.home, `rules/r${i}.md`), `# R${i}\n`)
    const mem = join(t.home, 'projects', encodeCwd(t.cwd), 'memory')
    for (let i = 0; i < 30; i++) t.put(join(mem, `m${i}.md`), `---\nname: m${i}\n---\n`)
    const ds = await t.reader().read([t.cwd])
    expect(ds.filter((d) => d.category === 'skill')).toHaveLength(48)
    expect(ds.filter((d) => d.category === 'rule' && d.kind !== 'memory')).toHaveLength(24)
    expect(ds.filter((d) => d.kind === 'memory')).toHaveLength(24)
  })

  it('skips files over 256 KB and parses only the first 4 KB', async () => {
    const t = tree()
    t.put(join(t.home, 'skills/huge/SKILL.md'), skillMd('huge', 'x', 'y'.repeat(300 * 1024)))
    t.put(join(t.home, 'rules/late.md'), `${'\n'.repeat(5000)}# Late title\n\nLate prose.\n`)
    const ds = await t.reader().read([])
    expect(byId(ds, 'skill:huge')).toBeUndefined()
    expect(byId(ds, 'rule:user:late.md')).toEqual({
      id: 'rule:user:late.md',
      category: 'rule',
      kind: 'rule',
      label: 'late.md',
      scope: 'user',
    })
  })

  it('does not follow symlinks (files or directories)', async () => {
    const t = tree()
    t.put(join(t.root, 'outside/secret/SKILL.md'), skillMd('secret', 'x'))
    t.put(join(t.root, 'outside/secret.md'), '# Secret\n')
    mkdirSync(join(t.home, 'skills'), { recursive: true })
    mkdirSync(join(t.home, 'rules'), { recursive: true })
    symlinkSync(join(t.root, 'outside/secret'), join(t.home, 'skills/linked'))
    symlinkSync(join(t.root, 'outside/secret.md'), join(t.home, 'rules/linked.md'))
    symlinkSync(join(t.root, 'outside/secret.md'), join(t.home, 'CLAUDE.md'))
    expect(await t.reader().read([])).toEqual([])
  })

  it('missing directories give []', async () => {
    const t = tree()
    expect(await t.reader().read(['/nowhere/at/all'])).toEqual([])
  })

  it('dedups ids across cwds (first wins)', async () => {
    const t = tree()
    const other = join(t.root, 'work', 'web')
    t.put(join(t.cwd, 'CLAUDE.md'), '# A\n')
    t.put(join(other, 'CLAUDE.md'), '# B\n')
    const ds = await t.reader().read([t.cwd, other])
    expect(ds.filter((d) => d.id === 'rule:project:CLAUDE.md').map((d) => d.label)).toEqual([
      'CLAUDE.md (shop)',
    ])
  })
})

describe('ClaudeKnowledgeReader: synced skills (~/.claude/skills/synced/*/*/SKILL.md)', () => {
  it('finds synced skills at exactly that depth, with scope user', async () => {
    const t = tree()
    t.put(join(t.home, 'skills/synced/team-a/deploy/SKILL.md'), skillMd('deploy', 'Ship it.'))
    t.put(join(t.home, 'skills/synced/team-b/review/SKILL.md'), skillMd('review', 'Review.'))
    // Too shallow (a group folder holding SKILL.md) and too deep: both ignored.
    t.put(join(t.home, 'skills/synced/team-a/SKILL.md'), skillMd('shallow', 'x'))
    t.put(join(t.home, 'skills/synced/team-a/nested/inner/SKILL.md'), skillMd('deep', 'x'))
    const ds = await t.reader().read([])
    expect(byId(ds, 'skill:deploy')).toEqual({
      id: 'skill:deploy',
      category: 'skill',
      kind: 'skill',
      label: 'deploy',
      summary: 'Ship it.',
      scope: 'user',
    })
    expect(byId(ds, 'skill:review')).toMatchObject({ scope: 'user' })
    expect(byId(ds, 'skill:shallow')).toBeUndefined()
    expect(byId(ds, 'skill:deep')).toBeUndefined()
    expect(byId(ds, 'skill:inner')).toBeUndefined()
  })

  it('ignores symlinked group and skill directories', async () => {
    const t = tree()
    t.put(join(t.root, 'outside/group/linked-skill/SKILL.md'), skillMd('via-group', 'x'))
    t.put(join(t.root, 'outside/lone/SKILL.md'), skillMd('via-skill', 'x'))
    mkdirSync(join(t.home, 'skills/synced/real'), { recursive: true })
    symlinkSync(join(t.root, 'outside/group'), join(t.home, 'skills/synced/linked-group'))
    symlinkSync(join(t.root, 'outside/lone'), join(t.home, 'skills/synced/real/linked'))
    expect(await t.reader().read([])).toEqual([])
  })

  it('counts synced skills toward the 48-skill cap', async () => {
    const t = tree()
    for (let i = 0; i < 30; i++) t.put(join(t.home, `skills/u${i}/SKILL.md`), skillMd(`u${i}`, 'x'))
    for (let i = 0; i < 30; i++)
      t.put(join(t.home, `skills/synced/g/s${i}/SKILL.md`), skillMd(`s${i}`, 'x'))
    const skills = (await t.reader().read([])).filter((d) => d.category === 'skill')
    expect(skills).toHaveLength(48)
    // User skills come first, so all 30 survive the cap.
    expect(skills.filter((d) => d.id.startsWith('skill:u'))).toHaveLength(30)
  })

  it('on a name clash: project > user > synced > plugin', async () => {
    const t = tree()
    t.put(join(t.cwd, '.claude/skills/one/SKILL.md'), skillMd('one', 'From project.'))
    t.put(join(t.home, 'skills/synced/g/one/SKILL.md'), skillMd('one', 'From synced.'))
    t.put(join(t.home, 'skills/two/SKILL.md'), skillMd('two', 'From user.'))
    t.put(join(t.home, 'skills/synced/g/two/SKILL.md'), skillMd('two', 'From synced.'))
    t.put(join(t.home, 'skills/synced/g/three/SKILL.md'), skillMd('three', 'From synced.'))
    // A plugin without a usable name yields a bare id, so it can clash with a synced skill.
    t.put(join(t.home, 'plugins/cache/bad name!/skills/three/SKILL.md'), skillMd('three', 'P.'))
    const ds = await t.reader().read([t.cwd])
    const summaries = (id: string) => ds.filter((d) => d.id === id).map((d) => d.summary)
    expect(summaries('skill:one')).toEqual(['From project.'])
    expect(summaries('skill:two')).toEqual(['From user.'])
    expect(summaries('skill:three')).toEqual(['From synced.'])
  })
})
