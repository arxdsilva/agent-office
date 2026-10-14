import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, no types
import { fromStdin, mapEvent } from './agent-office-observe.mjs'

// Stdin field names, checked 2026-10-12 against the official references:
// - Cursor https://cursor.com/docs/agent/hooks
// - Gemini https://geminicli.com/docs/hooks/reference/
// - Copilot https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
const SECRET = 'sk-SENTINEL-s3cret'
const LEAK_PATH = '/Users/victim/private'
const EMAIL = 'victim@example.com'

const cursor = (o: object) => ({
  conversation_id: 'conv-1',
  model: 'gpt-x',
  workspace_roots: [`${LEAK_PATH}/my-proj`],
  user_email: EMAIL,
  transcript_path: `${LEAK_PATH}/t.jsonl`,
  ...o,
})
const gemini = (o: object) => ({
  session_id: 'g-1',
  cwd: `${LEAK_PATH}/gproj`,
  transcript_path: `${LEAK_PATH}/t.json`,
  ...o,
})
const copilot = (o: object) => ({ sessionId: 'c-1', cwd: `${LEAK_PATH}/cproj`, ...o })

describe('mapEvent: cursor (HK-1)', () => {
  it('maps the subscribed events to a status', () => {
    const m = (name: string, extra: object = {}) =>
      mapEvent('cursor', cursor({ hook_event_name: name, ...extra }))
    expect(m('sessionStart')).toMatchObject({
      agentId: 'cu:conv-1',
      provider: 'cursor',
      source: 'hook',
      status: 'idle',
      name: 'my-proj',
      topic: 'my-proj',
      model: 'gpt-x',
    })
    expect(m('afterAgentThought', { text: SECRET })).toMatchObject({ status: 'thinking' })
    expect(m('postToolUse', { tool_name: 'Grep' })).toMatchObject({ status: 'tool', tool: 'Grep' })
    expect(m('afterShellExecution', { command: SECRET })).toMatchObject({
      status: 'tool',
      tool: 'Bash',
    })
    expect(m('afterFileEdit')).toMatchObject({ status: 'tool', tool: 'Edit' })
    expect(m('afterMCPExecution', { tool_name: 'x' })).toMatchObject({
      status: 'tool',
      tool: 'mcp',
    })
    expect(m('stop')).toMatchObject({ status: 'waiting' })
    expect(m('sessionEnd')).toMatchObject({ status: 'done' })
  })
  it('drops unknown/blocking events and subagentStop (no child id in the payload)', () => {
    for (const n of ['preToolUse', 'beforeSubmitPrompt', 'subagentStart', 'subagentStop', 'nope'])
      expect(mapEvent('cursor', cursor({ hook_event_name: n }))).toBeNull()
  })
})

describe('mapEvent: gemini (HK-2)', () => {
  it('maps events; name from cwd; model from llm_request', () => {
    const m = (name: string, extra: object = {}) =>
      mapEvent('gemini', gemini({ hook_event_name: name, ...extra }))
    expect(m('SessionStart')).toMatchObject({
      agentId: 'gm:g-1',
      provider: 'gemini',
      status: 'idle',
      name: 'gproj',
    })
    expect(m('AfterModel', { llm_request: { model: 'gemini-3', messages: SECRET } })).toMatchObject(
      {
        status: 'thinking',
        model: 'gemini-3',
      },
    )
    expect(m('AfterTool', { tool_name: 'read_file', tool_input: { p: SECRET } })).toMatchObject({
      status: 'tool',
      tool: 'read_file',
    })
    expect(m('AfterAgent', { prompt: SECRET })).toMatchObject({ status: 'waiting' })
    expect(m('Notification', { message: SECRET })).toMatchObject({ status: 'waiting' })
    expect(m('SessionEnd')).toMatchObject({ status: 'done' })
    expect(m('BeforeTool')).toBeNull()
  })
})

