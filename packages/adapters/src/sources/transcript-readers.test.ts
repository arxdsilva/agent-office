import type { TranscriptReader } from '@agent-office/core'
import { describe, expect, it } from 'vitest'
import { TranscriptReaders } from './transcript-readers.ts'

const reader = (name: string): TranscriptReader & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    async page(ref) {
      calls.push(`page:${ref}`)
      return {
        messages: [{ uuid: name, role: 'user', text: name, ts: 1, tools: [] }],
        more: false,
      }
    },
    async search(ref, q) {
      calls.push(`search:${ref}:${q}`)
      return [{ uuid: name, snippet: name }]
    },
  }
}

describe('TranscriptReaders', () => {
  it('TR-route: Claude refs (tr_ + hex) stay on the default reader', async () => {
    const cc = reader('cc')
    const oc = reader('oc')
    const r = new TranscriptReaders({ default: cc, byPrefix: { oc } })
    const ref = `tr_${'ab12'.repeat(6)}`
    expect((await r.page(ref, { limit: 5 })).messages[0]!.uuid).toBe('cc')
    expect(await r.search(ref, 'x', 3)).toEqual([{ uuid: 'cc', snippet: 'cc' }])
    expect(oc.calls).toEqual([])
  })

  it('TR-route: a provider-prefixed ref goes to that provider only', async () => {
    const cc = reader('cc')
    const oc = reader('oc')
    const r = new TranscriptReaders({ default: cc, byPrefix: { oc } })
    expect((await r.page('tr_oc_abc', { limit: 5 })).messages[0]!.uuid).toBe('oc')
    expect(await r.search('tr_oc_abc', 'q', 3)).toEqual([{ uuid: 'oc', snippet: 'oc' }])
    expect(oc.calls).toEqual(['page:tr_oc_abc', 'search:tr_oc_abc:q'])
    expect(cc.calls).toEqual([])
  })

  it('TR-route: an unregistered prefix reads as empty and touches no reader', async () => {
    const cc = reader('cc')
    const r = new TranscriptReaders({ default: cc })
    expect(await r.page('tr_go_1', { limit: 5 })).toEqual({ messages: [], more: false })
    expect(await r.search('tr_go_1', 'q', 3)).toEqual([])
    expect(cc.calls).toEqual([])
  })

  it('TR-route: errors from the owning reader surface unchanged', async () => {
    const bad: TranscriptReader = {
      page: async () => {
        throw new Error('boom')
      },
      search: async () => [],
    }
    const r = new TranscriptReaders({ default: reader('cc'), byPrefix: { oc: bad } })
    await expect(r.page('tr_oc_x', { limit: 1 })).rejects.toThrow('boom')
  })
})
