// The Context Engine's ranking (docs/projects.md §6): deterministic, explainable, no model calls.
import type { ContextBundleView, MemoryKind, MemoryScope } from '@agent-office/shared'

export const DEFAULT_BUDGET_CHARS = 12_000
export const MAX_ITEM_BODY = 2000

export interface ContextCandidate {
  ref: { kind: 'memory' | 'summary'; id: string }
  version: number
  kind: MemoryKind | 'summary'
  scope: MemoryScope
  title: string
  body: string
  /** Last update. */
  ts: number
  pinned?: boolean
}

export interface RankedItem extends ContextCandidate {
  score: number
  reasons: string[]
  included: boolean
  excludedReason?: string
  /** Characters this item costs in a bundle (title + body excerpt). */
  chars: number
}

export interface RankedContext {
  items: RankedItem[]
  usedChars: number
  budgetChars: number
  estimatedTokens: number
}

const KIND_PRIORITY: Record<ContextCandidate['kind'], number> = {
  instruction: 50,
  constraint: 40,
  decision: 30,
  fact: 20,
  note: 20,
  summary: 10,
}
const SCOPE_WEIGHT: Record<MemoryScope, number> = {
  session: 6,
  project: 5,
  workspace: 3,
  global: 2,
}
const RELEVANCE = 8
const RECENCY = 4
const DAY = 86_400_000

const STOP = new Set(
  'the and for are but not you all any can her was one our out his has its how who did let put say she too use with that this from have they will your what when where which there their then than them into also been were'.split(
    ' ',
  ),
)

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

/** Okapi BM25 (k1 = 1.2, b = 0.75) of each doc against the query. */
export function bm25(docs: string[], query: string, k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))]
  if (!docs.length) return []
  if (!q.length) return docs.map(() => 0)
  const toks = docs.map(tokenize)
  const avg = toks.reduce((n, t) => n + t.length, 0) / toks.length || 1
  const df = new Map<string, number>()
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1)
  return toks.map((t) => {
    let s = 0
    for (const w of q) {
      const n = df.get(w)
      if (!n) continue
      const tf = t.filter((x) => x === w).length
      if (!tf) continue
      const idf = Math.log(1 + (toks.length - n + 0.5) / (n + 0.5))
      s += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / avg))
    }
    return s
  })
}

export function rankContext(
  candidates: ContextCandidate[],
  o: { objective?: string; budgetChars?: number; now: number; exclude?: ReadonlySet<string> },
): RankedContext {
  const budget = o.budgetChars ?? DEFAULT_BUDGET_CHARS
  const rel = bm25(
    candidates.map((c) => `${c.title} ${c.body}`),
    o.objective ?? '',
  )
  const top = Math.max(0, ...rel)
  const qTerms = new Set(tokenize(o.objective ?? ''))
  const scored = candidates.map((c, i) => {
    const reasons: string[] = [c.kind, `${c.scope} scope`]
    let score = KIND_PRIORITY[c.kind] + SCOPE_WEIGHT[c.scope]
    if (top > 0 && rel[i]! > 0) {
      score += (RELEVANCE * rel[i]!) / top
      const hits = [...new Set(tokenize(`${c.title} ${c.body}`))].filter((t) => qTerms.has(t))
      reasons.push(`matches: ${hits.slice(0, 4).join(', ')}`)
    }
    const age = Math.max(0, o.now - c.ts) / DAY
    score += RECENCY * Math.exp(-age / 30)
    if (age < 7) reasons.push('recent')
    if (c.pinned) reasons.unshift('pinned')
    return { c, i, score: Math.round(score * 100) / 100, reasons }
  })
  scored.sort(
    (a, b) => Number(!!b.c.pinned) - Number(!!a.c.pinned) || b.score - a.score || a.i - b.i,
  )

  let used = 0
  const items: RankedItem[] = scored.map(({ c, score, reasons }) => {
    const chars = c.title.length + Math.min(c.body.length, MAX_ITEM_BODY)
    const base = { ...c, score, reasons, chars }
    if (o.exclude?.has(c.ref.id))
      return { ...base, included: false, excludedReason: 'removed by you' }
    if (used + chars > budget) return { ...base, included: false, excludedReason: 'over budget' }
    used += chars
    return { ...base, included: true }
  })
  return { items, usedChars: used, budgetChars: budget, estimatedTokens: Math.ceil(used / 4) }
}

export function toBundleView(
  projectId: string,
  objective: string | undefined,
  r: RankedContext,
): ContextBundleView {
  return {
    projectId,
    ...(objective ? { objective } : {}),
    items: r.items.map((i) => ({
      ref: { kind: i.ref.kind, id: i.ref.id },
      kind: i.kind,
      title: i.title,
      excerpt: i.body.slice(0, MAX_ITEM_BODY),
      score: i.score,
      reasons: [...i.reasons],
      included: i.included,
      ...(i.excludedReason ? { excludedReason: i.excludedReason } : {}),
    })),
    usedChars: r.usedChars,
    budgetChars: r.budgetChars,
    estimatedTokens: r.estimatedTokens,
  }
}
