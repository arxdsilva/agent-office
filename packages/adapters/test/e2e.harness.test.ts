// The Harness Builder end to end (docs/harness.md): real core + FileRecordLog-shaped vault (the in-memory
// FakeRecordLog, so a "restart" is a reopen), the real filesystem rule reader on a temp git repo, the
// ScriptedAgentRunner standing in for Claude Code, and both a FakeGateRunner and the real ProcessGateRunner.
// Nothing here touches a real CLI, ~/.claude or ~/.agent-office.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOffice, ForbiddenError, SessionStartError } from '@agent-office/core'
import type { AgentRunner } from '@agent-office/core'
import {
  FakeAgentRunner,
  FakeClaudeSettingsStore,
  FakeGateRunner,
  FakeHookRunner,
  FakeRecordLog,
  FakeSettingsRepository,
  FakeWindow,
  fakePlatform,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
} from '@agent-office/core/testing'
import type { GateRunner } from '@agent-office/core'
import type { HarnessDetail, HarnessDraft } from '@agent-office/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ScriptedAgentRunner } from '../src/agents/index.ts'
import { GitRepoIdentity, loadOrCreateWorkspaceSalt } from '../src/git/index.ts'
import { createAuth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import { ProcessGateRunner } from '../src/harness/index.ts'
import { FsRuleSourceReader } from '../src/harness/importers/index.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'

const root = mkdtempSync(join(tmpdir(), 'ao-e2e-hrn-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await wait(20)
  }
}

const SENTINEL = 'SECRET-7f3a'

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  )

/** A tiny git repo with the three kinds of rule files the importer knows. */
function makeRepo(): { dir: string; home: string; repo: string } {
  const dir = mkdtempSync(join(root, 'run-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const repo = join(dir, 'shop-api')
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true })
  mkdirSync(join(repo, '.cursor', 'rules'), { recursive: true })
  writeFileSync(
    join(repo, 'AGENTS.md'),
    '# Rules\n\n- Always write a failing test before the code.\n- Never commit secrets to the repository.\n',
  )
  writeFileSync(
    join(repo, '.claude', 'rules', 'x.md'),
    '# Checks\n\n- Run the full check before you stop working.\n\n```sh\nmake check\n```\n',
  )
  writeFileSync(
    join(repo, '.cursor', 'rules', 'y.mdc'),
    '---\ndescription: style\nglobs: src/**\n---\n- Prefer small pure functions over large classes.\n',
  )
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { dir, home, repo }
}

interface BootOpts {
  runner?: AgentRunner
  gateRunner?: GateRunner
  log?: FakeRecordLog
  home: string
  /** Receives the MCP token of every managed session (a stand-in for the stdio bridge launch). */
  onMcpToken?: (token: string) => void
}

/** One app run: real core on a vault `log`; `reopen()` of the same log is a restart. */
async function boot(o: BootOpts) {
  const scheduler = new TimerScheduler()
  const runner = o.runner ?? new ScriptedAgentRunner({ stepMs: 10 })
  const log = o.log ?? new FakeRecordLog()
  const office = createOffice({
    agents: new InMemoryAgentRepository(),
    capabilities: new InMemoryCapabilityRepository(),
    messages: new InMemoryMessageRepository(),
    bus: new InMemoryEventBus(),
    clock: new SystemClock(),
    ids: new RandomIds(),
    scheduler,
    settingsRepo: new FakeSettingsRepository(),
    loginItem: new RecordingLoginItem(),
    claudeSettings: new FakeClaudeSettingsStore(),
    hookRunner: new FakeHookRunner(),
    notifier: new RecordingNotifier(),
    tray: new RecordingTray(),
    window: new FakeWindow(),
    updater: new ScriptedUpdater(),
    platform: fakePlatform({ packaged: false }),
    releaseUrl: 'https://example.invalid',
    runner,
    vault: log,
    repoIdentity: new GitRepoIdentity({ salt: loadOrCreateWorkspaceSalt(o.home) }),
    ruleSources: new FsRuleSourceReader(),
    random: { token: (n) => randomBytes(n).toString('hex') },
    ...(o.gateRunner ? { gateRunner: o.gateRunner } : {}),
    ...(o.onMcpToken
      ? {
          mcpLaunch: (token: string) => {
            o.onMcpToken!(token)
            return { name: 'agent-office', command: 'node', args: [], env: {} }
          },
        }
      : {}),
  })
  const projects = office.projects!
  await projects.load()
  const close = async () => {
    await office.sessions!.stopAll()
    await projects.store.flush()
    scheduler.dispose()
  }
  return { office, projects, runner, log, close }
}

