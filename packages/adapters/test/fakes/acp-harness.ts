// In-process ACP agent for the core contract suites (managedRuntimeContract): every agent message
// is delivered in a microtask, so the suites' microtask-only `tick()` is enough. `controls()`
// combines the session calls with the transport's kill (close). Used by each ACP profile's tests.
import type { ManagedRuntimeHarness } from '@agent-office/core/testing'
import type { AcpProfile } from '../../src/providers/common/acp/acp-profile.ts'
import { type AcpTransport, AcpRunner } from '../../src/providers/common/acp/acp-runner.ts'

const MARKER = '\u0000harness-result'

export function acpHarness(profile: AcpProfile): ManagedRuntimeHarness {
  const prompts: string[] = []
  const controls: string[] = []
  const dataFns: ((c: string) => void)[] = []
  const closeFns: (() => void)[] = []
  const answers = new Map<number, (m: Record<string, any>) => void>()
  const natives = (profile.modes ?? []).map((m) => m.native ?? m.id)
  let sessionId: string | undefined
  let newReq: number | undefined
  let killed = false
  let agentId = 900
  let toolSeq = 0
  let nextReply = ''
  let inner: ReturnType<AcpRunner['start']> | undefined
  let resolveExit!: (e: { code: number | null; signal: NodeJS.Signals | null }) => void
  const emit = (m: unknown) =>
    queueMicrotask(() =>
      dataFns.forEach((f) => f(JSON.stringify({ jsonrpc: '2.0', ...(m as object) }) + '\n')),
    )
  const update = (u: Record<string, unknown>) =>
    emit({ method: 'session/update', params: { sessionId, update: u } })
  const sessionResult = () => ({
    sessionId,
    modes: { currentModeId: natives[0], availableModes: natives.map((id) => ({ id, name: id })) },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'sonnet',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
    ],
  })
  const handle = (m: Record<string, any>) => {
    if (m.method === undefined) return answers.get(m.id)?.(m)
    switch (m.method) {
      case 'initialize':
        return emit({ id: m.id, result: { protocolVersion: 1, authMethods: [] } })
      case 'session/new':
        newReq = m.id
        if (sessionId) emit({ id: m.id, result: sessionResult() })
        return
      case 'session/prompt': {
        const text = m.params.prompt[0].text as string
        if (text === MARKER) {
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: nextReply },
          })
        } else prompts.push(text)
        return emit({ id: m.id, result: { stopReason: 'end_turn' } })
      }
      default:
        if (m.id !== undefined) emit({ id: m.id, result: {} })
    }
  }
  const transport: AcpTransport = {
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
  const runner = new AcpRunner(profile, { spawn: () => transport })
  const ask = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = agentId++
      answers.set(id, resolve)
      emit({ id, method, params })
    })
  return {
    runner: {
      decl: runner.decl,
      start(o) {
        const s = runner.start(o)
        inner = s
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
      sessionId = id
      if (newReq !== undefined) emit({ id: newReq, result: sessionResult() })
    },
    toolUse(name, input) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: `c${++toolSeq}`,
        title: String(input.command ?? input.file_path ?? name),
        kind: name === 'Bash' ? 'execute' : 'edit',
        rawInput: input,
      })
    },
    result(text) {
      // A turn needs a prompt in ACP: the harness starts one the contract does not count.
      nextReply = text
      inner?.push(MARKER)
    },
    async ask(tool, input) {
      const r = await ask('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: `p${agentId}`,
          kind: tool === 'Bash' ? 'execute' : 'edit',
          title: 'secret title',
          rawInput: input,
          locations: input.file_path ? [{ path: input.file_path }] : [],
        },
        options: [
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      })
      return { behavior: r.result?.outcome?.optionId === 'allow' ? 'allow' : 'deny' }
    },
    prompts: () => prompts,
    controls: () => controls,
    alive: () => !killed,
  }
}
