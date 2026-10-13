import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ActionPolicy,
  PolicyAction,
  PolicyDecision,
  RunnerDecision,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
} from '@agent-office/core'
import { MemoryLogger } from '@agent-office/core/testing'
import type { AgentEvent } from '@agent-office/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpProfile } from './acp-profile.ts'
import { AcpRunner } from './acp-runner.ts'

const FAKE = fileURLToPath(new URL('../../../../test/fakes/fake-acp-agent.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'acp-runner-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Test profiles shaped like the fake's (common/ may not import the provider folders). */
const CURSORISH: AcpProfile = {
  provider: 'cursor',
  prefix: 'cu:',
  label: 'Cursor',
  bin: 'agent',
  args: ['acp'],
  acpFlag: /ACP/,
  caps: ['launch', 'send-message', 'interrupt', 'stop', 'approve-tools', 'change-mode'],
  authMethodPrefer: ['cursor_login'],
  loginHint: 'agent login',
  modes: [
    { id: 'agent', label: 'Agent' },
    { id: 'plan', label: 'Plan' },
    { id: 'ask', label: 'Ask' },
  ],
  defaultModeId: 'agent',
}
const URL_MODE = 'https://agentclientprotocol.com/protocol/session-modes#'
const COPILOTISH: AcpProfile = {
  ...CURSORISH,
  provider: 'copilot',
  prefix: 'gh:',
  label: 'Copilot',
  authMethodPrefer: [],
  loginHint: 'copilot login',
  modes: [
    { id: 'agent', label: 'Agent', native: `${URL_MODE}agent` },
    { id: 'plan', label: 'Plan', native: `${URL_MODE}plan` },
    { id: 'autopilot', label: 'Autopilot', native: `${URL_MODE}autopilot`, dangerous: true },
  ],
}
const GEMINIISH: AcpProfile = {
  ...CURSORISH,
  provider: 'gemini',
  prefix: 'gm:',
  label: 'Gemini CLI',
  authMethodPrefer: [],
  loginHint: 'gemini',
  modes: [
    { id: 'default', label: 'Default' },
    { id: 'yolo', label: 'YOLO', dangerous: true },
  ],
  defaultModeId: 'default',
}
const FAKE_PROFILE: Record<string, string> = {
  cursor: 'cursor',
  copilot: 'copilot',
  gemini: 'gemini',
}

const START: RunnerStart = {
  cwd: dir,
  mode: 'default',
  extraDirs: [],
  chrome: false,
  allowBypass: false,
}

let seq = 0
const open: RunnerSession[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()))
})

