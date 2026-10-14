import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, SessionStartError } from '../domain/errors.ts'
import type { EnforcementDecl } from '../domain/harness-types.ts'
import type { HarnessDraft } from '@agent-office/shared'

const CLAUDE: EnforcementDecl = {
  instructions: 'native',
  toolDeny: 'hook',
  pathDeny: 'hook',
  commandDeny: 'hook',
  fsIsolation: 'sandbox',
  subagents: 'inherited',
  nonInterceptingModes: ['bypassPermissions'],
  interceptingMode: 'default',
}
const ACP: EnforcementDecl = {
  instructions: 'first-message',
  toolDeny: 'approval',
  pathDeny: 'none',
  commandDeny: 'none',
  fsIsolation: 'none',
  subagents: 'opaque',
}
const DRAFT: HarnessDraft = {
  name: 'Std',
  rules: [
    { name: 'Tests', text: 'Run the tests', category: 'testing', enforcement: 'instruction' },
    {
      name: 'No rm',
      text: 'Never delete files with rm',
      category: 'security',
      enforcement: 'runtime-policy',
      policy: { effect: 'deny', commands: ['rm'] },
    },
    {
      name: 'Env',
      text: 'Ask before reading env files',
      category: 'security',
      enforcement: 'runtime-policy',
      policy: { effect: 'ask', paths: ['.env'] },
    },
  ],
  gates: [{ name: 'Check', argv: ['make', 'check'] }],
}

async function setup(draft: HarnessDraft = DRAFT) {
  const h = harness({
    enforcementOf: (p) => (p === 'claude-code' ? CLAUDE : p === 'codex' ? ACP : undefined),
  })
  const prj = await withProject(h)
  const d = await h.projects.harness.create(draft)
  await h.projects.harness.publish(d.id)
  await h.projects.harness.attach(prj, d.id)
  return { h, prj, hid: d.id, policy: h.projects.policy }
}

const START = (
  prj: string,
  o: Partial<{
    provider: 'claude-code' | 'codex'
    mode: string
    modeId: string
    enforcement: EnforcementDecl
  }> = {},
) => ({
  projectId: prj,
  provider: o.provider ?? ('claude-code' as const),
  cwd: '/work/shop',
  mode: o.mode ?? 'default',
  ...(o.modeId ? { modeId: o.modeId } : {}),
  ...(o.enforcement !== undefined ? { enforcement: o.enforcement } : { enforcement: CLAUDE }),
})

