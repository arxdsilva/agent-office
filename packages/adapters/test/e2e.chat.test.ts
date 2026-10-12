import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { is, observe, startServer, TOKEN } from './helpers.ts'

const HOOK = fileURLToPath(new URL('../../../hooks/agent-office-hook.mjs', import.meta.url))

/** Runs the real hook script the way Claude Code does: JSON on stdin, JSON (or nothing) on stdout. */
function runHook(input: object, env: Record<string, string>) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin!.end(JSON.stringify(input))
  })
}

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
    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // The agent starts long-polling its inbox before anything is sent (wait=5 holds the request open).
    const poll = srv.api('/api/agents/helper/inbox?claim=1&wait=5')

    // The user sends a message from the UI; the UI sees it as queued and the agent's unread badge goes to 1.
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

  it('delivers a context preamble to a terminal session verbatim through the hook (EC-ctx)', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    await srv.api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'cc:sess-ctx', provider: 'claude-code' }),
    })

    // The UI composed a message with attached context and tools (format of session-prompt §6.1;
    // paths and tools are invented). For a terminal session it is queued as plain text.
    const preamble = [
      'why does checkout fail?',
      '',
      '---',
      'Context from agent-office (the user attached these; read them as needed):',
      '- file: /home/dev/shop/src/checkout.ts',
      '- folder: /home/dev/shop/src/coupons',
      'Use these tools for this request: skill run-office, Shell (Bash).',
    ].join('\n')
    const sent = await srv.api(`/api/agents/${encodeURIComponent('cc:sess-ctx')}/messages`, {
      method: 'POST',
      headers: { origin: srv.url },
      body: JSON.stringify({ text: preamble }),
    })
    expect(sent.status).toBe(202)

    // The user prompts in the terminal: the hook hands the whole preamble to Claude, line for line.
    const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-ctx-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, TOKEN)
    const out = JSON.parse(
      await runHook(
        { hook_event_name: 'UserPromptSubmit', session_id: 'sess-ctx', permission_mode: 'default' },
        { AGENT_OFFICE_URL: srv.url, AGENT_OFFICE_TOKEN_FILE: tokenFile },
      ),
    )
    expect(out.hookSpecificOutput.additionalContext).toContain(`- ${preamble}`)
    expect(srv.office.query.agent('cc:sess-ctx')?.permissionMode).toBe('default')
  })
})
