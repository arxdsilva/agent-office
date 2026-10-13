// Real-CLI verification (plan "multi-provider platform" §9; docs/provider-integrations.md §10).
// For each installed and logged-in provider CLI, starts a managed session through the REAL adapter in
// a temp folder and checks each capability with harmless prompts. Nothing outside the temp folder is
// touched; every session is closed. Prints a pass / fail / n/a matrix (and JSON with --json).
//
//   pnpm exec tsx scripts/verify-providers.ts [--only codex,cursor] [--json] [--harness | --harness-only]
//
// `--harness` adds the opt-in Harness Builder check (docs/harness.md) for Claude Code and Codex: a real
// session under a deny rule must be stopped by the harness. It spends model tokens, so it never runs
// by default and refuses to run when CI is set.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createOffice,
  type AgentRunner,
  type ProviderProbe,
  type RunnerSession,
} from '@agent-office/core'
import {
  FakeClaudeSettingsStore,
  FakeHookRunner,
  FakeSettingsRepository,
  FakeWindow,
  fakePlatform,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
} from '@agent-office/core/testing'
import { resolveClaudeExecutable, ClaudeSdkRunner } from '../packages/adapters/src/agents/index.ts'
import { GitRepoIdentity, loadOrCreateWorkspaceSalt } from '../packages/adapters/src/git/index.ts'
import { createAuth } from '../packages/adapters/src/http/auth.ts'
import { buildHttpApi } from '../packages/adapters/src/http/http-api.ts'
import { startHttpServer } from '../packages/adapters/src/http/server.ts'
import { observeWorkspace } from '../packages/adapters/src/http/workspace-observer.ts'
import { McpLauncher } from '../packages/adapters/src/mcp/mcp-launcher.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../packages/adapters/src/memory/index.ts'
import { ClaudeProbe } from '../packages/adapters/src/providers/claude-code/probe.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../packages/adapters/src/system/index.ts'
import { FileRecordLog, TestKeyProvider, TextIndex } from '../packages/adapters/src/vault/index.ts'
import {
  ClineAcpRunner,
  ClineProbe,
  CodexProbe,
  CodexRunner,
  CopilotAcpRunner,
  CopilotProbe,
  CursorAcpRunner,
  CursorProbe,
  GeminiAcpRunner,
  GeminiProbe,
  GooseAcpRunner,
  GooseProbe,
  KiloAcpRunner,
  KiloProbe,
  OpenCodeAcpProbe,
  OpenCodeAcpRunner,
  OpenHandsAcpRunner,
  OpenHandsProbe,
  QwenAcpRunner,
  QwenProbe,
} from '../packages/adapters/src/providers/index.ts'

type Result = 'pass' | 'fail' | 'n/a'
const CHECKS = [
  'detect',
  'auth',
  'start',
  'stream',
  'approve',
  'reply',
  'deny',
  'interrupt',
  'models',
  'modes',
  'stop',
] as const
type Check = (typeof CHECKS)[number]

interface Target {
  id: string
  probe: ProviderProbe
  runner: AgentRunner
  /** Process name pattern for the leftover-process check. */
  processPattern: string
  /** A mode that asks before running commands, and a different one to switch to. */
  askMode?: string
  otherMode?: string
  /** A model that needs no login, when the CLI's default model does (picked at start, like the UI). */
  model?: string
}

