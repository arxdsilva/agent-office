// The harness policy engine (docs/harness.md §3): compiles `runtime-policy` rules once into a
// synchronous, total evaluator. Deny beats ask; anything unreadable in a shell command turns into
// ask; any internal error is a deny. Globs are compiled through our own escaper (no user RegExp).
import type { FsIsolation } from '@agent-office/shared'
import type { ActionPolicy, PolicyAction, PolicyDecision, PolicyRule } from './harness-types.ts'
import { parseCommands, type ParsedCommands } from './shell-words.ts'

export const OUTSIDE = '@outside'
export const OPAQUE_RULE = 'harness:opaque-command'
export const OPAQUE_REASON =
  'This command could not be read reliably (substitution, eval or quoting); confirm it first.'
const POLICY_ERROR = 'policy error'
const MAX_GLOB = 200

export const TOOL_CLASSES = {
  write: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  read: ['Read', 'Glob', 'Grep'],
  exec: ['Bash'],
  fetch: ['WebFetch', 'WebSearch'],
  agent: ['Task', 'Agent'],
} as const
export type ToolClass = keyof typeof TOOL_CLASSES | 'mcp'

export function toolClass(tool: string): ToolClass | undefined {
  if (tool.startsWith('mcp__')) return 'mcp'
  for (const [k, list] of Object.entries(TOOL_CLASSES))
    if ((list as readonly string[]).includes(tool)) return k as ToolClass
  return undefined
}

// ── globs ──

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/** Splits `a,b{c,d}` on top-level commas. */
function alternatives(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '{') depth++
    if (c === '}') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function globBody(g: string, star: string, any: string): string {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += star
    } else if (c === '?') re += any
    else if (c === '{') {
      let depth = 0
      let j = i
      for (; j < g.length; j++) {
        if (g[j] === '{') depth++
        else if (g[j] === '}' && --depth === 0) break
      }
      if (j >= g.length) {
        re += escapeRe(c)
        continue
      }
      re += `(?:${alternatives(g.slice(i + 1, j))
        .map((a) => globBody(a, star, any))
        .join('|')})`
      i = j
    } else re += escapeRe(c)
  }
  return re
}

/**
 * A repo-relative path glob: `**`, `*`, `?`, `{a,b}`. A pattern without `/` matches at any depth
 * (like .gitignore); a leading `/` anchors it to the root; a trailing `/` names a directory.
 */
export function compileGlob(glob: string): RegExp {
  if (glob.length > MAX_GLOB) throw new Error('glob too long')
  let g = glob.replace(/\\/g, '/')
  if (g.endsWith('/') && g.length > 1) g = g.slice(0, -1)
  const anchored = g.startsWith('/')
  if (anchored) g = g.slice(1)
  const prefix = !anchored && !g.includes('/') ? '(?:.*/)?' : ''
  return new RegExp(`^${prefix}${globBody(g, '[^/]*', '[^/]')}$`)
}

function compileHostGlob(glob: string): RegExp {
  if (glob.length > MAX_GLOB) throw new Error('glob too long')
  return new RegExp(`^${globBody(glob.toLowerCase(), '[^/]*', '[^/]')}$`)
}

