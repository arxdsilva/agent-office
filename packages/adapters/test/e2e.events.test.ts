import { afterEach, describe, expect, it } from 'vitest'
import { is, observe, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

describe('events over HTTP → UI stream (E2E)', () => {
  it('an external agent appears, updates, and is removed when it goes silent', async () => {
    const srv = await startServer({ expireAfterMs: 1_000 })
    cleanup.push(srv.close)
    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // An external agent reports it is running a tool; the UI stream gets an upsert with the merged state.
    const res = await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'bot-1', name: 'Bot', provider: 'custom', topic: 'Deploy', status: 'tool', tool: 'Bash' }),
    })
    expect(res.status).toBe(202)
    const up = await ui.next(is('upsert', (m) => m.agent.id === 'bot-1'))
    expect(up.agent).toMatchObject({ provider: 'custom', topic: 'Deploy', status: 'tool', tool: 'Bash' })

    // After the expiry window the sweep removes it and the UI is told.
    await new Promise((r) => setTimeout(r, 1_100))
    srv.office.activity.sweep()
    expect((await ui.next(is('remove'))).id).toBe('bot-1')
  })

  it('a UI opened later sees existing agents in its snapshot', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    // Batch of two events from one producer.
    await srv.api('/api/events', { method: 'POST', body: JSON.stringify([{ agentId: 'a' }, { agentId: 'b' }]) })
    expect(srv.office.query.snapshot().agents.map((a) => a.id).sort()).toEqual(['a', 'b'])
  })
})