describe('mapEvent: copilot (HK-3)', () => {
  it('maps events incl. errors', () => {
    const m = (name: string, extra: object = {}) =>
      mapEvent('copilot', copilot({ hook_event_name: name, ...extra }))
    expect(m('sessionStart')).toMatchObject({
      agentId: 'gh:c-1',
      provider: 'copilot',
      status: 'idle',
      name: 'cproj',
    })
    expect(m('userPromptSubmitted', { prompt: SECRET })).toMatchObject({ status: 'thinking' })
    expect(m('postToolUse', { toolName: 'bash', toolArgs: SECRET })).toMatchObject({
      status: 'tool',
      tool: 'bash',
    })
    expect(m('postToolUseFailure', { toolName: 'edit' })).toMatchObject({
      status: 'tool',
      tool: 'edit',
    })
    expect(m('errorOccurred', { error: { message: SECRET } })).toMatchObject({ status: 'error' })
    expect(m('agentStop')).toMatchObject({ status: 'waiting' })
    expect(m('sessionEnd')).toMatchObject({ status: 'done' })
    expect(m('preToolUse')).toBeNull()
  })
  it('subagent events become a child with parentId (keyed by agentName)', () => {
    expect(
      mapEvent('copilot', copilot({ hook_event_name: 'subagentStart', agentName: 'explore' })),
    ).toMatchObject({
      agentId: 'gh:c-1.explore',
      parentId: 'gh:c-1',
      status: 'thinking',
    })
    expect(
      mapEvent('copilot', copilot({ hook_event_name: 'subagentStop', agentName: 'explore' })),
    ).toMatchObject({
      agentId: 'gh:c-1.explore',
      parentId: 'gh:c-1',
      status: 'done',
    })
    expect(
      mapEvent('copilot', copilot({ hook_event_name: 'subagentStart', agentName: 'bad/name' })),
    ).toBeNull()
  })
})

describe('mapEvent: copilot event inference (payloads have no event name)', () => {
  const m = (extra: object) => mapEvent('copilot', copilot(extra))
  it('infers from the documented field shapes', () => {
    expect(m({ source: 'startup', initialPrompt: SECRET })).toMatchObject({ status: 'idle' })
    expect(m({ prompt: SECRET })).toMatchObject({ status: 'thinking' })
    expect(m({ toolName: 'bash', toolResult: {} })).toMatchObject({ status: 'tool', tool: 'bash' })
    expect(m({ toolName: 'bash', error: 'x' })).toMatchObject({ status: 'tool' })
    expect(m({ error: { message: SECRET }, recoverable: true })).toMatchObject({ status: 'error' })
    expect(m({ stopReason: 'end_turn', transcriptPath: '/p' })).toMatchObject({ status: 'waiting' })
    expect(m({ agentName: 'explore' })).toMatchObject({ status: 'thinking', parentId: 'gh:c-1' })
    expect(
      m({ agentName: 'explore', agentId: 'a1', agentType: 't', stopReason: 's' }),
    ).toMatchObject({ status: 'done' })
    expect(m({ reason: 'complete' })).toMatchObject({ status: 'done', agentId: 'gh:c-1' })
    expect(m({})).toBeNull()
    expect(
      mapEvent('copilot', copilot({}), { AGENT_OFFICE_HOOK_EVENT: 'agentStop' }),
    ).toMatchObject({ status: 'waiting' })
  })
})