function compileToolPattern(p: string): (tool: string) => boolean {
  if (p.startsWith('class:')) {
    const k = p.slice(6)
    if (k === 'mcp') return (t) => t.startsWith('mcp__')
    const list = (TOOL_CLASSES as Record<string, readonly string[]>)[k] ?? []
    return (t) => list.includes(t)
  }
  if (!p.includes('*')) return (t) => t === p
  const re = new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`)
  return (t) => re.test(t)
}

// ── paths ──

const DRIVE = /^[a-zA-Z]:\//

/** Resolves `.`/`..`; null when a relative path climbs above its start. */
function lexical(segments: string[], clampAtRoot: boolean): string[] | null {
  const out: string[] = []
  for (const s of segments) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (out.length) out.pop()
      else if (!clampAtRoot) return null
    } else out.push(s)
  }
  return out
}

function absolute(p: string): string {
  const root = DRIVE.test(p) ? p.slice(0, 2) : ''
  const segs = lexical((root ? p.slice(2) : p).split('/'), true)!
  return `${root}/${segs.join('/')}`
}

/** cwd-relative POSIX path; `@outside` for anything that escapes the working directory. */
export function normalizePath(path: string, cwd: string): string {
  const s = path.replace(/\\/g, '/')
  if (s.startsWith('~')) return OUTSIDE
  if (!s.startsWith('/') && !DRIVE.test(s)) {
    const segs = lexical(s.split('/'), false)
    return segs === null ? OUTSIDE : segs.join('/') || '.'
  }
  const c = cwd.replace(/\\/g, '/')
  if (!c.startsWith('/') && !DRIVE.test(c)) return OUTSIDE
  const ap = absolute(s)
  const ac = absolute(c)
  const windows = DRIVE.test(s) || DRIVE.test(c)
  const cmp = (x: string) => (windows ? x.toLowerCase() : x)
  if (cmp(ap) === cmp(ac)) return '.'
  const base = ac.endsWith('/') ? ac : `${ac}/`
  return cmp(ap).startsWith(cmp(base)) ? ap.slice(base.length) || '.' : OUTSIDE
}

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path'])
    if (typeof input[k] === 'string' && input[k]) out.push(input[k] as string)
  const many = input.file_paths
  if (Array.isArray(many)) for (const p of many) if (typeof p === 'string' && p) out.push(p)
  return out
}

function hostOf(input: Record<string, unknown>): string | undefined {
  const url = input.url
  if (typeof url !== 'string') return undefined
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)
  return m?.[1]?.toLowerCase()
}

/** The path and each of its ancestors, so `secrets/` covers everything below it. */
function withAncestors(p: string): string[] {
  const parts = p.split('/')
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('/'))
}

// ── compile ──

interface Compiled {
  rule: PolicyRule
  tools?: ((t: string) => boolean)[]
  paths?: RegExp[]
  except: RegExp[]
  commands?: Set<string>
  hosts?: RegExp[]
  roles?: Set<string>
  providers?: Set<string>
}

const nonEmpty = <T>(a: T[] | undefined): a is T[] => !!a && a.length > 0

function compileRule(r: PolicyRule): Compiled {
  return {
    rule: r,
    ...(nonEmpty(r.tools) ? { tools: r.tools.map(compileToolPattern) } : {}),
    ...(nonEmpty(r.paths) ? { paths: r.paths.map(compileGlob) } : {}),
    except: (r.except ?? []).map(compileGlob),
    ...(nonEmpty(r.commands) ? { commands: new Set(r.commands.map((c) => c.toLowerCase())) } : {}),
    ...(nonEmpty(r.hosts) ? { hosts: r.hosts.map(compileHostGlob) } : {}),
    ...(nonEmpty(r.roles) ? { roles: new Set(r.roles) } : {}),
    ...(nonEmpty(r.providers) ? { providers: new Set<string>(r.providers) } : {}),
  }
}

const ALLOW: PolicyDecision = { action: 'allow', ruleIds: [], reason: '', basis: 'exact' }

function evaluateWith(rules: Compiled[], a: PolicyAction): PolicyDecision {
  const input = a.input && typeof a.input === 'object' ? a.input : {}
  const role = a.agentRole ?? 'main'
  const exec = toolClass(a.tool) === 'exec'
  const basis = exec ? 'heuristic' : 'exact'
  let rel: string[] | undefined
  let host: string | undefined | null = null
  let parsed: ParsedCommands | undefined
  const commandsOf = () =>
    (parsed ??= parseCommands(typeof input.command === 'string' ? input.command : ''))
  const deny: Compiled[] = []
  const ask: Compiled[] = []
  let opaque = false

  for (const c of rules) {
    if (c.roles && !c.roles.has(role)) continue
    if (c.providers && a.provider && !c.providers.has(a.provider)) continue
    if (c.commands && exec && commandsOf().opaque) opaque = true
    if (!c.tools && !c.paths && !c.commands && !c.hosts) continue
    if (c.tools && !c.tools.some((t) => t(a.tool))) continue
    if (c.paths) {
      rel ??= pathsOf(input).map((p) => normalizePath(p, a.cwd))
      const hit = rel.some((p) => {
        const all = withAncestors(p)
        return (
          all.some((x) => c.paths!.some((g) => g.test(x))) &&
          !all.some((x) => c.except.some((g) => g.test(x)))
        )
      })
      if (!hit) continue
    }
    if (c.hosts) {
      if (host === null) host = hostOf(input)
      const h = host
      if (!h || !c.hosts.some((g) => g.test(h))) continue
    }
    if (c.commands) {
      if (!exec) continue
      const names = c.commands
      if (!commandsOf().commands.some((x) => names.has(x.name))) continue
    }
    ;(c.rule.effect === 'deny' ? deny : ask).push(c)
  }
  if (deny.length)
    return {
      action: 'deny',
      ruleIds: deny.map((c) => c.rule.id),
      reason: deny[0]!.rule.reason,
      basis,
    }
  if (ask.length || opaque)
    return {
      action: 'ask',
      ruleIds: [...ask.map((c) => c.rule.id), ...(opaque ? [OPAQUE_RULE] : [])],
      reason: ask[0]?.rule.reason ?? OPAQUE_REASON,
      basis,
    }
  return { ...ALLOW, basis }
}

/** Compiles rules once. The evaluator never throws: a compile or runtime error denies. */
export function compilePolicy(rules: PolicyRule[]): (a: PolicyAction) => PolicyDecision {
  const fail = (): PolicyDecision => ({
    action: 'deny',
    ruleIds: [],
    reason: POLICY_ERROR,
    basis: 'exact',
  })
  let compiled: Compiled[]
  try {
    compiled = rules.map(compileRule)
  } catch {
    return fail
  }
  return (a) => {
    try {
      return evaluateWith(compiled, a)
    } catch {
      return fail()
    }
  }
}

// ── native parts ──

function expandTools(tools: string[]): string[] {
  const out: string[] = []
  for (const t of tools) {
    if (!t.startsWith('class:')) out.push(t)
    else if (t === 'class:mcp') out.push('mcp__*')
    else out.push(...((TOOL_CLASSES as Record<string, readonly string[]>)[t.slice(6)] ?? []))
  }
  return [...new Set(out)]
}

const has = (a: unknown[] | undefined) => !!a && a.length > 0

/** Static parts a runtime can apply natively; only rules with no other condition qualify. */
export function nativeOf(rules: PolicyRule[], fsIsolation: FsIsolation): ActionPolicy['native'] {
  const n: ActionPolicy['native'] = {
    deniedTools: [],
    denyPaths: [],
    askPaths: [],
    denyCommands: [],
    askCommands: [],
    fsIsolation,
  }
  for (const r of rules) {
    if (has(r.roles) || has(r.providers) || has(r.except) || has(r.hosts)) continue
    const deny = r.effect === 'deny'
    if (has(r.tools) && !has(r.paths) && !has(r.commands)) {
      if (deny) n.deniedTools.push(...expandTools(r.tools!))
    } else if (has(r.paths) && !has(r.tools) && !has(r.commands)) {
      ;(deny ? n.denyPaths : n.askPaths).push(...r.paths!)
    } else if (
      has(r.commands) &&
      !has(r.paths) &&
      (r.tools ?? []).every((t) => t === 'Bash' || t === 'class:exec')
    ) {
      ;(deny ? n.denyCommands : n.askCommands).push(...r.commands!)
    }
  }
  n.deniedTools = [...new Set(n.deniedTools)]
  return n
}