/** An AcpRunner driving the fake agent as a real child process. */
function real(env: Record<string, string> = {}, profile: AcpProfile = CURSORISH) {
  const logFile = join(dir, `log-${++seq}.jsonl`)
  const log = new MemoryLogger()
  const runner = new AcpRunner(profile, {
    bin: process.execPath,
    args: [FAKE, '--profile', FAKE_PROFILE[profile.provider]!],
    env: { FAKE_LOG: logFile, ...env },
    log,
  })
  const all = (): Record<string, any>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  const received = () => all().filter((m) => m.pid === undefined)
  const pid = () => all().find((m) => m.pid)?.pid as number
  const methods = () => received().flatMap((m) => (m.method ? [m.method as string] : []))
  const call = (method: string) => received().find((m) => m.method === method)
  /** Client responses to agent→client requests (ids ≥ 5000 in the fake). */
  const responses = () => received().filter((m) => m.method === undefined)
  const start = (o: Partial<RunnerStart> = {}) => {
    const s = runner.start({ ...START, ...o })
    open.push(s)
    const events: Omit<AgentEvent, 'agentId'>[] = []
    const results: { text: string; isError: boolean }[] = []
    const exits: RunnerExit[] = []
    const perms: RunnerPermission[] = []
    s.onEvent((e) => events.push(e))
    s.onResult((r) => results.push(r))
    s.onExit((e) => exits.push(e))
    const decide = (d: RunnerDecision | (() => Promise<RunnerDecision>)) =>
      s.onPermission((r) => {
        perms.push(r)
        return typeof d === 'function' ? d() : Promise.resolve(d)
      })
    return { s, events, results, exits, perms, decide }
  }
  return { runner, received, methods, call, responses, start, log, pid }
}

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('AcpRunner (fake agent process)', () => {
  it('declares itself from the profile', () => {
    const r = new AcpRunner(GEMINIISH)
    expect(r.decl).toEqual({
      provider: 'gemini',
      prefix: 'gm:',
      caps: GEMINIISH.caps,
      modes: [
        { id: 'default', label: 'Default' },
        { id: 'yolo', label: 'YOLO', dangerous: true },
      ],
      defaultModeId: 'default',
      fallbackModels: [],
      enforcement: {
        instructions: 'first-message',
        toolDeny: 'approval',
        pathDeny: 'partial',
        commandDeny: 'partial',
        fsIsolation: 'none',
        subagents: 'none',
      },
    })
    // Every profile gets the same default enforcement from the shared builder.
    expect(new AcpRunner(COPILOTISH).decl.enforcement).toEqual(r.decl.enforcement)
    // Native ids stay inside the adapter.
    expect(JSON.stringify(new AcpRunner(COPILOTISH).decl)).not.toContain('https:')
  })

  // ACP-1: initialize with no client fs/terminal, then session/new in the folder.
  it('ACP-1 initializes and opens a session', async () => {
    const f = real()
    const { s } = f.start({ extraDirs: ['/elsewhere'] })
    await expect(s.sessionId).resolves.toBe('sess_fake1')
    const init = f.call('initialize')!
    expect(init.jsonrpc).toBe('2.0')
    expect(init.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-office', title: 'agent-office', version: '1' },
    })
    // Extra folders only go out when the agent advertises additionalDirectories.
    expect(f.call('session/new')!.params).toEqual({ cwd: dir, mcpServers: [] })
    expect(f.methods()).not.toContain('authenticate')
  })

  it('ACP-1b sends additionalDirectories when the agent supports them', async () => {
    const f = real({ FAKE_ACP_ADDDIRS: '1' })
    const { s } = f.start({ extraDirs: ['/elsewhere'] })
    await s.sessionId
    expect(f.call('session/new')!.params).toEqual({
      cwd: dir,
      mcpServers: [],
      additionalDirectories: ['/elsewhere'],
    })
  })

  // MCP: RunnerStart.mcp becomes one stdio entry in session/new, env as [{name, value}].
  it('ACP-MCP passes RunnerStart.mcp in session/new mcpServers', async () => {
    const f = real()
    const mcp = {
      name: 'agent-office',
      command: '/u/mcp/agent-office-mcp.sh',
      args: [],
      env: { AGENT_OFFICE_MCP_URL: 'http://127.0.0.1:1/mcp', AGENT_OFFICE_MCP_TOKEN: 'mcp_t' },
    }
    const { s } = f.start({ mcp })
    await s.sessionId
    expect(f.call('session/new')!.params).toEqual({
      cwd: dir,
      mcpServers: [
        {
          name: 'agent-office',
          command: '/u/mcp/agent-office-mcp.sh',
          args: [],
          env: [
            { name: 'AGENT_OFFICE_MCP_URL', value: 'http://127.0.0.1:1/mcp' },
            { name: 'AGENT_OFFICE_MCP_TOKEN', value: 'mcp_t' },
          ],
        },
      ],
    })
  })

  // ACP-2: another protocol version → disconnect with a runtime error.
  it('ACP-2 disconnects on a protocol mismatch', async () => {
    const f = real({ FAKE_ACP_VERSION: '2' })
    const { s, exits } = f.start()
    await expect(s.sessionId).rejects.toMatchObject({ error: 'runtime' })
    expect(f.methods()).toEqual(['initialize'])
    await until(() => !running(f.pid()))
    expect(exits[0]?.error).toBe('runtime')
  })

  // ACP-3: auth_required → authenticate once with the preferred method → retry.
  it('ACP-3 authenticates with an existing login and retries', async () => {
    const f = real({ FAKE_ACP_AUTH: 'required' })
    const { s } = f.start()
    await expect(s.sessionId).resolves.toBe('sess_fake1')
    expect(f.methods()).toEqual(['initialize', 'session/new', 'authenticate', 'session/new'])
    expect(f.call('authenticate')!.params).toEqual({ methodId: 'cursor_login' })
  })

  // ACP-4: authenticate fails → exit 'auth' with the profile's login hint.
  it('ACP-4 exits with auth when authenticate fails', async () => {
    const f = real({ FAKE_ACP_AUTH: 'fail' })
    const { s } = f.start()
    const err = await s.sessionId.catch((e: RunnerExit) => e)
    expect(err).toMatchObject({ error: 'auth' })
    expect((err as RunnerExit).message).toContain('agent login')
    expect(f.methods().filter((m) => m === 'authenticate')).toHaveLength(1)
  })

  it('ACP-4b never authenticates with a method the profile does not prefer', async () => {
    // Gemini advertises oauth-personal and an API key method; neither reuses a login silently.
    const f = real({ FAKE_ACP_AUTH: 'required' }, GEMINIISH)
    const { s } = f.start()
    await expect(s.sessionId).rejects.toMatchObject({ error: 'auth' })
    expect(f.methods()).not.toContain('authenticate')
  })

  // ACP-5: the start mode is applied with session/set_mode; native ids are translated.
  it('ACP-5 applies the start mode (native ids, dangerous gated)', async () => {
    const f = real()
    const { s } = f.start({ modeId: 'plan' })
    await s.sessionId
    expect(f.call('session/set_mode')!.params).toEqual({ sessionId: 'sess_fake1', modeId: 'plan' })

    const c = real({}, COPILOTISH)
    const cs = c.start({ modeId: 'plan' })
    await cs.s.sessionId
    expect(c.call('session/set_mode')!.params.modeId).toBe(`${URL_MODE}plan`)
    // The agent confirms with current_mode_update: reported as the short profile id, never the URL.
    await vi.waitFor(() => expect(cs.events.some((e) => e.modeId === 'plan')).toBe(true))
    expect(JSON.stringify(cs.events)).not.toContain(URL_MODE)
    await expect(cs.s.setModeId!('autopilot')).rejects.toThrow(/not available/)

    const d = real({}, COPILOTISH)
    const ds = d.start({ modeId: 'autopilot' })
    await ds.s.sessionId
    expect(d.methods()).not.toContain('session/set_mode')
  })

  it('ACP-5b the default mode needs no set_mode', async () => {
    const f = real()
    const { s } = f.start({ modeId: 'agent' })
    await s.sessionId
    expect(f.methods()).not.toContain('session/set_mode')
  })

  // ACP-6: a prompt streams privacy-safe events and ends with the final message as the result.
  it('ACP-6 streams a prompt into events and a reply', async () => {
    const f = real()
    const { s, events, results, perms, decide } = f.start()
    decide({ behavior: 'allow' })
    await s.sessionId
    s.push('list the files')
    await until(() => results.length === 1)
    expect(f.call('session/prompt')!.params).toEqual({
      sessionId: 'sess_fake1',
      prompt: [{ type: 'text', text: 'list the files' }],
    })
    expect(events.map((e) => e.status)).toEqual(
      expect.arrayContaining(['thinking', 'tool', 'waiting']),
    )
    expect(events.find((e) => e.status === 'tool')).toEqual({ status: 'tool', tool: 'Bash' })
    expect(events.at(-1)).toEqual({ status: 'waiting', text: 'Here are the files.' })
    expect(results).toEqual([{ text: 'Here are the files.', isError: false }])
    expect(perms).toEqual([
      { tool: 'Bash', input: { command: 'ls -la /Users/secret/project' }, cwd: dir },
    ])
    expect(JSON.stringify(events)).not.toMatch(/secret/)
  })

  // ACP-7: each decision maps to the right option; never allow_always.
  it.each([
    [{ behavior: 'allow' } as RunnerDecision, 'allow', 'Here are the files.'],
    [
      { behavior: 'deny', message: 'no' } as RunnerDecision,
      'reject',
      'I was not allowed to run it.',
    ],
  ])('ACP-7 permission round-trip %#', async (d, optionId, text) => {
    const f = real()
    const { s, results, decide } = f.start()
    decide(d)
    await s.sessionId
    s.push('go')
    await until(() => results.length === 1)
    expect(results[0]!.text).toBe(text)
    expect(f.responses()[0]!.result).toEqual({ outcome: { outcome: 'selected', optionId } })
  })

  it('ACP-7b a throwing permission handler denies', async () => {
    const f = real()
    const { s, results, decide } = f.start()
    decide(() => Promise.reject(new Error('boom')))
    await s.sessionId
    s.push('go')
    await until(() => results.length === 1)
    expect(f.responses()[0]!.result.outcome.optionId).toBe('reject')
  })

  describe('harness', () => {
    const policy = (action: PolicyDecision['action'] | 'throw') => {
      const calls: PolicyAction[] = []
      const h: ActionPolicy = {
        evaluate: (a) => {
          calls.push(a)
          if (action === 'throw') throw new Error('x')
          return { action, ruleIds: ['rul_1'], reason: 'No listing', basis: 'heuristic' }
        },
        instructions: 'HARNESS RULES',
        native: {
          deniedTools: [],
          denyPaths: [],
          askPaths: [],
          denyCommands: [],
          askCommands: [],
          fsIsolation: 'off',
        },
        interceptAll: true,
        unsupported: [],
      }
      return { h, calls }
    }

    it('ACP-H1 prepends the instructions to the first prompt only', async () => {
      const f = real()
      const { s, results, decide } = f.start({ harness: policy('allow').h })
      decide({ behavior: 'allow' })
      await s.sessionId
      s.push('first')
      await until(() => results.length === 1)
      s.push('second')
      await until(() => results.length === 2)
      const prompts = f
        .received()
        .filter((m) => m.method === 'session/prompt')
        .map((m) => m.params.prompt[0].text)
      expect(prompts).toEqual(['HARNESS RULES\n\nfirst', 'second'])
    })

    it.each(['deny', 'throw'] as const)(
      'ACP-H2 a harness %s rejects once without asking the user',
      async (action) => {
        const f = real()
        const { h, calls } = policy(action)
        const { s, results, perms, decide } = f.start({ harness: h })
        decide({ behavior: 'allow' })
        await s.sessionId
        s.push('go')
        await until(() => results.length === 1)
        expect(perms).toEqual([])
        expect(calls[0]).toMatchObject({ tool: 'Bash', cwd: dir, provider: 'cursor' })
        expect(f.responses()[0]!.result).toEqual({
          outcome: { outcome: 'selected', optionId: 'reject' },
        })
      },
    )

    it('ACP-H3 a harness ask continues to the permission card', async () => {
      const f = real()
      const { s, results, perms, decide } = f.start({ harness: policy('ask').h })
      decide({ behavior: 'allow' })
      await s.sessionId
      s.push('go')
      await until(() => results.length === 1)
      expect(perms).toHaveLength(1)
      expect(f.responses()[0]!.result.outcome.optionId).toBe('allow')
    })
  })

  // ACP-8: interrupt sends session/cancel and answers the open permission with cancelled.
  it('ACP-8 interrupt cancels the prompt and open permissions', async () => {
    const f = real()
    const { s, events, results, perms, decide } = f.start()
    decide(() => new Promise<RunnerDecision>(() => {}))
    await s.sessionId
    s.push('go')
    await until(() => perms.length === 1)
    await s.interrupt()
    await until(() => results.length === 1)
    expect(f.methods()).toContain('session/cancel')
    expect(f.responses()[0]!.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(results[0]).toEqual({ text: '', isError: false })
    expect(events.at(-1)).toEqual({ status: 'idle' })
  })

  it('ACP-8b interrupt during a slow turn ends it cancelled; with no turn it is a no-op', async () => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    await s.interrupt()
    expect(f.methods()).not.toContain('session/cancel')
    s.push('/slow')
    await until(() => f.methods().includes('session/prompt'))
    await s.interrupt()
    await until(() => results.length === 1)
    expect(results[0]).toEqual({ text: '', isError: false })
  })

  // ACP-9: prompts are queued, one at a time (the fake rejects overlapping prompts).
  it('ACP-9 queues prompts one at a time', async () => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    s.push('/quick a')
    s.push('/quick b')
    s.push('/quick c')
    await until(() => results.length === 3)
    expect(results.map((r) => r.text)).toEqual(['ok: /quick a', 'ok: /quick b', 'ok: /quick c'])
  })

  // ACP-10: setModeId → session/set_mode; the agent's mode update comes back as modeId.
  it('ACP-10 changes mode', async () => {
    const f = real()
    const { s } = f.start()
    await s.sessionId
    await s.setModeId!('ask')
    expect(f.call('session/set_mode')!.params).toEqual({ sessionId: 'sess_fake1', modeId: 'ask' })
    await expect(s.setModeId!('nope')).rejects.toThrow(/not available/)
    // Claude permission modes do not apply to ACP agents.
    await expect(s.setMode('plan')).resolves.toBeUndefined()
  })

  // ACP-11: unknown updates, extension notifications and client requests never hang the agent.
  it.each([
    ['/ext', 'ext error -32601'],
    ['/fs', 'fs error -32601'],
  ])('ACP-11 answers %s with method-not-found', async (prompt, text) => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    s.push(prompt)
    await until(() => results.length === 1)
    expect(results[0]!.text).toBe(text)
  })

  // ACP-12: a crash mid-turn is an exit with 'crash'.
  it('ACP-12 reports a crash', async () => {
    const f = real()
    const { s, exits } = f.start()
    await s.sessionId
    s.push('/crash')
    await until(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ error: 'crash' })
    expect(exits[0]!.message).toContain('Cursor')
    s.push('ignored')
  })

  it('reassembles a message split across stdout chunks', async () => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    s.push('/partial')
    await until(() => results.length === 1)
    expect(results[0]!.text).toBe('split reply')
  })

  it('a refusal is an error; a long reply is capped at 4000 characters', async () => {
    const f = real()
    const { s, results, events } = f.start()
    await s.sessionId
    s.push('/refuse')
    s.push('/long')
    await until(() => results.length === 2)
    expect(results[0]).toEqual({ text: '', isError: true })
    expect(events).toContainEqual({ status: 'error' })
    expect(results[1]!.text.length).toBe(4000)
  })

  it('models: config option (set_config_option) and session models (set_model)', async () => {
    const f = real()
    const { s } = f.start({ model: 'fast-1' })
    await s.sessionId
    expect(f.call('session/set_config_option')!.params).toEqual({
      sessionId: 'sess_fake1',
      configId: 'model',
      value: 'fast-1',
    })
    await expect(s.supportedModels()).resolves.toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'fast-1', label: 'Fast One' },
    ])

    const g = real({}, GEMINIISH)
    const gs = g.start()
    await gs.s.sessionId
    await gs.s.setModel('fast-1')
    expect(g.call('session/set_model')!.params).toEqual({
      sessionId: 'sess_fake1',
      modelId: 'fast-1',
    })
    await expect(gs.s.supportedModels()).resolves.toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'fast-1', label: 'Fast One', description: 'A quick model' },
    ])
  })

  it('models: none advertised → empty list and setModel rejects as unsupported', async () => {
    const f = real({ FAKE_ACP_NOMODELS: '1' })
    const { s } = f.start({ model: 'fast-1' })
    await s.sessionId
    await expect(s.supportedModels()).resolves.toEqual([])
    await expect(s.setModel('fast-1')).rejects.toThrow(/unsupported/)
  })

  it('a missing folder or binary never starts', async () => {
    const f = real()
    const { s } = f.start({ cwd: join(dir, 'missing') })
    await expect(s.sessionId).rejects.toMatchObject({ error: 'folder' })
    const r = new AcpRunner(CURSORISH, { bin: join(dir, 'no-such-agent') })
    const t = r.start(START)
    open.push(t)
    await expect(t.sessionId).rejects.toMatchObject({ error: 'runtime' })
  })

  // Close kills the process; onExit reports a clean end; close is idempotent.
  it('close kills the agent', async () => {
    const f = real()
    const { s, exits } = f.start()
    await s.sessionId
    const pid = f.pid()
    expect(running(pid)).toBe(true)
    await s.close()
    await s.close()
    await until(() => !running(pid))
    expect(exits).toEqual([{}])
    s.push('ignored after close')
    await expect(s.supportedModels()).resolves.toEqual([])
  })
})
