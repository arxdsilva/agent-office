import type { HarnessDraft } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'
import type { EnforcementDecl, GateRun, GateSpec } from '../domain/harness-types.ts'
import type { ManagedSessions } from '../ports/driving.ts'
import type { CancelSignal } from '../ports/driving.ts'
import { CancelController } from './harness-validation-service.ts'

const CLAUDE: EnforcementDecl = {
  instructions: 'native',
  toolDeny: 'hook',
  pathDeny: 'hook',
  commandDeny: 'hook',
  fsIsolation: 'none',
  subagents: 'inherited',
}

/** Inline fake runner: scripted results per gate id; `hold` keeps a run pending until released. */
class Runner {
  calls: { spec: GateSpec; cwd: string }[] = []
  results = new Map<string, GateRun['status']>()
  hold = false
  private releases: (() => void)[] = []
  async run(spec: GateSpec, o: { cwd: string; signal?: CancelSignal }): Promise<GateRun> {
    this.calls.push({ spec, cwd: o.cwd })
    if (this.hold)
      await new Promise<void>((res) => {
        this.releases.push(res)
        o.signal?.addEventListener('abort', () => res(), { once: true })
      })
    if (o.signal?.aborted)
      return { status: 'cancelled', exitCode: null, durationMs: 1, outputTail: '' }
    const status = this.results.get(spec.argv.join(' ')) ?? 'pass'
    if (status === 'error') throw new Error('spawn failed')
    return {
      status,
      exitCode: status === 'pass' ? 0 : 2,
      durationMs: 5,
      outputTail: `out of ${spec.argv[0]}\u0007`,
    }
  }
  release() {
    for (const r of this.releases.splice(0)) r()
  }
}

const tick = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const DRAFT: HarnessDraft = {
  name: 'Std',
  gateTrigger: 'turn-end',
  retryBudget: 1,
  rules: [
    { name: 'Tests', text: 'Run the tests', category: 'testing', enforcement: 'instruction' },
  ],
  gates: [
    { name: 'Check', argv: ['make', 'check'] },
    { name: 'Web', argv: ['pnpm', 'test'], subdir: 'packages/web', required: false },
    { name: 'Win only', argv: ['win'], platforms: ['win32'] },
    { name: 'Bad dir', argv: ['bad'], subdir: '../x', required: false },
  ],
}

async function setup(o: { runner?: Runner | null; draft?: HarnessDraft } = {}) {
  const runner = o.runner === null ? undefined : (o.runner ?? new Runner())
  const sent: { agentId: string; text: string }[] = []
  const sessions = {
    send: async (agentId: string, m: { text: string }) => void sent.push({ agentId, text: m.text }),
  }
  const h = harness({
    enforcementOf: () => CLAUDE,
    platform: 'darwin',
    ...(runner ? { gateRunner: runner } : {}),
    sessions: () => sessions as unknown as ManagedSessions,
  })
  const prj = await withProject(h)
  const d = await h.projects.harness.create(o.draft ?? DRAFT)
  await h.projects.harness.publish(d.id)
  await h.projects.harness.attach(prj, d.id)
  const ap = (await h.projects.policy.prepare({
    projectId: prj,
    provider: 'claude-code',
    cwd: '/work/shop',
    mode: 'default',
    enforcement: CLAUDE,
  }))!
  h.putAgent({ id: 'cc:s1', projectId: prj })
  h.projects.policy.bind({ agentId: 'cc:s1', sessionId: 's1', projectId: prj, policy: ap })
  const gates = h.projects.store.harness(d.id)!.gates
  return {
    h,
    prj,
    runner: runner!,
    sent,
    v: h.projects.validation,
    policy: h.projects.policy,
    gates,
  }
}

