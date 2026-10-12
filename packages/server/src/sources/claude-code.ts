import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, AgentStatus } from '@agent-office/shared'
import type { AgentStore } from '../store.ts'

const PROVIDER = 'claude-code'
const SNIPPET = 80
const TAIL_BYTES = 64 * 1024

export interface ParseContext {
  /** Session titles; custom (user-set) wins over AI-generated. */
  titles: Map<string, { ai?: string; custom?: string }>
  /** Subagent metadata from `agent-<id>.meta.json`. */
  meta: Map<string, { agentType?: string; description?: string }>
  /** Last transcript timestamp per session, used for lines without one. */
  lastTs: Map<string, number>
}

export const newParseContext = (): ParseContext => ({
  titles: new Map(),
  meta: new Map(),
  lastTs: new Map(),
})

type Block = { type?: string; name?: string; input?: { description?: unknown }; is_error?: boolean }

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
  let text = ''

  if (d.type === 'assistant') {
    const uses = blocks.filter((b) => b?.type === 'tool_use')
    const last = uses[uses.length - 1]
    if (last) {
      status = 'tool'
      tool = typeof last.name === 'string' ? last.name.slice(0, 100) : 'tool'
      text = snippet(last.input?.description)
    } else if (
      d.message?.stop_reason === 'end_turn' ||
      d.message?.stop_reason === 'stop_sequence'
    ) {
      status = 'waiting'
    }
  } else if (blocks.some((b) => b?.type === 'tool_result' && b.is_error)) {
    text = 'tool error'
  }

  const cwdName = typeof d.cwd === 'string' && d.cwd ? basename(d.cwd) : 'claude'
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
    ...(model ? { model: model.slice(0, 100) } : {}),
  }

  if (d.isSidechain && typeof d.agentId === 'string') {
    const meta = ctx.meta.get(d.agentId)
    event.agentId = `cc:${d.agentId}`
    event.parentId = `cc:${sessionId}`
    event.name = (meta?.agentType ?? `sub·${d.agentId.slice(0, 6)}`).slice(0, 100)
    if (meta?.agentType) event.kind = meta.agentType.slice(0, 100)
    if (!text && meta?.description) event.text = snippet(meta.description)
  }
  return event
}

function titleOf(ctx: ParseContext, sessionId: string): string | undefined {
  const t = ctx.titles.get(sessionId)
  return t?.custom ?? t?.ai
}

export interface ClaudeCodeSourceOptions {
  /** Usually ~/.claude/projects */
  dir: string
  store: AgentStore
  /** Files and events older than this are ignored. */
  expireAfterMs: number
  now?: () => number
  log?: (msg: string) => void
}

interface Tail {
  offset: number
  partial: string
}

/** Polls Claude Code transcript files and feeds new lines into the store. */
export class ClaudeCodeSource {
  private ctx = newParseContext()
  private tails = new Map<string, Tail>()
  private warned = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private running = false
  private now: () => number
  private log: (msg: string) => void

  constructor(private opts: ClaudeCodeSourceOptions) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  start(pollMs = 1000): void {
    const loop = async () => {
      await this.tick()
      if (this.timer) this.timer = setTimeout(loop, pollMs)
    }
    this.timer = setTimeout(loop, 0)
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** One polling pass. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const file of await this.activeFiles()) await this.readFile(file)
    } finally {
      this.running = false
    }
  }

  private async activeFiles(): Promise<string[]> {
    const cutoff = this.now() - this.opts.expireAfterMs
    const candidates: string[] = []
    for (const project of await this.list(this.opts.dir)) {
      const projectDir = join(this.opts.dir, project)
      for (const entry of await this.list(projectDir)) {
        if (entry.endsWith('.jsonl')) candidates.push(join(projectDir, entry))
        else {
          const subDir = join(projectDir, entry, 'subagents')
          for (const sub of await this.list(subDir))
            if (sub.endsWith('.jsonl')) candidates.push(join(subDir, sub))
        }
      }
    }
    const active: string[] = []
    for (const f of candidates) {
      const s = await stat(f).catch(() => undefined)
      if (s?.isFile() && s.mtimeMs >= cutoff) active.push(f)
    }
    return active
  }

  private async list(dir: string): Promise<string[]> {
    return readdir(dir).catch(() => [])
  }

  private async readFile(file: string): Promise<void> {
    try {
      const { size } = await stat(file)
      let tail = this.tails.get(file)
      if (!tail) {
        await this.prime(file)
        tail = { offset: Math.max(0, size - TAIL_BYTES), partial: '' }
        // Starting mid-file: the first line is probably cut, drop it.
        if (tail.offset > 0) tail.partial = '\u0000'
        this.tails.set(file, tail)
      }
      if (size < tail.offset) tail = { offset: 0, partial: '' }
      if (size === tail.offset) {
        this.tails.set(file, tail)
        return
      }

      const fh = await open(file, 'r')
      const buf = Buffer.alloc(size - tail.offset)
      try {
        await fh.read(buf, 0, buf.length, tail.offset)
      } finally {
        await fh.close()
      }
      const chunk = buf.toString('utf8')
      const lines = chunk.split('\n')
      const skipFirst = tail.partial === '\u0000'
      lines[0] = (skipFirst ? '' : tail.partial) + lines[0]
      const rest = lines.pop() ?? ''
      this.tails.set(file, { offset: size, partial: rest })
      const firstUsable = skipFirst ? 1 : 0
      for (const line of lines.slice(firstUsable)) this.handle(line)
    } catch (err) {
      if (!this.warned.has(file)) {
        this.warned.add(file)
        this.log(
          `claude-code: skipping ${file} (${(err as NodeJS.ErrnoException).code ?? 'read error'})`,
        )
      }
    }
  }

  /** First sight of a file: load subagent meta and scan the whole file for titles (cheap substring filter). */
  private async prime(file: string): Promise<void> {
    const m = basename(file).match(/^agent-(.+)\.jsonl$/)
    if (m) {
      const meta = await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(
        () => undefined,
      )
      if (meta) {
        try {
          const { agentType, description } = JSON.parse(meta)
          this.ctx.meta.set(m[1]!, {
            agentType: typeof agentType === 'string' ? agentType : undefined,
            description: typeof description === 'string' ? description : undefined,
          })
        } catch {
          /* ignore malformed meta */
        }
      }
      return
    }
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.includes('-title"')) lineToEvent(line, this.ctx)
    }
  }

  private handle(line: string): void {
    if (!line) return
    const e = lineToEvent(line, this.ctx)
    if (!e) return
    if (e.ts !== undefined && e.ts < this.now() - this.opts.expireAfterMs) return
    this.opts.store.apply(e, this.now())
  }
}
