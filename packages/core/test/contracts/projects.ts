// Contract suites for the projects-first driven ports (docs/projects.md). Every implementation,
// fakes included, must pass them: RecordLog (vault), SearchIndex, TranscriptReader, HistorySource.
import { describe, expect, it } from 'vitest'
import type {
  HistorySource,
  RecordLog,
  SearchIndex,
  TranscriptReader,
  VaultRecord,
} from '../../src/ports/driven.ts'

const rec = (t: string, n: number, extra: Record<string, unknown> = {}): VaultRecord => ({
  t,
  ts: 1000 + n,
  data: { n, ...extra },
})
const strip = (rs: VaultRecord[]) => rs.map(({ t, ts, data }) => ({ t, ts, data }))

export interface RecordLogHarness {
  log: RecordLog
  /** A new RecordLog over the same storage (an app restart). */
  reopen: () => Promise<RecordLog>
  /** Optional: damages one stored line of `partition` (e.g. flips ciphertext bytes). */
  corrupt?: (partition: string) => Promise<void>
}

/** Every RecordLog must pass this. `make()` returns a fresh, empty vault. */
export function recordLogContract(name: string, make: () => Promise<RecordLogHarness>) {
  describe(`RecordLog contract: ${name}`, () => {
    it('reports a status and reads an unknown partition as empty', async () => {
      const { log } = await make()
      expect(['encrypted', 'memory-only']).toContain(log.status())
      expect(await log.read('catalog')).toEqual([])
      expect(await log.partitions('p/')).toEqual([])
    })

    it('round-trips records in append order with increasing seq', async () => {
      const { log } = await make()
      await log.append('catalog', [rec('project', 1), rec('session', 2)])
      await log.append('catalog', [rec('assign', 3, { text: 'ünïcødé ✓ "quotes"\nline' })])
      const got = await log.read('catalog')
      expect(strip(got)).toEqual([
        rec('project', 1),
        rec('session', 2),
        rec('assign', 3, { text: 'ünïcødé ✓ "quotes"\nline' }),
      ])
      const seqs = got.map((r) => r.seq!)
      expect(seqs.every((s) => typeof s === 'number')).toBe(true)
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
      expect(new Set(seqs).size).toBe(seqs.length)
    })

    it('keeps partitions isolated and lists them by prefix', async () => {
      const { log } = await make()
      await log.append('p/prj_aaaaaaaaaaaa', [rec('memory', 1)])
      await log.append('p/prj_bbbbbbbbbbbb', [rec('memory', 2)])
      await log.append('s/ses_aaaaaaaaaaaa', [rec('message', 3)])
      expect((await log.partitions('p/')).sort()).toEqual([
        'p/prj_aaaaaaaaaaaa',
        'p/prj_bbbbbbbbbbbb',
      ])
      expect(await log.partitions('s/')).toEqual(['s/ses_aaaaaaaaaaaa'])
      expect(strip(await log.read('p/prj_aaaaaaaaaaaa'))).toEqual([rec('memory', 1)])
      expect(strip(await log.read('p/prj_bbbbbbbbbbbb'))).toEqual([rec('memory', 2)])
    })

    it('survives a reopen (same storage)', async () => {
      const h = await make()
      await h.log.append('catalog', [rec('project', 1)])
      await h.log.append('p/prj_aaaaaaaaaaaa', [rec('memory', 2)])
      const again = await h.reopen()
      expect(strip(await again.read('catalog'))).toEqual([rec('project', 1)])
      expect(await again.partitions('p/')).toEqual(['p/prj_aaaaaaaaaaaa'])
      await again.append('catalog', [rec('session', 3)])
      const all = await again.read('catalog')
      expect(strip(all)).toEqual([rec('project', 1), rec('session', 3)])
      expect(all[1]!.seq!).toBeGreaterThan(all[0]!.seq!)
    })

    it('compacts to the same resulting state, durably, and keeps appending after it', async () => {
      const h = await make()
      await h.log.append('catalog', [rec('project', 1), rec('project', 2), rec('project', 3)])
      await h.log.compact('catalog', [rec('project', 3)])
      expect(strip(await h.log.read('catalog'))).toEqual([rec('project', 3)])
      await h.log.append('catalog', [rec('session', 4)])
      const again = await h.reopen()
      const all = await again.read('catalog')
      expect(strip(all)).toEqual([rec('project', 3), rec('session', 4)])
      expect(all[1]!.seq!).toBeGreaterThan(all[0]!.seq!)
    })

    it('drops a partition', async () => {
      const h = await make()
      await h.log.append('s/ses_aaaaaaaaaaaa', [rec('message', 1)])
      await h.log.drop('s/ses_aaaaaaaaaaaa')
      expect(await h.log.read('s/ses_aaaaaaaaaaaa')).toEqual([])
      expect(await h.log.partitions('s/')).toEqual([])
      expect(await (await h.reopen()).partitions('s/')).toEqual([])
      await h.log.drop('s/ses_unknown00000') // dropping nothing is fine
    })

    it('skips a corrupt line instead of failing the whole partition (when the harness can corrupt)', async () => {
      const h = await make()
      if (!h.corrupt) return
      await h.log.append('catalog', [rec('project', 1), rec('project', 2), rec('project', 3)])
      await h.corrupt('catalog')
      const again = await h.reopen()
      const got = strip(await again.read('catalog'))
      expect(got.length).toBe(2)
      for (const r of got)
        expect([rec('project', 1), rec('project', 2), rec('project', 3)]).toContainEqual(r)
    })
  })
}

