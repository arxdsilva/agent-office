import { afterEach, describe, expect, it } from 'vitest'
import { connectWs, is, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

describe('events → WebSocket (E2E)', () => {
  it('streams snapshot, upserts and removals to browsers', async () => {
    const srv = await startServer({ expireAfterMs: 1_000 })
    cleanup.push(srv.close)

    // A fresh browser connection first receives a snapshot of the (empty) office.
    const client = await connectWs(srv.url)
    cleanup.push(client.close)
    const snap = await client.next(is('snapshot'))
    expect(snap.agents).toEqual([])

    // An external agent reports it is running a tool; the browser gets an upsert with the merged state.
    const res = await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'bot-1',
        name: 'Bot',
        provider: 'custom',
        topic: 'Deploy',
        status: 'tool',
        tool: 'Bash',
      }),
    })
    expect(res.status).toBe(202)
    const up = await client.next(is('upsert', (m) => m.agent.id === 'bot-1'))
    expect(up.agent).toMatchObject({
      provider: 'custom',
      topic: 'Deploy',
      status: 'tool',
      tool: 'Bash',
    })

    // When the agent goes silent past the expiry window, the sweep removes it and the browser is told.
    srv.store.sweep(Date.now() + 2_000)
    const rm = await client.next(is('remove'))
    expect(rm.id).toBe('bot-1')
  })

  it('a second browser sees agents that already exist in its snapshot', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    // Batch of two events from one producer.
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify([{ agentId: 'a' }, { agentId: 'b' }]),
    })

    const late = await connectWs(srv.url)
    cleanup.push(late.close)
    const snap = await late.next(is('snapshot'))
    expect(snap.agents.map((a) => a.id).sort()).toEqual(['a', 'b'])
  })
})