const TARGETS: Target[] = [
  {
    id: 'codex',
    probe: new CodexProbe({}),
    runner: new CodexRunner({}),
    processPattern: 'codex app-server',
    askMode: 'ask',
    otherMode: 'read-only',
  },
  // ACP agents: their default modes ask before shell commands; plan mode is the read-only switch.
  {
    id: 'cursor',
    probe: new CursorProbe({}),
    runner: new CursorAcpRunner({}),
    processPattern: 'agent acp',
    askMode: 'agent',
    otherMode: 'plan',
  },
  {
    id: 'gemini',
    probe: new GeminiProbe({}),
    runner: new GeminiAcpRunner({}),
    processPattern: 'gemini --acp',
    askMode: 'default',
    otherMode: 'plan',
  },
  {
    id: 'copilot',
    probe: new CopilotProbe({}),
    runner: new CopilotAcpRunner({}),
    processPattern: 'copilot --acp',
    askMode: 'agent',
    otherMode: 'plan',
  },
  // Open-source ACP runtimes (docs/providers/<id>.md). Each needs its own model/login configured by
  // the user; modes are the verified ones. The ACP entry is verified, the rest is "built, not yet
  // verified" until this has run on a logged-in machine.
  {
    id: 'opencode',
    probe: new OpenCodeAcpProbe({}),
    runner: new OpenCodeAcpRunner({}),
    processPattern: 'opencode acp',
    askMode: 'build',
    otherMode: 'plan',
  },
  {
    id: 'goose',
    probe: new GooseProbe({}),
    runner: new GooseAcpRunner({}),
    processPattern: 'goose acp',
    askMode: 'approve',
    otherMode: 'chat',
  },
  {
    id: 'kilo',
    probe: new KiloProbe({}),
    runner: new KiloAcpRunner({}),
    processPattern: 'kilo acp',
    askMode: 'code',
    otherMode: 'plan',
    // Kilo's default gateway model needs `kilo auth login`; its free auto model does not (7.8.8).
    model: 'kilo/kilo-auto/free',
  },
  {
    id: 'qwen',
    probe: new QwenProbe({}),
    runner: new QwenAcpRunner({}),
    processPattern: 'qwen --acp',
    askMode: 'default',
    otherMode: 'plan',
  },
  {
    id: 'cline',
    probe: new ClineProbe({}),
    runner: new ClineAcpRunner({}),
    processPattern: 'cline --acp',
    askMode: 'act',
    otherMode: 'plan',
  },
  {
    // Its only non-dangerous mode is always-ask, so there is no second mode to switch to.
    id: 'openhands',
    probe: new OpenHandsProbe({}),
    runner: new OpenHandsAcpRunner({}),
    processPattern: 'openhands acp',
    askMode: 'always-ask',
  },
]

const STEP_MS = 120_000
const COMMAND_PROMPT =
  'Run exactly this shell command in the current folder: node -e "console.log(6*7)" — then reply with only its output. Do not modify any file.'

function withTimeout<T>(p: Promise<T>, ms = STEP_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms)),
  ])
}

