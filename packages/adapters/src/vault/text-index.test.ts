import type { SearchDoc } from '@agent-office/core'
import { describe, expect, it } from 'vitest'
import { TextIndex, tokenize } from './text-index.ts'

const doc = (id: string, over: Partial<SearchDoc> = {}): SearchDoc => ({
  id,
  projectId: 'prj_aaaaaaaaaa',
  kind: 'message',
  title: '',
  text: '',
  ts: 1,
  ...over,
})

describe('tokenize', () => {
  it('lowercases, keeps unicode letters and digits, drops 1-char tokens and stop words', () => {
    expect(tokenize('The Café-Größe is 42 a b x9!')).toEqual(['café', 'größe', '42', 'x9'])
  })
})

describe('TextIndex', () => {
  it('ranks by BM25 and boosts title matches', () => {
    const ix = new TextIndex()
    ix.upsert(doc('a', { text: 'deploy the renderer pipeline' }))
    ix.upsert(doc('b', { title: 'renderer', text: 'something else entirely' }))
    ix.upsert(doc('c', { text: 'unrelated words here' }))
    const hits = ix.query('renderer', { limit: 10 })
    expect(hits.map((h) => h.id)).toEqual(['b', 'a'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('filters by project (including null) and kind, and honours limit', () => {
    const ix = new TextIndex()
    ix.upsert(doc('a', { text: 'vault key', projectId: 'prj_aaaaaaaaaa' }))
    ix.upsert(doc('b', { text: 'vault key', projectId: null, kind: 'session' }))
    ix.upsert(doc('c', { text: 'vault key', projectId: 'prj_bbbbbbbbbb', kind: 'memory' }))
    expect(ix.query('vault', { projectIds: [null], limit: 10 }).map((h) => h.id)).toEqual(['b'])
    expect(ix.query('vault', { kinds: ['memory'], limit: 10 }).map((h) => h.id)).toEqual(['c'])
    expect(ix.query('vault', { limit: 2 })).toHaveLength(2)
    expect(ix.query('vault', { limit: 0 })).toEqual([])
  })

  it('upsert replaces, remove deletes, empty or stop-word queries return nothing', () => {
    const ix = new TextIndex()
    ix.upsert(doc('a', { text: 'alpha' }))
    ix.upsert(doc('a', { text: 'beta' }))
    expect(ix.query('alpha', { limit: 5 })).toEqual([])
    expect(ix.query('beta', { limit: 5 }).map((h) => h.id)).toEqual(['a'])
    ix.remove('a')
    ix.remove('missing')
    expect(ix.query('beta', { limit: 5 })).toEqual([])
    expect(ix.query('', { limit: 5 })).toEqual([])
    expect(ix.query('the a', { limit: 5 })).toEqual([])
  })

  it('returns a snippet of at most 200 chars around the best match', () => {
    const ix = new TextIndex()
    const text = `${'lorem ipsum '.repeat(40)}needle found here\n\nand ${'dolor sit '.repeat(40)}`
    ix.upsert(doc('a', { text }))
    const [hit] = ix.query('needle', { limit: 1 })
    expect(hit!.snippet.length).toBeLessThanOrEqual(200)
    expect(hit!.snippet).toContain('needle found here and')
    expect(hit!.snippet.startsWith('…')).toBe(true)
    expect(hit!.snippet.endsWith('…')).toBe(true)
  })

  it('snippets the start of the text when only the title matches, and short text whole', () => {
    const ix = new TextIndex()
    ix.upsert(doc('a', { title: 'Needle', text: 'short body' }))
    expect(ix.query('needle', { limit: 1 })[0]!.snippet).toBe('short body')
  })

  it('breaks score ties by newest first', () => {
    const ix = new TextIndex()
    ix.upsert(doc('old', { text: 'same words', ts: 1 }))
    ix.upsert(doc('new', { text: 'same words', ts: 2 }))
    expect(ix.query('words', { limit: 5 }).map((h) => h.id)).toEqual(['new', 'old'])
  })
})
