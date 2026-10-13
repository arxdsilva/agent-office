import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger, RecordLog, VaultRecord } from '@agent-office/core'
import { openLine, sealLine } from './aes-box.ts'
import { appendDurable, createFileExclusiveSync, writeFileDurable } from './durable.ts'
import type { KeyProvider } from './key-provider.ts'
import { MemoryRecordLog } from './memory-record-log.ts'
import { checkPartition, PARTITION } from './partition.ts'

export interface FileRecordLogOptions {
  /** The vault directory (`<userData>/vault`). Created with mode 0700. */
  dir: string
  keys: KeyProvider
  log?: Logger
  /** Size above which `needsCompaction` is true. Default 2 MB. */
  compactBytes?: number
  /** Clock for `.corrupt-<ts>` names. */
  now?: () => number
}

/** Where the next append goes. Every line, readable or not, takes one seq. */
interface Tail {
  seq: number
  /** The file ends without '\n' (a torn append); the next append starts a new line first. */
  torn: boolean
}

interface Loaded extends Tail {
  records: VaultRecord[]
  corrupt: number
}

const KEY_FILE = 'key.v1'
const KEY_BYTES = 32

const isRecord = (v: unknown): v is VaultRecord => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.t === 'string' &&
    typeof r.ts === 'number' &&
    typeof r.data === 'object' &&
    r.data !== null &&
    !Array.isArray(r.data)
  )
}

/**
 * The encrypted vault (docs/projects.md §3): one append-only file per partition, one AES-256-GCM
 * line per record with AAD `<partition>|<seq>`, where seq is the record's 1-based line number
 * (so moving, swapping or splicing lines fails authentication). The random data key is wrapped
 * by the KeyProvider in `key.v1`. Without a usable key the log runs memory-only and never
 * touches the key file.
 */
export class FileRecordLog implements RecordLog {
  static readonly COMPACT_BYTES = 2 * 1024 * 1024

  private readonly dir: string
  private readonly log: Logger | undefined
  private readonly compactBytes: number
  private readonly now: () => number
  private readonly key: Buffer | null
  private readonly fallback = new MemoryRecordLog()
  private readonly tails = new Map<string, Tail>()
  private readonly corrupt = new Map<string, number>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(o: FileRecordLogOptions) {
    this.dir = o.dir
    this.log = o.log
    this.compactBytes = o.compactBytes ?? FileRecordLog.COMPACT_BYTES
    this.now = o.now ?? Date.now
    this.key = this.loadKey(o.keys)
  }

  status(): 'encrypted' | 'memory-only' {
    return this.key ? 'encrypted' : 'memory-only'
  }

  /** Lines skipped as corrupt or tampered, from the latest read of each partition. */
  stats(): { corrupt: number } {
    let corrupt = 0
    for (const n of this.corrupt.values()) corrupt += n
    return { corrupt }
  }

  async partitions(prefix: string): Promise<string[]> {
    if (!this.key) return this.fallback.partitions(prefix)
    const found: string[] = []
    if (existsSync(this.file('catalog'))) found.push('catalog')
    for (const sub of ['p', 's']) {
      const names = await readdir(join(this.dir, sub)).catch(() => [] as string[])
      for (const n of names) {
        const p = `${sub}/${n.slice(0, -'.log'.length)}`
        if (n.endsWith('.log') && PARTITION.test(p)) found.push(p)
      }
    }
    return found.filter((p) => p.startsWith(prefix)).sort()
  }

  async read(partition: string): Promise<VaultRecord[]> {
    checkPartition(partition)
    if (!this.key) return this.fallback.read(partition)
    return this.serial(partition, async () => (await this.load(partition)).records)
  }

  async append(partition: string, records: VaultRecord[]): Promise<void> {
    checkPartition(partition)
    const key = this.key
    if (!key) return this.fallback.append(partition, records)
    await this.serial(partition, async () => {
      if (records.length === 0) return
      const tail = this.tails.get(partition) ?? (await this.load(partition))
      let seq = tail.seq
      const lines = records.map((r) => this.seal(key, partition, ++seq, r))
      await appendDurable(this.file(partition), `${tail.torn ? '\n' : ''}${lines.join('\n')}\n`)
      this.tails.set(partition, { seq, torn: false })
    })
  }

