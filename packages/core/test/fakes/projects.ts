// Fakes for the projects-first driven ports. Each passes its contract suite (test/fakes.test.ts).
import type {
  HistorySource,
  PastSession,
  RecordLog,
  RepoIdentity,
  RepoIdentityInfo,
  SearchDoc,
  SearchIndex,
  SecureRandom,
  TranscriptMessage,
  TranscriptReader,
  VaultRecord,
} from '../../src/ports/driven.ts'

type Storage = Map<string, VaultRecord[]>
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** In-memory vault. `reopen()` returns a new log over the same storage (an app restart). */
export class FakeRecordLog implements RecordLog {
  appends = 0
  compactions: string[] = []
  /** Set to make the next append reject (durability failure paths). */
  failNext = false
  constructor(
    readonly storage: Storage = new Map(),
    private mode: 'encrypted' | 'memory-only' = 'encrypted',
  ) {}
  status() {
    return this.mode
  }
  async partitions(prefix: string) {
    return [...this.storage.keys()].filter((k) => k.startsWith(prefix))
  }
  async read(p: string) {
    return clone(this.storage.get(p) ?? [])
  }
  async append(p: string, records: VaultRecord[]) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk full')
    }
    this.appends++
    const list = this.storage.get(p) ?? []
    let seq = list.at(-1)?.seq ?? 0
    for (const r of records) list.push({ ...clone(r), seq: ++seq })
    this.storage.set(p, list)
  }
  async compact(p: string, records: VaultRecord[]) {
    this.compactions.push(p)
    const seq = this.storage.get(p)?.at(-1)?.seq ?? 0
    this.storage.set(
      p,
      records.map((r, i) => ({ ...clone(r), seq: seq + i + 1 })),
    )
  }
  async drop(p: string) {
    this.storage.delete(p)
  }
  reopen(): FakeRecordLog {
    return new FakeRecordLog(this.storage, this.mode)
  }
  /** Every stored record of every partition (for no-leak assertions). */
  dump(): string {
    return JSON.stringify([...this.storage])
  }
}

/** Scripted identities: `set(locator, info)`; workspace keys derive from the common dir key. */
export class FakeRepoIdentity implements RepoIdentity {
  private infos = new Map<string, RepoIdentityInfo>()
  calls: string[] = []
  set(locator: string, info: RepoIdentityInfo): this {
    this.infos.set(locator, info)
    return this
  }
  async resolve(locator: string) {
    this.calls.push(locator)
    const i = this.infos.get(locator)
    return i ? clone(i) : null
  }
  async workspaceKey(locator: string) {
    const i = this.infos.get(locator)
    return i ? FakeRepoIdentity.keyOf(i.commonDirKey) : null
  }
  /** The `wk_` key an observe hook would send for this common dir key. */
  static keyOf(commonDirKey: string): string {
    let h = ''
    for (let i = 0; h.length < 32; i++)
      h += ((commonDirKey.charCodeAt(i % commonDirKey.length) + i) % 16).toString(16)
    return `wk_${h}`
  }
}

/** Transcripts by ref, already reduced to what agent-office may show. */
export class FakeTranscriptReader implements TranscriptReader {
  private m = new Map<string, TranscriptMessage[]>()
  fail = false
  set(ref: string, messages: TranscriptMessage[]): this {
    this.m.set(ref, clone(messages))
    return this
  }
  async page(ref: string, o: { before?: string; limit: number }) {
    if (this.fail) throw new Error('transcript gone')
    const all = this.m.get(ref) ?? []
    const end = o.before ? all.findIndex((x) => x.uuid === o.before) : all.length
    const stop = end < 0 ? 0 : end
    const start = Math.max(0, stop - o.limit)
    return { messages: clone(all.slice(start, stop)), more: start > 0 }
  }
  async search(ref: string, query: string, limit: number) {
    const q = query.toLowerCase()
    if (!q) return []
    return (this.m.get(ref) ?? [])
      .filter((x) => x.text.toLowerCase().includes(q))
      .slice(0, limit)
      .map((x) => ({ uuid: x.uuid, snippet: x.text.slice(0, 200) }))
  }
}

/** Case-insensitive "contains every word" search; score = occurrences. */
export class FakeSearchIndex implements SearchIndex {
  docs = new Map<string, SearchDoc>()
  upsert(d: SearchDoc) {
    this.docs.set(d.id, { ...d })
  }
  remove(id: string) {
    this.docs.delete(id)
  }
  query(
    q: string,
    o: { projectIds?: (string | null)[]; kinds?: SearchDoc['kind'][]; limit: number },
  ) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const out: { id: string; score: number; snippet: string }[] = []
    for (const d of this.docs.values()) {
      if (o.projectIds && !o.projectIds.includes(d.projectId)) continue
      if (o.kinds && !o.kinds.includes(d.kind)) continue
      const hay = `${d.title} ${d.text}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
      const score = words.reduce((n, w) => n + hay.split(w).length - 1, 0)
      const at = Math.max(0, hay.indexOf(words[0]!) - 60)
      out.push({ id: d.id, score, snippet: `${d.title} ${d.text}`.slice(at, at + 200) })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, o.limit)
  }
}

/** Deterministic hex tokens: bytes*2 hex chars from a counter (not secure; tests only). */
export class SeqRandom implements SecureRandom {
  private n = 0
  token(bytes: number): string {
    const seed = (++this.n).toString(16).padStart(8, '0')
    let s = ''
    while (s.length < bytes * 2) s += seed
    return s.slice(0, bytes * 2)
  }
}

/** Past sessions on disk; `list` honours the limit like the real source. */
export class FakeHistorySource implements HistorySource {
  fail = false
  constructor(private past: PastSession[] = []) {}
  set(past: PastSession[]): this {
    this.past = clone(past)
    return this
  }
  async list(o: { limit: number }) {
    if (this.fail) throw new Error('history unreadable')
    return clone(this.past.slice(0, o.limit))
  }
}
