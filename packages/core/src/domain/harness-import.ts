import type {
  ImportCandidateView,
  ImportGateSuggestion,
  RuleCategory,
  RuleSourceFormat,
  RuleSourceView,
} from '@agent-office/shared'

/** Pure rule-file parsing for the harness importer (docs/harness.md §5). Never executes anything. */

export type RawCandidate = Omit<ImportCandidateView, 'tempId' | 'duplicateOf' | 'conflictsWith'>
export type RawGate = Omit<ImportGateSuggestion, 'tempId'>
export interface ParsedRuleFile {
  candidates: RawCandidate[]
  gates: RawGate[]
}

const MAX_TEXT = 2000
const MIN_TEXT = 12
const NAME_MAX = 120

// ── Which files are rule sources ────────────────────────────────────────────────────────────────

const AGENTS_DEPTH = 4

/** Candidate paths per format, for the reader. Paths are repo-relative POSIX. */
export const RULE_FILE_RULES: readonly {
  format: RuleSourceFormat
  test(relPath: string): boolean
}[] = [
  {
    format: 'agents-md',
    test: (p) => /(^|\/)AGENTS\.md$/.test(p) && p.split('/').length <= AGENTS_DEPTH + 1,
  },
  { format: 'claude-md', test: (p) => p === 'CLAUDE.md' || p === '.claude/CLAUDE.md' },
  { format: 'claude-rule', test: (p) => /^\.claude\/rules\/(?:[^/]+\/)*[^/]+\.md$/.test(p) },
  { format: 'cursor-mdc', test: (p) => /^\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.mdc$/.test(p) },
  { format: 'cursorrules', test: (p) => p === '.cursorrules' },
  { format: 'gemini-md', test: (p) => p === 'GEMINI.md' },
  { format: 'copilot-instructions', test: (p) => p === '.github/copilot-instructions.md' },
  {
    format: 'copilot-instruction-file',
    test: (p) => /^\.github\/instructions\/[^/]+\.instructions\.md$/.test(p),
  },
  { format: 'makefile', test: (p) => p === 'Makefile' },
  { format: 'ci-workflow', test: (p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) },
]

export function formatOf(relPath: string): RuleSourceFormat | undefined {
  return RULE_FILE_RULES.find((r) => r.test(relPath))?.format
}

// ── Category ────────────────────────────────────────────────────────────────────────────────────

const CATEGORY_WORDS: [RuleCategory, string[]][] = [
  [
    'architecture',
    ['layer', 'port', 'adapter', 'dependency', 'dependencies', 'hexagonal', 'import', 'module'],
  ],
  ['testing', ['test', 'tdd', 'coverage', 'spec', 'vitest', 'playwright']],
  [
    'security',
    ['secret', 'token', 'auth', 'password', 'permission', 'sandbox', 'privacy', 'leak', 'csp'],
  ],
  ['workflow', ['commit', 'branch', 'pr', 'review', 'git', 'release', 'ci']],
  ['tools', ['pnpm', 'make', 'cli', 'command', 'tool', 'mcp', 'hook']],
  ['completion', ['done', 'definition of done', 'before declaring', 'verify', 'check']],
]

const CATEGORY_RES = CATEGORY_WORDS.map(([cat, words]) => {
  const alt = words.map((w) => (w.length <= 3 ? `${w}s?\\b` : w)).join('|')
  return [cat, new RegExp(`\\b(?:${alt})`, 'i')] as const
})

export function classifyCategory(text: string): RuleCategory {
  for (const [cat, re] of CATEGORY_RES) if (re.test(text)) return cat
  return 'coding'
}

