// Reads an OpenCode session's messages on demand through the server API (GET
// /session/{id}/message). Only text parts (not synthetic or ignored ones) and tool names come out,
// ≤ 4000 chars per message; reasoning, files, tool input and output are never read into a result.
// Nothing is cached or copied.
import type { TranscriptMessage, TranscriptReader } from '@agent-office/core'
import type { FetchLike } from '../common/http/http-json.ts'
import { getArray, type OpenCodeServerAccess } from './opencode-history.ts'
import { items, MessageWithParts, parts, sessionOfRef, toolName } from './opencode-protocol.ts'

const MAX_TEXT = 4000
const MAX_SNIPPET = 200
/** Whole-session responses include tool output; cap what we are willing to download. */
const MAX_BYTES = 32 * 1024 * 1024

export interface OpenCodeTranscriptReaderOptions {
  servers: OpenCodeServerAccess
  fetch?: FetchLike
}

function toMessage(m: MessageWithParts): TranscriptMessage | undefined {
  const texts: string[] = []
  const tools: string[] = []
  for (const p of parts(m.parts)) {
    if (p.type === 'text' && typeof p.text === 'string' && !p.synthetic && !p.ignored)
      texts.push(p.text)
    else if (p.type === 'tool') {
      const t = toolName(p.tool)
      if (t) tools.push(t)
    }
  }
  const text = texts.join('\n').slice(0, MAX_TEXT)
  if (!text && tools.length === 0) return undefined
  return { uuid: m.info.id, role: m.info.role, text, ts: m.info.time.created, tools }
}

export class OpenCodeTranscriptReader implements TranscriptReader {
  constructor(private o: OpenCodeTranscriptReaderOptions) {}

  private async all(ref: string): Promise<TranscriptMessage[]> {
    const id = sessionOfRef(ref)
    if (!id) return []
    let raw: unknown[]
    try {
      raw = await this.o.servers.use((s) =>
        getArray(
          s,
          `/session/${id}/message`,
          {},
          {
            maxBytes: MAX_BYTES,
            ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
          },
        ),
      )
    } catch {
      return [] // unreachable or unreadable: an empty transcript, nothing logged
    }
    const out: TranscriptMessage[] = []
    for (const m of items(MessageWithParts, raw)) {
      const t = toMessage(m)
      if (t) out.push(t)
    }
    return out.sort((a, b) => a.ts - b.ts)
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