const doc = (id: string, over: Partial<Parameters<SearchIndex['upsert']>[0]> = {}) => ({
  id,
  projectId: 'prj_aaaaaaaaaaaa' as string | null,
  kind: 'memory' as const,
  title: `title ${id}`,
  text: 'nothing special',
  ts: 1,
  ...over,
})

/** Every SearchIndex must pass this. `make()` returns an empty index. */
export function searchIndexContract(name: string, make: () => SearchIndex | Promise<SearchIndex>) {
  describe(`SearchIndex contract: ${name}`, () => {
    it('finds documents by words in the title or text, best first, with short snippets', async () => {
      const ix = await make()
      ix.upsert(doc('a', { text: 'the refresh token rotation for JWT auth' }))
      ix.upsert(doc('b', { title: 'JWT notes', text: 'JWT JWT and more JWT' }))
      ix.upsert(doc('c', { text: 'css colors' }))
      const hits = ix.query('jwt', { limit: 10 })
      expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
      for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(200)
      const scores = hits.map((h) => h.score)
      expect([...scores].sort((x, y) => y - x)).toEqual(scores)
      expect(ix.query('JWT', { limit: 10 }).length).toBe(2)
    })

    it('filters by project (null = no project) and kind, and honors the limit', async () => {
      const ix = await make()
      ix.upsert(doc('a', { text: 'deploy' }))
      ix.upsert(doc('b', { text: 'deploy', projectId: 'prj_bbbbbbbbbbbb' }))
      ix.upsert(doc('c', { text: 'deploy', projectId: null, kind: 'session' }))
      expect(
        ix.query('deploy', { projectIds: ['prj_bbbbbbbbbbbb'], limit: 10 }).map((h) => h.id),
      ).toEqual(['b'])
      expect(ix.query('deploy', { projectIds: [null], limit: 10 }).map((h) => h.id)).toEqual(['c'])
      expect(ix.query('deploy', { kinds: ['session'], limit: 10 }).map((h) => h.id)).toEqual(['c'])
      expect(ix.query('deploy', { limit: 2 }).length).toBe(2)
      expect(ix.query('deploy', { projectIds: [], limit: 10 })).toEqual([])
    })

    it('upsert replaces and remove forgets', async () => {
      const ix = await make()
      ix.upsert(doc('a', { text: 'alpha' }))
      ix.upsert(doc('a', { text: 'beta' }))
      expect(ix.query('alpha', { limit: 10 })).toEqual([])
      expect(ix.query('beta', { limit: 10 }).map((h) => h.id)).toEqual(['a'])
      ix.remove('a')
      ix.remove('unknown')
      expect(ix.query('beta', { limit: 10 })).toEqual([])
    })

    it('returns nothing for an empty or unmatched query', async () => {
      const ix = await make()
      ix.upsert(doc('a', { text: 'alpha' }))
      expect(ix.query('', { limit: 10 })).toEqual([])
      expect(ix.query('zzzz', { limit: 10 })).toEqual([])
    })
  })
}

