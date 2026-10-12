import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CapabilityDecl, CapabilityScope } from '@agent-office/shared'

/** Limits from docs/capabilities.md §4. */
export const KNOWLEDGE_LIMITS = {
  skills: 48,
  rules: 24,
  memory: 24,
  maxFileBytes: 256 * 1024,
  parseBytes: 4 * 1024,
  summaryChars: 160,
} as const

const LABEL = 80
const NAME = /^[A-Za-z0-9_-]{1,80}$/
const PLUGIN = /^[A-Za-z0-9_-]{1,40}$/
const SKILL_ID = /^[A-Za-z0-9:_-]{1,80}$/
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\.md$/
const MAX_PLUGIN_DIRS = 2000
const MAX_PLUGIN_DEPTH = 6

export interface KnowledgeReaderOptions {
  /** Usually ~/.claude */
  claudeHome: string
  /** Usually ~/.claude/projects */
  projectsDir?: string
}

/** Claude Code names a project dir after its cwd with every non-alphanumeric turned into '-'. */
export const encodeCwd = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

interface Parsed {
  front: Record<string, string>
  body: string
}

/**
 * Discovers skills, rules and memory titles for Claude Code (docs/capabilities.md §4). Read-only,
 * never logs, never follows symlinks, reads at most 4 KB of each file. Memory entries yield only
 * their frontmatter `name` — never a summary (PRIVACY_SECURITY rule).
 */
export class ClaudeKnowledgeReader {
  private projectsDir: string

  constructor(private o: KnowledgeReaderOptions) {
    this.projectsDir = o.projectsDir ?? join(o.claudeHome, 'projects')
  }

  async read(cwds: string[]): Promise<CapabilityDecl[]> {
    const L = KNOWLEDGE_LIMITS
    const skills: CapabilityDecl[] = []
    for (const cwd of cwds)
      skills.push(...(await this.skillsIn(join(cwd, '.claude/skills'), 'project')))
    skills.push(...(await this.skillsIn(join(this.o.claudeHome, 'skills'), 'user')))
    skills.push(...(await this.pluginSkills()))

    const rules: CapabilityDecl[] = []
    for (const cwd of cwds) rules.push(...(await this.projectRules(cwd)))
    rules.push(...(await this.userRules()))

    const memory: CapabilityDecl[] = []
    for (const cwd of cwds)
      memory.push(...(await this.memoryIn(join(this.projectsDir, encodeCwd(cwd), 'memory'))))

    return [
      ...dedup(skills).slice(0, L.skills),
      ...dedup(rules).slice(0, L.rules),
      ...dedup(memory).slice(0, L.memory),
    ]
  }

  private async skillsIn(dir: string, scope: CapabilityScope, plugin?: string) {
    const out: CapabilityDecl[] = []
    for (const d of await dirs(dir)) {
      const parsed = await readHead(join(dir, d, 'SKILL.md'))
      if (!parsed) continue
      const name = parsed.front.name ?? d
      if (!NAME.test(name)) continue
      const full = plugin ? `${plugin}:${name}` : name
      if (!SKILL_ID.test(full)) continue
      const summary = cut(parsed.front.description)
      out.push({
        id: `skill:${full}`,
        category: 'skill',
        kind: 'skill',
        label: full,
        ...(summary ? { summary } : {}),
        scope,
      })
    }
    return out.sort((a, b) => (a.label < b.label ? -1 : 1))
  }