const SEVERE = /\b(?:must|never|always|required|do not|don't)\b/i

// ── Frontmatter ─────────────────────────────────────────────────────────────────────────────────

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2')

function listValue(v: string): string[] {
  const t = unquote(v)
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t
  return inner
    .split(',')
    .map(unquote)
    .filter((s) => s.length > 0)
}

function splitFrontmatter(text: string): { front: Record<string, string[]>; body: string } {
  const src = text.replace(/\r\n?/g, '\n')
  if (!src.startsWith('---\n')) return { front: {}, body: src }
  const end = src.indexOf('\n---', 4)
  if (end < 0) return { front: {}, body: src }
  const after = src.indexOf('\n', end + 1)
  const body = after < 0 ? '' : src.slice(after + 1)
  const front: Record<string, string[]> = {}
  let key: string | undefined
  for (const line of src.slice(4, end).split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && key) {
      ;(front[key] ??= []).push(unquote(item[1] ?? ''))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    key = kv[1]!
    front[key] = (kv[2] ?? '').trim() === '' ? [] : listValue(kv[2]!)
  }
  return { front, body }
}

// ── Gates ───────────────────────────────────────────────────────────────────────────────────────

const COMMAND_START =
  /^(?:make|pnpm|npm run|npx|go test|go vet|cargo test|pytest|curl|wget|bash|sh|zsh|sudo|rm|cat|eval|git|docker|node|python3?|pip|yarn|bun|deno|cargo|go|npm|ssh|scp|chmod|chown|mv|cp|dd|nc)\b/
const KNOWN_GATE = /^(?:make|pnpm|npm run|npx|go test|go vet|cargo test|pytest)\b/
const SHELL_META = /[|;&><$`(){}*?~!'"\\]/

const REJECT_META = 'shell metacharacters; add this gate by hand'

function gateFromLine(raw: string, source: RuleSourceView): RawGate | undefined {
  const line = raw.trim().replace(/^\$\s+/, '')
  if (!COMMAND_START.test(line) || line.length > 200) return undefined
  const argv = line.split(/\s+/)
  if (SHELL_META.test(line)) return { name: line.slice(0, 80), argv, source, rejected: REJECT_META }
  if (!KNOWN_GATE.test(line))
    return {
      name: line.slice(0, 80),
      argv,
      source,
      rejected: 'not a recognized gate command; add this gate by hand',
    }
  return { name: line.slice(0, 80), argv, source }
}

function makefileGates(text: string, source: RuleSourceView): RawGate[] {
  const out: RawGate[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9._-]+):(?!=)/.exec(line)
    const t = m?.[1]
    if (!t || t.startsWith('.') || t === 'help' || seen.has(t)) continue
    seen.add(t)
    out.push({ name: `make ${t}`, argv: ['make', t], source })
  }
  return out
}

function ciGates(text: string, source: RuleSourceView): RawGate[] {
  const out: RawGate[] = []
  let inJobs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (inJobs && /^\S/.test(line) && !line.startsWith('#')) inJobs = false
    const m = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null
    if (m?.[1])
      out.push({
        name: m[1],
        argv: ['make', m[1]],
        source,
        rejected: 'CI job; map to a local command by hand',
      })
  }
  return out
}

// ── Body → candidates ───────────────────────────────────────────────────────────────────────────

function clip(text: string): string {
  if (text.length <= MAX_TEXT) return text
  const cut = text.slice(0, MAX_TEXT - 1)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return `${(end > 200 ? cut.slice(0, end + 1) : cut).trimEnd()}…`
}

function nameOf(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/.exec(text)
  const first = m ? m[0] : text
  return (first.length <= NAME_MAX ? first : text).slice(0, NAME_MAX).trim()
}

const isSkippable = (t: string) =>
  t.length < MIN_TEXT ||
  /^!\[/.test(t) ||
  /^<?https?:\/\/\S+>?$/.test(t) ||
  /^\[[^\]]*\]\([^)]*\)$/.test(t) ||
  /^@\S+$/.test(t)

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

function textCandidates(body: string, source: RuleSourceView, gates: RawGate[]): string[] {
  const texts: string[] = []
  const lines = body.split('\n')
  let para: string[] = []
  let bullet: string[] | null = null
  let fence: string | null = null
  let header: string[] | null = null

  const flushPara = () => {
    const t = para.join(' ').replace(/\s+/g, ' ').trim()
    para = []
    if (t && !t.endsWith(':')) texts.push(t)
  }
  const flushBullet = () => {
    if (bullet) texts.push(bullet.join(' ').replace(/\s+/g, ' ').trim())
    bullet = null
  }
  const flush = () => {
    flushPara()
    flushBullet()
  }

  for (const line of lines) {
    const fenceM = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (fenceM && line.trim().startsWith(fence)) fence = null
      else {
        const g = gateFromLine(line, source)
        if (g) gates.push(g)
      }
      continue
    }
    if (fenceM) {
      flush()
      header = null
      fence = fenceM[1]!
      continue
    }
    if (isTableRow(line)) {
      flush()
      if (isSeparator(line)) continue
      if (!header) {
        header = cells(line)
        continue
      }
      const row = cells(line)
      const doCol = header.findIndex((h) => /^do\b/i.test(h))
      const dontCol = header.findIndex((h) => /^don'?t\b/i.test(h))
      if (doCol >= 0 && dontCol >= 0) {
        if (row[doCol]) texts.push(`Do: ${row[doCol]}`)
        if (row[dontCol]) texts.push(`Don't: ${row[dontCol]}`)
      } else {
        const t = row.filter(Boolean).join(': ')
        if (t) texts.push(t)
      }
      continue
    }
    header = null
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(?:-{3,}|\*{3,})\s*$/.test(line) || line.trim() === '') {
      flush()
      continue
    }
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (b) {
      flush()
      bullet = [b[2] ?? '']
      continue
    }
    if (bullet && /^\s+\S/.test(line)) bullet.push(line.trim())
    else {
      flushBullet()
      para.push(line.trim())
    }
  }
  flush()
  return texts
}

function toCandidates(texts: string[], source: RuleSourceView): RawCandidate[] {
  const out: RawCandidate[] = []
  for (const raw of texts) {
    const stripped = raw.replace(/^\[[ xX]\]\s+/, '').trim()
    if (isSkippable(stripped)) continue
    const text = clip(stripped)
    out.push({
      name: nameOf(text),
      text,
      category: classifyCategory(text),
      enforcement: 'instruction',
      severity: SEVERE.test(text) ? 'required' : 'recommended',
      source,
    })
  }
  return out
}

export function parseRuleFile(
  format: RuleSourceFormat,
  text: string,
  source: RuleSourceView,
): ParsedRuleFile {
  if (format === 'makefile') return { candidates: [], gates: makefileGates(text, source) }
  if (format === 'ci-workflow') return { candidates: [], gates: ciGates(text, source) }

  const { front, body } =
    format === 'cursorrules' ? { front: {}, body: text } : splitFrontmatter(text)
  const globs = [
    ...((front as Record<string, string[]>).globs ?? []),
    ...((front as Record<string, string[]>).paths ?? []),
    ...((front as Record<string, string[]>).applyTo ?? []),
  ]
  const src: RuleSourceView = globs.length > 0 ? { ...source, globs } : source

  const gates: RawGate[] = []
  const texts =
    format === 'cursorrules'
      ? body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
      : textCandidates(body.replace(/\r\n?/g, '\n'), src, gates)

  const seen = new Set<string>()
  const uniqueGates = gates.filter((g) => {
    const k = g.argv.join('\0')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { candidates: toCandidates(texts, src), gates: uniqueGates }
}
