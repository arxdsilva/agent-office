import type { RecordLog, VaultRecord } from '@agent-office/core'
import { checkPartition } from './partition.ts'

const copy = (r: VaultRecord, seq: number): VaultRecord => ({
  t: r.t,
  seq,
  ts: r.ts,
  data: structuredClone(r.data),
})

/** A RecordLog that keeps everything in memory (no OS keychain, and tests). Lost on quit. */
export class MemoryRecordLog implements RecordLog {
  private parts = new Map<string, VaultRecord[]>()

  status(): 'memory-only' {
    return 'memory-only'
  }

  async partitions(prefix: string): Promise<string[]> {
    return [...this.parts.keys()].filter((p) => p.startsWith(prefix)).sort()
  }

  async read(partition: string): Promise<VaultRecord[]> {
    checkPartition(partition)
    return (this.parts.get(partition) ?? []).map((r) => copy(r, r.seq!))
  }

  async append(partition: string, records: VaultRecord[]): Promise<void> {
    checkPartition(partition)
    const list = this.parts.get(partition) ?? []
    let seq = list.at(-1)?.seq ?? 0
    for (const r of records) list.push(copy(r, ++seq))
    this.parts.set(partition, list)
  }

  async compact(partition: string, records: VaultRecord[]): Promise<void> {
    checkPartition(partition)
    this.parts.set(
      partition,
      records.map((r, i) => copy(r, i + 1)),
    )
  }

  async drop(partition: string): Promise<void> {
    checkPartition(partition)
    this.parts.delete(partition)
  }

  /** Nothing to compact in memory. */
  async needsCompaction(partition: string): Promise<boolean> {
    checkPartition(partition)
    return false
  }
}
