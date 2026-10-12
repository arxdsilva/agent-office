import type { AgentEvent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import type { AgentRunner, RunnerStart } from '../../src/ports/driven.ts'

/**
 * How a contract test drives the "SDK side" of a runner. The fake implements it directly; the SDK
 * adapter implements it by feeding scripted SDK messages to an injected `query` double.
 */
export interface RunnerHarness {
  runner: AgentRunner
  /** Completes the session's init (system/init message) with this session id. */
  init(sessionId: string): void
  /** The model emits a tool call (assistant tool_use). */
  toolUse(name: string, input: Record<string, unknown>): void
  /** The turn ends with this final text. */
  result(text: string): void
  /** The runtime asks to approve a tool call; resolves with the decision returned to the runtime. */
  ask(tool: string, input: Record<string, unknown>): Promise<{ behavior: 'allow' | 'deny' }>
  /** Prompts the runtime received, in order. */
  prompts(): string[]
  /** Control calls the runtime received, as 'mode:<m>' | 'model:<m>' | 'interrupt' | 'close'. */
  controls(): string[]
}

const START: RunnerStart = {
  cwd: '/work/shop-api',
  mode: 'default',
  extraDirs: [],
  chrome: false,
  allowBypass: false,
}

/** Every AgentRunner implementation must pass this. */
export function agentRunnerContract(name: string, make: () => RunnerHarness) {
  describe(`AgentRunner contract: ${name}`, () => {
    it('resolves the session id from init', async () => {
      const h = make()
      const s = h.runner.start(START)
      h.init('sess-a')
      await expect(s.sessionId).resolves.toBe('sess-a')
    })

    it('streams pushed prompts in order', async () => {
      const h = make()
      const s = h.runner.start(START)
      h.init('sess-a')
      await s.sessionId
      s.push('one')
      s.push('two')
      await tick()
      expect(h.prompts()).toEqual(['one', 'two'])
    })

    it('maps a tool call to a privacy-safe tool event and a turn end to a result', async () => {
      const h = make()
      const s = h.runner.start(START)
      const events: Omit<AgentEvent, 'agentId'>[] = []
      const results: string[] = []
      s.onEvent((e) => events.push(e))
      s.onResult((r) => results.push(r.text))
      h.init('sess-a')
      await s.sessionId
      h.toolUse('Bash', { command: 'git status --porcelain /Users/secret/path', description: 'x' })
      h.result('done')
      await tick()
      const tool = events.find((e) => e.status === 'tool')
      expect(tool?.tool).toBe('Bash')
      expect(JSON.stringify(events)).not.toContain('/Users/secret')
      expect(results).toEqual(['done'])
    })

    it('round-trips a permission request', async () => {
      const h = make()
      const s = h.runner.start(START)
      s.onPermission(async (r) =>
        r.tool === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' },
      )
      h.init('sess-a')
      await s.sessionId
      await expect(h.ask('Bash', { command: 'ls' })).resolves.toMatchObject({ behavior: 'allow' })
      await expect(h.ask('Write', { file_path: 'a' })).resolves.toMatchObject({ behavior: 'deny' })
    })

    it('forwards mode, model, interrupt and close', async () => {
      const h = make()
      const s = h.runner.start(START)
      h.init('sess-a')
      await s.sessionId
      await s.setMode('plan')
      await s.setModel('opus')
      await s.interrupt()
      await s.close()
      expect(h.controls()).toEqual(['mode:plan', 'model:opus', 'interrupt', 'close'])
    })
  })
}

/** Lets queued microtasks (async iterators, promise chains) run; core has no host timers. */
async function tick(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** A RunnerHarness that can also tell whether the runtime is still alive (process, stream). */
export interface ManagedRuntimeHarness extends RunnerHarness {
  /** False once the runtime is fully torn down (no live process or open stream). */
  alive(): boolean
}

/**
 * Every managed runtime (Fake, ClaudeSdk, Codex, each ACP profile) must pass this: the AgentRunner
 * contract plus declarations, provider modes and a clean close.
 */
export function managedRuntimeContract(name: string, make: () => ManagedRuntimeHarness) {
  agentRunnerContract(name, make)
  describe(`Managed runtime contract: ${name}`, () => {
    it('a runner with a decl declares a prefix, caps and consistent modes', () => {
      const { runner } = make()
      const d = runner.decl
      if (!d) return // Claude Code: no decl, cc: ids
      expect(d.prefix).toMatch(/^[a-z]{2}:$/)
      expect(d.caps.length).toBeGreaterThan(0)
      expect(d.caps).toContain('launch')
      if (d.defaultModeId !== undefined)
        expect(d.modes?.map((m) => m.id)).toContain(d.defaultModeId)
    })

    it('setModeId reaches the session', async () => {
      const h = make()
      const mode = h.runner.decl?.modes?.[0]
      const s = h.runner.start({ ...START, ...(mode ? { modeId: mode.id } : {}) })
      h.init('sess-m')
      await s.sessionId
      if (!mode || !s.setModeId) return
      await s.setModeId(mode.id)
      expect(h.controls()).toContain(`modeId:${mode.id}`)
    })

    it('close leaves nothing alive and is idempotent', async () => {
      const h = make()
      const s = h.runner.start(START)
      h.init('sess-c')
      await s.sessionId
      expect(h.alive()).toBe(true)
      await s.close()
      await s.close()
      await tick()
      expect(h.alive()).toBe(false)
    })
  })
}
