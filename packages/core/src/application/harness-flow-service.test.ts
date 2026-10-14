import type { HarnessDraft } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { harness, withHarnessSession, withProject } from '../../test/projects-harness.ts'
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../domain/errors.ts'
import type { EnforcementDecl } from '../domain/harness-types.ts'
import type { RepoFiles } from '../ports/driven.ts'
import type { ManagedSessions, McpPrincipal } from '../ports/driving.ts'

const CLAUDE: EnforcementDecl = {
  instructions: 'native',
  toolDeny: 'hook',
  pathDeny: 'hook',
  commandDeny: 'hook',
  fsIsolation: 'none',
  subagents: 'inherited',
}

/** Inline RepoFiles fake: a set of repo-relative files per root, matched by prefix or exact path. */
class Files implements RepoFiles {
  files = new Set<string>()
  calls: { root: string; glob: string }[] = []
  async exists(root: string, glob: string): Promise<boolean> {
    this.calls.push({ root, glob })
    const prefix = glob.replace(/\*\*.*$/, '')
    return [...this.files].some((f) => f === glob || (prefix !== glob && f.startsWith(prefix)))
  }
}

const tick = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const FLOW: HarnessDraft = {
  name: 'Pipeline',
  steps: [
    { name: 'Research', goal: 'Notes exist', exit: [{ kind: 'report' }] },
    {
      name: 'Outline',
      goal: 'Outline is agreed',
      exit: [{ kind: 'approval', prompt: 'Outline approved' }],
    },
    {
      name: 'Draft',
      goal: 'Draft written',
      exit: [{ kind: 'artifact', path: 'drafts/**' }, { kind: 'report' }],
    },
    { name: 'Extras', goal: 'Optional polish', optional: true, exit: [{ kind: 'report' }] },
    { name: 'Publish', goal: 'Published', exit: [{ kind: 'report' }] },
  ],
}

async function setup(o: { files?: Files | null; draft?: HarnessDraft; live?: boolean } = {}) {
  const files = o.files === null ? undefined : (o.files ?? new Files())
  const sent: { agentId: string; text: string }[] = []
  const sessions = {
    send: async (agentId: string, m: { text: string }) => void sent.push({ agentId, text: m.text }),
  }
  const h = harness({
    enforcementOf: () => CLAUDE,
    sessions: () => sessions as unknown as ManagedSessions,
    ...(files ? { repoFiles: files } : {}),
  })
  const prj = await withProject(h)
  const d = await h.projects.harness.create(o.draft ?? FLOW)
  await h.projects.harness.publish(d.id)
  await h.projects.harness.attach(prj, d.id)
  const ap = (await h.projects.policy.prepare({
    projectId: prj,
    provider: 'claude-code',
    cwd: '/work/shop',
    mode: 'default',
    enforcement: CLAUDE,
  }))!
  h.putAgent({ id: 'cc:f1', name: 'Writer', projectId: prj })
  h.projects.policy.bind({ agentId: 'cc:f1', sessionId: 'f1', projectId: prj, policy: ap })
  const sid = h.projects.policy.sessionOf('cc:f1')!
  const steps = h.projects.store.harness(d.id)!.steps!
  const principal: McpPrincipal = {
    kind: 'mcp',
    projectId: prj,
    sessionId: sid,
    provider: 'claude-code',
    tokenId: 'tok_aaaaaaaaaa',
    access: 'read',
  }
  return { h, prj, sid, steps, sent, files: files!, flow: h.projects.flow, principal }
}

const kinds = (h: ReturnType<typeof harness>, sid: string) =>
  h.projects.store
    .harnessEventsOf(sid)
    .filter((e) => e.kind.startsWith('step-') || e.kind === 'approval-granted')
    .map((e) => `${e.kind}:${e.detail.summary}`)