  async compact(partition: string, records: VaultRecord[]): Promise<void> {
    checkPartition(partition)
    const key = this.key
    if (!key) return this.fallback.compact(partition, records)
    await this.serial(partition, async () => {
      const body = records.map((r, i) => `${this.seal(key, partition, i + 1, r)}\n`).join('')
      await writeFileDurable(this.file(partition), body)
      this.tails.set(partition, { seq: records.length, torn: false })
      this.corrupt.delete(partition)
    })
  }

  async drop(partition: string): Promise<void> {
    checkPartition(partition)
    if (!this.key) return this.fallback.drop(partition)
    await this.serial(partition, async () => {
      await rm(this.file(partition), { force: true })
      this.tails.delete(partition)
      this.corrupt.delete(partition)
    })
  }

  /** True when the partition's file is over the compaction threshold (2 MB by default). */
  async needsCompaction(partition: string): Promise<boolean> {
    checkPartition(partition)
    if (!this.key) return false
    const st = await stat(this.file(partition)).catch(() => null)
    return st !== null && st.size > this.compactBytes
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private file(partition: string): string {
    return join(this.dir, `${partition}.log`)
  }

  private seal(key: Buffer, partition: string, seq: number, r: VaultRecord): string {
    return sealLine(key, JSON.stringify({ t: r.t, ts: r.ts, data: r.data }), `${partition}|${seq}`)
  }

  /** Per-partition FIFO so concurrent calls never interleave or reuse a seq. */
  private serial<T>(partition: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(partition) ?? Promise.resolve()).then(fn)
    this.queues.set(
      partition,
      next.catch(() => undefined),
    )
    return next
  }

  /** Reads and decrypts a partition, and refreshes its tail and corrupt count. */
  private async load(partition: string): Promise<Loaded> {
    const out = await this.decryptFile(partition)
    this.tails.set(partition, { seq: out.seq, torn: out.torn })
    this.corrupt.set(partition, out.corrupt)
    return out
  }

  private async decryptFile(partition: string): Promise<Loaded> {
    const empty: Loaded = { seq: 0, torn: false, corrupt: 0, records: [] }
    const file = this.file(partition)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await this.quarantine(file)
      return empty
    }
    if (text === '') return empty
    const torn = !text.endsWith('\n')
    const lines = text.split('\n')
    if (!torn) lines.pop()
    const records: VaultRecord[] = []
    lines.forEach((line, i) => {
      const seq = i + 1
      try {
        const plain = openLine(this.key!, line, `${partition}|${seq}`).toString('utf8')
        const v: unknown = JSON.parse(plain)
        if (isRecord(v)) records.push({ t: v.t, seq, ts: v.ts, data: v.data })
      } catch {
        // Counted below: tampered, torn or written with another key.
      }
    })
    if (records.length === 0) {
      await this.quarantine(file)
      return empty
    }
    const corrupt = lines.length - records.length
    if (corrupt > 0) this.log?.warn(`vault: skipped ${corrupt} unreadable record(s)`)
    return { seq: lines.length, torn, corrupt, records }
  }

  /** Never deletes data: an unreadable file is moved aside as `<file>.corrupt-<ts>`. */
  private async quarantine(file: string): Promise<void> {
    try {
      await rename(file, `${file}.corrupt-${this.now()}`)
      this.log?.warn('vault: moved an unreadable partition aside')
    } catch {
      this.log?.warn('vault: could not move an unreadable partition aside')
    }
  }

  private loadKey(keys: KeyProvider): Buffer | null {
    if (keys.status() !== 'available') {
      this.log?.warn('vault: no OS keychain; running memory-only')
      return null
    }
    const file = join(this.dir, KEY_FILE)
    if (!existsSync(file)) {
      try {
        const key = randomBytes(KEY_BYTES)
        createFileExclusiveSync(file, keys.wrap(key))
        return key
      } catch (e) {
        // EEXIST: another instance created it first; use theirs below.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.log?.warn('vault: could not create the data key; running memory-only')
          return null
        }
      }
    }
    try {
      const key = keys.unwrap(readFileSync(file))
      if (key.length !== KEY_BYTES) throw new Error('bad key length')
      return key
    } catch {
      this.log?.warn('vault: the data key could not be unwrapped; running memory-only')
      return null
    }
  }
}
