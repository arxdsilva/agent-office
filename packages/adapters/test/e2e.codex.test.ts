// Codex managed sessions end to end: real core + real HTTP server, with the real CodexRunner talking
// JSON-RPC to the fake app-server (a child process run by node). Nothing here touches the real codex CLI.
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOffice } from '@agent-office/core'
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
import type { Agent, ChatMessage } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { CodexRunner } from '../src/providers/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { is, observe, TOKEN } from './helpers.ts'

const FAKE = join(import.meta.dirname, 'fakes', 'fake-codex-app-server.mjs')

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

/** Live fake app-server processes (matched by script path; only this file spawns it). */
function fakeProcs(): number {
  try {
    const out = execFileSync('pgrep', ['-f', FAKE], { encoding: 'utf8' })
    return out.split('\n').filter(Boolean).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

async function startServer(o: { claude?: FakeAgentRunner; env?: Record<string, string> } = {}) {
  const scheduler = new TimerScheduler()
  const codex = new CodexRunner({
    bin: process.execPath,
    args: [FAKE],
    env: { ELECTRON_RUN_AS_NODE: '1', ...o.env },
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
    ...(o.claude ? { runner: o.claude } : {}),
    providers: [{ provider: 'codex', runner: codex }],
    runtimes: new Map([['codex', codex]]),
  })
  // Codex is off by default; the user turns it on in Settings.
  await office.providers.setEnabled('codex', true)
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
  const startCodex = (text = 'Fix the failing test') =>
    office.sessions!.start({
      provider: 'codex',
      modeId: 'ask',
      cwd: tmpdir(),
      name: 'codex-demo',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text, context: [], use: [] },
    })
  const say = (agentId: string, text: string) =>
    office.compose.send(agentId, { text, context: [], use: [] })
  const agent = (id: string) => office.query.agent(id)
  return { office, api, ui, startCodex, say, agent }
}

describe('codex managed sessions (E2E)', () => {
  it('C1 start → tool activity → permission → allow → reply → interrupt → file edit denied', async () => {
    const { office, api, ui, startCodex, say, agent } = await startServer()
    const sessions = office.sessions!

    // Start a Codex session in "ask" mode; the fake app-server gives it a thread id.
    const agentId = await startCodex()
    expect(agentId).toMatch(/^cx:/)

    // External clients see a managed Codex agent that can receive messages and approvals.
    const listed = await api<Agent[]>('/api/agents')
    const mine = listed.find((a) => a.id === agentId)!
    expect(mine).toMatchObject({ provider: 'codex', source: 'managed' })
    expect(JSON.stringify(mine)).toContain('send-message')
    expect(JSON.stringify(mine)).toContain('approve-tools')

    // The default scenario runs a command: the agent shows tool activity and asks permission.
    const perm = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    expect(perm.requests[0]!.tool).toBe('Bash')
    expect(perm.requests[0]!.summary.length).toBeLessThanOrEqual(120)
    expect(sessions.pending(agentId)).toHaveLength(1)

    // Allowing it once lets the turn finish; the agent's message lands in the chat as a reply.
    sessions.answer(agentId, perm.requests[0]!.id, 'allow')
    await ui.next(is('permission', (m) => m.agentId === agentId && m.requests.length === 0))
    const replies = await until(() => {
      const h = office.chat.history(agentId).filter((m) => m.from === 'agent')
      return h.length ? h : undefined
    })
    expect(replies.at(-1)!.text.length).toBeGreaterThan(0)
    const http = await api<ChatMessage[]>(`/api/agents/${encodeURIComponent(agentId)}/messages`)
    expect(http.some((m) => m.from === 'agent' && m.state === 'replied')).toBe(true)
    await until(() => agent(agentId)?.status === 'waiting')

    // A prompt that never finishes ("/slow"), then Interrupt: the turn is cancelled and the agent goes idle.
    await say(agentId, '/slow')
    await until(() => ['thinking', 'tool'].includes(agent(agentId)?.status ?? ''))
    await sessions.interrupt(agentId)
    await until(() => ['idle', 'waiting'].includes(agent(agentId)?.status ?? ''))

    // "/file" makes the agent want to edit a file: an Edit permission appears and we deny it.
    await say(agentId, '/file')
    const edit = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    expect(edit.requests[0]!.tool).toBe('Edit')
    sessions.answer(agentId, edit.requests[0]!.id, 'deny')
    await ui.next(is('permission', (m) => m.agentId === agentId && m.requests.length === 0))
    expect(sessions.pending(agentId)).toHaveLength(0)
  })

  it('C2 /crash ends the session with the crash exit and the agent leaves', async () => {
    const { office, ui, startCodex, say, agent } = await startServer()
    const agentId = await startCodex()
    const perm = await ui.next(is('permission', (m) => m.agentId === agentId))
    office.sessions!.answer(agentId, perm.requests[0]!.id, 'allow')
    await until(() => agent(agentId)?.status === 'waiting')

    // "/crash" makes the app-server process die mid-turn.
    await say(agentId, '/crash')
    await until(() => agent(agentId)?.managed?.phase === 'ended')
    expect(agent(agentId)?.status === 'done' || agent(agentId)?.status === 'error').toBe(true)
    await until(() => fakeProcs() === 0)
  })

  it('C3 stop leaves no child process behind', async () => {
    const before = fakeProcs()
    const { office, startCodex, ui } = await startServer()
    const agentId = await startCodex()
    await ui.next(is('permission', (m) => m.agentId === agentId))
    expect(fakeProcs()).toBeGreaterThan(before)

    // Stopping the session kills the app-server child.
    await office.sessions!.stop(agentId)
    await until(() => fakeProcs() === before)
    expect(office.query.agent(agentId)).toMatchObject({ managed: { phase: 'ended' } })
  })

  it('C4 a Codex crash does not affect a running Claude session', async () => {
    const claude = new FakeAgentRunner()
    const { office, ui, startCodex, say, agent } = await startServer({ claude })

    // Two sessions of different providers side by side.
    const claudeId = await office.sessions!.start({
      cwd: tmpdir(),
      name: 'claude-demo',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: 'hello', context: [], use: [] },
    })
    const codexId = await startCodex()
    const perm = await ui.next(is('permission', (m) => m.agentId === codexId))
    office.sessions!.answer(codexId, perm.requests[0]!.id, 'allow')
    await until(() => agent(codexId)?.status === 'waiting')

    // Crash Codex: only its session ends.
    await say(codexId, '/crash')
    await until(() => agent(codexId)?.managed?.phase === 'ended')

    // The Claude session still takes a message and answers.
    const session = claude.last()
    await say(claudeId, 'still there?')
    expect(session.prompts.at(-1)).toContain('still there?')
    session.result('Yes.')
    await until(() => office.chat.history(claudeId).some((m) => m.text === 'Yes.'))
    expect(agent(claudeId)?.managed?.phase).toBe('running')
  })
})
