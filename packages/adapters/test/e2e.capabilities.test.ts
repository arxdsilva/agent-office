import type { Capability } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { is, observe, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

const find = (cs: Capability[], id: string) => cs.find((c) => c.id === id)

describe('capabilities over HTTP → UI stream (E2E)', () => {
  it('a generic provider declares capabilities and they reach the UI and later snapshots', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // A LangGraph app declares a database and a skill for its agents.
    const res = await srv.api('/api/providers/langgraph/capabilities', {
      method: 'POST',
      body: JSON.stringify([
        { id: 'mcp:warehouse_db', category: 'adapter', kind: 'database', label: 'Warehouse' },
        {
          id: 'skill:triage',
          category: 'skill',
          kind: 'skill',
          label: 'triage',
          summary: 'Sort tickets.',
        },
      ]),
    })
    expect(res.status).toBe(202)
    const msg = await ui.next(is('capabilities', (m) => m.provider === 'langgraph'))
    expect(msg.capabilities.map((c) => [c.id, c.declared])).toEqual([
      ['mcp:warehouse_db', true],
      ['skill:triage', true],
    ])

    // A UI opened later gets them in its snapshot.
    expect(srv.office.query.snapshot().capabilities?.map((c) => c.id)).toEqual([
      'mcp:warehouse_db',
      'skill:triage',
    ])

    // Over 64 declarations in one request is refused.
    const many = Array.from({ length: 65 }, (_, i) => ({
      id: `api:t${i}`,
      category: 'adapter',
      kind: 'api',
      label: `t${i}`,
    }))
    const tooMany = await srv.api('/api/providers/langgraph/capabilities', {
      method: 'POST',
      body: JSON.stringify(many),
    })
    expect(tooMany.status).toBe(413)
  })

  it('tool events with mcp__x__y and with Skill + skill:run-office are classified and streamed', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // An agent calls an MCP tool: the server becomes an observed adapter with the agent active on it.
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'ada',
        provider: 'claude-code',
        status: 'tool',
        tool: 'mcp__x__y',
      }),
    })
    const mcp = await ui.next(
      is('capabilities', (m) => m.provider === 'claude-code' && !!find(m.capabilities, 'mcp:x')),
    )
    expect(find(mcp.capabilities, 'mcp:x')).toMatchObject({
      category: 'adapter',
      kind: 'mcp',
      label: 'X',
      tools: ['y'],
      declared: false,
      calls: 1,
      active: ['ada'],
    })

    // The same agent invokes a skill: the skill is used (and active), the MCP server is released.
    // This lands inside the 250 ms window, so it arrives as the trailing publish.
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'ada',
        status: 'tool',
        tool: 'Skill',
        target: 'skill:run-office',
      }),
    })
    const lib = await ui.next(is('capabilities', (m) => !!find(m.capabilities, 'skill:run-office')))
    expect(find(lib.capabilities, 'skill:run-office')).toMatchObject({
      category: 'skill',
      calls: 1,
      active: ['ada'],
    })
    expect(find(lib.capabilities, 'mcp:x')!.active).toEqual([])

    // The agent finishes its turn: nothing is active any more.
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'ada', status: 'waiting' }),
    })
    const done = await ui.next(
      is('capabilities', (m) => find(m.capabilities, 'skill:run-office')?.active.length === 0),
    )
    expect(done.capabilities.every((c) => c.active.length === 0)).toBe(true)
  })

  it('a target outside the privacy grammar is dropped, and an explicit capability is honored', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // A generic producer sends a full URL as target (not allowed) and an explicit capability id.
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'bot',
        provider: 'custom',
        status: 'tool',
        tool: 'fetch',
        target: 'https://api.example.com/?token=sk-secret',
        capability: 'web',
      }),
    })
    const msg = await ui.next(is('capabilities', (m) => m.provider === 'custom'))
    expect(find(msg.capabilities, 'web')).toMatchObject({ tools: ['fetch'], sees: [] })
    expect(JSON.stringify(msg)).not.toContain('sk-secret')
  })
})
