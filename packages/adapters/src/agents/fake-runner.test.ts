import type { AgentEvent } from '@agent-office/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionPolicy, PolicyAction, PolicyDecision, RunnerStart } from '@agent-office/core'
import { ScriptedAgentRunner } from './fake-runner.ts'
import { CLAUDE_ENFORCEMENT } from './claude-sdk-runner.ts'

const START = {
  cwd: '/tmp/shop',
  mode: 'default' as const,
  extraDirs: [],
  chrome: false,
  allowBypass: false,
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function started(more: Partial<RunnerStart> = {}) {
  const runner = new ScriptedAgentRunner({ stepMs: 10, slowMs: 5000 })
  const s = runner.start({ ...START, ...more })
  const events: Omit<AgentEvent, 'agentId'>[] = []
  const results: string[] = []
  const exits: unknown[] = []
  s.onEvent((e) => events.push(e))
  s.onResult((r) => results.push(r.isError ? `error:${r.text}` : r.text))
  s.onExit((e) => exits.push(e))
  return { s, events, results, exits }
}

describe('ScriptedAgentRunner (AGENT_OFFICE_FAKE_RUNNER)', () => {
  it('starts with a fake session id and replies "ok"', async () => {
    const { s, events, results } = started()
    await vi.advanceTimersByTimeAsync(10)
    await expect(s.sessionId).resolves.toMatch(/^fake-[a-z0-9]+$/)
    s.push('hello')
    await vi.advanceTimersByTimeAsync(30)
    expect(events.map((e) => e.status)).toContain('thinking')
    expect(results).toEqual(['ok'])
  })

  it('/perm asks to run Bash `pnpm test` and replies after the decision', async () => {
    const { s, events, results } = started()
    const asked: unknown[] = []
    s.onPermission(async (r) => {
      asked.push(r)
      return { behavior: 'allow' }
    })
    await vi.advanceTimersByTimeAsync(10)
    s.push('please /perm')
    await vi.advanceTimersByTimeAsync(30)
    expect(asked).toEqual([{ tool: 'Bash', input: { command: 'pnpm test' }, cwd: '/tmp/shop' }])
    expect(events.some((e) => e.tool === 'Bash' && e.target === 'cmd:pnpm')).toBe(true)
    expect(results).toEqual(['ok'])
  })

  it('/perm denied replies "denied"', async () => {
    const { s, results } = started()
    s.onPermission(async () => ({ behavior: 'deny', message: 'no' }))
    await vi.advanceTimersByTimeAsync(10)
    s.push('/perm')
    await vi.advanceTimersByTimeAsync(30)
    expect(results).toEqual(['denied'])
  })

  it('/slow stays busy until interrupted', async () => {
    const { s, events, results } = started()
    await vi.advanceTimersByTimeAsync(10)
    s.push('/slow')
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.at(-1)?.status).toBe('tool')
    expect(results).toEqual([])
    await s.interrupt()
    await vi.advanceTimersByTimeAsync(6000)
    expect(results).toEqual(['error:'])
  })

  // Like the real runtime, a prompt sent mid-turn waits for that turn to end.
  it('runs one turn at a time: a prompt pushed during a turn starts after its result', async () => {
    const { s } = started()
    const log: string[] = []
    s.onEvent((e) => log.push(`event:${e.status}`))
    s.onResult((r) => log.push(`result:${r.text}`))
    await vi.advanceTimersByTimeAsync(10)
    s.push('first')
    s.push('/slow')
    await vi.advanceTimersByTimeAsync(100)
    expect(log).toEqual(['event:thinking', 'result:ok', 'event:thinking', 'event:tool'])
  })

  // Like the real runtime (assistant messages carry `model`), the session reports its model.
  it('reports a model with its activity; the chosen model once set', async () => {
    const { s, events } = started()
    await vi.advanceTimersByTimeAsync(10)
    s.push('hello')
    await vi.advanceTimersByTimeAsync(30)
    expect(events.find((e) => e.status === 'thinking')?.model).toBe('claude-sonnet-5')
    await s.setModel('opus')
    s.push('again')
    await vi.advanceTimersByTimeAsync(30)
    expect(events.filter((e) => e.status === 'thinking').at(-1)?.model).toBe('opus')
  })

  it('/slow finishes on its own after the delay', async () => {
    const { s, results } = started()
    await vi.advanceTimersByTimeAsync(10)
    s.push('/slow')
    await vi.advanceTimersByTimeAsync(5100)
    expect(results).toEqual(['ok'])
  })

  it('records mode and model, lists models, and exits cleanly on close', async () => {
    const { s, exits } = started()
    await vi.advanceTimersByTimeAsync(10)
    await s.setMode('plan')
    await s.setModel('opus')
    expect((await s.supportedModels()).map((m) => m.id)).toEqual(['default', 'opus', 'sonnet'])
    await s.close()
    expect(exits).toEqual([{}])
    s.push('ignored after close')
  })
})

