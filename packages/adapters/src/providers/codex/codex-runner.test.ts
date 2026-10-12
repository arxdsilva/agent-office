import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunnerExit, RunnerPermission, RunnerSession, RunnerStart } from '@agent-office/core'
import {
  managedRuntimeContract,
  MemoryLogger,
  type ManagedRuntimeHarness,
} from '@agent-office/core/testing'
import type { AgentEvent } from '@agent-office/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { CodexRunner, type CodexTransport } from './codex-runner.ts'

const FAKE = fileURLToPath(
  new URL('../../../test/fakes/fake-codex-app-server.mjs', import.meta.url),
)
const dir = mkdtempSync(join(tmpdir(), 'codex-runner-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

/** A CodexRunner driving the fake app-server as a real child process. */
function real(env: Record<string, string> = {}) {
  const logFile = join(dir, `log-${++seq}.jsonl`)
  const log = new MemoryLogger()
  const runner = new CodexRunner({
    bin: process.execPath,
    args: [FAKE, 'app-server'],
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
  const start = (o: Partial<RunnerStart> = {}) => {
    const s = runner.start({ ...START, ...o })
    open.push(s)
    const events: Omit<AgentEvent, 'agentId'>[] = []
    const results: { text: string; isError: boolean }[] = []
    const exits: RunnerExit[] = []
    s.onEvent((e) => events.push(e))
    s.onResult((r) => results.push(r))
    s.onExit((e) => exits.push(e))
    return { s, events, results, exits }
  }
  return { runner, received, methods, start, log, pid }
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

describe('CodexRunner (fake app-server process)', () => {
  it('declares the Codex provider, prefix, caps and the four presets', () => {
    const d = new CodexRunner().decl
    expect(d).toMatchObject({
      provider: 'codex',
      prefix: 'cx:',
      defaultModeId: 'ask',
      fallbackModels: [],
    })
    expect(d.modes?.map((m) => m.id)).toEqual(['read-only', 'ask', 'auto', 'full-access'])
    expect(d.modes?.find((m) => m.id === 'full-access')?.dangerous).toBe(true)
    expect(d.caps).toEqual([
      'launch',
      'send-message',
      'interrupt',
      'stop',
      'approve-tools',
      'select-model',
      'change-mode',
      'attach-context',
    ])
  })

  // CX-1: spawn → initialize → initialized → account/read → thread/start; the id is the thread id.
  it('runs the documented startup sequence and resolves the thread id', async () => {
    const f = real({ FAKE_CODEX_THREAD: 'thr_abc' })
    const { s } = f.start()
    await expect(s.sessionId).resolves.toBe('thr_abc')
    expect(f.methods()).toEqual(['initialize', 'initialized', 'account/read', 'thread/start'])
    const [init] = f.received()
    expect(init).not.toHaveProperty('jsonrpc')
    expect(init!.params.clientInfo).toMatchObject({ name: 'agent-office' })
    // CX-10: the default preset ('ask') reaches thread/start.
    expect(f.received()[3]!.params).toEqual({
      cwd: dir,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })
  })

  // CX-2: no login → exit 'auth' before any thread exists; the process is gone.
  it('exits with auth when Codex needs a login', async () => {
    const f = real({ FAKE_CODEX_AUTH: 'none' })
    const { s, exits } = f.start()
    await expect(s.sessionId).rejects.toMatchObject({ error: 'auth' })
    await until(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ error: 'auth' })
    expect(f.methods()).not.toContain('thread/start')
    const pid = f.pid()
    await until(() => !running(pid))
  })

  // CX-3: model/list → ModelOption[]; hidden models dropped; cached.
  it('lists models once', async () => {
    const f = real()
    const { s } = f.start()
    await s.sessionId
    const models = await s.supportedModels()
    expect(models).toEqual([
      { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', description: 'Coding model' },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 Mini' },
    ])
    await s.supportedModels()
    expect(f.methods().filter((m) => m === 'model/list')).toHaveLength(1)
  })

  // CX-4 + CX-7: a command approval round-trip (allow → accept), deltas → the reply, events
  // carry status/tool only.
  it('round-trips a command approval and returns the streamed reply', async () => {
    const f = real()
    const { s, events, results } = f.start()
    const asked: RunnerPermission[] = []
    s.onPermission(async (r) => {
      asked.push(r)
      return { behavior: 'allow' }
    })
    await s.sessionId
    s.push('please check git')
    await until(() => results.length > 0)
    expect(asked).toEqual([
      { tool: 'Bash', input: { command: 'git status SENTINEL_CMD' }, cwd: dir },
    ])
    expect(results).toEqual([{ text: 'Hello world', isError: false }])
    expect(f.received().find((m) => m.result?.decision)?.result).toEqual({ decision: 'accept' })
    const turn = f.received().find((m) => m.method === 'turn/start')
    expect(turn!.params).toEqual({
      threadId: 'thr_fake1',
      input: [{ type: 'text', text: 'please check git' }],
    })
    expect(events.map((e) => e.status)).toEqual([
      'thinking',
      'thinking',
      'tool',
      'thinking',
      'waiting',
    ])
    expect(events.find((e) => e.status === 'tool')).toEqual({
      status: 'tool',
      tool: 'Bash',
      target: 'cmd:git',
    })
    expect(events.at(-1)).toEqual({ status: 'waiting', text: 'Hello world' })
    expect(JSON.stringify(events)).not.toMatch(/SENTINEL|\/Users|\/private|\/var/)
  })

  // CX-5: deny → decline.
  it('declines a denied command', async () => {
    const f = real()
    const { s, results } = f.start()
    s.onPermission(async () => ({ behavior: 'deny', message: 'no' }))
    await s.sessionId
    s.push('go')
    await until(() => results.length > 0)
    expect(f.received().find((m) => m.result?.decision)?.result).toEqual({ decision: 'decline' })
    expect(results[0]!.text).toBe('Hello declined')
  })

  // CX-6: a file change approval is normalized to Edit with the changed file.
  it('round-trips a file change approval as Edit', async () => {
    const f = real()
    const { s, results, events } = f.start()
    const asked: RunnerPermission[] = []
    s.onPermission(async (r) => {
      asked.push(r)
      return { behavior: 'allow' }
    })
    await s.sessionId
    s.push('/file')
    await until(() => results.length > 0)
    expect(asked).toEqual([{ tool: 'Edit', input: { file_path: `${dir}/src/app.ts` }, cwd: dir }])
    expect(results[0]!.text).toBe('Edited.')
    expect(events.find((e) => e.status === 'tool')).toEqual({ status: 'tool', tool: 'Edit' })
    expect(JSON.stringify(events)).not.toContain('SENTINEL')
  })

  it('declines approvals when nobody is listening', async () => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    s.push('go')
    await until(() => results.length > 0)
    expect(f.received().find((m) => m.result?.decision)?.result).toEqual({ decision: 'decline' })
  })

  // CX-7: the reply is capped at 4000 characters; the bubble at 80.
  it('caps the reply', async () => {
    const f = real()
    const { s, results, events } = f.start()
    await s.sessionId
    s.push('/long')
    await until(() => results.length > 0)
    expect(results[0]!.text).toHaveLength(4000)
    expect(events.at(-1)!.text!.length).toBeLessThanOrEqual(80)
  })

  // CX-8: interrupt → turn/interrupt with the running turn → idle.
  it('interrupts the running turn', async () => {
    const f = real()
    const { s, events, results } = f.start()
    await s.sessionId
    s.push('/slow')
    await until(() => f.methods().includes('turn/start') && events.length > 1)
    await s.interrupt()
    await until(() => events.some((e) => e.status === 'idle'))
    expect(f.received().find((m) => m.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thr_fake1',
      turnId: 'turn_1',
    })
    expect(results).toEqual([{ text: '', isError: false }])
  })

  // CX-8: interrupt answers an open approval with 'cancel'.
  it('cancels an open approval on interrupt', async () => {
    const f = real()
    const { s, events } = f.start()
    let asked = false
    s.onPermission(() => {
      asked = true
      return new Promise(() => {}) // the user never answers
    })
    await s.sessionId
    s.push('go')
    await until(() => asked)
    await s.interrupt()
    await until(() => events.some((e) => e.status === 'idle'))
    expect(f.received().find((m) => m.result?.decision)?.result).toEqual({ decision: 'cancel' })
  })

  // CX-9: a failed turn → error event + an error result; the session stays usable.
  it('reports a failed turn', async () => {
    const f = real()
    const { s, events, results } = f.start()
    await s.sessionId
    s.push('/fail')
    await until(() => results.length > 0)
    expect(results).toEqual([{ text: '', isError: true }])
    expect(events.at(-1)).toEqual({ status: 'error' })
  })

  // Messages queue while a turn runs: one turn at a time.
  it('queues prompts while a turn is running', async () => {
    const f = real()
    const { s, results } = f.start()
    s.onPermission(async () => ({ behavior: 'allow' }))
    await s.sessionId
    s.push('/slow first')
    s.push('second')
    await until(() => f.methods().includes('turn/start'))
    await new Promise((r) => setTimeout(r, 100))
    expect(f.methods().filter((m) => m === 'turn/start')).toHaveLength(1)
    await s.interrupt()
    await until(() => results.length === 2)
    const turns = f.received().filter((m) => m.method === 'turn/start')
    expect(turns.map((t) => t.params.input[0].text)).toEqual(['/slow first', 'second'])
  })

  // CX-10: presets → thread/start; dangerous only with allowBypass; changes apply on the next turn.
  it('maps presets and applies model/mode changes on the next turn/start', async () => {
    const ro = real()
    await ro.start({ modeId: 'read-only' }).s.sessionId
    expect(ro.received()[3]!.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
    })

    const gated = real()
    await gated.start({ modeId: 'full-access' }).s.sessionId
    expect(gated.received()[3]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })

    const full = real()
    await full.start({ modeId: 'full-access', allowBypass: true, model: 'gpt-5.5-codex' }).s
      .sessionId
    expect(full.received()[3]!.params).toEqual({
      cwd: dir,
      model: 'gpt-5.5-codex',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })

    const f = real()
    const { s, results } = f.start({ extraDirs: ['/extra/one'] })
    s.onPermission(async () => ({ behavior: 'allow' }))
    await s.sessionId
    await expect(s.setModeId!('full-access')).rejects.toThrow()
    await expect(s.setModeId!('bogus')).rejects.toThrow()
    await s.setModel('gpt-5.5-mini')
    await s.setModeId!('auto')
    await s.setMode('plan') // Claude permission modes do not apply to Codex
    s.push('one')
    await until(() => results.length === 1)
    s.push('two')
    await until(() => results.length === 2)
    const [t1, t2] = f.received().filter((m) => m.method === 'turn/start')
    expect(t1!.params).toEqual({
      threadId: 'thr_fake1',
      input: [{ type: 'text', text: 'one' }],
      model: 'gpt-5.5-mini',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/extra/one'] },
    })
    expect(t2!.params).toEqual({ threadId: 'thr_fake1', input: [{ type: 'text', text: 'two' }] })
  })

  // Other server requests get a JSON-RPC error so Codex never waits on us.
  it('answers unsupported server requests with an error', async () => {
    const f = real()
    const { s, results } = f.start()
    await s.sessionId
    s.push('/ask')
    await until(() => results.length > 0)
    expect(f.received().find((m) => m.askReply)?.askReply).toBe(-32601)
  })

  // A crash mid-turn → exit 'crash'; stderr is never logged.
  it('reports a crash and never logs stderr', async () => {
    const f = real()
    const { s, exits } = f.start()
    await s.sessionId
    s.push('/crash')
    await until(() => exits.length > 0)
    expect(exits).toMatchObject([{ error: 'crash' }])
    expect(f.log.lines.join('\n')).not.toContain('panicked')
  })

  it('reports a missing folder and a missing CLI', async () => {
    const f = real()
    const a = f.start({ cwd: join(dir, 'gone') })
    await expect(a.s.sessionId).rejects.toMatchObject({ error: 'folder' })
    const missing = new CodexRunner({ bin: join(dir, 'no-codex') }).start(START)
    open.push(missing)
    await expect(missing.sessionId).rejects.toMatchObject({ error: 'runtime' })
  })

  // Close kills the process; onExit reports a clean end; close is idempotent.
  it('close kills the app-server', async () => {
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

/**
 * In-process app-server for the contract suites: every server message is delivered in a
 * microtask, so the suites' microtask-only `tick()` is enough. `controls()` combines the session
 * calls (Codex applies mode/model on the next turn, so there is no wire call to observe) with the
 * transport's kill (close).
 */
function harness(): ManagedRuntimeHarness {
  const prompts: string[] = []
  const controls: string[] = []
  const dataFns: ((c: string) => void)[] = []
  const closeFns: (() => void)[] = []
  const answers = new Map<number, (m: Record<string, any>) => void>()
  let threadId: string | undefined
  let threadReq: number | undefined
  let killed = false
  let serverId = 900
  let resolveExit!: (e: { code: number | null; signal: NodeJS.Signals | null }) => void
  const emit = (m: unknown) =>
    queueMicrotask(() => dataFns.forEach((f) => f(JSON.stringify(m) + '\n')))
  const handle = (m: Record<string, any>) => {
    if (m.method === undefined) return answers.get(m.id)?.(m)
    switch (m.method) {
      case 'initialize':
        return emit({ id: m.id, result: { userAgent: 'h' } })
      case 'account/read':
        return emit({ id: m.id, result: { requiresOpenaiAuth: false, account: null } })
      case 'thread/start':
        threadReq = m.id
        if (threadId) emit({ id: m.id, result: { thread: { id: threadId } } })
        return
      case 'turn/start': {
        prompts.push(m.params.input[0].text)
        const turn = { id: `t${prompts.length}`, status: 'inProgress' }
        emit({ id: m.id, result: { turn } })
        emit({
          method: 'turn/completed',
          params: { threadId, turn: { ...turn, status: 'completed' } },
        })
        return
      }
      default:
        if (m.id !== undefined) emit({ id: m.id, result: {} })
    }
  }
  const transport: CodexTransport = {
    stdin: {
      write: (s: string) => {
        for (const l of s.split('\n')) if (l) handle(JSON.parse(l))
      },
      end: () => {},
    },
    stdout: {
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        if (ev === 'data') dataFns.push(fn as unknown as (c: string) => void)
        if (ev === 'close') closeFns.push(fn as unknown as () => void)
      },
    },
    exited: new Promise((r) => (resolveExit = r)),
    stderrTail: () => '',
    alive: () => !killed,
    kill: async () => {
      if (killed) return
      killed = true
      controls.push('close')
      closeFns.forEach((f) => f())
      resolveExit({ code: null, signal: 'SIGTERM' })
    },
  }
  const inner = new CodexRunner({ spawn: () => transport })
  const ask = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = serverId++
      answers.set(id, resolve)
      emit({ id, method, params })
    })
  return {
    runner: {
      decl: inner.decl,
      start(o) {
        const s = inner.start(o)
        return {
          get sessionId() {
            return s.sessionId
          },
          push: (p) => s.push(p),
          setMode: async (m) => {
            controls.push(`mode:${m}`)
            await s.setMode(m)
          },
          setModel: async (m) => {
            controls.push(`model:${m}`)
            await s.setModel(m)
          },
          setModeId: async (m) => {
            controls.push(`modeId:${m}`)
            await s.setModeId!(m)
          },
          supportedModels: () => s.supportedModels(),
          interrupt: async () => {
            controls.push('interrupt')
            await s.interrupt()
          },
          close: () => s.close(),
          onEvent: (fn) => s.onEvent(fn),
          onResult: (fn) => s.onResult(fn),
          onPermission: (fn) => s.onPermission(fn),
          onExit: (fn) => s.onExit(fn),
        }
      },
    },
    init(id) {
      threadId = id
      if (threadReq !== undefined) emit({ id: threadReq, result: { thread: { id } } })
    },
    toolUse(name, input) {
      const item =
        name === 'Bash'
          ? {
              type: 'commandExecution',
              id: 'i1',
              command: String(input.command ?? ''),
              status: 'inProgress',
            }
          : { type: 'fileChange', id: 'i1', changes: [{ path: String(input.file_path ?? '') }] }
      emit({ method: 'item/started', params: { threadId, turnId: 'tx', item } })
    },
    result(text) {
      emit({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId: 'tx', itemId: 'm1', delta: text },
      })
      emit({
        method: 'turn/completed',
        params: { threadId, turn: { id: 'tx', status: 'completed' } },
      })
    },
    async ask(tool, input) {
      const bash = tool === 'Bash'
      const itemId = `a${serverId}`
      emit({
        method: 'item/started',
        params: {
          threadId,
          turnId: 'tx',
          item: bash
            ? { type: 'commandExecution', id: itemId, command: input.command }
            : { type: 'fileChange', id: itemId, changes: [{ path: input.file_path }] },
        },
      })
      const r = await ask(
        bash ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval',
        { threadId, turnId: 'tx', itemId, ...(bash ? { command: input.command } : {}) },
      )
      return { behavior: r.result?.decision === 'accept' ? 'allow' : 'deny' }
    },
    prompts: () => prompts,
    controls: () => controls,
    alive: () => !killed,
  }
}

managedRuntimeContract('CodexRunner', harness)