function countProcesses(pattern: string): number {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

async function verify(t: Target): Promise<Record<Check, Result> & { notes: string[] }> {
  const r = Object.fromEntries(CHECKS.map((c) => [c, 'n/a'])) as Record<Check, Result>
  const notes: string[] = []
  const probe = await t.probe.detect()
  r.detect = probe.installed && probe.flagsOk ? 'pass' : 'fail'
  if (r.detect !== 'pass') return { ...r, notes: ['not installed or flags missing'] }
  r.auth = probe.auth === 'ok' ? 'pass' : probe.auth === 'unknown' ? 'n/a' : 'fail'
  if (probe.auth === 'needed') return { ...r, notes: ['login required'] }

  const dir = mkdtempSync(join(tmpdir(), `ao-verify-${t.id}-`))
  writeFileSync(join(dir, 'hello.txt'), 'hello from agent-office verification\n')
  const before = countProcesses(t.processPattern)
  let s: RunnerSession | undefined
  try {
    s = t.runner.start({
      cwd: dir,
      mode: 'default',
      modeId: t.askMode,
      ...(t.model ? { model: t.model } : {}),
      extraDirs: [],
      chrome: false,
      allowBypass: false,
    })
    await withTimeout(s.sessionId)
    r.start = 'pass'

    const statuses = new Set<string>()
    s.onEvent((e) => e.status && statuses.add(e.status))
    const results: { text: string; isError: boolean }[] = []
    const nextResult = () =>
      withTimeout(
        new Promise<{ text: string; isError: boolean }>((ok) => {
          const off = s!.onResult((x) => {
            off()
            results.push(x)
            ok(x)
          })
        }),
      )
    let decide: 'allow' | 'deny' = 'allow'
    let asked = 0
    s.onPermission(async (p) => {
      asked++
      notes.push(`permission asked: ${p.tool}`)
      return decide === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied by verification' }
    })

    // Approve: the command is not on the auto-allowed list, so a permission request must arrive.
    let res = nextResult()
    s.push(COMMAND_PROMPT)
    const first = await res
    r.stream = statuses.size > 0 ? 'pass' : 'fail'
    r.approve = asked > 0 ? 'pass' : 'fail'
    r.reply = !first.isError && first.text.includes('42') ? 'pass' : 'fail'
    if (r.reply === 'fail') notes.push(`reply: ${first.text.slice(0, 80)}`)

    // Deny: the turn still finishes (the agent reports it couldn't run the command).
    decide = 'deny'
    const askedBefore = asked
    res = nextResult()
    s.push('Run the same command again and reply with its output.')
    const second = await res
    r.deny = asked > askedBefore && !second.text.includes('42') ? 'pass' : 'fail'

    // Interrupt: a long answer, interrupted after it starts.
    res = nextResult()
    s.push('Count from 1 to 400, one number per line, without using any tools.')
    await new Promise((ok) => setTimeout(ok, 4000))
    await s.interrupt()
    await res.then(
      () => (r.interrupt = 'pass'),
      () => (r.interrupt = 'fail'),
    )

    const models = await s.supportedModels().catch(() => [])
    r.models = models.length > 0 ? 'pass' : 'fail'
    if (t.otherMode && s.setModeId) {
      await s.setModeId(t.otherMode).then(
        () => (r.modes = 'pass'),
        () => (r.modes = 'fail'),
      )
    }
  } catch (e) {
    notes.push(`error: ${(e as Error).message}`)
  } finally {
    await s?.close().catch(() => {})
    await new Promise((ok) => setTimeout(ok, 2500))
    r.stop = s ? (countProcesses(t.processPattern) <= before ? 'pass' : 'fail') : 'n/a'
    rmSync(dir, { recursive: true, force: true })
  }
  return { ...r, notes }
}

// ── Step "project MCP" (docs/projects.md §5, plan 13.3) ────────────────────────────────────────────
// A managed session on a project must call agent-office's MCP server (search_memory) and get an
// approved memory back. Everything lives in a temp dir (vault key, AGENT_OFFICE_HOME, userData);
// the real ~/.agent-office and ~/.claude/settings.json are never touched. One short prompt each.
const SENTINEL = 'PLUM-7731'
const MCP_PROMPT =
  'Use the agent-office-memory search_memory tool to find the deploy codeword, then reply with just the codeword.'
const BRIDGE = join(import.meta.dirname, '..', 'hooks', 'agent-office-mcp.mjs')

interface McpRow {
  id: string
  result: 'pass' | 'fail' | 'skipped'
  notes: string[]
}

async function verifyMcp(onlyIds?: string[]): Promise<McpRow[]> {
  const root = mkdtempSync(join(tmpdir(), 'ao-verify-mcp-'))
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  const cwd = join(root, 'work')
  for (const d of [home, userData, cwd]) mkdirSync(d, { recursive: true })
  const apiToken = randomBytes(32).toString('hex')
  // Drop variables a parent Claude Code session leaks (CLAUDECODE, CLAUDE_CODE_*): they make a nested CLI misbehave.
  const procEnv: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        k !== 'CLAUDECODE' &&
        k !== 'ELECTRON_RUN_AS_NODE' &&
        k !== 'CLAUDE_PID' &&
        k !== 'CLAUDE_EFFORT' &&
        !k.startsWith('CLAUDE_CODE_') &&
        !k.startsWith('CLAUDE_AGENT_SDK'),
    ),
  )
  const claudeBin = resolveClaudeExecutable({
    env: procEnv,
    home: homedir(),
    platform: process.platform,
    exists: existsSync,
  })
  const claudeRunner = new ClaudeSdkRunner({
    env: procEnv,
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => console.log(`  [claude-sdk] ${m}`),
      error: (m: string) => console.log(`  [claude-sdk] ${m}`),
    } as never,
    ...(claudeBin ? { executable: claudeBin } : {}),
  })
  const codexRunner = new CodexRunner({})
  const scheduler = new TimerScheduler()
  let base = ''
  const launcher = new McpLauncher({
    userData,
    execPath: process.execPath,
    script: BRIDGE,
    platform: process.platform,
    runAsNode: false,
    url: () => base,
  })
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
    runner: claudeRunner,
    providers: [{ provider: 'codex', runner: codexRunner }],
    runtimes: new Map([['codex', codexRunner]]),
    vault: new FileRecordLog({
      dir: join(userData, 'vault'),
      keys: new TestKeyProvider({ master: 'verify-mcp' }),
    }),
    repoIdentity: new GitRepoIdentity({ salt: loadOrCreateWorkspaceSalt(home) }),
    searchIndex: new TextIndex(),
    random: { token: (n) => randomBytes(n).toString('hex') },
    mcpLaunch: (token) => launcher.launch(token),
  })
  const projects = office.projects!
  await office.providers.setEnabled('codex', true)
  await projects.load()
  let auth = createAuth({ token: apiToken, port: 0 })
  const app = buildHttpApi(
    {
      activity: observeWorkspace(office.activity, projects.observation),
      inbox: office.inbox,
      chat: office.chat,
      query: office.query,
      capabilities: office.capabilities,
      mcp: projects.mcp,
    },
    {
      token: apiToken,
      hostAllowed: (h) => auth.hostAllowed(h),
      originAllowed: (x) => auth.originAllowed(x),
      bearerOk: (h) => auth.bearerOk(h),
      tokenOk: (t) => auth.tokenOk(t),
    },
  )
  const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
  auth = createAuth({ token: apiToken, port: server.port })
  base = `http://127.0.0.1:${server.port}`
  await launcher.ensureInstalled()

  const project = await projects.catalog.create({ name: 'Verify', folders: [] })
  await projects.memory.create({
    projectId: project.id,
    scope: 'project',
    kind: 'decision',
    title: `The deploy codeword is ${SENTINEL}`,
    body: `The deploy codeword is ${SENTINEL}. Say it when asked for the deploy codeword.`,
  })

  const rows: McpRow[] = []
  const targets: { id: 'claude-code' | 'codex'; probe: ProviderProbe; modeId?: string }[] = [
    {
      id: 'claude-code',
      probe: new ClaudeProbe({ resolve: () => claudeBin }),
    },
    { id: 'codex', probe: new CodexProbe({}), modeId: 'ask' },
  ]
  try {
    for (const t of targets.filter((x) => !onlyIds || onlyIds.includes(x.id))) {
      const notes: string[] = []
      const probe = await t.probe.detect()
      if (!probe.installed || !probe.flagsOk) {
        rows.push({ id: t.id, result: 'skipped', notes: ['not installed (or flags missing)'] })
        continue
      }
      if (probe.auth === 'needed') {
        rows.push({ id: t.id, result: 'skipped', notes: ['not logged in'] })
        continue
      }
      notes.push(`version ${probe.version ?? '?'}`)
      process.stdout.write(`verifying project MCP with ${t.id}…\n`)
      let agentId: string | undefined
      let result: McpRow['result'] = 'fail'
      try {
        agentId = await withTimeout(
          office.sessions!.start({
            ...(t.id === 'codex' ? { provider: 'codex' as const } : {}),
            ...(t.modeId ? { modeId: t.modeId } : {}),
            projectId: project.id,
            cwd,
            name: `verify-mcp-${t.id}`,
            mode: 'default',
            extraDirs: [],
            chrome: false,
            first: { text: MCP_PROMPT, context: [], use: [] },
          }),
        )
        const id = agentId
        const seen = new Set<string>()
        const deadline = Date.now() + STEP_MS
        let reply = ''
        while (Date.now() < deadline) {
          // Approve the MCP tool only; deny anything else the runner asks for.
          for (const req of office.sessions!.pending(id)) {
            if (seen.has(req.id)) continue
            seen.add(req.id)
            const isMcp = /agent-office|search_memory|mcp/i.test(`${req.tool} ${req.summary}`)
            notes.push(`permission ${isMcp ? 'allowed' : 'denied'}: ${req.tool}`)
            office.sessions!.answer(id, req.id, isMcp ? 'allow' : 'deny')
          }
          const msg = office.chat
            .history(id)
            .find((m) => m.from === 'agent' && m.text.includes(SENTINEL))
          if (msg) {
            reply = msg.text
            break
          }
          await new Promise((ok) => setTimeout(ok, 250))
        }
        const retrieved = projects.context.inspect(id).retrieved
        const replyOk = reply.includes(SENTINEL)
        const retrievalOk = retrieved.some((r) => r.tool === 'search_memory')
        if (!replyOk) {
          const last = office.chat
            .history(id)
            .filter((m) => m.from === 'agent')
            .at(-1)
          notes.push(
            `no sentinel in reply; last agent text: ${(last?.text ?? '(none)').slice(0, 160)}`,
          )
        }
        if (!retrievalOk) notes.push('no mcp.retrieval recorded for this session')
        else
          notes.push(
            `mcp.retrieval x${retrieved.length} (${retrieved.map((r) => r.tool).join(',')})`,
          )
        result = replyOk && retrievalOk ? 'pass' : 'fail'
      } catch (e) {
        const msg = (e as Error).message
        notes.push(`error: ${msg}`)
        if (/auth/i.test(msg)) result = 'skipped'
      } finally {
        if (agentId) await office.sessions!.stop(agentId).catch(() => {})
      }
      rows.push({ id: t.id, result, notes })
    }
  } finally {
    await office.sessions!.stopAll().catch(() => {})
    projects.mcp.revokeAll()
    await projects.store.flush().catch(() => {})
    await server.close().catch(() => {})
    scheduler.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return rows
}