describe('mapEvent: validation and privacy (HK-4, HK-5)', () => {
  it('drops invalid ids and bad input', () => {
    for (const id of ['', 'a b', '../x', 'x'.repeat(161), 5, null, undefined])
      expect(
        mapEvent('cursor', cursor({ hook_event_name: 'stop', conversation_id: id })),
      ).toBeNull()
    expect(mapEvent('cursor', null)).toBeNull()
    expect(mapEvent('nope', {})).toBeNull()
    expect(mapEvent('cursor', 'str')).toBeNull()
  })
  it('never carries prompts, inputs, paths, emails or transcript paths', () => {
    const dirty = {
      text: SECRET,
      command: SECRET,
      tool_input: { a: SECRET },
      tool_output: SECRET,
      prompt: SECRET,
      toolArgs: SECRET,
      llm_request: { model: 'm', x: SECRET },
      file_path: `${LEAK_PATH}/f`,
      mcp_server_url: `https://${SECRET}.example`,
    }
    const cases: [string, object][] = [
      ['cursor', cursor({ ...dirty, hook_event_name: 'postToolUse', tool_name: 'Edit' })],
      ['gemini', gemini({ ...dirty, hook_event_name: 'AfterTool', tool_name: 'Edit' })],
      ['copilot', copilot({ ...dirty, hook_event_name: 'postToolUse', toolName: 'edit' })],
    ]
    for (const [p, input] of cases) {
      const s = JSON.stringify(mapEvent(p, input))
      for (const bad of [SECRET, LEAK_PATH, EMAIL, 'transcript']) expect(s).not.toContain(bad)
    }
  })
  it('drops a tool name that is not a plain identifier', () => {
    const e = mapEvent(
      'cursor',
      cursor({ hook_event_name: 'postToolUse', tool_name: `rm -rf ${LEAK_PATH}` }),
    )
    expect(JSON.stringify(e)).not.toContain(LEAK_PATH)
  })
})

describe('fromStdin (HK-6..8)', () => {
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'ao-obs-')), 'token')
  writeFileSync(tokenFile, 'tok\n')
  const env = { AGENT_OFFICE_URL: 'http://127.0.0.1:4317', AGENT_OFFICE_TOKEN_FILE: tokenFile }
  const raw = JSON.stringify(cursor({ hook_event_name: 'stop' }))

  it('posts the event with the bearer token', async () => {
    const calls: { url: string; init: any }[] = []
    const f = async (url: string, init: any) => (
      calls.push({ url, init }),
      new Response('{}', { status: 202 })
    )
    await fromStdin('cursor', raw, env, f)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:4317/api/events')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({
      agentId: 'cu:conv-1',
      status: 'waiting',
      source: 'hook',
    })
    expect(calls[0]!.init.body).not.toContain(EMAIL)
  })
  it('does nothing in managed sessions', async () => {
    let n = 0
    await fromStdin(
      'cursor',
      raw,
      { ...env, AGENT_OFFICE_MANAGED: '1' },
      async () => (n++, new Response()),
    )
    expect(n).toBe(0)
  })
  it('swallows garbage, oversized input, missing token and fetch failures', async () => {
    const boom = async () => {
      throw new Error('down')
    }
    await expect(fromStdin('cursor', '{oops', env, boom)).resolves.toBeUndefined()
    await expect(fromStdin('cursor', raw, env, boom)).resolves.toBeUndefined()
    await expect(fromStdin('cursor', 'x'.repeat(300_000), env, boom)).resolves.toBeUndefined()
    let n = 0
    await fromStdin(
      'cursor',
      raw,
      { ...env, AGENT_OFFICE_TOKEN_FILE: '/nonexistent/tok' },
      async () => (n++, new Response()),
    )
    expect(n).toBe(0)
  })
})

