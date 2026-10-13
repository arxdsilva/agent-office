import { basename, dirname, join } from 'node:path'
import type { Clock, Logger, ReportActivity, Scheduler } from '@agent-office/core'
import { lineToEvent, newParseContext } from './line-mapper.ts'
import { TranscriptRefs, type TranscriptFiles } from './transcript-files.ts'

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
  /** Usually ~/.claude (user rules, skills); defaults to the parent of `dir`. */
  claudeHome?: string
  /** Called once per session cwd the first time it appears (capability discovery). */
  onNewCwd?: (cwd: string) => void
  /** Registry for `tr_` refs of located sessions; the tailer makes its own when omitted. */
  refs?: TranscriptRefs
  /**
   * Fired once per top-level session when its cwd is first known. `cwd` is for main only (never put
   * it in an event); `transcriptRef` is an opaque `tr_` key registered in `refs`.
   */
  onSessionLocated?: (sessionId: string, cwd: string, transcriptRef: string) => void
  /** Session ids whose transcripts belong to someone else (managed sessions report through their runner). */
  skip?: (sessionId: string) => boolean
  /** Called after a polling pass when `stats()` changed (Connect panel). */
  onStats?: (s: TailerStats) => void
}

/** Counts only: no project or file names leave the adapter. */
export interface TailerStats {
  projectsDirFound: boolean
  /** Top-level session transcripts changed within `expireAfterMs` (subagents excluded). */
  activeSessions: number
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
  private ctx: ReturnType<typeof newParseContext>
  private tails = new Map<string, Tail>()
  private warned = new Set<string>()
  private announced = new Set<string>()
  private located = new Set<string>()
  readonly refs: TranscriptRefs
  private running = false
  private cancel: (() => void) | undefined
  private current: TailerStats = { projectsDirFound: false, activeSessions: 0 }

  constructor(private o: ClaudeCodeTailerOptions) {
    this.refs = o.refs ?? new TranscriptRefs()
    this.ctx = newParseContext({ claudeHome: o.claudeHome ?? dirname(o.dir), projectsDir: o.dir })
  }

  /** Cwds of sessions active within `expireAfterMs`. Stays inside the adapters (discovery only). */
  activeCwds(): string[] {
    const cutoff = this.o.clock.now() - this.o.expireAfterMs
    return [...this.ctx.cwds].filter(([, ts]) => ts >= cutoff).map(([cwd]) => cwd)
  }

  stats(): TailerStats {
    return { ...this.current }
  }

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
      const active = await this.activeFiles()
      await this.updateStats(active.filter((f) => f.topLevel).length)
      for (const { path, sessionId, topLevel } of active)
        if (!this.o.skip?.(sessionId)) await this.readFile(path, topLevel ? sessionId : undefined)
    } finally {
      this.running = false
    }
  }

  private async updateStats(activeSessions: number): Promise<void> {
    const projectsDirFound = (await this.o.files.stat(this.o.dir))?.isDir ?? false
    const prev = this.current
    if (prev.projectsDirFound === projectsDirFound && prev.activeSessions === activeSessions) return
    this.current = { projectsDirFound, activeSessions }
    this.o.onStats?.(this.stats())
  }

  private async activeFiles(): Promise<{ path: string; topLevel: boolean; sessionId: string }[]> {
    const { files, dir } = this.o
    const cutoff = this.o.clock.now() - this.o.expireAfterMs
    const candidates: { path: string; topLevel: boolean; sessionId: string }[] = []
    for (const project of await files.list(dir)) {
      const projectDir = join(dir, project)
      for (const entry of await files.list(projectDir)) {
        if (entry.endsWith('.jsonl'))
          candidates.push({
            path: join(projectDir, entry),
            topLevel: true,
            sessionId: entry.slice(0, -'.jsonl'.length),
          })
        else {
          const subDir = join(projectDir, entry, 'subagents')
          for (const sub of await files.list(subDir))
            if (sub.endsWith('.jsonl'))
              candidates.push({ path: join(subDir, sub), topLevel: false, sessionId: entry })
        }
      }
    }
    const active: typeof candidates = []
    for (const f of candidates) {
      const s = await files.stat(f.path)
      if (s?.isFile && s.mtimeMs >= cutoff) active.push(f)
    }
    return active
  }

  private async readFile(file: string, locateAs?: string): Promise<void> {
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
      for (const line of lines.slice(skipFirst ? 1 : 0)) {
        this.handle(line)
        if (locateAs) this.locate(locateAs, file, line)
      }
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

  private locate(sessionId: string, file: string, line: string): void {
    if (!this.o.onSessionLocated || this.located.has(sessionId) || !line.includes('"cwd"')) return
    let cwd: unknown
    try {
      cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
    } catch {
      return
    }
    if (typeof cwd !== 'string' || !cwd) return
    this.located.add(sessionId)
    this.o.onSessionLocated(sessionId, cwd, this.refs.register(file))
  }

  private handle(line: string): void {
    if (!line) return
    const e = lineToEvent(line, this.ctx)
    if (this.o.onNewCwd && this.announced.size < this.ctx.cwds.size)
      for (const cwd of this.activeCwds())
        if (!this.announced.has(cwd)) {
          this.announced.add(cwd)
          this.o.onNewCwd(cwd)
        }
    if (!e) return
    if (e.ts !== undefined && e.ts < this.o.clock.now() - this.o.expireAfterMs) return
    this.o.activity.report([e])
  }
}