// ── Step "harness" (docs/harness.md §3; opt-in with --harness) ─────────────────────────────────────
// A managed session on a project with a published harness must be stopped by the runtime's trusted
// interception point: Claude Code's PreToolUse hook (deny edits of **/protected.txt) and Codex's
// approval channel (deny the `rm` command). Passing needs BOTH the untouched file/folder AND a recorded
// `action-denied` event in the inspection. Anything the harness did not stop and that reaches the
// approver is denied here, so a failing run never damages the temp folder.
interface HarnessRow {
  id: string
  result: 'pass' | 'fail' | 'skipped'
  notes: string[]
}

const PROTECTED_BEFORE = 'keep me as I am\n'
const HARNESS_CASES = {
  'claude-code': {
    prompt:
      'Use your Edit or Write tool to append one line saying "changed" to protected.txt in the current folder, then reply "done".',
    policy: {
      effect: 'deny' as const,
      tools: ['Edit', 'Write', 'MultiEdit'],
      paths: ['**/protected.txt'],
    },
    ruleName: 'Do not edit protected.txt',
    ruleText: 'Never modify any file named protected.txt.',
    setup: (cwd: string) => writeFileSync(join(cwd, 'protected.txt'), PROTECTED_BEFORE),
    intact: (cwd: string) => readFileSync(join(cwd, 'protected.txt'), 'utf8') === PROTECTED_BEFORE,
  },
  codex: {
    prompt:
      'Run exactly this shell command in the current folder: rm -rf ./tmpdir — then reply "done".',
    policy: { effect: 'deny' as const, commands: ['rm'] },
    ruleName: 'No rm',
    ruleText: 'Never run the rm command.',
    setup: (cwd: string) => {
      mkdirSync(join(cwd, 'tmpdir'), { recursive: true })
      writeFileSync(join(cwd, 'tmpdir', 'keep.txt'), 'keep\n')
    },
    intact: (cwd: string) => existsSync(join(cwd, 'tmpdir', 'keep.txt')),
  },
}

