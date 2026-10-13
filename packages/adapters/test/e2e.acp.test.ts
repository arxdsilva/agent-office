// ACP managed sessions end to end: real core + real HTTP server, with the real AcpRunner (Cursor and
// Gemini profiles, plus a parameterized case per open-source runtime: OpenCode, goose, Kilo, Qwen,
// Cline, OpenHands) talking JSON-RPC 2.0 to the fake ACP agent (a child process run by node).
// Nothing here touches the real `agent`, `gemini`, `copilot`, `opencode`, `goose`, `kilo`, `qwen`,
// `cline` or `openhands` CLIs.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOffice, PROVIDER_DECLS, type AgentRunner } from '@agent-office/core'
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
import type { Agent, ChatMessage, ProviderId } from '@agent-office/shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { McpLauncher } from '../src/mcp/mcp-launcher.ts'
import {
  AcpRunner,
  ClineAcpRunner,
  CursorAcpRunner,
  GeminiAcpRunner,
  GooseAcpRunner,
  KiloAcpRunner,
  OpenCodeAcpRunner,
  OpenHandsAcpRunner,
  QwenAcpRunner,
} from '../src/providers/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { fakeMcpAccess, GOOD_TOKEN } from './fakes/fake-mcp-access.ts'
import { is, observe, TOKEN } from './helpers.ts'
import { makeOffice } from './support.ts'

const FAKE = join(import.meta.dirname, 'fakes', 'fake-acp-agent.mjs')

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls until `fn` returns a truthy value (the fake child answers asynchronously). */
async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await wait(20)
  }
}

