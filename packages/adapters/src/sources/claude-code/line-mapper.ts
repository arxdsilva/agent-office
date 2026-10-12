import { basename, posix } from 'node:path'
import { PermissionModeSchema, type AgentEvent, type AgentStatus } from '@agent-office/shared'

const PROVIDER = 'claude-code'
const SNIPPET = 80

export interface ParseContext {
  /** Session titles; custom (user-set) wins over AI-generated. */
  titles: Map<string, { ai?: string; custom?: string }>
  /** Subagent metadata from `agent-<id>.meta.json`. */
  meta: Map<string, { agentType?: string; description?: string }>
  /** Last transcript timestamp per session, used for lines without one. */
  lastTs: Map<string, number>
  /** Session cwds → last timestamp. Kept inside the adapter for discovery; never emitted. */
  cwds: Map<string, number>
  /** Where Claude Code keeps user rules, skills and memory; without it those aren't recognized. */
  paths: ClaudePaths
}

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeHome?: string
  /** Usually ~/.claude/projects */
  projectsDir?: string
}

export const newParseContext = (paths: ClaudePaths = {}): ParseContext => ({
  titles: new Map(),
  meta: new Map(),
  lastTs: new Map(),
  cwds: new Map(),
  paths,
})

type Block = {
  type?: string
  name?: string
  input?: Record<string, unknown> & { description?: unknown }
  is_error?: boolean
}

const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'LS',
])
const CMD = /^[a-z0-9._-]{1,20}$/
const HOST = /^[a-z0-9.-]{1,95}$/
const SKILL = /^[A-Za-z0-9:_-]{1,80}$/
const SKILL_DIR = /^[A-Za-z0-9_-]{1,80}$/
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\.md$/
const CONTROL = /[\u0000-\u001f]/

/**
 * The privacy-safe `target` of a tool call (docs/capabilities.md §3). Inputs are matched here and
 * only the fixed-form string leaves the adapter: never a path, URL, argument or content.
 */
function targetOf(
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
  paths: ClaudePaths,
): string | undefined {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  if (name === 'Skill') {
    const skill = str('skill')
    return skill && SKILL.test(skill) ? `skill:${skill}` : undefined
  }
  if (name === 'Bash') {
    const head = str('command')?.trim().split(/\s+/)[0]
    return head && CMD.test(head) ? `cmd:${head}` : undefined
  }
  if (name === 'WebFetch') {
    const url = str('url')
    if (!url || !URL.canParse(url)) return undefined
    const host = new URL(url).hostname
    return HOST.test(host) ? `host:${host}` : undefined
  }
  if (!FILE_TOOLS.has(name)) return undefined
  if (name === 'Read') {
    const file = str('file_path')
    const lib = file && libraryTarget(file, cwd, paths)
    if (lib) return lib
  }
  return projectTarget(cwd)
}

function projectTarget(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const b = basename(cwd)
  return b && !CONTROL.test(b) && !b.includes('\\') ? `project:${b.slice(0, 92)}` : undefined
}

/** `skill:`, `rule:` or `memory:` for a Read of a SKILL.md, a rule file or a memory entry. */
function libraryTarget(
  file: string,
  cwd: string | undefined,
  paths: ClaudePaths,
): string | undefined {
  const norm = (p: string) => posix.normalize(p.replace(/\\/g, '/'))
  const abs = norm(posix.isAbsolute(file.replace(/\\/g, '/')) || !cwd ? file : `${cwd}/${file}`)
  const dir = posix.dirname(abs)
  const name = posix.basename(abs)
  if (name === 'SKILL.md') {
    const skill = posix.basename(dir)
    return posix.basename(posix.dirname(dir)) === 'skills' && SKILL_DIR.test(skill)
      ? `skill:${skill}`
      : undefined
  }
  if (!FILE.test(name)) return undefined
  const home = paths.claudeHome && norm(paths.claudeHome)
  if (home && ((dir === home && name === 'CLAUDE.md') || dir === `${home}/rules`))
    return `rule:user:${name}`
  const projects = paths.projectsDir && norm(paths.projectsDir)
  if (
    projects &&
    posix.basename(dir) === 'memory' &&
    posix.dirname(posix.dirname(dir)) === projects
  )
    return `memory:${name.slice(0, -3)}`
  const root = cwd && norm(cwd)
  if (
    root &&
    ((dir === root && (name === 'CLAUDE.md' || name === 'AGENTS.md')) ||
      dir === `${root}/.claude/rules`)
  )
    return `rule:project:${name}`
  return undefined
}

