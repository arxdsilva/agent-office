// Experimental history import: lists past Claude Code sessions (~/.claude/projects/*/*.jsonl),
// newest first. Reads only the head (cwd, first timestamp) and tail (titles) of each file and
// registers a `tr_` ref so TranscriptReader can page it later. Nothing is copied; no path is logged.
import { basename, join } from 'node:path'
import type { HistorySource, PastSession } from '@agent-office/core'
import { lineToEvent, newParseContext } from './line-mapper.ts'
import type { TranscriptFiles, TranscriptRefs } from './transcript-files.ts'

const HEAD_BYTES = 32 * 1024
const TAIL_BYTES = 256 * 1024
const MAX_TITLE = 80
const ID = /^[A-Za-z0-9_-]{1,100}$/

export interface ClaudeHistorySourceOptions {
  /** Usually ~/.claude/projects (honours CLAUDE_PROJECTS_DIR through the composition root). */
  dir: string
  files: TranscriptFiles
  refs: TranscriptRefs
  /** Without it (the Claude adapter is off) nothing is listed. */
  enabled?: () => boolean | Promise<boolean>
}

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1)}…`
}

export class ClaudeHistorySource implements HistorySource {
  constructor(private o: ClaudeHistorySourceOptions) {}

  async list(o: { limit: number }): Promise<PastSession[]> {
    if (this.o.enabled && !(await this.o.enabled())) return []
    const limit = Math.max(0, Math.floor(o.limit))
    const found: { path: string; id: string; mtimeMs: number; size: number }[] = []
    for (const project of await this.o.files.list(this.o.dir)) {
      const projectDir = join(this.o.dir, project)
      for (const entry of await this.o.files.list(projectDir)) {
        if (!entry.endsWith('.jsonl')) continue
        const id = entry.slice(0, -'.jsonl'.length)
        if (!ID.test(id)) continue
        const path = join(projectDir, entry)
        const s = await this.o.files.stat(path).catch(() => undefined)
        if (s?.isFile) found.push({ path, id, mtimeMs: s.mtimeMs, size: s.size })
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const out: PastSession[] = []
    for (const f of found) {
      if (out.length >= limit) break
      const p = await this.read(f).catch(() => undefined) // unreadable: skipped, nothing logged
      if (p) out.push(p)
    }
    return out
  }

  private async read(f: { path: string; id: string; mtimeMs: number; size: number }) {
    const head = await this.o.files.readRange(f.path, 0, Math.min(f.size, HEAD_BYTES))
    let cwd: string | undefined
    let startedAt: number | undefined
    for (const line of head.split('\n')) {
      if (cwd !== undefined && startedAt !== undefined) break
      if (!line.startsWith('{')) continue
      let d: { cwd?: unknown; timestamp?: unknown }
      try {
        d = JSON.parse(line) as typeof d
      } catch {
        continue // a cut last line or noise
      }
      if (cwd === undefined && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd
      if (startedAt === undefined && typeof d.timestamp === 'string') {
        const t = Date.parse(d.timestamp)
        if (Number.isFinite(t)) startedAt = t
      }
    }
    if (cwd === undefined && startedAt === undefined) return undefined // not a transcript
    const ctx = newParseContext({})
    const from = Math.max(0, f.size - TAIL_BYTES)
    const tail = await this.o.files.readRange(f.path, from, f.size)
    for (const line of tail.split('\n')) if (line.includes('-title"')) lineToEvent(line, ctx)
    const titles = [...ctx.titles.values()]
    const named = titles.find((t) => t.custom)?.custom ?? titles.find((t) => t.ai)?.ai
    const title = clip(named ?? (cwd ? basename(cwd) : '')) || 'Claude Code session'
    return {
      provider: 'claude-code',
      providerSessionId: f.id,
      transcriptRef: this.o.refs.register(f.path),
      ...(cwd ? { cwd } : {}),
      title,
      startedAt: startedAt ?? f.mtimeMs,
      lastSeenAt: f.mtimeMs,
    } satisfies PastSession
  }
}