describe('HarnessFlowService', () => {
  it('HF-user actions: mark done, approve, skip, reopen; events and a message per started step', async () => {
    const { h, sid, steps, sent, flow } = await setup()
    const [research, outline, draft, extras, publish] = steps.map((s) => s.id)
    expect(flow.progress('cc:f1')).toMatchObject({ current: research, done: 0, total: 5 })
    expect(flow.progress('cc:none')).toBeNull()

    await flow.markDone({ agentId: 'cc:f1', stepId: research! })
    await tick()
    expect(sent.at(-1)).toEqual({
      agentId: 'cc:f1',
      text: 'Step 2 of 5 is now active: Outline — Outline is agreed. Exit: user approval "Outline approved".',
    })
    await expect(flow.markDone({ agentId: 'cc:f1', stepId: outline! })).rejects.toBeInstanceOf(
      ValidationError,
    )
    const v = await flow.approve({ agentId: 'cc:f1', stepId: outline!, checkIndex: 0 })
    expect(v.current).toBe(draft)
    await flow.skip({ agentId: 'cc:f1', stepId: extras!, confirmed: false })
    await expect(
      flow.skip({ agentId: 'cc:f1', stepId: draft!, confirmed: false }),
    ).rejects.toBeInstanceOf(ValidationError)
    const s = await flow.skip({ agentId: 'cc:f1', stepId: draft!, confirmed: true })
    expect(s.current).toBe(publish)
    const r = await flow.reopen({ agentId: 'cc:f1', stepId: research! })
    expect(r.current).toBe(research)
    expect(kinds(h, sid)).toEqual([
      'step-started:Research',
      'step-done:Research',
      'step-started:Outline',
      'approval-granted:Outline',
      'step-done:Outline',
      'step-started:Draft',
      'step-skipped:Extras',
      'step-skipped:Draft',
      'step-started:Publish',
      'step-started:Research',
    ])
    expect(sent.every((m) => m.text.length <= 1000)).toBe(true)
  })

  it('HF-only the user may act; unknown agents are not found', async () => {
    const { prj, steps, flow } = await setup()
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    expect(() => flow.progress('cc:f1', runtime)).toThrow(ForbiddenError)
    await expect(
      flow.markDone({ agentId: 'cc:f1', stepId: steps[0]!.id }, runtime),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      flow.approve({ agentId: 'cc:f1', stepId: steps[1]!.id, checkIndex: 0 }, runtime),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      flow.markDone({ agentId: 'cc:nobody', stepId: steps[0]!.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(() => flow.pendingApprovals(undefined, runtime)).toThrow(ForbiddenError)
  })

  it('HF-report_step: own session only, report checks only, rate limited', async () => {
    const { h, sid, steps, flow, principal } = await setup()
    const v = await flow.reportStep(principal, steps[0]!.id, 'notes in notes.md')
    expect(v.current).toBe(steps[1]!.id)
    expect(kinds(h, sid)).toContain('step-done:Research')
    // An approval can never be passed by the agent.
    await expect(flow.reportStep(principal, steps[1]!.id)).rejects.toBeInstanceOf(ValidationError)
    // Another session's (or a session-less) principal is refused.
    await expect(
      flow.reportStep({ ...principal, sessionId: 'ses_someoneelse0' }, steps[1]!.id),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      flow.reportStep({ ...principal, projectId: 'prj_otherproject' }, steps[1]!.id),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      flow.reportStep({ ...principal, sessionId: '' }, steps[1]!.id),
    ).rejects.toBeInstanceOf(ForbiddenError)
    // The note is never stored.
    await h.projects.store.flush()
    expect(h.log.dump()).not.toContain('notes in notes.md')
    let limited = false
    for (let i = 0; i < 25 && !limited; i++)
      await flow.reportStep(principal, steps[1]!.id).catch((e) => {
        if (e instanceof RateLimitedError) limited = true
      })
    expect(limited).toBe(true)
    h.clock.advance(61_000)
    await expect(flow.reportStep(principal, steps[1]!.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('HF-artifact checks: stat through RepoFiles in the repo; without it they stay pending with a label', async () => {
    const { steps, flow, files, principal } = await setup()
    await flow.reportStep(principal, steps[0]!.id)
    await flow.approve({ agentId: 'cc:f1', stepId: steps[1]!.id, checkIndex: 0 })
    await flow.reportStep(principal, steps[2]!.id)
    await tick()
    expect(flow.progress('cc:f1')!.current).toBe(steps[2]!.id)
    expect(files.calls.at(-1)).toEqual({ root: '/work/shop', glob: 'drafts/**' })
    files.files.add('drafts/one.md')
    await flow.refreshChecks('cc:f1')
    expect(flow.progress('cc:f1')!.current).toBe(steps[3]!.id)

    const none = await setup({ files: null })
    await none.flow.reportStep(none.principal, none.steps[0]!.id)
    await none.flow.approve({ agentId: 'cc:f1', stepId: none.steps[1]!.id, checkIndex: 0 })
    await none.flow.refreshChecks('cc:f1')
    const draft = none.flow.progress('cc:f1')!.steps[2]!
    expect(draft.checks[0]).toMatchObject({
      state: 'pending',
      label: 'drafts/** (cannot check: no repository access)',
    })
  })

  it('HF-artifact paths outside the repository are never checked', async () => {
    const draft: HarnessDraft = {
      name: 'Bad',
      steps: [{ name: 'Escape', goal: 'g', exit: [{ kind: 'artifact', path: '../secrets/**' }] }],
    }
    const { flow, files } = await setup({ draft })
    await flow.refreshChecks('cc:f1')
    expect(files.calls).toEqual([])
    expect(flow.progress('cc:f1')!.steps[0]!.checks[0]!.state).toBe('pending')
  })

  it('HF-pending approvals for the overview, with project and agent names', async () => {
    const { prj, steps, flow, principal } = await setup()
    expect(flow.pendingApprovals()).toEqual([])
    await flow.reportStep(principal, steps[0]!.id)
    expect(flow.pendingApprovals()).toEqual([
      {
        projectId: prj,
        projectName: 'Shop',
        agentId: 'cc:f1',
        agentName: 'Writer',
        stepId: steps[1]!.id,
        stepName: 'Outline',
        checkIndex: 0,
        prompt: 'Outline approved',
      },
    ])
    expect(flow.pendingApprovals('prj_otherproject')).toEqual([])
  })

  it('HF-a write after a gate pass voids the gate check', async () => {
    const draft: HarnessDraft = {
      name: 'Gated',
      gates: [{ id: 'gat_tmplcheck', name: 'Check', argv: ['make', 'check'] }],
      steps: [
        {
          name: 'Tests',
          goal: 'Green',
          exit: [
            { kind: 'gate', gateId: 'gat_tmplcheck' },
            { kind: 'approval', prompt: 'ok' },
          ],
        },
        { name: 'Ship', goal: 'Shipped', exit: [{ kind: 'report' }] },
      ],
    }
    const { h, flow } = await setup({ draft })
    const gateId = h.projects.store.allHarnesses()[0]!.gates[0]!.id
    flow.gateFinished('cc:f1', gateId, true)
    expect(flow.progress('cc:f1')!.steps[0]!.checks[0]!.state).toBe('pass')
    h.projects.policy.evaluate('cc:f1', {
      tool: 'Edit',
      input: { file_path: 'src/a.ts' },
      cwd: '/work/shop',
    })
    expect(flow.progress('cc:f1')!.steps[0]!.checks[0]!.state).toBe('pending')
    flow.gateFinished('cc:f1', gateId, false)
    expect(flow.progress('cc:f1')!.steps[0]!.checks[0]!.state).toBe('fail')
  })

  it('HF-free mode: a checklist in any order; no step messages', async () => {
    const sent: string[] = []
    const h = harness({
      sessions: () =>
        ({ send: async (_a: string, m: { text: string }) => void sent.push(m.text) }) as never,
    })
    const prj = await withProject(h)
    await withHarnessSession(h, prj, { ...FLOW, flowMode: 'free' }, { agentId: 'cc:free' })
    const flow = h.projects.flow
    const ids = flow.progress('cc:free')!.steps.map((s) => s.stepId)
    const v = await flow.markDone({ agentId: 'cc:free', stepId: ids[4]! })
    expect(v.steps.map((s) => s.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'done',
    ])
    expect(v.current).toBeNull()
    expect(sent).toEqual([])
  })
})