describe('ScriptedAgentRunner harness', () => {
  const policy = (action: PolicyDecision['action']) => {
    const calls: PolicyAction[] = []
    const h: ActionPolicy = {
      evaluate: (a) => {
        calls.push(a)
        return { action, ruleIds: ['rul_1'], reason: 'Shared contracts are frozen', basis: 'exact' }
      },
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

  it('declares the same enforcement as Claude', () => {
    expect(new ScriptedAgentRunner().enforcement).toEqual(CLAUDE_ENFORCEMENT)
    expect('decl' in new ScriptedAgentRunner()).toBe(false)
  })

  it('/perm-protected denied by the harness: tool event, "denied: <reason>", no permission call', async () => {
    const { h, calls } = policy('deny')
    const { s, events, results } = started({ harness: h })
    const asked: unknown[] = []
    s.onPermission(async (r) => {
      asked.push(r)
      return { behavior: 'allow' }
    })
    await vi.advanceTimersByTimeAsync(10)
    s.push('/perm-protected')
    await vi.advanceTimersByTimeAsync(30)
    expect(calls).toEqual([
      { tool: 'Edit', input: { file_path: 'packages/shared/src/protocol.ts' }, cwd: '/tmp/shop' },
    ])
    expect(asked).toEqual([])
    expect(events.some((e) => e.status === 'tool' && e.tool === 'Edit')).toBe(true)
    expect(results).toEqual(['denied: Shared contracts are frozen'])
  })

  it('/perm-protected with ask goes through the permission callback', async () => {
    const { h } = policy('ask')
    const { s, results } = started({ harness: h })
    const asked: unknown[] = []
    s.onPermission(async (r) => {
      asked.push(r)
      return { behavior: 'deny', message: 'no' }
    })
    await vi.advanceTimersByTimeAsync(10)
    s.push('/perm-protected')
    await vi.advanceTimersByTimeAsync(30)
    expect(asked).toEqual([
      { tool: 'Edit', input: { file_path: 'packages/shared/src/protocol.ts' }, cwd: '/tmp/shop' },
    ])
    expect(results).toEqual(['denied'])
  })

  it('/perm-protected allowed (or without a harness) replies "ok"', async () => {
    for (const harness of [policy('allow').h, undefined]) {
      const { s, results } = started(harness ? { harness } : {})
      await vi.advanceTimersByTimeAsync(10)
      s.push('/perm-protected')
      await vi.advanceTimersByTimeAsync(30)
      expect(results).toEqual(['ok'])
    }
  })

  it('/subagent emits child start, tool and stop events, then "ok"', async () => {
    const { s, results } = started()
    const kids: { childId: string; event: { status?: string } }[] = []
    s.onChild!((c) => kids.push(c))
    await vi.advanceTimersByTimeAsync(10)
    s.push('/subagent')
    await vi.advanceTimersByTimeAsync(60)
    expect(kids.map((k) => k.event.status)).toEqual(['thinking', 'tool', 'done'])
    expect(new Set(kids.map((k) => k.childId)).size).toBe(1)
    expect(kids[0]!.childId).toMatch(/^cc:/)
    expect(results).toEqual(['ok'])
  })
})