  /** Skills anywhere under `~/.claude/plugins` (scope plugin), skipping dot-dirs and marketplace listings. */
  private async pluginSkills(): Promise<CapabilityDecl[]> {
    const out: CapabilityDecl[] = []
    let visited = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_PLUGIN_DEPTH) return
      for (const d of await dirs(dir)) {
        if (++visited > MAX_PLUGIN_DIRS) return
        if (d.startsWith('.') || d === 'marketplaces') continue
        const sub = join(dir, d)
        if (d === 'skills') out.push(...(await this.skillsIn(sub, 'plugin', await pluginName(dir))))
        else await walk(sub, depth + 1)
      }
    }
    await walk(join(this.o.claudeHome, 'plugins'), 0)
    return out
  }

  private async projectRules(cwd: string): Promise<CapabilityDecl[]> {
    const project = basename(cwd)
    const out: CapabilityDecl[] = []
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const p = await readHead(join(cwd, file))
      if (p) out.push(rule('project', file, `${file} (${project})`, 'project-rules', p))
    }
    out.push(...(await this.rulesIn(join(cwd, '.claude/rules'), 'project')))
    return out
  }

  private async userRules(): Promise<CapabilityDecl[]> {
    const p = await readHead(join(this.o.claudeHome, 'CLAUDE.md'))
    return [
      ...(p ? [rule('user', 'CLAUDE.md', 'CLAUDE.md (you)', 'user-rules', p)] : []),
      ...(await this.rulesIn(join(this.o.claudeHome, 'rules'), 'user')),
    ]
  }

  private async rulesIn(dir: string, scope: 'project' | 'user'): Promise<CapabilityDecl[]> {
    const out: CapabilityDecl[] = []
    for (const file of (await files(dir)).filter((f) => FILE.test(f)).sort()) {
      const p = await readHead(join(dir, file))
      if (p) out.push(rule(scope, file, title(p.body) ?? file, 'rule', p))
    }
    return out
  }

  private async memoryIn(dir: string): Promise<CapabilityDecl[]> {
    const out: CapabilityDecl[] = []
    for (const file of (await files(dir)).filter((f) => FILE.test(f)).sort()) {
      const name = (await readHead(join(dir, file)))?.front.name
      if (!name) continue
      // Titles only: memory may hold personal facts, so it never gets a summary.
      out.push({
        id: `memory:${file.slice(0, -3)}`,
        category: 'rule',
        kind: 'memory',
        label: name.slice(0, LABEL),
      })
    }
    return out
  }
}

function rule(
  scope: 'project' | 'user',
  file: string,
  label: string,
  kind: 'project-rules' | 'user-rules' | 'rule',
  p: Parsed,
): CapabilityDecl {
  const summary = firstSentence(p.body)
  return {
    id: `rule:${scope}:${file}`,
    category: 'rule',
    kind,
    label: label.slice(0, LABEL),
    ...(summary ? { summary } : {}),
    scope,
  }
}

function dedup(ds: CapabilityDecl[]): CapabilityDecl[] {
  const seen = new Set<string>()
  return ds.filter((d) => !seen.has(d.id) && !!seen.add(d.id))
}

const cut = (s: string | undefined) =>
  s?.trim().slice(0, KNOWLEDGE_LIMITS.summaryChars) || undefined

/** Real (non-symlink) subdirectories; [] when missing. */
async function dirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/** Real (non-symlink) files; [] when missing. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => e.name)
}

/** The first 4 KB of a regular file ≤ 256 KB, split into frontmatter and body. */
async function readHead(path: string): Promise<Parsed | undefined> {
  const text = await readBytes(path, KNOWLEDGE_LIMITS.maxFileBytes, KNOWLEDGE_LIMITS.parseBytes)
  return text === undefined ? undefined : parse(text)
}

async function readBytes(path: string, maxSize: number, n: number): Promise<string | undefined> {
  try {
    const s = await lstat(path)
    if (!s.isFile() || s.size > maxSize) return undefined
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(n, s.size))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/** The plugin's name from `.claude-plugin/plugin.json`, else its directory name. */
async function pluginName(root: string): Promise<string | undefined> {
  const raw = await readBytes(join(root, '.claude-plugin/plugin.json'), 64 * 1024, 64 * 1024)
  try {
    const name: unknown = raw && JSON.parse(raw).name
    if (typeof name === 'string' && PLUGIN.test(name)) return name
  } catch {
    /* fall back to the directory name */
  }
  let dir = basename(root)
  if (/^\d+(\.\d+)+/.test(dir)) dir = basename(dirname(root))
  dir = dir.replace(/~.*$/, '')
  return PLUGIN.test(dir) ? dir : undefined
}

function parse(text: string): Parsed {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return { front: {}, body: lines.join('\n') }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { front: {}, body: '' }
  const front: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    let value = m[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const folded: string[] = []
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) folded.push(lines[++i]!.trim())
      value = folded.join(' ')
    }
    front[m[1]!] = value.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { front, body: lines.slice(end + 1).join('\n') }
}

/** The first `# ` heading. */
function title(body: string): string | undefined {
  const line = body.split('\n').find((l) => l.startsWith('# '))
  return line?.slice(2).trim() || undefined
}

const NOT_PROSE = /^(#|\||>|<|@|-|\*|\+|\d+[.)]\s|---|===|!\[)/

/** The first prose sentence (no headings, lists, tables, code, quotes or imports), ≤ 160 chars. */
function firstSentence(body: string): string | undefined {
  let fenced = false
  const para: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced
      if (para.length) break
      continue
    }
    if (fenced) continue
    if (!line || NOT_PROSE.test(line)) {
      if (para.length) break
      continue
    }
    para.push(line)
  }
  if (!para.length) return undefined
  const text = para
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text
  return cut(sentence)
}