const snippet = (s: unknown) => (typeof s === 'string' ? s.slice(0, SNIPPET) : '')

/**
 * Maps one transcript line to an agent event. Pure apart from `ctx`, which carries what earlier
 * lines taught us (titles, subagent meta). Only status, tool, title, model and short snippets
 * are extracted — see PRIVACY_SECURITY rule.
 */
export function lineToEvent(raw: string, ctx: ParseContext): AgentEvent | null {
  let d: Record<string, any>
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || typeof d.sessionId !== 'string') return null
  const sessionId: string = d.sessionId

  if (d.type === 'ai-title' || d.type === 'custom-title') {
    const t = ctx.titles.get(sessionId) ?? {}
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') t.ai = d.aiTitle.slice(0, 200)
    if (d.type === 'custom-title' && typeof d.customTitle === 'string')
      t.custom = d.customTitle.slice(0, 200)
    ctx.titles.set(sessionId, t)
    const ts = ctx.lastTs.get(sessionId)
    // Without a timestamp we can't order it safely; the next message line carries the topic instead.
    if (ts === undefined) return null
    return { agentId: `cc:${sessionId}`, topic: titleOf(ctx, sessionId)!, source: PROVIDER, ts }
  }

  if (d.type !== 'user' && d.type !== 'assistant') return null
  const ts = Date.parse(d.timestamp)
  if (Number.isNaN(ts)) return null
  ctx.lastTs.set(sessionId, Math.max(ts, ctx.lastTs.get(sessionId) ?? 0))

  const content: Block[] | string = d.message?.content ?? []
  const blocks = Array.isArray(content) ? content : []
  let status: AgentStatus = 'thinking'
  let tool: string | undefined
  let target: string | undefined
  let text = ''
  const cwd = typeof d.cwd === 'string' && d.cwd ? d.cwd : undefined
  if (cwd) ctx.cwds.set(cwd, Math.max(ts, ctx.cwds.get(cwd) ?? 0))

  if (d.type === 'assistant') {
    const uses = blocks.filter((b) => b?.type === 'tool_use')
    const last = uses[uses.length - 1]
    if (last) {
      status = 'tool'
      tool = typeof last.name === 'string' ? last.name.slice(0, 100) : 'tool'
      text = snippet(last.input?.description)
      const input = last.input && typeof last.input === 'object' ? last.input : {}
      target = targetOf(tool, input, cwd, ctx.paths)
    } else if (
      d.message?.stop_reason === 'end_turn' ||
      d.message?.stop_reason === 'stop_sequence'
    ) {
      status = 'waiting'
    }
  } else if (blocks.some((b) => b?.type === 'tool_result' && b.is_error)) {
    text = 'tool error'
  }

  const cwdName = cwd ? basename(cwd) : 'claude'
  const model =
    typeof d.message?.model === 'string' && d.message.model !== '<synthetic>'
      ? d.message.model
      : undefined
  const event: AgentEvent = {
    agentId: `cc:${sessionId}`,
    provider: PROVIDER,
    source: PROVIDER,
    name: cwdName.slice(0, 100),
    topic: titleOf(ctx, sessionId) ?? cwdName.slice(0, 200),
    status,
    text,
    ts,
    ...(tool ? { tool } : {}),
    ...(target ? { target } : {}),
    ...(model ? { model: model.slice(0, 100) } : {}),
  }

  if (d.isSidechain && typeof d.agentId === 'string') {
    const meta = ctx.meta.get(d.agentId)
    event.agentId = `cc:${d.agentId}`
    event.parentId = `cc:${sessionId}`
    event.name = (meta?.agentType ?? `sub·${d.agentId.slice(0, 6)}`).slice(0, 100)
    if (meta?.agentType) event.kind = meta.agentType.slice(0, 100)
    if (!text && meta?.description) event.text = snippet(meta.description)
  } else if (d.type === 'user') {
    // Only the session's own prompts carry its permission mode (Shift+Tab); subagents never do.
    const mode = PermissionModeSchema.safeParse(d.permissionMode)
    if (mode.success) event.permissionMode = mode.data
  }
  return event
}

function titleOf(ctx: ParseContext, sessionId: string): string | undefined {
  const t = ctx.titles.get(sessionId)
  return t?.custom ?? t?.ai
}