async function verifyHarness(onlyIds?: string[]): Promise<HarnessRow[]> {
  const root = mkdtempSync(join(tmpdir(), 'ao-verify-harness-'))
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  for (const d of [home, userData]) mkdirSync(d, { recursive: true })
  const procEnv: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        k !== 'CLAUDECODE' &&
        k !== 'ELECTRON_RUN_AS_NODE' &&
        k !== 'CLAUDE_PID' &&
        k !== 'CLAUDE_EFFORT' &&
        !k.startsWith('CLAUDE_CODE_') &&
        !k.startsWith('CLAUDE_AGENT_SDK'),
    ),
  )
  const claudeBin = resolveClaudeExecutable({
    env: procEnv,
    home: homedir(),
    platform: process.platform,
    exists: existsSync,
  })
  const claudeRunner = new ClaudeSdkRunner({
    env: procEnv,
    log: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => console.log(`  [claude-sdk] ${m}`),
      error: (m: string) => console.log(`  [claude-sdk] ${m}`),
    } as never,
    ...(claudeBin ? { executable: claudeBin } : {}),
  })
  const codexRunner = new CodexRunner({})
  const scheduler = new TimerScheduler()
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
    runner: claudeRunner,
    providers: [{ provider: 'codex', runner: codexRunner }],
    runtimes: new Map([['codex', codexRunner]]),
    vault: new FileRecordLog({
      dir: join(userData, 'vault'),
      keys: new TestKeyProvider({ master: 'verify-harness' }),
    }),
    repoIdentity: new GitRepoIdentity({ salt: loadOrCreateWorkspaceSalt(home) }),
    random: { token: (n) => randomBytes(n).toString('hex') },
  })
  const projects = office.projects!
  await office.providers.setEnabled('codex', true)
  await projects.load()

  const rows: HarnessRow[] = []
  const targets: { id: 'claude-code' | 'codex'; probe: ProviderProbe; modeId?: string }[] = [
    { id: 'claude-code', probe: new ClaudeProbe({ resolve: () => claudeBin }) },
    { id: 'codex', probe: new CodexProbe({}), modeId: 'ask' },
  ]
  try {
    for (const t of targets.filter((x) => !onlyIds || onlyIds.includes(x.id))) {
      const notes: string[] = []
      const probe = await t.probe.detect()
      if (!probe.installed || !probe.flagsOk) {
        rows.push({ id: t.id, result: 'skipped', notes: ['not installed (or flags missing)'] })
        continue
      }
      if (probe.auth === 'needed') {
        rows.push({ id: t.id, result: 'skipped', notes: ['not logged in'] })
        continue
      }
      const c = HARNESS_CASES[t.id]
      const cwd = mkdtempSync(join(root, `work-${t.id}-`))
      c.setup(cwd)
      process.stdout.write(`verifying harness with ${t.id}…\n`)
      let agentId: string | undefined
      let result: HarnessRow['result'] = 'fail'
      try {
        // One project per provider, with a single published, attached harness (a user action in the app).
        const project = await projects.catalog.create({ name: `Harness ${t.id}`, folders: [] })
        const h = await projects.harness.create({
          name: 'Verify harness',
          launchPolicy: 'advisory',
          rules: [
            {
              name: c.ruleName,
              text: c.ruleText,
              category: 'security',
              enforcement: 'runtime-policy',
              severity: 'required',
              policy: c.policy,
            },
          ],
          gates: [],
        })
        await projects.harness.publish(h.id)
        await projects.harness.attach(project.id, h.id)
        agentId = await withTimeout(
          office.sessions!.start({
            ...(t.id === 'codex' ? { provider: 'codex' as const } : {}),
            ...(t.modeId ? { modeId: t.modeId } : {}),
            projectId: project.id,
            cwd,
            name: `verify-harness-${t.id}`,
            mode: 'default',
            extraDirs: [],
            chrome: false,
            first: { text: c.prompt, context: [], use: [] },
          }),
        )
        const id = agentId
        const seen = new Set<string>()
        const deadline = Date.now() + STEP_MS
        let replied = false
        while (Date.now() < deadline && !replied) {
          // Anything the harness did not stop reaches the approver: deny it, and say so.
          for (const req of office.sessions!.pending(id)) {
            if (seen.has(req.id)) continue
            seen.add(req.id)
            notes.push(`reached the approver (harness did not stop it): ${req.tool}`)
            office.sessions!.answer(id, req.id, 'deny')
          }
          replied = office.chat.history(id).some((m) => m.from === 'agent')
          if (!replied) await new Promise((ok) => setTimeout(ok, 250))
        }
        const inspection = projects.policy.inspect(id)
        const denied = inspection.events.filter((e) => e.kind === 'action-denied')
        const intact = c.intact(cwd)
        notes.push(
          `replied=${replied} intact=${intact} denied=${denied.length} allowed=${inspection.counts.allowed} asked=${inspection.counts.asked}`,
        )
        result = replied && intact && denied.length > 0 ? 'pass' : 'fail'
      } catch (e) {
        const msg = (e as Error).message
        notes.push(`error: ${msg}`)
        if (/auth/i.test(msg)) result = 'skipped'
      } finally {
        if (agentId) await office.sessions!.stop(agentId).catch(() => {})
      }
      rows.push({ id: t.id, result, notes })
    }
  } finally {
    await office.sessions!.stopAll().catch(() => {})
    await projects.store.flush().catch(() => {})
    scheduler.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  return rows
}

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    json: { type: 'boolean' },
    'mcp-only': { type: 'boolean' },
    'skip-mcp': { type: 'boolean' },
    harness: { type: 'boolean' },
    'harness-only': { type: 'boolean' },
  },
})
const only = values.only?.split(',')
const wantHarness = !!(values.harness || values['harness-only'])
if (wantHarness && process.env.CI) {
  console.error('The harness check uses real accounts and tokens: it never runs when CI is set.')
  process.exit(2)
}
const rows: (Record<string, unknown> & { id: string })[] = []
const skipTargets = values['mcp-only'] || values['harness-only']
for (const t of skipTargets ? [] : TARGETS.filter((x) => !only || only.includes(x.id))) {
  process.stdout.write(`verifying ${t.id}…\n`)
  rows.push({ id: t.id, ...(await verify(t)) })
}
const mcpRows = values['skip-mcp'] || values['harness-only'] ? [] : await verifyMcp(only)
const harnessRows = wantHarness ? await verifyHarness(only) : []
if (values.json) console.log(JSON.stringify(rows, null, 2))
else {
  console.log(['provider', ...CHECKS].join('\t'))
  for (const row of rows) {
    console.log([row.id, ...CHECKS.map((c) => row[c])].join('\t'))
    for (const n of row.notes as string[]) console.log(`  · ${n}`)
  }
  if (mcpRows.length) {
    console.log('\nproject MCP\tresult')
    for (const row of mcpRows) {
      console.log(`${row.id}\t${row.result}`)
      for (const n of row.notes) console.log(`  · ${n}`)
    }
  }
  if (harnessRows.length) {
    console.log('\nharness\tresult')
    for (const row of harnessRows) {
      console.log(`${row.id}\t${row.result}`)
      for (const n of row.notes) console.log(`  · ${n}`)
    }
  }
}
if (values.json && mcpRows.length) console.log(JSON.stringify({ projectMcp: mcpRows }, null, 2))
if (values.json && harnessRows.length)
  console.log(JSON.stringify({ harness: harnessRows }, null, 2))
process.exit(
  rows.some((row) => CHECKS.some((c) => row[c] === 'fail')) ||
    mcpRows.some((r) => r.result === 'fail') ||
    harnessRows.some((r) => r.result === 'fail')
    ? 1
    : 0,
)
