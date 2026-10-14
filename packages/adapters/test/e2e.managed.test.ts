// Managed sessions end to end: real core + real HTTP server, with a scripted runner standing in for
// the Agent SDK. The HTTP API is how external tools (and the hook) see the office.
import { createOffice, type AgentRunner } from '@agent-office/core'
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
import { ScriptedAgentRunner } from '../src/agents/fake-runner.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { is, observe, TOKEN } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

/** `scripted`: a runtime to use instead of the FakeAgentRunner (e.g. the app specs' ScriptedAgentRunner). */
async function startManagedServer(scripted?: AgentRunner) {
  const scheduler = new TimerScheduler()
  const runner = new FakeAgentRunner()
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
    runner: scripted ?? runner,
  })
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
      originAllowed: (o) => auth.originAllowed(o),
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
  return { office, runner, api }
}

describe('managed sessions (E2E)', () => {
  it('M1 start → message with context → permission → reply → stop', async () => {
    const { office, runner, api } = await startManagedServer()
    const ui = observe(office)
    cleanup.push(ui.stop)
    const sessions = office.sessions!

    // Start a session in a folder; the scripted runtime reports session id sess-1.
    const agentId = await sessions.start({
      cwd: '/home/dev/code/shop-api',
      name: 'shop-api',
      model: 'sonnet',
      mode: 'plan',
      extraDirs: [],
      chrome: false,
      first: { text: 'Plan the logout flow', context: [], use: [] },
    })
    expect(agentId).toBe('cc:sess-1')
    const session = runner.last()

    // External clients see a managed claude-code agent through GET /api/agents.
    const agents = await api<Agent[]>('/api/agents')
    expect(agents.find((a) => a.id === agentId)).toMatchObject({
      provider: 'claude-code',
      source: 'managed',
      permissionMode: 'plan',
      managed: { phase: 'running', chrome: false, pending: 0, modelId: 'sonnet' },
    })

    // The UI sends a follow-up with a folder attached: the runner gets the absolute path,
    // the stored message only the chip.
    const sent = await office.compose.send(agentId, {
      text: 'review this folder',
      context: [
        {
          kind: 'folder',
          path: '/home/dev/code/shop-api/src/auth',
          label: 'auth',
          hint: '~/code/shop-api/src/auth',
        },
      ],
      use: [],
    })
    expect(session.prompts.at(-1)).toContain('- folder: /home/dev/code/shop-api/src/auth')
    expect(sent.context).toEqual([
      { kind: 'folder', label: 'auth', hint: '~/code/shop-api/src/auth' },
    ])

    // The agent wants to run a command: the UI receives a permission message and the agent waits.
    const decision = session.ask('Bash', { command: 'pnpm test' })
    const perm = await ui.next(
      is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
    )
    expect(perm.requests[0]).toMatchObject({ tool: 'Bash', summary: 'pnpm test' })
    await ui.next(is('upsert', (m) => m.agent.id === agentId && m.agent.status === 'waiting'))

    // The user allows it once; the run continues and the turn ends with a reply.
    sessions.answer(agentId, perm.requests[0]!.id, 'allow')
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    await ui.next(is('permission', (m) => m.agentId === agentId && m.requests.length === 0))
    session.result('Tests pass.')

    // GET /messages: both user messages (replied, the second with its chip) plus the reply.
    const thread = await api<ChatMessage[]>(`/api/agents/${encodeURIComponent(agentId)}/messages`)
    expect(thread.map((m) => [m.from, m.state, m.text])).toEqual([
      ['user', 'replied', 'Plan the logout flow'],
      ['user', 'replied', 'review this folder'],
      ['agent', 'replied', 'Tests pass.'],
    ])
    expect(JSON.stringify(thread)).not.toContain('/home/dev/code/shop-api/src/auth')

    // Stop: the runner is closed and the agent is done (it leaves through the elevator).
    await sessions.stop(agentId)
    expect(session.closed).toBe(true)
    const after = await api<Agent[]>('/api/agents')
    expect(after.find((a) => a.id === agentId)).toMatchObject({
      status: 'done',
      managed: { phase: 'ended' },
    })
  })

  describe('questions (AskUserQuestion, scripted runtime)', () => {
    const START_ASK = {
      cwd: '/home/dev/code/shop-api',
      name: 'shop-api',
      mode: 'default' as const,
      extraDirs: [],
      chrome: false,
      first: { text: '/ask', context: [], use: [] },
    }

    it('M2 /ask → question card → answer → "chose: Green"; the agent waits while asking', async () => {
      const { office } = await startManagedServer(new ScriptedAgentRunner({ stepMs: 5 }))
      const ui = observe(office)
      cleanup.push(ui.stop)
      const sessions = office.sessions!

      // The first prompt "/ask" makes the scripted runtime ask "Which colour?" (Blue or Green).
      const agentId = await sessions.start(START_ASK)

      // The UI receives a question card (not a plain permission) carrying the bounded question.
      const perm = await ui.next(
        is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
      )
      expect(perm.requests[0]).toMatchObject({
        tool: 'AskUserQuestion',
        summary: 'Which colour?',
        question: {
          prompts: [
            { question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] },
          ],
        },
      })

      // While the card is pending the agent waits for the user and shows the question.
      await ui.next(
        is(
          'upsert',
          (m) =>
            m.agent.id === agentId &&
            m.agent.status === 'waiting' &&
            m.agent.text === 'Asking you a question' &&
            m.agent.question?.prompts[0]?.question === 'Which colour?',
        ),
      )

      // The user picks Green: the runtime gets it as `answers` and replies with the label.
      sessions.answer(agentId, perm.requests[0]!.id, 'allow', { 'Which colour?': 'Green' })
      const reply = await ui.next(
        is('chat', (m) => m.message.agentId === agentId && m.message.from === 'agent'),
      )
      expect(reply.message.text).toBe('chose: Green')

      // Answered: the question is gone from the agent.
      expect(office.query.snapshot().agents.find((a) => a.id === agentId)?.question).toBeUndefined()
    })

    it('M3 "Allow for this session" never applies to a question: the next /ask asks again', async () => {
      const { office } = await startManagedServer(new ScriptedAgentRunner({ stepMs: 5 }))
      const ui = observe(office)
      cleanup.push(ui.stop)
      const sessions = office.sessions!
      const agentId = await sessions.start(START_ASK)

      // First question: answered with allow-session (treated as a plain allow).
      const first = await ui.next(
        is('permission', (m) => m.agentId === agentId && m.requests.length === 1),
      )
      sessions.answer(agentId, first.requests[0]!.id, 'allow-session', { 'Which colour?': 'Blue' })
      const r1 = await ui.next(
        is('chat', (m) => m.message.agentId === agentId && m.message.from === 'agent'),
      )
      expect(r1.message.text).toBe('chose: Blue')

      // A second /ask still raises a card instead of being auto-allowed.
      await office.compose.send(agentId, { text: '/ask', context: [], use: [] })
      const second = await ui.next(
        is(
          'permission',
          (m) =>
            m.agentId === agentId &&
            m.requests.length === 1 &&
            m.requests[0]!.id !== first.requests[0]!.id,
        ),
      )
      expect(second.requests[0]?.question).toBeDefined()

      // Declining it ends the turn with "declined".
      sessions.answer(agentId, second.requests[0]!.id, 'deny')
      const r2 = await ui.next(
        is(
          'chat',
          (m) =>
            m.message.agentId === agentId &&
            m.message.from === 'agent' &&
            m.message.text === 'declined',
        ),
      )
      expect(r2.message.text).toBe('declined')
    })
  })
})
