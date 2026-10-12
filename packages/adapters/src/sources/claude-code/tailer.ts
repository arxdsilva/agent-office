import { basename, join } from 'node:path'
import type { Clock, Logger, ReportActivity, Scheduler } from '@agent-office/core'
import { lineToEvent, newParseContext } from './line-mapper.ts'
import type { TranscriptFiles } from './transcript-files.ts'

const TAIL_BYTES = 64 * 1024
/** Marks a tail that started mid-file: its first (cut) line must be dropped. */
const SKIP_FIRST = '\u0000'

export interface ClaudeCodeTailerOptions {
  /** Usually ~/.claude/projects */
  dir: string
  files: TranscriptFiles
  activity: ReportActivity
  clock: Clock
  scheduler: Scheduler
  /** Files and events older than this are ignored. */
  expireAfterMs: number
  log?: Logger
}

interface Tail {
  offset: number
  partial: string
}

/**
 * Driving adapter: polls Claude Code transcripts and reports agent activity to the core.
 * Only short, mapped fields leave this adapter (see line-mapper and PRIVACY_SECURITY rule).
 */
export class ClaudeCodeTailer {
  private ctx = newParseContext()
  private tails = new Map<string, Tail>()
  private warned = new Set<string>()
  private running = false
  private cancel: (() => void) | undefined

  constructor(private o: ClaudeCodeTailerOptions) {}

  start(pollMs = 1000): void {
    this.cancel = this.o.scheduler.every(pollMs, () => void this.tick())
    void this.tick()
  }

  stop(): void {
    this.cancel?.()
    this.cancel = undefined
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
    const { files, dir } = this.o
    const cutoff = this.o.clock.now() - this.o.expireAfterMs
    const candidates: string[] = []
    for (const project of await files.list(dir)) {
      const projectDir = join(dir, project)
      for (const entry of await files.list(projectDir)) {
        if (entry.endsWith('.jsonl')) candidates.push(join(projectDir, entry))
        else {
          const subDir = join(projectDir, entry, 'subagents')
          for (const sub of await files.list(subDir))
            if (sub.endsWith('.jsonl')) candidates.push(join(subDir, sub))
        }
      }
    }
    const active: string[] = []
    for (const f of candidates) {
      const s = await files.stat(f)
      if (s?.isFile && s.mtimeMs >= cutoff) active.push(f)
    }
    return active
  }

  private async readFile(file: string): Promise<void> {
    try {
      const s = await this.o.files.stat(file)
      if (!s) return
      let tail = this.tails.get(file)
      if (!tail) {
        await this.prime(file)
        tail = { offset: Math.max(0, s.size - TAIL_BYTES), partial: '' }
        if (tail.offset > 0) tail.partial = SKIP_FIRST
      }
      if (s.size < tail.offset) tail = { offset: 0, partial: '' }
      if (s.size === tail.offset) {
        this.tails.set(file, tail)
        return
      }
      const chunk = await this.o.files.readRange(file, tail.offset, s.size)
      const lines = chunk.split('\n')
      const skipFirst = tail.partial === SKIP_FIRST
      lines[0] = (skipFirst ? '' : tail.partial) + lines[0]
      const rest = lines.pop() ?? ''
      this.tails.set(file, { offset: s.size, partial: rest })
      for (const line of lines.slice(skipFirst ? 1 : 0)) this.handle(line)
    } catch (err) {
      if (!this.warned.has(file)) {
        this.warned.add(file)
        this.o.log?.warn(
          `claude-code: skipping ${file} (${(err as NodeJS.ErrnoException).code ?? 'read error'})`,
        )
      }
    }
  }

  /** First sight of a file: load subagent meta, and scan the whole file for session titles. */
  private async prime(file: string): Promise<void> {
    const m = basename(file).match(/^agent-(.+)\.jsonl$/)
    if (m) {
      const meta = await this.o.files.readText(file.replace(/\.jsonl$/, '.meta.json'))
      if (!meta) return
      try {
        const { agentType, description } = JSON.parse(meta)
        this.ctx.meta.set(m[1]!, {
          ...(typeof agentType === 'string' ? { agentType } : {}),
          ...(typeof description === 'string' ? { description } : {}),
        })
      } catch {
        /* malformed meta: ignore */
      }
      return
    }
    for await (const line of this.o.files.lines(file)) {
      if (line.includes('-title"')) lineToEvent(line, this.ctx)
    }
  }

  private handle(line: string): void {
    if (!line) return
    const e = lineToEvent(line, this.ctx)
    if (!e) return
    if (e.ts !== undefined && e.ts < this.o.clock.now() - this.o.expireAfterMs) return
    this.o.activity.report([e])
  }
}
