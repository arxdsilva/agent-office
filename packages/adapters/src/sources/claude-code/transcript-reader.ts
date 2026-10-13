import type { TranscriptMessage, TranscriptReader } from '@agent-office/core'
import type { TranscriptFiles, TranscriptRefs } from './transcript-files.ts'

export interface ClaudeTranscriptReaderOptions {
  refs: TranscriptRefs
  files: TranscriptFiles
}

const MAX_TEXT = 4000
const MAX_SNIPPET = 200

/** Pulls only the privacy-safe parts of one transcript line: text blocks and tool names. */
function parse(line: string): TranscriptMessage | undefined {
  if (!line.includes('"type"')) return undefined
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!d || (d.type !== 'user' && d.type !== 'assistant')) return undefined
  if (d.isSidechain === true || d.isMeta === true) return undefined
  if (typeof d.uuid !== 'string' || !d.uuid) return undefined
  const content = d.message?.content
  const texts: string[] = []
  const tools: string[] = []
  if (typeof content === 'string') texts.push(content)
  else if (Array.isArray(content))
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      else if (b.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name.slice(0, 100))
    }
  else return undefined
  const text = texts.join('\n').slice(0, MAX_TEXT)
  if (!text && tools.length === 0) return undefined
  const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
  return {
    uuid: d.uuid,
    role: d.type,
    text,
    ts: Number.isFinite(ts) ? ts : 0,
    tools,
  }
}

/** Reads Claude Code transcripts on demand, exposing text blocks and tool names only. */
export class ClaudeTranscriptReader implements TranscriptReader {
  constructor(private o: ClaudeTranscriptReaderOptions) {}

  private async all(ref: string): Promise<TranscriptMessage[]> {
    const path = this.o.refs.resolve(ref)
    if (!path) return []
    const out: TranscriptMessage[] = []
    try {
      for await (const line of this.o.files.lines(path)) {
        const m = parse(line)
        if (m) out.push(m)
      }
    } catch {
      /* unreadable: whatever was parsed so far */
    }
    return out
  }

  async page(
    ref: string,
    o: { before?: string; limit: number },
  ): Promise<{ messages: TranscriptMessage[]; more: boolean }> {
    const all = await this.all(ref)
    let end = all.length
    if (o.before !== undefined) {
      const i = all.findIndex((m) => m.uuid === o.before)
      end = i < 0 ? 0 : i
    }
    const start = Math.max(0, end - Math.max(0, o.limit))
    return { messages: all.slice(start, end), more: start > 0 }
  }

  async search(
    ref: string,
    query: string,
    limit: number,
  ): Promise<{ uuid: string; snippet: string }[]> {
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
