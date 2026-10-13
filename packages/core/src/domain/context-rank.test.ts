import { describe, expect, it } from 'vitest'
import {
  bm25,
  DEFAULT_BUDGET_CHARS,
  rankContext,
  tokenize,
  toBundleView,
  type ContextCandidate,
} from './context-rank.ts'

const DAY = 86_400_000
const NOW = 100 * DAY
const c = (over: Partial<ContextCandidate> & { id: string }): ContextCandidate => ({
  ref: { kind: 'memory', id: over.id },
  version: 1,
  kind: 'note',
  scope: 'project',
  title: over.id,
  body: 'text',
  ts: NOW,
  ...over,
})

describe('tokenize + bm25', () => {
  it('CR-tokenize lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
    expect(tokenize('The JWT-auth flow, a b OAuth2!')).toEqual(['jwt', 'auth', 'flow', 'oauth2'])
  })

  it('CR-bm25 scores matching docs above non-matching; rarer terms weigh more', () => {
    const s = bm25(['jwt auth tokens', 'css colors', 'auth auth auth'], 'jwt auth')
    expect(s[0]).toBeGreaterThan(s[2]!)
    expect(s[1]).toBe(0)
    expect(bm25(['x'], '')).toEqual([0])
    expect(bm25([], 'x')).toEqual([])
  })
})

describe('rankContext (docs/projects.md §6)', () => {
  it('CR-kind priority: instruction > constraint > decision > fact/note > summary', () => {
    const r = rankContext(
      [
        c({ id: 's', kind: 'summary', ref: { kind: 'summary', id: 's' } }),
        c({ id: 'n', kind: 'note' }),
        c({ id: 'd', kind: 'decision' }),
        c({ id: 'k', kind: 'constraint' }),
        c({ id: 'i', kind: 'instruction' }),
      ],
      { now: NOW },
    )
    expect(r.items.map((x) => x.ref.id)).toEqual(['i', 'k', 'd', 'n', 's'])
    expect(r.items[0]!.reasons).toContain('instruction')
  })

  it('CR-objective: BM25 relevance reorders within a kind and is explained', () => {
    const r = rankContext(
      [c({ id: 'css', body: 'button colors' }), c({ id: 'auth', body: 'jwt refresh tokens' })],
      { objective: 'fix the jwt refresh', now: NOW },
    )
    expect(r.items[0]!.ref.id).toBe('auth')
    expect(r.items[0]!.reasons.some((x) => x.startsWith('matches'))).toBe(true)
  })

  it('CR-scope and recency weights; pinned first', () => {
    const r = rankContext(
      [
        c({ id: 'old-global', scope: 'global', ts: NOW - 300 * DAY }),
        c({ id: 'new-project', scope: 'project', ts: NOW }),
        c({ id: 'pinned', scope: 'global', ts: 0, pinned: true, kind: 'note' }),
      ],
      { now: NOW },
    )
    expect(r.items.map((x) => x.ref.id)).toEqual(['pinned', 'new-project', 'old-global'])
    expect(r.items[0]!.reasons).toContain('pinned')
    expect(r.items[1]!.reasons).toContain('recent')
  })

  it('CR-budget: greedy inclusion, the rest excluded with a reason; ≈ chars/4 tokens', () => {
    const r = rankContext(
      [
        c({ id: 'a', kind: 'instruction', body: 'x'.repeat(600) }),
        c({ id: 'b', body: 'y'.repeat(600) }),
        c({ id: 'z', body: 'small' }),
      ],
      { now: NOW, budgetChars: 800 },
    )
    expect(r.items.map((x) => [x.ref.id, x.included, x.excludedReason])).toEqual([
      ['a', true, undefined],
      ['b', false, 'over budget'],
      ['z', true, undefined],
    ])
    expect(r.usedChars).toBe(601 + 6)
    expect(r.estimatedTokens).toBe(Math.ceil(r.usedChars / 4))
    expect(rankContext([], { now: NOW }).budgetChars).toBe(DEFAULT_BUDGET_CHARS)
  })

  it('CR-bodies over 2000 chars count as their 2000-char excerpt; explicit exclusion is kept', () => {
    const r = rankContext([c({ id: 'big', body: 'b'.repeat(5000) }), c({ id: 'x' })], {
      now: NOW,
      exclude: new Set(['x']),
    })
    expect(r.items[0]!.chars).toBe(3 + 2000)
    expect(r.items[1]).toMatchObject({ included: false, excludedReason: 'removed by you' })
  })

  it('CR-view', () => {
    const r = rankContext([c({ id: 'a', body: 'b'.repeat(3000) })], { now: NOW })
    const v = toBundleView('prj_a', 'goal', r)
    expect(v).toMatchObject({
      projectId: 'prj_a',
      objective: 'goal',
      budgetChars: DEFAULT_BUDGET_CHARS,
    })
    expect(v.items[0]!.excerpt.length).toBeLessThanOrEqual(2000)
    expect(v.items[0]).toMatchObject({ ref: { kind: 'memory', id: 'a' }, included: true })
    expect(toBundleView('prj_a', undefined, r).objective).toBeUndefined()
  })
})