describe('fromStdin: workspace key', () => {
  const home = mkdtempSync(join(tmpdir(), 'ao-wk-'))
  const tokenFile = join(home, 'token')
  const saltFile = join(home, 'workspace-salt')
  writeFileSync(tokenFile, 'tok\n')
  const repoDir = join(home, 'SENTINEL-parent', 'repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  const env = (o: object = {}) => ({
    AGENT_OFFICE_URL: 'http://127.0.0.1:4317',
    AGENT_OFFICE_TOKEN_FILE: tokenFile,
    AGENT_OFFICE_WORKSPACE_SALT_FILE: saltFile,
    ...o,
  })
  const post = async (e: object) => {
    let body = ''
    const f = async (_u: string, init: any) => ((body = init.body), new Response())
    await fromStdin(
      'cursor',
      JSON.stringify(cursor({ hook_event_name: 'stop', workspace_roots: [repoDir] })),
      e as any,
      f,
    )
    return body
  }

  it('sends wk_ + 32 hex and never the path', async () => {
    writeFileSync(saltFile, 'ab'.repeat(32) + '\n')
    const body = await post(env())
    expect(JSON.parse(body).workspace).toMatch(/^wk_[0-9a-f]{32}$/)
    expect(body).not.toContain('SENTINEL-parent')
    expect(body).not.toContain(home)
  })
  it('omits the field without a salt or outside git, and still posts', async () => {
    expect(
      JSON.parse(await post(env({ AGENT_OFFICE_WORKSPACE_SALT_FILE: join(home, 'none') }))),
    ).not.toHaveProperty('workspace')
    writeFileSync(saltFile, 'not-hex')
    expect(JSON.parse(await post(env()))).not.toHaveProperty('workspace')
    writeFileSync(saltFile, 'ab'.repeat(32))
    const f = async (_u: string, init: any) => ((body = init.body), new Response())
    let body = ''
    await fromStdin(
      'cursor',
      JSON.stringify(cursor({ hook_event_name: 'stop', workspace_roots: [tmpdir()] })),
      env() as any,
      f,
    )
    expect(JSON.parse(body).status).toBe('waiting')
  })
})

const SCRIPT = new URL('./agent-office-observe.mjs', import.meta.url).pathname
let server: Server | undefined
afterEach(() =>
  new Promise<void>((r) => (server ? server.close(() => r()) : r())).then(
    () => (server = undefined),
  ),
)

function run(args: string[], stdin: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = execFile(
      'node',
      [SCRIPT, ...args],
      { env: { ...process.env, ...env } },
      (err, stdout) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout }),
    )
    child.stdin!.end(stdin)
  })
}

describe('process (HK-9: always exit 0, never print)', () => {
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'ao-obs-p-')), 'token')
  writeFileSync(tokenFile, 'tok')
  const input = JSON.stringify(cursor({ hook_event_name: 'stop' }))
  const base = { AGENT_OFFICE_TOKEN_FILE: tokenFile }

  const listen = (status: number, delay = 0) =>
    new Promise<number>((resolve) => {
      server = createServer((_, res) =>
        setTimeout(() => ((res.statusCode = status), res.end('{"error":"x"}')), delay),
      )
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as any).port))
    })

  it('server down', async () => {
    expect(
      await run(['--provider', 'cursor'], input, {
        ...base,
        AGENT_OFFICE_URL: 'http://127.0.0.1:1',
      }),
    ).toEqual({ code: 0, stdout: '' })
  })
  it('401', async () => {
    const port = await listen(401)
    expect(
      await run(['--provider', 'cursor'], input, {
        ...base,
        AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
      }),
    ).toEqual({ code: 0, stdout: '' })
  })
  it('timeout', async () => {
    const port = await listen(202, 4000)
    const t = Date.now()
    const r = await run(['--provider', 'cursor'], input, {
      ...base,
      AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
    })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(Date.now() - t).toBeLessThan(3500)
  })
  it('garbage stdin, unknown provider, missing provider', async () => {
    expect(await run(['--provider', 'cursor'], '{{{', base)).toEqual({ code: 0, stdout: '' })
    expect(await run(['--provider', 'nope'], input, base)).toEqual({ code: 0, stdout: '' })
    expect(await run([], input, base)).toEqual({ code: 0, stdout: '' })
  })
})

describe('Claude hook stays non-blocking (HK-10)', () => {
  it('agent-office-hook.mjs subscribes only to Stop and UserPromptSubmit and never to blocking events', () => {
    const src = readFileSync(join(SCRIPT, '..', 'agent-office-hook.mjs'), 'utf8')
    expect(src).toContain("'Stop'")
    expect(src).toContain("'UserPromptSubmit'")
    for (const blocking of [
      'PreToolUse',
      'PermissionRequest',
      'BeforeTool',
      'preToolUse',
      'beforeShellExecution',
    ])
      expect(src).not.toContain(blocking)
  })
})
