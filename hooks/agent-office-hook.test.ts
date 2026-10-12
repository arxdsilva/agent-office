import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, no types
import { fromStdin, handle } from './agent-office-hook.mjs'

type Call = { method: string; url: string; body?: unknown; auth?: string }

/** Fake fetch that records calls and answers from a route table. */
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []) {
  const f = async (
    url: string,
    init: { method?: string; body?: string; headers: Record<string, string> },
  ) => {
    const path = new URL(url).pathname + new URL(url).search
    calls.push({
      method: init.method ?? 'GET',
      url: path,
      body: init.body && JSON.parse(init.body),
      auth: init.headers.authorization,
    })
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`
    if (!(key in routes)) return new Response('', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }
  return { f, calls }
}

const deps = (f: unknown) => ({
  url: 'http://127.0.0.1:4317',
  token: 't0k',
  fetch: f,
  timeoutMs: 500,
})
const INBOX = 'GET /api/agents/cc%3As1/inbox'
const REPLIES = 'POST /api/agents/cc%3As1/replies'

describe('handle (Stop)', () => {
  it('posts the last answer as a reply, then blocks with new messages', async () => {
    const { f, calls } = fakeFetch({
      [REPLIES]: {},
      [INBOX]: { messages: [{ text: 'check CI' }, { text: 'then deploy' }] },
    })
    const out = await handle(
      { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'All tests pass.' },
      deps(f),
    )
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/agents/cc%3As1/replies',
      body: { text: 'All tests pass.', requireAwaiting: true },
      auth: 'Bearer t0k',
    })
    expect(calls[1]!.url).toBe('/api/agents/cc%3As1/inbox?claim=1')
    const parsed = JSON.parse(out)
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toContain('- check CI')
    expect(parsed.reason).toContain('- then deploy')
  })

  it('prints nothing when the inbox is empty', async () => {
    const { f } = fakeFetch({ [REPLIES]: {}, [INBOX]: { messages: [] } })
    expect(await handle({ hook_event_name: 'Stop', session_id: 's1' }, deps(f))).toBe('')
  })

  it('skips the reply when there is no last message', async () => {
    const { f, calls } = fakeFetch({ [INBOX]: { messages: [] } })
    await handle({ hook_event_name: 'Stop', session_id: 's1' }, deps(f))
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
})

describe('handle (UserPromptSubmit)', () => {
  it('adds queued messages as additional context', async () => {
    const { f } = fakeFetch({ [INBOX]: { messages: [{ text: 'use staging' }] } })
    const out = JSON.parse(
      await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps(f)),
    )
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(out.hookSpecificOutput.additionalContext).toContain('- use staging')
  })
})

describe('handle fails open', () => {
  it('returns empty output on network errors, bad JSON, unknown events, or missing fields', async () => {
    const boom = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await handle({ hook_event_name: 'Stop', session_id: 's1' }, deps(boom))).toBe('')
    const bad = async () => new Response('not json', { status: 200 })
    expect(await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps(bad))).toBe(
      '',
    )
    const { f } = fakeFetch({})
    expect(await handle({ hook_event_name: 'PreToolUse', session_id: 's1' }, deps(f))).toBe('')
    expect(await handle({ hook_event_name: 'Stop' }, deps(f))).toBe('')
    expect(
      await handle({ hook_event_name: 'Stop', session_id: 's1' }, { ...deps(f), token: '' }),
    ).toBe('')
  })

  it('gives up within the timeout when the server hangs', async () => {
    const hang = (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    const t = Date.now()
    expect(
      await handle(
        { hook_event_name: 'UserPromptSubmit', session_id: 's1' },
        { ...deps(hang), timeoutMs: 100 },
      ),
    ).toBe('')
    expect(Date.now() - t).toBeLessThan(1000)
  })
})

describe('fromStdin', () => {
  it('parses stdin, reads the token file and uses env overrides', async () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'ao-hook-')), 'token')
    writeFileSync(tokenFile, 'filetoken\n')
    const { f, calls } = fakeFetch({
      'GET /api/agents/cc%3As2/inbox': { messages: [{ text: 'hey' }] },
    })
    const out = await fromStdin(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's2' }),
      { AGENT_OFFICE_URL: 'http://127.0.0.1:9', AGENT_OFFICE_TOKEN_FILE: tokenFile },
      f,
    )
    expect(calls[0]!.auth).toBe('Bearer filetoken')
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('hey')
  })

  it('returns nothing for invalid JSON or a missing token file', async () => {
    const { f, calls } = fakeFetch({})
    expect(await fromStdin('nope', {}, f)).toBe('')
    expect(
      await fromStdin(
        '{"hook_event_name":"Stop","session_id":"s"}',
        { AGENT_OFFICE_TOKEN_FILE: '/no/such' },
        f,
      ),
    ).toBe('')
    expect(calls).toEqual([])
  })
})

describe('script (child process)', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  const run = (stdin: string, env: Record<string, string>) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [join(__dirname, 'agent-office-hook.mjs')],
        { env: { ...process.env, ...env } },
        (err, stdout) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
      )
      child.stdin!.end(stdin)
    })

  it('reads stdin, calls the server with the token file, prints JSON, exits 0', async () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'ao-hook-')), 'token')
    writeFileSync(tokenFile, 'filetoken\n')
    let auth = ''
    server = createServer((req, res) => {
      auth = req.headers.authorization ?? ''
      res.end(JSON.stringify({ messages: [{ text: 'from the UI' }] }))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const { code, stdout } = await run(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's9' }),
      {
        AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
        AGENT_OFFICE_TOKEN_FILE: tokenFile,
      },
    )
    expect(code).toBe(0)
    expect(auth).toBe('Bearer filetoken')
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('from the UI')
  })

  it('exits 0 silently when the server is down or the token is missing', async () => {
    const down = await run(JSON.stringify({ hook_event_name: 'Stop', session_id: 's9' }), {
      AGENT_OFFICE_URL: 'http://127.0.0.1:1',
      AGENT_OFFICE_TOKEN_FILE: '/nonexistent/token',
    })
    expect(down).toEqual({ code: 0, stdout: '' })
    const garbage = await run('not json', { AGENT_OFFICE_TOKEN_FILE: '/nonexistent/token' })
    expect(garbage).toEqual({ code: 0, stdout: '' })
  })
})