describe('HarnessValidationService', () => {
  it('HV-run: gates from the snapshot in the repo (+subdir), platform filter, results, events, activity', async () => {
    const { h, prj, runner, v, policy } = await setup()
    const out = await v.run({ agentId: 'cc:s1' })
    expect(runner.calls.map((c) => [c.spec.argv.join(' '), c.cwd])).toEqual([
      ['make check', '/work/shop'],
      ['pnpm test', '/work/shop/packages/web'],
    ])
    expect(out.map((r) => [r.name, r.status])).toEqual([
      ['Check', 'pass'],
      ['Web', 'pass'],
      ['Bad dir', 'error'],
    ])
    expect(out[0]!.outputTail).toBe('out of make')
    expect(out[0]!.harnessVersion).toMatch(/^hrn_[a-z0-9]+@1$/)
    expect(v.results('cc:s1').length).toBe(3)
    expect(policy.inspect('cc:s1').verification).toBe('verified')
    const sid = policy.sessionOf('cc:s1')!
    expect(
      h.projects.store
        .harnessEventsOf(sid)
        .filter((e) => e.kind.startsWith('validation'))
        .map((e) => e.kind),
    ).toEqual([
      'validation-started',
      'validation-passed',
      'validation-started',
      'validation-passed',
      'validation-started',
      'validation-failed',
    ])
    expect(
      h.projects.store
        .activityOf(prj)
        .filter((a) => a.kind.startsWith('validation'))
        .map((a) => a.text),
    ).toEqual(['Validation started: 3 gates', 'Validation failed: Bad dir'])
    await h.projects.store.flush()
    for (const rec of [...h.log.storage.values()]
      .flat()
      .filter((x) => x.t === 'activity' || x.t === 'harness-event'))
      expect(JSON.stringify(rec)).not.toContain('make check')
  })

  it('HV-only selected gates; unknown gate, no runner, no session and agents are refused', async () => {
    const { runner, v, gates, prj } = await setup()
    await v.run({ agentId: 'cc:s1', gateIds: [gates[0]!.id] })
    expect(runner.calls).toHaveLength(1)
    await expect(v.run({ agentId: 'cc:s1', gateIds: ['gat_unknown000'] })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(v.run({ agentId: 'cc:none' })).rejects.toBeInstanceOf(NotFoundError)
    expect(v.results('cc:none')).toEqual([])
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    await expect(v.run({ agentId: 'cc:s1' }, runtime)).rejects.toBeInstanceOf(ForbiddenError)
    expect(() => v.cancel('cc:s1', runtime)).toThrow(ForbiddenError)
    expect(() => v.results('cc:s1', runtime)).toThrow(ForbiddenError)
    const none = await setup({ runner: null })
    await expect(none.v.run({ agentId: 'cc:s1' })).rejects.toThrow('validation unavailable')
  })

  it('HV-running state, one run per project at a time, and cancel', async () => {
    const { runner, v, policy } = await setup()
    runner.hold = true
    const a = v.run({ agentId: 'cc:s1' })
    const b = v.run({ agentId: 'cc:s1' })
    await tick()
    expect(runner.calls).toHaveLength(1)
    expect(policy.inspect('cc:s1').verification).toBe('running')
    expect(v.results('cc:s1')[0]).toMatchObject({ status: 'running', exitCode: null })
    v.cancel('cc:s1')
    const ra = await a
    expect(ra.map((r) => r.status)).toEqual(['cancelled'])
    runner.hold = false
    runner.release()
    expect((await b).length).toBe(3)
  })

  it('HV-turn-end: runs after a write, feeds failures back within the retry budget', async () => {
    const { runner, v, policy, sent, h } = await setup()
    runner.results.set('make check', 'fail')
    // No write yet: nothing runs.
    policy.turnEnded('cc:s1', { isError: false, interrupted: false })
    await tick()
    expect(runner.calls).toHaveLength(0)
    h.clock.advance(5)
    policy.evaluate('cc:s1', { tool: 'Edit', input: { file_path: 'a.ts' }, cwd: '/work/shop' })
    h.clock.advance(5)
    // Interrupted or failed turns never trigger gates.
    policy.turnEnded('cc:s1', { isError: false, interrupted: true })
    policy.turnEnded('cc:s1', { isError: true, interrupted: false })
    await tick()
    expect(runner.calls).toHaveLength(0)
    policy.turnEnded('cc:s1', { isError: false, interrupted: false })
    await tick(80)
    expect(runner.calls.length).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Check failed (exit 2)')
    expect(policy.retriesLeft('cc:s1')).toBe(0)
    // Same write, another turn: no new run.
    policy.turnEnded('cc:s1', { isError: false, interrupted: false })
    await tick(80)
    expect(runner.calls.length).toBe(2)
    // A new write, still failing: the budget is spent, nothing is sent.
    h.clock.advance(5)
    policy.evaluate('cc:s1', { tool: 'Bash', input: { command: 'make x' }, cwd: '/work/shop' })
    h.clock.advance(5)
    policy.turnEnded('cc:s1', { isError: false, interrupted: false })
    await tick(80)
    expect(runner.calls.length).toBe(4)
    expect(sent).toHaveLength(1)
    // Passing resets the budget.
    runner.results.clear()
    h.clock.advance(5)
    policy.evaluate('cc:s1', { tool: 'Write', input: { file_path: 'b.ts' }, cwd: '/work/shop' })
    h.clock.advance(5)
    policy.turnEnded('cc:s1', { isError: false, interrupted: false })
    await tick(80)
    expect(policy.retriesLeft('cc:s1')).toBe(1)
    expect(policy.inspect('cc:s1').completion).toBe('harness-verified')
    policy.ended('cc:s1')
  })

  it('HV-runner errors become error results', async () => {
    const { runner, v } = await setup()
    runner.results.set('make check', 'error')
    expect((await v.run({ agentId: 'cc:s1' }))[0]).toMatchObject({
      status: 'error',
      exitCode: null,
    })
  })

  it('HV-flow: a passing gate passes the matching gate check of the active step; a failure fails it', async () => {
    const runner = new Runner()
    const draft: HarnessDraft = {
      name: 'Release',
      gates: [{ id: 'gat_tmplcheck', name: 'Check', argv: ['make', 'check'] }],
      steps: [
        { name: 'Tests', goal: 'Green', exit: [{ kind: 'gate', gateId: 'gat_tmplcheck' }] },
        { name: 'Tag', goal: 'Tagged', exit: [{ kind: 'report' }] },
      ],
    }
    const { h, v, sent } = await setup({ runner, draft })
    runner.results.set('make check', 'fail')
    await v.run({ agentId: 'cc:s1' })
    await tick()
    expect(h.projects.flow.progress('cc:s1')!.steps[0]!.checks[0]!.state).toBe('fail')
    runner.results.set('make check', 'pass')
    await v.run({ agentId: 'cc:s1' })
    await tick()
    const p = h.projects.flow.progress('cc:s1')!
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'active'])
    expect(p.steps[0]!.by).toBe('checks')
    expect(sent.at(-1)?.text).toMatch(/^Step 2 of 2 is now active: Tag/)
  })

  it('CancelController', () => {
    const c = new CancelController()
    let n = 0
    const fn = () => n++
    c.signal.addEventListener('abort', fn)
    c.signal.addEventListener('abort', () => {
      throw new Error('isolated')
    })
    expect(c.signal.aborted).toBe(false)
    c.abort()
    c.abort()
    expect(n).toBe(1)
    expect(c.signal.aborted && c.aborted).toBe(true)
    c.signal.addEventListener('abort', fn)
    expect(n).toBe(2)
    c.signal.removeEventListener('abort', fn)
  })
})