export interface TranscriptFixture {
  reader: TranscriptReader
  /** A ref with `total` messages (≥ 5) whose user/assistant text contains `word`. */
  ref: string
  total: number
  word: string
  /** A sentinel that appears in the source only inside tool input/output or thinking. */
  secret: string
  /** A ref nothing was registered under. */
  unknownRef: string
}

/** Every TranscriptReader must pass this. */
export function transcriptReaderContract(name: string, make: () => Promise<TranscriptFixture>) {
  describe(`TranscriptReader contract: ${name}`, () => {
    it('pages newest last, with `more`, and continues with `before` without overlap', async () => {
      const f = await make()
      const first = await f.reader.page(f.ref, { limit: 2 })
      expect(first.messages.length).toBe(2)
      expect(first.more).toBe(true)
      const ts = first.messages.map((m) => m.ts)
      expect([...ts].sort((a, b) => a - b)).toEqual(ts)
      const seen = new Set(first.messages.map((m) => m.uuid))
      let before = first.messages[0]!.uuid
      let more = first.more
      while (more) {
        const p = await f.reader.page(f.ref, { before, limit: 2 })
        for (const m of p.messages) {
          expect(seen.has(m.uuid)).toBe(false)
          seen.add(m.uuid)
        }
        more = p.more
        if (p.messages.length) before = p.messages[0]!.uuid
        else break
      }
      expect(seen.size).toBe(f.total)
    })

    it('returns text ≤ 4000 chars and tool names only; never the secret', async () => {
      const f = await make()
      const all = await f.reader.page(f.ref, { limit: 1000 })
      for (const m of all.messages) {
        expect(m.text.length).toBeLessThanOrEqual(4000)
        expect(['user', 'assistant']).toContain(m.role)
        for (const t of m.tools) expect(typeof t).toBe('string')
      }
      expect(JSON.stringify(all)).not.toContain(f.secret)
      expect(JSON.stringify(await f.reader.search(f.ref, f.secret, 10))).not.toContain(f.secret)
      expect(await f.reader.search(f.ref, f.secret, 10)).toEqual([])
    })

    it('searches text with short snippets; unknown refs read as empty', async () => {
      const f = await make()
      const hits = await f.reader.search(f.ref, f.word, 3)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.length).toBeLessThanOrEqual(3)
      for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(200)
      expect(await f.reader.page(f.unknownRef, { limit: 5 })).toEqual({ messages: [], more: false })
      expect(await f.reader.search(f.unknownRef, f.word, 5)).toEqual([])
    })
  })
}

export interface HistoryFixture {
  source: HistorySource
  /** How many sessions the fixture holds (≥ 3). */
  total: number
  /** A sentinel that appears only inside message text, never in metadata. */
  secret: string
}

/** Every HistorySource must pass this. */
export function historySourceContract(name: string, make: () => Promise<HistoryFixture>) {
  describe(`HistorySource contract: ${name}`, () => {
    it('lists newest first, capped by the limit, and is stable between calls', async () => {
      const f = await make()
      const all = await f.source.list({ limit: 500 })
      expect(all).toHaveLength(f.total)
      const seen = all.map((p) => p.lastSeenAt)
      expect([...seen].sort((a, b) => b - a)).toEqual(seen)
      expect(await f.source.list({ limit: 2 })).toEqual(all.slice(0, 2))
      expect(await f.source.list({ limit: 0 })).toEqual([])
      expect((await f.source.list({ limit: 500 })).map((p) => p.providerSessionId)).toEqual(
        all.map((p) => p.providerSessionId),
      )
    })

    it('returns metadata only: ids, a tr_ ref, a title ≤ 80 chars, finite times; no content', async () => {
      const f = await make()
      const all = await f.source.list({ limit: 500 })
      expect(new Set(all.map((p) => p.providerSessionId)).size).toBe(all.length)
      for (const p of all) {
        expect(p.providerSessionId).toMatch(/^[A-Za-z0-9_-]{1,100}$/)
        expect(p.transcriptRef).toMatch(/^tr_[A-Za-z0-9_-]{1,100}$/)
        expect(p.title.length).toBeGreaterThan(0)
        expect(p.title.length).toBeLessThanOrEqual(80)
        expect(Number.isFinite(p.startedAt)).toBe(true)
        expect(Number.isFinite(p.lastSeenAt)).toBe(true)
      }
      expect(JSON.stringify(all)).not.toContain(f.secret)
    })
  })
}
