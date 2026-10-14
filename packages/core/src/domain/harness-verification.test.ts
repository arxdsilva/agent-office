import { describe, expect, it } from 'vitest'
import type { GateResult, GateRun, ValidationGate } from './harness-types.ts'
import {
  completionState,
  gateFeedback,
  MAX_FEEDBACK,
  verificationState,
} from './harness-verification.ts'

const gate = (id: string, required = true): ValidationGate => ({
  id,
  name: id,
  argv: ['x'],
  timeoutMs: 1000,
  required,
})
let n = 0
const res = (
  gateId: string,
  status: GateRun['status'],
  startedAt: number,
  o: Partial<GateResult> & Partial<GateRun> = {},
): GateResult => ({
  id: `gtr_${++n}`,
  sessionId: 'ses_1',
  projectId: 'prj_1',
  gateId,
  name: `Gate ${gateId}`,
  required: true,
  harnessVersion: o.harnessVersion ?? 'hrn_a@1',
  startedAt,
  run: {
    status,
    exitCode: status === 'pass' ? 0 : 1,
    durationMs: 1,
    outputTail: o.outputTail ?? 'out',
    ...(o.pinChanged ? { pinChanged: true } : {}),
  },
})
const V = { harnessVersion: 'hrn_a@1' }
const G = [gate('a'), gate('b'), gate('c', false)]

describe('verificationState', () => {
  it('not-run, running, verified, failed, stale', () => {
    expect(verificationState(G, [], V)).toBe('not-run')
    expect(verificationState(G, [], { ...V, running: true })).toBe('running')
    const ok = [res('a', 'pass', 10), res('b', 'pass', 11)]
    expect(verificationState(G, ok, V)).toBe('verified')
    expect(verificationState(G, ok, { ...V, lastWriteAt: 5 })).toBe('verified')
    expect(verificationState(G, ok, { ...V, lastWriteAt: 10 })).toBe('stale')
    expect(verificationState(G, [res('a', 'pass', 10)], V)).toBe('not-run')
    expect(verificationState(G, [...ok, res('b', 'fail', 12)], V)).toBe('failed')
    expect(verificationState(G, [res('b', 'fail', 9), ...ok], V)).toBe('verified')
    expect(verificationState(G, [...ok, res('c', 'timeout', 12)], V)).toBe('verified')
    expect(
      verificationState(G, [res('a', 'pass', 10), res('b', 'pass', 11, { pinChanged: true })], V),
    ).toBe('stale')
    expect(verificationState(G, [res('a', 'pass', 10, { harnessVersion: 'hrn_a@0' })], V)).toBe(
      'stale',
    )
  })

  it('a harness without required gates is verified by any newer pass', () => {
    expect(verificationState([gate('c', false)], [res('c', 'pass', 3)], V)).toBe('verified')
  })
})

describe('completionState', () => {
  it.each([
    [{ phase: 'live', verification: 'not-run', userApproved: false }, 'agent-reported'],
    [{ phase: 'ended', verification: 'not-run', userApproved: false }, 'validation-pending'],
    [{ phase: 'live', verification: 'running', userApproved: false }, 'validation-pending'],
    [{ phase: 'live', verification: 'stale', userApproved: false }, 'validation-pending'],
    [{ phase: 'live', verification: 'failed', userApproved: false }, 'validation-failed'],
    [{ phase: 'live', verification: 'verified', userApproved: false }, 'harness-verified'],
    [{ phase: 'ended', verification: 'failed', userApproved: true }, 'user-approved'],
  ] as const)('%j → %s', (o, want) => {
    expect(completionState(o)).toBe(want)
  })
})

describe('gateFeedback', () => {
  it('lists failed gates with exit codes and tails, ≤ 4000 chars', () => {
    const s = gateFeedback([
      res('a', 'pass', 1),
      res('b', 'fail', 2, { outputTail: 'line1\nboom' }),
      res('c', 'timeout', 3),
    ])
    expect(s).toContain('Gate b')
    expect(s).toContain('boom')
    expect(s).toContain('timed out')
    expect(s).not.toContain('Gate a')
    const big = gateFeedback(
      Array.from({ length: 10 }, (_, i) =>
        res(`g${i}`, 'fail', i, { outputTail: 'z'.repeat(8000) }),
      ),
    )
    expect(big.length).toBeLessThanOrEqual(MAX_FEEDBACK)
    expect(gateFeedback([])).toBe('')
  })
})

describe('verificationState with a flow', () => {
  const flow = (
    states: ('pending' | 'active' | 'done' | 'skipped')[],
    optional: boolean[] = [],
  ) => ({
    harnessVersion: 'hrn_a@1',
    mode: 'sequential' as const,
    current: null,
    steps: states.map((state, i) => ({
      stepId: `stp_${i}`,
      index: i,
      name: `s${i}`,
      goal: 'g',
      state,
      optional: optional[i] ?? false,
      checks: [],
    })),
    done: 0,
    total: states.length,
  })
  const ok = [res('a', 'pass', 10), res('b', 'pass', 11)]

  it('verified requires every required step done or skipped as well as the gates', () => {
    expect(verificationState(G, ok, { ...V, flow: flow(['done', 'active']) })).toBe(
      'flow-incomplete',
    )
    expect(verificationState(G, ok, { ...V, flow: flow(['done', 'skipped']) })).toBe('verified')
    expect(verificationState(G, ok, { ...V, flow: flow(['done', 'pending'], [false, true]) })).toBe(
      'verified',
    )
    expect(
      verificationState(G, [...ok, res('b', 'fail', 12)], { ...V, flow: flow(['active']) }),
    ).toBe('failed')
  })

  it('a flow without gates is verified when its steps are', () => {
    expect(verificationState([], [], { ...V, flow: flow(['done']) })).toBe('verified')
    expect(verificationState([], [], { ...V, flow: flow(['active']) })).toBe('not-run')
  })
})