/** A detail back as the draft the editor would send (ids kept so history and provenance stay). */
function draftOf(d: HarnessDetail, extra: Partial<HarnessDraft> = {}): HarnessDraft {
  return {
    name: d.name,
    scope: d.scope,
    launchPolicy: d.launchPolicy,
    gateTrigger: d.gateTrigger,
    fsIsolation: d.fsIsolation,
    retryBudget: d.retryBudget,
    rules: d.rules.map((r) => ({
      id: r.id,
      name: r.name,
      text: r.text,
      category: r.category,
      enforcement: r.enforcement,
      severity: r.severity,
      ...(r.policy ? { policy: r.policy } : {}),
    })),
    gates: d.gates.map((g) => ({
      id: g.id,
      name: g.name,
      argv: g.argv,
      timeoutMs: g.timeoutMs,
      required: g.required,
      ...(g.subdir ? { subdir: g.subdir } : {}),
    })),
    ...extra,
  }
}

const startArgs = (projectId: string, cwd: string, text = 'hello') => ({
  projectId,
  cwd,
  name: 'shop',
  mode: 'default' as const,
  extraDirs: [],
  chrome: false,
  first: { text, context: [], use: [] },
})

describe('harness builder end to end', () => {
  it('H1 import → rules → publish → attach → coverage → session → denial → subagent → gates → restart', async () => {
    const { dir, home, repo } = makeRepo()
    const gates = new FakeGateRunner()
    const a = await boot({ home, gateRunner: gates })
    let closed = false
    cleanup.push(async () => {
      if (!closed) await a.close()
    })
    const { office, projects } = a

    // A project linked to the temp repo; the importer reads the repo through the real filesystem reader.
    const project = await projects.catalog.create({ name: 'Shop', folders: [repo] })
    const cwd = projects.repos.repoPath(project.id, project.repos[0]!.id)!

    // Detect lists the rule files by repo-relative path only (never an absolute path).
    const sources = await projects.harnessImport.detect(project.id)
    expect(sources.map((s) => s.path).sort()).toEqual(
      ['.claude/rules/x.md', '.cursor/rules/y.mdc', 'AGENTS.md'].sort(),
    )
    expect(JSON.stringify(sources)).not.toContain(dir)

    // Preview extracts candidates with provenance; the fenced `make check` is a gate suggestion, not run.
    const preview = await projects.harnessImport.preview({ projectId: project.id })
    expect(preview.candidates.length).toBeGreaterThanOrEqual(4)
    for (const c of preview.candidates) {
      expect(c.source.path.startsWith('/')).toBe(false)
      expect(c.source.path).not.toContain(dir)
    }
    const suggestion = preview.gates.find((g) => g.argv.join(' ') === 'make check')
    expect(suggestion).toBeTruthy()
    expect(suggestion!.rejected).toBeUndefined()

    // Commit keeps every candidate and the suggested gate: the result is always a draft.
    const imported = await projects.harnessImport.commit({
      previewId: preview.previewId,
      name: 'Shop standards',
      selected: preview.candidates.map((c) => c.tempId),
      gates: [suggestion!.tempId],
    })
    expect(imported.status).toBe('draft')
    expect(imported.gates.map((g) => g.argv.join(' '))).toEqual(['make check'])

    // The user adds a deny rule on packages/shared/**, a command deny, and one more required gate.
    const edited = await projects.harness.update(imported.id, {
      ...draftOf(imported, { launchPolicy: 'advisory' }),
      rules: [
        ...draftOf(imported).rules!,
        {
          name: 'Do not edit shared contracts',
          text: 'Never edit files under packages/shared.',
          category: 'security',
          enforcement: 'runtime-policy',
          severity: 'required',
          policy: { effect: 'deny', tools: ['Edit', 'Write'], paths: ['packages/shared/**'] },
        },
        {
          name: 'No destructive removal',
          text: 'Never run rm.',
          category: 'security',
          enforcement: 'runtime-policy',
          severity: 'required',
          policy: { effect: 'deny', commands: ['rm'] },
        },
      ],
      gates: [
        ...draftOf(imported).gates!,
        { name: 'Unit tests', argv: ['pnpm', 'test'], required: true, timeoutMs: 60_000 },
      ],
    })
    const denyRule = edited.rules.find((r) => r.name === 'Do not edit shared contracts')!

    // Publish makes the version immutable; attach binds it to the project.
    await projects.harness.publish(edited.id)
    await projects.harness.attach(project.id, edited.id)
    const published = projects.harness.get(edited.id)
    expect(published.status).toBe('published')
    for (const g of published.gates)
      gates.script(g.id, { status: 'fail', outputTail: 'boom' }, { status: 'pass' })

    // Coverage preview for Claude: instructions and tool-deny enforced, command-deny only partial.
    const cov = projects.policy.preview(project.id, 'claude-code')
    const level = (c: string) => cov.report.rows.find((r) => r.capability === c)?.level
    expect(level('instructions')).toBe('enforced')
    expect(level('tool-deny')).toBe('enforced')
    expect(level('command-deny')).toBe('partial')

    // Start a managed session on the project: a snapshot of the effective harness is written.
    const sessionEvents: string[] = []
    const stop = office.query.watch((m) => {
      if (m.type === 'permission' && m.requests.length) sessionEvents.push('permission')
    })
    cleanup.push(stop)
    const agentId = await office.sessions!.start(startArgs(project.id, cwd))
    const snap = await until(() => projects.policy.snapshotOf(agentId))
    expect(snap.projectId).toBe(project.id)
    expect(snap.effective.gates).toHaveLength(2)

    // "/perm-protected" edits packages/shared/src/protocol.ts: the harness denies before any approval.
    await office.compose.send(agentId, { text: '/perm-protected', context: [], use: [] })
    const reply = await until(() =>
      office.chat.history(agentId).find((m) => m.from === 'agent' && m.text.includes('denied')),
    )
    expect(reply.text).toContain('denied')
    const inspection = await until(() => {
      const i = projects.policy.inspect(agentId)
      return i.counts.denied > 0 ? i : undefined
    })
    expect(inspection.counts.denied).toBe(1)
    const denied = inspection.events.filter((e) => e.kind === 'action-denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]!.ruleIds).toEqual([denyRule.id])

    // The permission callback (the user's approval cards) was never consulted for the denied action.
    expect(sessionEvents).toEqual([])
    expect(office.sessions!.pending(agentId)).toHaveLength(0)

    // "/subagent": the child appears with its parent and the parent's compliance badge exists.
    await office.compose.send(agentId, { text: '/subagent', context: [], use: [] })
    const child = await until(() => office.query.agents().find((x) => x.parentId === agentId))
    expect(child.id).not.toBe(agentId)
    expect(projects.policy.badges().find((b) => b.agentId === agentId)).toMatchObject({
      harnessNames: ['Shop standards'],
    })

    // A direct policy evaluation with a sentinel in the raw Bash input beyond its first line (events keep only a one-line summary; the raw input must never be stored).
    await wait(5)
    projects.policy.evaluate(agentId, {
      tool: 'Bash',
      input: {
        command: `echo ok
export TOKEN=${SENTINEL}`,
        env: { TOKEN: SENTINEL },
      },
      cwd,
    })

    // First validation run: the scripted gates fail → failed / validation-failed, and the activity says so.
    await wait(5)
    const failed = await projects.validation.run({ agentId })
    expect(failed.every((r) => r.status === 'fail')).toBe(true)
    const afterFail = projects.policy.inspect(agentId)
    expect(afterFail.verification).toBe('failed')
    expect(afterFail.completion).toBe('validation-failed')
    expect(projects.store.activityOf(project.id).map((x) => x.kind)).toContain('validation.failed')

    // Re-running with passing results verifies the work against the current harness version.
    await projects.validation.run({ agentId })
    const afterPass = projects.policy.inspect(agentId)
    expect(afterPass.verification).toBe('verified')
    expect(afterPass.completion).toBe('harness-verified')
    expect(afterPass.events.some((e) => e.kind === 'validation-passed')).toBe(true)
    expect(projects.validation.results(agentId).length).toBeGreaterThanOrEqual(4)

    // No sentinel anywhere: not in the stored vault records, not in any view returned to the UI.
    const views = JSON.stringify([
      projects.policy.inspect(agentId),
      projects.policy.badges(),
      projects.validation.results(agentId),
      projects.harness.list(),
      projects.harness.get(edited.id),
      projects.store.harnessEventsOf(snap.sessionId),
    ])
    expect(views).not.toContain(SENTINEL)
    await projects.store.flush()
    expect(a.log.dump()).not.toContain(SENTINEL)

    // Restart: reopen the same vault. The harness, attachment, snapshot and gate results persist.
    const sessionId = snap.sessionId
    await a.close()
    closed = true
    const b = await boot({ home, gateRunner: new FakeGateRunner(), log: a.log.reopen() })
    cleanup.push(() => b.close())
    expect(b.projects.harness.get(edited.id).status).toBe('published')
    expect(b.projects.store.projects.get(project.id)!.harnesses?.map((h) => h.harnessId)).toEqual([
      edited.id,
    ])
    expect(b.projects.store.harnessSnapshot(sessionId)?.projectId).toBe(project.id)
    expect(b.projects.store.gateResultsOf(sessionId).length).toBeGreaterThanOrEqual(4)
    expect(
      b.projects.store.harnessEventsOf(sessionId).some((e) => e.kind === 'action-denied'),
    ).toBe(true)
  })

  it('H2 the real ProcessGateRunner runs published argv with no shell and reports pass and fail', async () => {
    const { home, repo } = makeRepo()
    const a = await boot({ home, gateRunner: new ProcessGateRunner() })
    cleanup.push(() => a.close())
    const { office, projects } = a
    const project = await projects.catalog.create({ name: 'Shop', folders: [repo] })
    const cwd = projects.repos.repoPath(project.id, project.repos[0]!.id)!

    // Two real gates run by node itself: one prints and exits 0, one exits 1.
    const h = await projects.harness.create({
      name: 'Process gates',
      rules: [
        {
          name: 'Be careful',
          text: 'Check your work before you stop.',
          category: 'completion',
          enforcement: 'instruction',
          severity: 'required',
        },
      ],
      gates: [
        {
          name: 'Passes',
          argv: [process.execPath, '-e', 'console.log("all good")'],
          required: true,
        },
        { name: 'Fails', argv: [process.execPath, '-e', 'process.exit(1)'], required: true },
      ],
    })
    await projects.harness.publish(h.id)
    await projects.harness.attach(project.id, h.id)
    const agentId = await office.sessions!.start(startArgs(project.id, cwd))
    await until(() => projects.policy.snapshotOf(agentId))

    // Running the gates through the trusted runner: the exit code decides the status.
    const out = await projects.validation.run({ agentId })
    const by = Object.fromEntries(out.map((r) => [r.name, r]))
    expect(by['Passes']).toMatchObject({ status: 'pass', exitCode: 0 })
    expect(by['Passes']!.outputTail).toContain('all good')
    expect(by['Fails']).toMatchObject({ status: 'fail', exitCode: 1 })
    expect(projects.policy.inspect(agentId).verification).toBe('failed')
  })

  it('H3 a strict harness with a required rule the runtime cannot enforce refuses to start', async () => {
    const { home, repo } = makeRepo()
    // FakeAgentRunner declares no enforcement: every runtime-policy rule is "unsupported" for it.
    const a = await boot({ home, runner: new FakeAgentRunner() })
    cleanup.push(() => a.close())
    const { office, projects } = a
    const project = await projects.catalog.create({ name: 'Shop', folders: [repo] })
    const cwd = projects.repos.repoPath(project.id, project.repos[0]!.id)!
    const h = await projects.harness.create({
      name: 'Strict',
      launchPolicy: 'strict',
      rules: [
        {
          name: 'No edits',
          text: 'Never edit packages/shared.',
          category: 'security',
          enforcement: 'runtime-policy',
          severity: 'required',
          policy: { effect: 'deny', tools: ['Edit'], paths: ['packages/shared/**'] },
        },
      ],
      gates: [],
    })
    await projects.harness.publish(h.id)
    await projects.harness.attach(project.id, h.id)

    // The start is refused with the "harness" code, never silently downgraded to a prompt.
    const err = await office.sessions!.start(startArgs(project.id, cwd)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionStartError)
    expect((err as SessionStartError).code).toBe('harness')
  })

  it('H4 harnesses are user-only: mcp and runtime principals are refused and MCP has no harness tool', async () => {
    const { home, repo } = makeRepo()
    const a = await boot({ home })
    cleanup.push(() => a.close())
    const { projects } = a
    const project = await projects.catalog.create({ name: 'Shop', folders: [repo] })

    // An agent's MCP principal and a provider runtime principal cannot even list harnesses.
    const minted = projects.mcp.mint({ projectId: project.id, provider: 'claude-code' })!
    const mcp = projects.mcp.principal(minted.token)!
    expect(() => projects.harness.list(mcp)).toThrow(ForbiddenError)
    expect(() =>
      projects.harness.list({ kind: 'runtime', provider: 'claude-code', projectId: project.id }),
    ).toThrow(ForbiddenError)

    // The MCP tool list never mentions a harness: agents cannot read or weaken their own rules.
    const names = projects.mcp.tools(mcp).map((t) => t.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n.toLowerCase().includes('harness'))).toEqual([])
  })
  it('H5 content-pipeline flow: report_step over POST /mcp, approval in the overview, scoped to the session, question options never stored', async () => {
    const { home, repo } = makeRepo()
    const tokens: string[] = []
    const a = await boot({ home, onMcpToken: (t) => tokens.push(t) })
    cleanup.push(() => a.close())
    const { office, projects } = a
    const project = await projects.catalog.create({ name: 'Shop', folders: [repo] })
    const other = await projects.catalog.create({ name: 'Plain', folders: [repo] })
    const cwd = projects.repos.repoPath(project.id, project.repos[0]!.id)!

    // The real HTTP route in front of the real MCP access service (the same wiring as the desktop app).
    const API_TOKEN = 'e'.repeat(64)
    let auth = createAuth({ token: API_TOKEN, port: 0 })
    const app = buildHttpApi(
      {
        activity: office.activity,
        inbox: office.inbox,
        chat: office.chat,
        query: office.query,
        mcp: projects.mcp,
      },
      {
        token: API_TOKEN,
        hostAllowed: (h) => auth.hostAllowed(h),
        originAllowed: (o) => auth.originAllowed(o),
        bearerOk: (h) => auth.bearerOk(h),
        tokenOk: (t) => auth.tokenOk(t),
      },
    )
    const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
    auth = createAuth({ token: API_TOKEN, port: server.port })
    cleanup.push(() => server.close())
    let rpcId = 0
    const rpc = async (token: string, method: string, params?: object) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      })
      return { status: res.status, body: (await res.json()) as Record<string, any> }
    }
    const toolNames = async (token: string) =>
      ((await rpc(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name)

    // The template becomes a harness with five steps; publish it and attach it to the project.
    const h = await projects.harness.createFromTemplate('content-pipeline')
    expect(h.steps).toHaveLength(5)
    await projects.harness.publish(h.id)
    await projects.harness.attach(project.id, h.id)

    // Two sessions on the flow project and one on a project without a flow.
    const agentA = await office.sessions!.start(startArgs(project.id, cwd))
    const agentB = await office.sessions!.start(startArgs(project.id, cwd))
    const agentC = await office.sessions!.start(startArgs(other.id, cwd))
    expect(tokens).toHaveLength(3)
    const [tokA, tokB, tokC] = tokens as [string, string, string]
    await until(() => projects.flow.progress(agentA) && projects.flow.progress(agentB))
    const progA = projects.flow.progress(agentA)!
    const [s1, s2, s3] = progA.steps
    expect(progA.steps.map((s) => s.state)).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
      'pending',
    ])

    // Step 1 is a report check: the agent reports it through report_step with its own token.
    expect(await toolNames(tokA)).toContain('report_step')
    const done = await rpc(tokA, 'tools/call', {
      name: 'report_step',
      arguments: { stepId: s1!.stepId },
    })
    expect(done.body.error).toBeUndefined()
    expect(done.body.result.isError).toBeFalsy()
    let p = projects.flow.progress(agentA)!
    expect(p.current).toBe(s2!.stepId)
    expect(p.steps[0]!.state).toBe('done')
    expect(p.steps[1]!.state).toBe('active')
    expect(p.steps[1]!.checks[0]!.state).toBe('waiting-user')

    // Step 2 is an approval: the overview lists it for the user, and only the user can pass it.
    const overview = projects.workspace.overview()
    expect(overview.flowApprovals).toMatchObject([
      { projectId: project.id, agentId: agentA, stepId: s2!.stepId },
    ])
    const early = await rpc(tokA, 'tools/call', {
      name: 'report_step',
      arguments: { stepId: s2!.stepId },
    })
    // The agent cannot approve its own step: the approval stays pending.
    expect(early.body.error).toMatchObject({ code: -32602 })
    expect(projects.flow.progress(agentA)!.steps[1]!.state).toBe('active')
    await projects.flow.approve({ agentId: agentA, stepId: s2!.stepId, checkIndex: 0 })
    p = projects.flow.progress(agentA)!
    expect(p.current).toBe(s3!.stepId)
    expect(p.steps[1]!.state).toBe('done')
    expect(projects.workspace.overview().flowApprovals).toEqual([])

    // Another session's token only ever touches that session's own progress.
    const bProgress = projects.flow.progress(agentB)!
    expect(bProgress.steps[0]!.state).toBe('active')
    const cross = await rpc(tokB, 'tools/call', {
      name: 'report_step',
      arguments: { stepId: s3!.stepId },
    })
    expect(cross.body.error).toMatchObject({ code: -32602 })
    expect(projects.flow.progress(agentA)!.current).toBe(s3!.stepId)
    // B's own step 1 is untouched by A's work and A's step 3 untouched by B's call.
    expect(projects.flow.progress(agentB)!.steps[0]!.state).toBe('active')
    // Direct service call: a principal of the flow-less project is forbidden.
    const principalC = projects.mcp.principal(tokC)!
    await expect(projects.flow.reportStep(principalC, s1!.stepId)).rejects.toBeInstanceOf(
      ForbiddenError,
    )

    // A session without a flow does not even see the tool, and cannot call it.
    expect(await toolNames(tokC)).not.toContain('report_step')
    const refused = await rpc(tokC, 'tools/call', {
      name: 'report_step',
      arguments: { stepId: s1!.stepId },
    })
    expect(refused.body.error).toMatchObject({ code: -32602 })
    expect(agentC).toBeTruthy()

    // A question asked through the scripted runner's /ask never reaches the vault: the answer does.
    await office.compose.send(agentB, { text: '/ask', context: [], use: [] })
    const ask = await until(() => office.sessions!.pending(agentB).find((r) => r.question))
    expect(ask.question!.prompts[0]!.question).toBe('Which colour?')
    office.sessions!.answer(agentB, ask.id, 'allow', { 'Which colour?': 'Green' })
    await until(() =>
      office.chat.history(agentB).find((m) => m.from === 'agent' && m.text === 'chose: Green'),
    )
    await projects.store.flush()
    const vault = a.log.dump()
    // Only the one-line summary (the first question, by design) is kept in the harness events; the
    // options and their descriptions never are.
    expect(vault).not.toContain('Blue')
    expect(vault).not.toContain('Calm and familiar')
    expect(vault).not.toContain('Fresh and bright')
  })
})
