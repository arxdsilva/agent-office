// goose history: `goose session list --format json` (verified on 1.54.0) lists past sessions
// {id, working_dir, name, created_at, updated_at, message_count, …}; `goose session export
// --session-id=<id> --format json` returns the conversation. Refs are `tr_go_<id>`; the id is
// checked before it reaches the command line. Paths stay in main; only text blocks and tool names
// are ever read from a conversation (docs/providers/goose.md).
import type {
  HistorySource,
  PastSession,
  TranscriptMessage,
  TranscriptReader,
} from '@agent-office/core'
import { type GooseCli, nodeGooseCli } from './goose-cli.ts'

/** goose ids look like `20261013_1`; never a leading `-` (it would read as a flag). */
export const GOOSE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
const REF_PREFIX = 'tr_go_'
const MAX_TITLE = 80
const MAX_TEXT = 4000
const MAX_SNIPPET = 200

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1)}…`
}
const ms = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : undefined
}
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export interface GooseHistorySourceOptions {
  /** Test seam and binary override. */
  cli?: GooseCli
  /** Without it (the provider is off) nothing is listed. */
  enabled?: () => boolean | Promise<boolean>
}

export class GooseHistorySource implements HistorySource {
  readonly idPattern = GOOSE_ID
  private cli: GooseCli

  constructor(private o: GooseHistorySourceOptions = {}) {
    this.cli = o.cli ?? nodeGooseCli()
  }

  async list(o: { limit: number }): Promise<PastSession[]> {
    if (this.o.enabled && !(await this.o.enabled())) return []
    const limit = Math.max(0, Math.floor(o.limit))
    if (limit === 0) return []
    let raw: unknown
    try {
      raw = parse(await this.cli(['session', 'list', '--format', 'json', '--limit', String(limit)]))
    } catch {
      return [] // goose missing or unreadable: nothing to import
    }
    if (!Array.isArray(raw)) return []
    const out: PastSession[] = []
    for (const item of raw) {
      const s = obj(item)
      const id = str(s?.id)
      if (!s || !id || !GOOSE_ID.test(id)) continue
      if (s.archived_at) continue
      const created = ms(s.created_at) ?? 0
      const seen = ms(s.last_message_at) ?? ms(s.updated_at) ?? created
      const dir = str(s.working_dir)
      out.push({
        provider: 'goose',
        providerSessionId: id,
        transcriptRef: `${REF_PREFIX}${id}`,
        ...(dir ? { cwd: dir } : {}),
        title: clip(str(s.name) ?? 'goose session') || 'goose session',
        startedAt: created,
        lastSeenAt: Math.max(created, seen),
      })
      if (out.length >= limit) break
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }
}

/** Reads one goose conversation on demand: text blocks and tool names only. */
export class GooseTranscriptReader implements TranscriptReader {
  private cli: GooseCli

  constructor(o: { cli?: GooseCli } = {}) {
    this.cli = o.cli ?? nodeGooseCli()
  }

  private async all(ref: string): Promise<TranscriptMessage[]> {
    if (!ref.startsWith(REF_PREFIX)) return []
    const id = ref.slice(REF_PREFIX.length)
    if (!GOOSE_ID.test(id)) return []
    let doc: Obj | undefined
    try {
      doc = obj(
        parse(await this.cli(['session', 'export', `--session-id=${id}`, '--format', 'json'])),
      )
    } catch {
      return []
    }
    const out: TranscriptMessage[] = []
    for (const m of Array.isArray(doc?.conversation) ? doc.conversation : []) {
      const msg = obj(m)
      const role = msg?.role
      const uuid = str(msg?.id)
      if (!msg || (role !== 'user' && role !== 'assistant') || !uuid) continue
      if (obj(msg.metadata)?.userVisible === false) continue
      const texts: string[] = []
      const tools: string[] = []
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        const block = obj(b)
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block?.type === 'toolRequest') {
          const name = str(obj(obj(block.toolCall)?.value)?.name)
          if (name) tools.push(name.slice(0, 100))
        }
      }
      const text = texts.join('\n').slice(0, MAX_TEXT)
      if (!text && tools.length === 0) continue
      out.push({
        uuid,
        role,
        text,
        ts: typeof msg.created === 'number' ? msg.created * 1000 : 0,
        tools,
      })
    }
    return out
  }

  async page(ref: string, o: { before?: string; limit: number }) {
    const all = await this.all(ref)
    let end = all.length
    if (o.before !== undefined) {
      const i = all.findIndex((m) => m.uuid === o.before)
      end = i < 0 ? 0 : i
    }
    const start = Math.max(0, end - Math.max(0, o.limit))
    return { messages: all.slice(start, end), more: start > 0 }
  }

  async search(ref: string, query: string, limit: number) {
    const q = query.trim().toLowerCase()
    if (!q || limit <= 0) return []
    const hits: { uuid: string; snippet: string }[] = []
    for (const m of await this.all(ref)) {
      const i = m.text.toLowerCase().indexOf(q)
      if (i < 0) continue
      const from = Math.max(0, i - Math.floor((MAX_SNIPPET - q.length) / 2))
      hits.push({ uuid: m.uuid, snippet: m.text.slice(from, from + MAX_SNIPPET) })
      if (hits.length >= limit) break
    }
    return hits
  }
}
