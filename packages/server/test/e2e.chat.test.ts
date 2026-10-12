import type { ChatMessage } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { connectWs, is, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

describe('chat round trip (E2E)', () => {
  it('UI message → agent inbox (long-poll) → agent reply → UI', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'helper', provider: 'custom' }),
    })
    const ui = await connectWs(srv.url)
    cleanup.push(ui.close)
    await ui.next(is('snapshot'))

    // The agent starts long-polling its inbox before anything is sent (wait=5 holds the request open).
    const poll = srv.api('/api/agents/helper/inbox?claim=1&wait=5')

    // The user sends a message from the UI; browsers see it as queued and the agent's unread badge goes to 1.
    const sent = await srv.api('/api/agents/helper/messages', {
      method: 'POST',
      headers: { origin: srv.url },
      body: JSON.stringify({ text: 'please summarize the logs' }),
    })
    expect(sent.status).toBe(202)
    const { message } = (await sent.json()) as { message: ChatMessage }
    await ui.next(is('chat', (m) => m.message.id === message.id && m.message.state === 'queued'))

    // The long-poll returns the message; the UI sees it flip to delivered and the agent become interactive.
    const inbox = (await (await poll).json()) as { messages: ChatMessage[] }
    expect(inbox.messages.map((m) => m.text)).toEqual(['please summarize the logs'])
    await ui.next(is('chat', (m) => m.message.id === message.id && m.message.state === 'delivered'))
    await ui.next(
      is('upsert', (m) => m.agent.id === 'helper' && m.agent.interactive && m.agent.unread === 0),
    )

    // The agent answers; the UI receives the reply and the original message marked replied.
    const replied = await srv.api('/api/agents/helper/replies', {
      method: 'POST',
      body: JSON.stringify({ text: 'Logs look clean.', inReplyTo: message.id }),
    })
    expect(replied.status).toBe(202)
    await ui.next(is('chat', (m) => m.message.id === message.id && m.message.state === 'replied'))
    const answer = await ui.next(is('chat', (m) => m.message.from === 'agent'))
    expect(answer.message).toMatchObject({ text: 'Logs look clean.', inReplyTo: message.id })

    // History endpoint returns the whole thread in order.
    const history = (await (await srv.api('/api/agents/helper/messages')).json()) as ChatMessage[]
    expect(history.map((m) => [m.from, m.state])).toEqual([
      ['user', 'replied'],
      ['agent', 'replied'],
    ])
  })
})