describe('HarnessPolicyService', () => {
  it('HP-preview: published, attached, not archived; coverage per rule from the runtime declaration', async () => {
    const { h, prj, hid, policy } = await setup()
    await h.projects.harness.update(hid, { ...DRAFT, name: 'Std v2 draft' }) // v2 draft is ignored
    const p = policy.preview(prj, 'claude-code')
    expect(p.effective.resolved).toEqual([{ harnessId: hid, version: 1, name: 'Std' }])
    expect(p.effective.rules.map((r) => r.coverage)).toEqual([
      'instruction-only',
      'partial',
      'enforced',
    ])
    expect(p.effective.instructionsChars).toBeGreaterThan(50)
    expect(p.report.launch).toEqual({ ok: true })
    expect(policy.preview(prj, 'cursor').effective.unsupported.length).toBe(3)
    await h.projects.harness.archive(hid)
    expect(policy.preview(prj, 'claude-code').effective.resolved).toEqual([])
    expect(await policy.prepare(START(prj))).toBeUndefined()
    expect(await policy.prepare(START('prj_unknown00000'))).toBeUndefined()
  })

  it('HP-prepare: strict refuses unsupported required rules and non-intercepting modes; advisory coerces', async () => {
    const { h, prj, hid, policy } = await setup()
    const ok = await policy.prepare(START(prj, { mode: 'bypassPermissions' }))
    expect(ok?.interceptAll).toBe(true)
    expect(ok?.native.denyCommands).toEqual(['rm'])
    expect(ok?.native.askPaths).toEqual(['.env'])
    expect(ok?.instructions).toContain('<agent-office-harness>')
    expect(ok?.unsupported).toEqual([])
    const acp = await policy.prepare(START(prj, { provider: 'codex', enforcement: ACP }))
    expect(acp?.unsupported.map((u) => u.ruleId).length).toBe(2)
    await h.projects.harness.update(hid, { ...DRAFT, launchPolicy: 'strict' })
    await h.projects.harness.publish(hid)
    await expect(
      policy.prepare(START(prj, { provider: 'codex', enforcement: ACP })),
    ).rejects.toMatchObject({ code: 'harness' })
    await expect(policy.prepare(START(prj, { mode: 'bypassPermissions' }))).rejects.toBeInstanceOf(
      SessionStartError,
    )
    await expect(
      policy.prepare(START(prj, { mode: 'x', modeId: 'bypassPermissions' })),
    ).rejects.toBeInstanceOf(SessionStartError)
    expect(await policy.prepare(START(prj))).toBeDefined()
  })

  it('HP-decisions are buffered before bind, then audited with redacted summaries; denies reach activity', async () => {
    const { h, prj, policy } = await setup()
    const ap = (await policy.prepare(START(prj)))!
    const early = ap.evaluate({
      tool: 'Bash',
      input: { command: 'rm -rf build' },
      cwd: '/work/shop',
    })
    expect(early).toMatchObject({
      action: 'deny',
      basis: 'heuristic',
      reason: expect.stringContaining('No rm'),
    })
    h.putAgent({
      id: 'cc:s1',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    policy.bind({ agentId: 'cc:s1', sessionId: 's1', projectId: prj, policy: ap })
    policy.bind({ agentId: 'cc:s1', sessionId: 's1', projectId: prj, policy: ap }) // idempotent
    expect(
      policy.evaluate('cc:s1', {
        tool: 'Read',
        input: { file_path: '/work/shop/.env' },
        cwd: '/work/shop',
      }).action,
    ).toBe('ask')
    expect(
      policy.evaluate('cc:s1', {
        tool: 'Bash',
        input: { command: 'curl -H "Authorization: Bearer SECRET-9f3a" https://x' },
        cwd: '/work/shop',
      }).action,
    ).toBe('allow')
    h.clock.advance(10)
    expect(
      policy.evaluate('cc:s1', {
        tool: 'Edit',
        input: { file_path: 'src/a.ts' },
        cwd: '/work/shop',
      }).action,
    ).toBe('allow')
    // A repeat of the same decision within seconds (hook, then approval) is recorded once.
    policy.evaluate('cc:s1', { tool: 'Edit', input: { file_path: 'src/a.ts' }, cwd: '/work/shop' })
    expect(
      policy.evaluate('cc:unknown', { tool: 'Bash', input: { command: 'rm x' }, cwd: '/' }).action,
    ).toBe('allow')
    expect(
      policy.ruleName(
        'cc:s1',
        ap.native.denyCommands.length ? h.projects.store.allHarnesses()[0]!.rules[1]!.id : '',
      ),
    ).toBe('No rm')

    const sid = policy.sessionOf('cc:s1')!
    expect(sid).toMatch(/^ses_/)
    const kinds = h.projects.store.harnessEventsOf(sid).map((e) => e.kind)
    expect(kinds).toEqual([
      'attached',
      'resolved',
      'instructions-delivered',
      'action-denied',
      'action-asked',
      'action-allowed',
      'action-allowed',
    ])
    expect(h.projects.store.harnessSnapshot(sid)).toMatchObject({
      agentId: 'cc:s1',
      projectId: prj,
      provider: 'claude-code',
    })
    expect(
      h.projects.store
        .activityOf(prj)
        .filter((a) => a.kind === 'harness.denied')
        .map((a) => a.text),
    ).toEqual(['Blocked Bash: No rm'])
    await h.projects.store.flush()
    expect(h.log.dump()).not.toContain('SECRET-9f3a')

    const ins = policy.inspect('cc:s1')
    expect(ins).toMatchObject({
      sessionId: sid,
      projectId: prj,
      counts: { allowed: 2, denied: 1, asked: 1 },
      verification: 'not-run',
      completion: 'agent-reported',
      retriesLeft: 2,
    })
    expect(ins.events[0]!.kind).toBe('action-allowed')
    expect(policy.lastWriteAt('cc:s1')).toBe(h.clock.now())
    expect(policy.badges()).toEqual([
      {
        agentId: 'cc:s1',
        harnessNames: ['Std'],
        ruleCount: 3,
        coverage: 'instruction-only',
        verification: 'not-run',
        completion: 'agent-reported',
        denied: 1,
      },
    ])
    policy.ended('cc:s1')
    expect(policy.inspect('cc:s1').completion).toBe('validation-pending')
    expect(
      policy.evaluate('cc:s1', { tool: 'Bash', input: { command: 'rm x' }, cwd: '/' }).action,
    ).toBe('allow')
    expect(policy.inspect('cc:none')).toMatchObject({ effective: null, verification: 'not-run' })
  })

  it('HP-lastWriteAt is rebuilt from stored events after a restart', async () => {
    const { h, prj, policy } = await setup()
    const ap = (await policy.prepare(START(prj)))!
    h.putAgent({ id: 'cc:s1', projectId: prj })
    policy.bind({ agentId: 'cc:s1', sessionId: 's1', projectId: prj, policy: ap })
    policy.evaluate('cc:s1', { tool: 'Write', input: { file_path: 'a.ts' }, cwd: '/work/shop' })
    const t = h.clock.now()
    await h.projects.store.flush()
    const h2 = harness({}, h.log.reopen())
    await h2.projects.load()
    expect(h2.projects.policy.lastWriteAt('cc:s1')).toBe(t)
    expect(h2.projects.policy.inspect('cc:s1').effective?.resolved.length).toBe(1)
  })

  it('HP-only the user may read the inspector', async () => {
    const { prj, policy } = await setup()
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    expect(() => policy.preview(prj, 'codex', runtime)).toThrow(ForbiddenError)
    expect(() => policy.badges(runtime)).toThrow(ForbiddenError)
    expect(() => policy.inspect('cc:x', runtime)).toThrow(ForbiddenError)
  })

  it('HP-flow: bind starts the flow; step policies apply while their step is current; inspect and badges show it', async () => {
    const FLOW: HarnessDraft = {
      name: 'Pipeline',
      rules: [{ name: 'Tone', text: 'Be clear', category: 'content', enforcement: 'instruction' }],
      steps: [
        {
          name: 'Draft',
          goal: 'A draft exists',
          exit: [{ kind: 'report' }],
          policies: [{ effect: 'deny', tools: ['class:write'], paths: ['published/**'] }],
        },
        { name: 'Review', goal: 'Approved', exit: [{ kind: 'approval', prompt: 'Looks good' }] },
      ],
    }
    const { h, prj, policy } = await setup(FLOW)
    const ap = (await policy.prepare(START(prj)))!
    expect(ap.interceptAll).toBe(true)
    expect(ap.native.denyPaths).toEqual([]) // step policies are dynamic, never native
    const write = {
      tool: 'Write',
      input: { file_path: '/work/shop/published/a.md' },
      cwd: '/work/shop',
    }
    // Before bind the first step is current (from the action's stepId).
    const stepId = h.projects.store.allHarnesses()[0]!.steps![0]!.id
    expect(ap.evaluate({ ...write, stepId }).action).toBe('deny')
    h.putAgent({ id: 'cc:f1', projectId: prj })
    policy.bind({ agentId: 'cc:f1', sessionId: 'f1', projectId: prj, policy: ap })
    const sid = policy.sessionOf('cc:f1')!
    expect(h.projects.store.flowOf(sid)).toMatchObject({ current: stepId, agentId: 'cc:f1' })
    const started = h.projects.store.harnessEventsOf(sid).filter((e) => e.kind === 'step-started')
    expect(started.map((e) => e.detail.summary)).toEqual(['Draft'])
    const d = policy.evaluate('cc:f1', write)
    expect(d).toMatchObject({ action: 'deny', ruleIds: [stepId] })
    expect(d.reason).toContain('Draft')
    expect(policy.inspect('cc:f1').flow).toMatchObject({ current: stepId, done: 0, total: 2 })
    expect(policy.inspect('cc:f1').verification).toBe('not-run')
    expect(policy.badges()[0]!.step).toEqual({ index: 1, total: 2, name: 'Draft' })

    await h.projects.flow.markDone({ agentId: 'cc:f1', stepId })
    expect(policy.evaluate('cc:f1', write).action).toBe('allow')
    expect(policy.badges()[0]!.step).toEqual({ index: 2, total: 2, name: 'Review' })
    const review = h.projects.store.allHarnesses()[0]!.steps![1]!.id
    await h.projects.flow.approve({ agentId: 'cc:f1', stepId: review, checkIndex: 0 })
    expect(policy.inspect('cc:f1').verification).toBe('verified')
    expect(policy.badges()[0]!.step).toBeUndefined()
  })

  it('HP-flow: a harness without steps starts no flow', async () => {
    const { h, prj, policy } = await setup()
    const ap = (await policy.prepare(START(prj)))!
    h.putAgent({ id: 'cc:s9', projectId: prj })
    policy.bind({ agentId: 'cc:s9', sessionId: 's9', projectId: prj, policy: ap })
    expect(h.projects.store.flowOf(policy.sessionOf('cc:s9')!)).toBeUndefined()
    expect(policy.inspect('cc:s9').flow).toBeUndefined()
  })
})
