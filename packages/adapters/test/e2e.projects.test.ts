// The projects-first workspace end to end (docs/projects.md): real core + the encrypted FileRecordLog
// (test key) + TextIndex + the real HTTP server with its /mcp route + the real MCP launcher/bridge, with
// the real CodexRunner talking to the fake app-server (which acts as an MCP client for `/mcp <query>`),
// and a FakeAgentRunner standing in for Claude Code. No real CLI, keychain or user directory is touched.
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOffice, type HistorySource } from '@agent-office/core'
import {
  FakeAgentRunner,
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
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { GitRepoIdentity, loadOrCreateWorkspaceSalt } from '../src/git/index.ts'
import { createAuth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import { observeWorkspace } from '../src/http/workspace-observer.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { McpLauncher } from '../src/mcp/mcp-launcher.ts'
import { CodexRunner } from '../src/providers/index.ts'
import {
  ClaudeHistorySource,
  NodeTranscriptFiles,
  TranscriptRefs,
} from '../src/sources/claude-code/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { FileRecordLog, TestKeyProvider, TextIndex } from '../src/vault/index.ts'
import { TOKEN } from './helpers.ts'
import { randomBytes } from 'node:crypto'

const BRIDGE = join(import.meta.dirname, '..', '..', '..', 'hooks', 'agent-office-mcp.mjs')
const FAKE_CODEX = join(import.meta.dirname, 'fakes', 'fake-codex-app-server.mjs')

const root = mkdtempSync(join(tmpdir(), 'ao-e2e-prj-'))
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

/** Every byte under a directory, concatenated (to prove nothing readable is on disk). */
function allBytes(dir: string): Buffer {
  const parts: Buffer[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    parts.push(statSync(p).isDirectory() ? allBytes(p) : readFileSync(p))
  }
  return Buffer.concat(parts)
}

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

const SENTINEL = 'ZEBRAFISH-CANARY'
const APPROVED_TITLE = `Deploys use make release ${SENTINEL}`
const PENDING_TITLE = 'Deploy pending idea'
const OTHER_TITLE = 'Deploy runbook of another project'

/** One app run over a vault directory: real core + real API (with /mcp) + launcher + two runtimes. */
async function boot(vaultDir: string, home: string, userData: string, history?: HistorySource) {
  const scheduler = new TimerScheduler()
  const claude = new FakeAgentRunner()
  const codex = new CodexRunner({
    bin: process.execPath,
    args: [FAKE_CODEX],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  let base = ''
  const launcher = new McpLauncher({
    userData,
    execPath: process.execPath,
    script: BRIDGE,
    platform: process.platform,
    runAsNode: false,
    url: () => base,
  })
  const vault = new FileRecordLog({
    dir: vaultDir,
    keys: new TestKeyProvider({ master: 'e2e-projects' }),
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
    runner: claude,
    providers: [{ provider: 'codex', runner: codex }],
    runtimes: new Map([['codex', codex]]),
    vault,
    repoIdentity: new GitRepoIdentity({ salt: loadOrCreateWorkspaceSalt(home) }),
    ...(history ? { history } : {}),
    searchIndex: new TextIndex(),
    random: { token: (n) => randomBytes(n).toString('hex') },
    mcpLaunch: (token) => launcher.launch(token),
  })
  const projects = office.projects!
  await office.providers.setEnabled('codex', true)
  // Before IPC/MCP are served.
  await projects.load()

  let auth = createAuth({ token: TOKEN, port: 0 })
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
      token: TOKEN,
      hostAllowed: (h) => auth.hostAllowed(h),
      originAllowed: (x) => auth.originAllowed(x),
      bearerOk: (h) => auth.bearerOk(h),
      tokenOk: (t) => auth.tokenOk(t),
    },
  )
  const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
  auth = createAuth({ token: TOKEN, port: server.port })
  base = `http://127.0.0.1:${server.port}`
  await launcher.ensureInstalled()

  const close = async () => {
    await office.sessions!.stopAll()
    projects.mcp.revokeAll()
    await projects.store.flush()
    await server.close()
    scheduler.dispose()
  }
  return { office, projects, claude, base, close }
}

describe('projects end to end', () => {
  it('P1 project → managed Claude session → memory → Codex retrieves it over MCP → restart', async () => {
    const dir = mkdtempSync(join(root, 'run-'))
    const home = join(dir, 'home')
    const userData = join(dir, 'userData')
    const vaultDir = join(userData, 'vault')
    mkdirSync(home, { recursive: true })
    // A real (tiny) git repository the project links to.
    const repo = join(dir, 'shop-api')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')

    const a = await boot(vaultDir, home, userData)
    let closed = false
    cleanup.push(async () => {
      if (!closed) await a.close()
    })

    // The user creates a project linked to the repository; its default policy lets enabled providers read.
    const project = await a.projects.catalog.create({ name: 'Shop', folders: [repo] })
    expect(project.repos).toHaveLength(1)
    expect(project.repos[0]!.label).toBe('shop-api')
    const repoRef = project.repos[0]!.id
    const cwd = a.projects.repos.repoPath(project.id, repoRef)
    expect(cwd).toBeTruthy()

    // A managed Claude session starts inside the project: it is associated and gets an MCP token.
    const claudeId = await a.office.sessions!.start({
      projectId: project.id,
      cwd: cwd!,
      name: 'claude-shop',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: 'Plan the release', context: [], use: [] },
    })
    expect(claudeId).toMatch(/^cc:/)
    expect(a.claude.last().options.mcp?.env.AGENT_OFFICE_MCP_TOKEN).toMatch(/^mcp_/)
    const inProject = a.projects.sessions.list({ scope: project.id })
    expect(inProject).toHaveLength(1)
    expect(inProject[0]).toMatchObject({
      origin: 'managed',
      provider: 'claude-code',
      state: 'active',
    })

    // It ends: the record stays (inactive/archived), the live agent is gone.
    await a.office.sessions!.stop(claudeId)
    const ended = await until(() => {
      const s = a.projects.sessions.list({ scope: project.id })[0]
      return s && s.state !== 'active' ? s : undefined
    })
    expect(['inactive', 'archived']).toContain(ended.state)

    // The user writes a memory and approves it; a second one stays pending; another project has its own.
    const approved = await a.projects.memory.create({
      projectId: project.id,
      scope: 'project',
      kind: 'decision',
      title: APPROVED_TITLE,
      body: 'Run make release; never deploy by hand.',
    })
    // The user's own items are approved at once; nothing to review.
    expect(approved.state).toBe('approved')
    // An agent's proposal stays pending until the user reviews it.
    const pending = await a.projects.memory.propose(
      {
        kind: 'mcp',
        projectId: project.id,
        sessionId: 'ses_proposer0001',
        provider: 'claude-code',
        tokenId: 'tok_proposer0001',
        access: 'read-propose',
      },
      { kind: 'note', title: PENDING_TITLE, body: 'Maybe deploy on Fridays.' },
    )
    expect(pending.state).toBe('pending')
    const other = await a.projects.catalog.create({ name: 'Other', folders: [] })
    const foreign = await a.projects.memory.create({
      projectId: other.id,
      scope: 'project',
      kind: 'decision',
      title: OTHER_TITLE,
      body: 'Deploy with the other pipeline.',
    })
    expect(foreign.state).toBe('approved')

    // A Codex session on the SAME project; its prompt makes the fake app-server call search_memory
    // through the real stdio bridge and HTTP route, authorized as that session's principal.
    const codexId = await a.office.sessions!.start({
      provider: 'codex',
      modeId: 'ask',
      projectId: project.id,
      cwd: cwd!,
      name: 'codex-shop',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: '/mcp deploy', context: [], use: [] },
    })
    expect(codexId).toMatch(/^cx:/)
    // Codex asks before calling an MCP tool (mcpServer/elicitation/request): the user allows it once.
    const card = await until(() => a.office.sessions!.pending(codexId)[0])
    a.office.sessions!.answer(codexId, card.id, 'allow')
    const reply = await until(() =>
      a.office.chat.history(codexId).find((m) => m.from === 'agent' && m.text.startsWith('mcp:')),
    )
    expect(reply.text).toContain(APPROVED_TITLE)
    // Other projects' and pending items are never returned.
    expect(reply.text).not.toContain(OTHER_TITLE)
    expect(reply.text).not.toContain(PENDING_TITLE)

    // The retrieval is recorded and visible to the user (Context Inspector).
    const inspection = a.projects.context.inspect(codexId)
    expect(inspection.projectId).toBe(project.id)
    expect(inspection.available).toBe(1)
    expect(inspection.retrieved.length).toBeGreaterThan(0)
    expect(inspection.retrieved[0]!.memoryIds).toEqual([approved.id])

    // The workspace key of an observe hook locates an agent but never reaches the Agent DTO.
    const wk = 'wk_' + 'd'.repeat(32)
    const res = await fetch(`${a.base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentId: 'cur:1', provider: 'cursor', status: 'idle', workspace: wk }),
    })
    expect(res.status).toBe(202)
    expect(JSON.stringify(a.office.query.snapshot())).not.toContain(wk)
    expect(JSON.stringify(a.office.query.agents())).not.toContain(wk)

    // ── restart: close everything, build a NEW office over the SAME vault directory ──
    await a.close()
    closed = true

    const b = await boot(vaultDir, home, userData)
    cleanup.push(() => b.close())
    expect(
      b.projects.catalog
        .list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Other', 'Shop'])
    const sessions = b.projects.sessions.list({ scope: project.id })
    expect(sessions.map((s) => s.provider).sort()).toEqual(['claude-code', 'codex'])
    expect(sessions.every((s) => s.state !== 'active')).toBe(true)
    const memories = b.projects.memory.list({ scope: project.id, states: ['approved'] })
    expect(memories.map((m) => m.title)).toEqual([APPROVED_TITLE])
    const dash = b.projects.workspace.dashboard(project.id)
    expect(dash.activity.length).toBeGreaterThan(0)
    expect(dash.activity.some((e) => e.kind === 'mcp.retrieval')).toBe(true)
    expect(b.projects.workspace.overview().vault).toBe('encrypted')
    // The repository link survived: a new session can still resolve its directory.
    expect(b.projects.repos.repoPath(project.id, repoRef)).toBe(cwd)

    // Nothing readable is on disk: no memory text, no repo path, no project name.
    await b.projects.store.flush()
    const bytes = allBytes(vaultDir).toString('latin1')
    expect(bytes).not.toContain(SENTINEL)
    expect(bytes).not.toContain('make release')
    expect(bytes).not.toContain('shop-api')
    expect(bytes).not.toContain('Shop')
  })

  it('P2 experimental: import Claude history → assigned by repo → resume natively; tasks with evidence; restart', async () => {
    const dir = mkdtempSync(join(root, 'run-'))
    const home = join(dir, 'home')
    const userData = join(dir, 'userData')
    const vaultDir = join(userData, 'vault')
    mkdirSync(home, { recursive: true })
    const repo = join(dir, 'shop-api')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    // A past Claude Code session in that repository (invented content, an old file).
    const projectsDir = join(dir, 'claude', 'projects')
    mkdirSync(join(projectsDir, '-shop'), { recursive: true })
    const file = join(projectsDir, '-shop', 'past-sess-1.jsonl')
    writeFileSync(
      file,
      [
        {
          type: 'user',
          sessionId: 'past-sess-1',
          cwd: repo,
          timestamp: '2026-01-02T10:00:00.000Z',
          message: { role: 'user', content: `${SENTINEL} secret prompt` },
        },
        { type: 'ai-title', sessionId: 'past-sess-1', aiTitle: 'Tidy the release script' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    )
    const old = new Date(Date.now() - 5 * 86_400_000)
    utimesSync(file, old, old)
    const history = new ClaudeHistorySource({
      dir: projectsDir,
      files: new NodeTranscriptFiles(),
      refs: new TranscriptRefs(),
    })

    const a = await boot(vaultDir, home, userData, history)
    let closed = false
    cleanup.push(async () => {
      if (!closed) await a.close()
    })
    const project = await a.projects.catalog.create({ name: 'Shop', folders: [repo] })

    // The import registers a reference only and the repo link assigns it, like an observed session.
    expect(await a.projects.history.importHistory({ limit: 50 })).toEqual({
      imported: 1,
      skipped: 0,
    })
    expect(await a.projects.history.importHistory({ limit: 50 })).toEqual({
      imported: 0,
      skipped: 1,
    })
    const [rec] = a.projects.sessions.list({ scope: project.id })
    expect(rec).toMatchObject({
      origin: 'imported',
      title: 'Tidy the release script',
      state: 'inactive',
      canResume: true,
      hasTranscript: true,
    })

    // The user continues it natively: the Claude runner receives the provider session id and folder.
    const { agentId } = await a.projects.history.resume(rec!.id)
    expect(a.claude.last().options).toMatchObject({ resume: 'past-sess-1', cwd: repo })
    expect(a.projects.sessions.list({ scope: project.id }).some((s) => s.agentId === agentId)).toBe(
      true,
    )
    await a.office.sessions!.stop(agentId)

    // Tasks: create, move, confirm; the dashboard shows them with the strongest evidence.
    const task = await a.projects.tasks.create(project.id, 'Tidy the release script')
    await a.projects.tasks.setState(task.id, 'done')
    await a.projects.tasks.addEvidence(task.id, { level: 'user-confirmed' })
    expect(a.projects.workspace.dashboard(project.id).completed[0]).toMatchObject({
      title: 'Tidy the release script',
      evidence: 'user-confirmed',
    })

    await a.close()
    closed = true
    const b = await boot(vaultDir, home, userData, history)
    cleanup.push(() => b.close())
    expect(b.projects.tasks.list(project.id).map((t) => t.state)).toEqual(['done'])
    expect(
      b.projects.sessions.list({ scope: project.id }).some((s) => s.origin === 'imported'),
    ).toBe(true)
    // Only a reference was kept: neither the prompt nor the repo path is in the vault.
    await b.projects.store.flush()
    const bytes = allBytes(vaultDir).toString('latin1')
    expect(bytes).not.toContain(SENTINEL)
    expect(bytes).not.toContain('secret prompt')
  })
})