/** Live fake agent processes of one profile (matched by script path and profile argument). */
function fakeProcs(profile: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', `${FAKE} --profile ${profile}`], { encoding: 'utf8' })
    return out.split('\n').filter(Boolean).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

/** The open-source runtimes run through their real profile; each gets its own fake agent profile. */
const OSS = {
  opencode: OpenCodeAcpRunner,
  goose: GooseAcpRunner,
  kilo: KiloAcpRunner,
  qwen: QwenAcpRunner,
  cline: ClineAcpRunner,
  openhands: OpenHandsAcpRunner,
} as const
type OssId = keyof typeof OSS

async function startServer(oss: OssId[] = []) {
  const scheduler = new TimerScheduler()
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  const cursor = new CursorAcpRunner({
    bin: process.execPath,
    args: [FAKE, '--profile', 'cursor'],
    // The real Cursor agent needs `authenticate {cursor_login}` before its first session.
    env: { ...env, FAKE_ACP_AUTH: 'required', FAKE_ACP_SESSION: 'cur-1' },
  })
  const gemini = new GeminiAcpRunner({
    bin: process.execPath,
    args: [FAKE, '--profile', 'gemini'],
    env: { ...env, FAKE_ACP_SESSION: 'gem-1' },
  })
  const ossRunners = oss.map(
    (id) =>
      [
        id,
        new OSS[id]({
          bin: process.execPath,
          args: [FAKE, '--profile', id],
          env: { ...env, FAKE_ACP_SESSION: `${id}-1` },
        }),
      ] as [ProviderId, AgentRunner],
  )
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
    providers: [
      { provider: 'cursor', runner: cursor },
      { provider: 'gemini', runner: gemini },
      ...ossRunners.map(([provider, runner]) => ({ provider, runner })),
    ],
    runtimes: new Map<ProviderId, AgentRunner>([
      ['cursor', cursor],
      ['gemini', gemini],
      ...ossRunners,
    ]),
  })
  // New providers start disabled; the user turns them on in Connect.
  await office.providers.setEnabled('cursor', true)
  await office.providers.setEnabled('gemini', true)
  for (const id of oss) await office.providers.setEnabled(id, true)
  let auth = createAuth({ token: TOKEN, port: 0 })
  const app = buildHttpApi(
    {
      activity: office.activity,
      inbox: office.inbox,
      chat: office.chat,
      query: office.query,
      capabilities: office.capabilities,
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
  const url = `http://127.0.0.1:${server.port}`
  const api = async <T>(path: string): Promise<T> =>
    (
      await fetch(url + path, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json() as Promise<T>
  cleanup.push(async () => {
    await office.sessions!.stopAll()
    await server.close()
    scheduler.dispose()
  })
  const ui = observe(office)
  cleanup.push(ui.stop)
  const start = (provider: 'cursor' | 'gemini' | OssId, text = 'List the files') =>
    office.sessions!.start({
      provider,
      cwd: tmpdir(),
      name: `${provider}-demo`,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text, context: [], use: [] },
    })
  const say = (agentId: string, text: string) =>
    office.compose.send(agentId, { text, context: [], use: [] })
  const agent = (id: string) => office.query.agent(id)
  const replies = (id: string) => office.chat.history(id).filter((m) => m.from === 'agent')
  return { office, api, ui, start, say, agent, replies }
}

describe('ACP managed sessions (E2E)', () => {
  it('A1 start → events → allow → reply → deny → interrupt → stop leaves no process', async () => {
    const before = fakeProcs('cursor')
    const { office, api, ui, start, say, agent, replies } = await startServer()
    const sessions = office.sessions!

    // Start a Cursor session: the runner authenticates with the existing login and gets `cur-1`.
    const agentId = await start('cursor')
    expect(agentId).toBe('cu:cur-1')

    // External clients see a managed Cursor agent with its modes and capabilities.
    const listed = await api<Agent[]>('/api/agents')
    const mine = listed.find((a) => a.id === agentId)!
    expect(mine).toMatchObject({ provider: 'cursor', source: 'managed', modeId: 'agent' })
    expect(mine.caps).toEqual(expect.arrayContaining(['send-message', 'approve-tools']))

    // The default scenario runs a command: tool activity, then a Bash permission card.
    const perm = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    expect(perm.requests[0]!.tool).toBe('Bash')
    expect(perm.requests[0]!.summary).toBe('ls -la /Users/secret/project')
    // The agent bubble never shows the tool title, thoughts or plan.
    expect(JSON.stringify(agent(agentId))).not.toMatch(/secret thought|secret plan|Run ls/)

    // Allow once: the turn finishes and the final message lands in the chat as a reply.
    sessions.answer(agentId, perm.requests[0]!.id, 'allow')
    await until(() => replies(agentId).length === 1)
    expect(replies(agentId)[0]!.text).toBe('Here are the files.')
    const http = await api<ChatMessage[]>(`/api/agents/${encodeURIComponent(agentId)}/messages`)
    expect(http.some((m) => m.from === 'agent' && m.state === 'replied')).toBe(true)
    await until(() => agent(agentId)?.status === 'waiting')

    // Same scenario again, denied: the agent reports it was not allowed.
    await say(agentId, 'List them again')
    const again = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    sessions.answer(agentId, again.requests[0]!.id, 'deny')
    await until(() => replies(agentId).length === 2)
    expect(replies(agentId)[1]!.text).toBe('I was not allowed to run it.')

    // A turn that never ends ("/slow"), then Interrupt: session/cancel, the agent goes idle.
    await say(agentId, '/slow')
    await until(() => agent(agentId)?.status === 'thinking')
    await sessions.interrupt(agentId)
    await until(() => ['idle', 'waiting'].includes(agent(agentId)?.status ?? ''))

    // Change mode to Plan through the session header (session/set_mode on the wire).
    await sessions.setModeId(agentId, 'plan')
    expect(agent(agentId)?.modeId).toBe('plan')

    // Stop: the session ends and the agent process is gone.
    expect(fakeProcs('cursor')).toBeGreaterThan(before)
    await sessions.stop(agentId)
    await until(() => fakeProcs('cursor') === before)
    expect(agent(agentId)).toMatchObject({ managed: { phase: 'ended' } })
  })

  it('A2 two providers at once; killing one leaves the other working', async () => {
    const { office, ui, start, say, agent, replies } = await startServer()

    // A Cursor and a Gemini session side by side, each in its own process.
    const cu = await start('cursor', '/quick hello')
    const gm = await start('gemini', '/quick hello')
    expect([cu, gm]).toEqual(['cu:cur-1', 'gm:gem-1'])
    expect(agent(gm)).toMatchObject({ provider: 'gemini', modeId: 'default' })
    await until(() => replies(cu).length === 1 && replies(gm).length === 1)

    // Cursor's agent crashes mid-turn: only its session ends.
    await say(cu, '/crash')
    await until(() => agent(cu)?.managed?.phase === 'ended')
    await until(() => fakeProcs('cursor') === 0)

    // Gemini still runs a full turn with a permission round-trip.
    await say(gm, 'List the files')
    const perm = await ui.next(is('permission', (m) => m.agentId === gm && m.requests.length === 1))
    office.sessions!.answer(gm, perm.requests[0]!.id, 'allow')
    await until(() => replies(gm).length === 2)
    expect(replies(gm)[1]!.text).toBe('Here are the files.')
    expect(agent(gm)?.managed?.phase).toBe('running')
  })
})

// One parameterized case per open-source runtime: the same lifecycle through its real profile.
describe.each(Object.keys(OSS) as OssId[])('%s ACP runtime (E2E)', (id) => {
  const prefix = PROVIDER_DECLS[id].prefix

  it('start → permission card → allow → reply → stop; nothing secret reaches the views', async () => {
    const before = fakeProcs(id)
    const { office, api, ui, start, agent, replies } = await startServer([id])
    const sessions = office.sessions!

    // Start a session on the runtime's real profile; the fake agent answers with `<id>-1`.
    const agentId = await start(id)
    expect(agentId).toBe(`${prefix}${id}-1`)

    // External clients see a managed agent of this provider with its declared caps.
    const mine = (await api<Agent[]>('/api/agents')).find((a) => a.id === agentId)!
    expect(mine).toMatchObject({ provider: id, source: 'managed' })
    expect(mine.caps).toEqual(expect.arrayContaining(['send-message', 'approve-tools']))

    // The default scenario runs a command: a Bash permission card with a short summary only.
    const perm = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    expect(perm.requests[0]!.tool).toBe('Bash')
    expect(perm.requests[0]!.summary).toBe('ls -la /Users/secret/project')
    expect(JSON.stringify(agent(agentId))).not.toMatch(/secret thought|secret plan|Run ls/)

    // Allow once: the final message lands in the chat as the agent's reply.
    sessions.answer(agentId, perm.requests[0]!.id, 'allow')
    await until(() => replies(agentId).length === 1)
    expect(replies(agentId)[0]!.text).toBe('Here are the files.')
    const http = await api<ChatMessage[]>(`/api/agents/${encodeURIComponent(agentId)}/messages`)
    expect(http.some((m) => m.from === 'agent' && m.state === 'replied')).toBe(true)
    // No raw thought, plan, command or path anywhere an external client can read.
    expect(JSON.stringify(await api<Agent[]>('/api/agents'))).not.toMatch(/secret|\/Users\//)

    // Stop: the session ends and its process is gone.
    expect(fakeProcs(id)).toBeGreaterThan(before)
    await sessions.stop(agentId)
    await until(() => fakeProcs(id) === before)
    expect(agent(agentId)).toMatchObject({ managed: { phase: 'ended' } })
  })

  it('is enabled in Connect and offers modes with a safe default', async () => {
    const { office } = await startServer([id])
    const runner = (await office.providers.list()).find((p) => p.id === id)!
    expect(runner.enabled).toBe(true)
    const decl = new OSS[id]().decl
    expect(decl.modes!.length).toBeGreaterThan(1)
    expect(decl.modes![0]!.dangerous).toBeFalsy()
  })
})

// The project MCP bridge through each real profile: session/new carries the stdio server, the fake
// agent calls search_memory through the real wrapper, and approved project memory comes back.
describe.each(Object.keys(OSS) as OssId[])('%s retrieves project memory over MCP (E2E)', (id) => {
  const dir = mkdtempSync(join(tmpdir(), `ao-e2e-acp-mcp-${id}-`))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const BRIDGE = join(import.meta.dirname, '..', '..', '..', 'hooks', 'agent-office-mcp.mjs')
  const API_TOKEN = 'f'.repeat(64)

  async function mcpLauncher() {
    const { office, scheduler } = makeOffice()
    const access = fakeMcpAccess()
    let current = createAuth({ token: API_TOKEN, port: 0 })
    const auth = {
      token: API_TOKEN,
      hostAllowed: (h: string | undefined) => current.hostAllowed(h),
      originAllowed: (o: string | undefined) => current.originAllowed(o),
      bearerOk: (h: string | undefined) => current.bearerOk(h),
      tokenOk: (t: string | undefined) => current.tokenOk(t),
    }
    const app = buildHttpApi(
      {
        activity: office.activity,
        inbox: office.inbox,
        chat: office.chat,
        query: office.query,
        mcp: access,
      },
      auth,
    )
    const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
    current = createAuth({ token: API_TOKEN, port: server.port })
    cleanup.push(
      () => server.close(),
      () => scheduler.dispose(),
    )
    const launcher = new McpLauncher({
      userData: mkdtempSync(join(dir, 'ud-')),
      execPath: process.execPath,
      script: BRIDGE,
      platform: process.platform,
      runAsNode: false,
      url: () => `http://127.0.0.1:${server.port}`,
    })
    await launcher.ensureInstalled()
    return { launcher, access }
  }

  const ask = async (
    runner: AcpRunner,
    mcp: ReturnType<McpLauncher['launch']> | undefined,
    q: string,
  ) => {
    const s = runner.start({
      cwd: dir,
      mode: 'default',
      extraDirs: [],
      chrome: false,
      allowBypass: false,
      ...(mcp ? { mcp } : {}),
    })
    cleanup.push(() => s.close())
    s.onPermission(async () => ({ behavior: 'allow' }))
    const result = new Promise<string>((resolve) => s.onResult((r) => resolve(r.text)))
    await s.sessionId
    s.push(q)
    return result
  }
  const runner = () =>
    new OSS[id]({ bin: process.execPath, args: [FAKE, '--profile', id], env: {} })

  it('finds the approved memory through the bridge, none when nothing matches', async () => {
    const { launcher, access } = await mcpLauncher()
    expect(await ask(runner(), launcher.launch(GOOD_TOKEN), '/mcp pnpm')).toBe(
      'mcp: Use pnpm, not npm',
    )
    expect(access.calls).toMatchObject([{ tool: 'search_memory', args: { query: 'pnpm' } }])
    expect(await ask(runner(), launcher.launch(GOOD_TOKEN), '/mcp kubernetes')).toBe('mcp: none')
  })

  it('a revoked token, or a session without MCP, finds nothing', async () => {
    const { launcher, access } = await mcpLauncher()
    access.revoke()
    expect(await ask(runner(), launcher.launch(GOOD_TOKEN), '/mcp pnpm')).toBe('mcp: unavailable')
    expect(await ask(runner(), undefined, '/mcp pnpm')).toBe('mcp: unavailable')
  })
})
