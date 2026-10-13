// Routes TranscriptReader calls to the provider that owns a `tr_` ref. Refs of other providers carry a
// two-letter prefix (`tr_oc_…`, the provider's id prefix without its colon); Claude Code refs predate
// that (`tr_<hex>`) and stay on the default reader. An unknown prefix reads as an empty transcript.
import type { TranscriptReader } from '@agent-office/core'

/** `tr_` + two lowercase letters + `_`. Claude's refs are `tr_` + 24 hex chars, so they never match. */
const PREFIXED = /^tr_([a-z]{2})_/

export interface TranscriptReadersOptions {
  /** Reads refs without a provider prefix (Claude Code). */
  default: TranscriptReader
  /** By provider id prefix without the colon: `{ oc: openCodeReader }`. */
  byPrefix?: Record<string, TranscriptReader>
}

export class TranscriptReaders implements TranscriptReader {
  private readers: Map<string, TranscriptReader>

  constructor(private o: TranscriptReadersOptions) {
    this.readers = new Map(Object.entries(o.byPrefix ?? {}))
  }

  private route(ref: string): TranscriptReader | undefined {
    const prefix = PREFIXED.exec(ref)?.[1]
    if (prefix === undefined) return this.o.default
    return this.readers.get(prefix)
  }

  async page(ref: string, o: { before?: string; limit: number }) {
    return (await this.route(ref)?.page(ref, o)) ?? { messages: [], more: false }
  }

  async search(ref: string, query: string, limit: number) {
    return (await this.route(ref)?.search(ref, query, limit)) ?? []
  }
}
