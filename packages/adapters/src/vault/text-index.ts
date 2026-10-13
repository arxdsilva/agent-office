import type { SearchDoc, SearchIndex } from '@agent-office/core'

const K1 = 1.2
const B = 0.75
const TITLE_BOOST = 2
const SNIPPET_MAX = 200

const STOP = new Set(
  `an and are as at be but by do for from has have he her his how if in into is it its me my no
   not of on or our she so than that the their them then there these they this to too us was we
   were what when where which who why will with you your`.split(/\s+/),
)

const WORD = /[\p{L}\p{N}]+/gu

interface Token {
  term: string
  index: number
  length: number
}

function scan(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(WORD)) {
    const term = m[0].normalize('NFKC').toLowerCase()
    if ([...term].length < 2 || STOP.has(term)) continue
    out.push({ term, index: m.index, length: m[0].length })
  }
  return out
}

/** Lowercased unicode letter/digit runs, without 1-char tokens and stop words. */
export function tokenize(text: string): string[] {
  return scan(text).map((t) => t.term)
}

interface Entry {
  doc: SearchDoc
  /** Weighted term frequency: title ×2 + text. */
  tf: Map<string, number>
  len: number
}

/**
 * In-memory BM25 full-text index (docs/projects.md §3). Pure TypeScript; never persisted.
 */
export class TextIndex implements SearchIndex {
  private docs = new Map<string, Entry>()
  private df = new Map<string, number>()
  private totalLen = 0

  upsert(doc: SearchDoc): void {
    this.remove(doc.id)
    const tf = new Map<string, number>()
    const add = (terms: string[], w: number) => {
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + w)
    }
    const title = tokenize(doc.title)
    const text = tokenize(doc.text)
    add(title, TITLE_BOOST)
    add(text, 1)
    const len = title.length * TITLE_BOOST + text.length
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.docs.set(doc.id, { doc: { ...doc }, tf, len })
    this.totalLen += len
  }

  remove(id: string): void {
    const e = this.docs.get(id)
    if (!e) return
    for (const t of e.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1
      if (n > 0) this.df.set(t, n)
      else this.df.delete(t)
    }
    this.totalLen -= e.len
    this.docs.delete(id)
  }

  query(
    q: string,
    o: { projectIds?: (string | null)[]; kinds?: SearchDoc['kind'][]; limit: number },
  ): { id: string; score: number; snippet: string }[] {
    const terms = [...new Set(tokenize(q))]
    const limit = Math.max(0, Math.floor(o.limit))
    if (terms.length === 0 || limit === 0 || this.docs.size === 0) return []
    const n = this.docs.size
    const avg = this.totalLen / n || 1
    const idf = new Map(
      terms.map((t) => {
        const df = this.df.get(t) ?? 0
        return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))] as const
      }),
    )
    const projects = o.projectIds ? new Set(o.projectIds) : null
    const kinds = o.kinds ? new Set(o.kinds) : null
    const hits: { e: Entry; score: number }[] = []
    for (const e of this.docs.values()) {
      if (projects && !projects.has(e.doc.projectId)) continue
      if (kinds && !kinds.has(e.doc.kind)) continue
      let score = 0
      for (const t of terms) {
        const f = e.tf.get(t)
        if (!f) continue
        score += idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.len) / avg)))
      }
      if (score > 0) hits.push({ e, score })
    }
    hits.sort(
      (a, b) => b.score - a.score || b.e.doc.ts - a.e.doc.ts || (a.e.doc.id < b.e.doc.id ? -1 : 1),
    )
    return hits.slice(0, limit).map(({ e, score }) => ({
      id: e.doc.id,
      score,
      snippet: snippet(e.doc.text, terms, idf),
    }))
  }
}

/** ≤ 200 chars of `text` around the occurrence of the rarest matching query term. */
function snippet(text: string, terms: string[], idf: Map<string, number>): string {
  const wanted = new Set(terms)
  let best: Token | undefined
  for (const tok of scan(text)) {
    if (wanted.has(tok.term) && (!best || idf.get(tok.term)! > idf.get(best.term)!)) best = tok
  }
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  if (text.length <= SNIPPET_MAX) return flat(text).trim()
  const center = best ? best.index + Math.floor(best.length / 2) : 0
  const room = SNIPPET_MAX - 2 // keep space for the ellipses
  let start = Math.max(0, Math.min(center - Math.floor(room / 2), text.length - room))
  let end = start + room
  // Don't cut a surrogate pair in half.
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--
  const body = flat(text.slice(start, end))
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
