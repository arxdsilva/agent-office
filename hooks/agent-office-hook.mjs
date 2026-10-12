#!/usr/bin/env node
// agent-office hook for Claude Code (Stop + UserPromptSubmit).
//
// Delivers messages typed in the agent-office UI into this Claude Code session, and posts
// Claude's answer back. It FAILS OPEN: on any error it prints nothing and exits 0, so it can
// never block or break a Claude session. Messages are passed to Claude as text only.
//
// Env overrides (used by tests): AGENT_OFFICE_URL, AGENT_OFFICE_TOKEN_FILE.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_REPLY_CHARS = 4000

/**
 * @param {{hook_event_name?: string, session_id?: string, last_assistant_message?: string}} input
 * @param {{url: string, token: string, fetch: typeof fetch, timeoutMs: number}} deps
 * @returns {Promise<string>} what to print on stdout ('' for nothing)
 */
export async function handle(input, deps) {
  try {
    const event = input?.hook_event_name
    if (!input?.session_id || !deps.token || (event !== 'Stop' && event !== 'UserPromptSubmit'))
      return ''
    const signal = AbortSignal.timeout(deps.timeoutMs)
    const agent = `${deps.url}/api/agents/${encodeURIComponent(`cc:${input.session_id}`)}`
    const headers = { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' }

    // Stop: Claude just finished a turn. If it was answering UI messages, record that answer.
    if (
      event === 'Stop' &&
      typeof input.last_assistant_message === 'string' &&
      input.last_assistant_message
    ) {
      await deps.fetch(`${agent}/replies`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          text: input.last_assistant_message.slice(0, MAX_REPLY_CHARS),
          requireAwaiting: true,
        }),
      })
    }

    const res = await deps.fetch(`${agent}/inbox?claim=1`, { headers, signal })
    if (!res.ok) return ''
    const { messages } = await res.json()
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const list = messages.map((m) => `- ${String(m.text)}`).join('\n')

    if (event === 'Stop') {
      return JSON.stringify({
        decision: 'block',
        reason: `📨 Message(s) from the agent-office UI:\n${list}\nRespond to them, then continue.`,
      })
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `📨 Messages from the agent-office UI (sent while you were idle):\n${list}`,
      },
    })
  } catch {
    return ''
  }
}

function readToken(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Full hook run minus process I/O: parses stdin, resolves URL and token from env, calls `handle`.
 * @param {string} raw stdin contents
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 */
export async function fromStdin(raw, env, fetchImpl) {
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return ''
  }
  return handle(input, {
    url: env.AGENT_OFFICE_URL || 'http://127.0.0.1:4317',
    token: readToken(env.AGENT_OFFICE_TOKEN_FILE || join(homedir(), '.agent-office', 'token')),
    fetch: fetchImpl,
    timeoutMs: 1500,
  })
}

/* v8 ignore start -- process glue; exercised by the child-process tests in agent-office-hook.test.ts */
async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const out = await fromStdin(raw, process.env, fetch)
  if (out) process.stdout.write(out)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().finally(() => process.exit(0))
}
/* v8 ignore stop */
