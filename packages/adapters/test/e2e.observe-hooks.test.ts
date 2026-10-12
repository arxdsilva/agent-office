// Observation hooks end to end: the REAL hooks/agent-office-observe.mjs runs as a child process,
// fed provider-shaped stdin, and posts to a real HTTP server backed by the real core.
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { startServer, TOKEN } from './helpers.ts'

const SCRIPT = fileURLToPath(new URL('../../../hooks/agent-office-observe.mjs', import.meta.url))
const SECRET = 'sk-SENTINEL-e2e-s3cret'
const EMAIL = 'victim@example.com'
const PRIV = '/Users/victim/private'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

const tokenFile = join(mkdtempSync(join(tmpdir(), 'ao-obs-e2e-')), 'token')
writeFileSync(tokenFile, TOKEN)

/** Runs the real script the way a provider does: stdin JSON, no stdout expected. */
function hook(provider: string, url: string, input: object, extraEnv: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, '--provider', provider],
      {
        env: {
          ...process.env,
          AGENT_OFFICE_URL: url,
          AGENT_OFFICE_TOKEN_FILE: tokenFile,
          ...extraEnv,
        },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin!.end(JSON.stringify(input))
  })
}

const dirty = {
  text: SECRET,
  prompt: SECRET,
  command: SECRET,
  tool_input: { x: SECRET },
  toolArgs: SECRET,
  user_email: EMAIL,
  transcript_path: `${PRIV}/t.jsonl`,
  transcriptPath: `${PRIV}/t.jsonl`,
}

const FLOWS: Record<string, { id: string; steps: [object, string, string?][] }> = {
  // [stdin, expected status, expected tool]
  cursor: {
    id: 'cu:conv-e2e',
    steps: [
      [{ hook_event_name: 'sessionStart' }, 'idle'],
      [{ hook_event_name: 'postToolUse', tool_name: 'Grep' }, 'tool', 'Grep'],
      [{ hook_event_name: 'stop' }, 'waiting'],
      [{ hook_event_name: 'sessionEnd' }, 'done'],
    ].map(([e, ...r]) => [
      {
        conversation_id: 'conv-e2e',
        model: 'm-1',
        workspace_roots: [`${PRIV}/proj-cu`],
        ...dirty,
        ...(e as object),
      },
      ...r,
    ]) as [object, string, string?][],
  },
  gemini: {
    id: 'gm:sess-e2e',
    steps: [
      [{ hook_event_name: 'SessionStart' }, 'idle'],
      [{ hook_event_name: 'AfterTool', tool_name: 'read_file' }, 'tool', 'read_file'],
      [{ hook_event_name: 'AfterAgent' }, 'waiting'],
      [{ hook_event_name: 'SessionEnd' }, 'done'],
    ].map(([e, ...r]) => [
      { session_id: 'sess-e2e', cwd: `${PRIV}/proj-gm`, ...dirty, ...(e as object) },
      ...r,
    ]) as [object, string, string?][],
  },
  copilot: {
    id: 'gh:s-e2e',
    steps: [
      [{ source: 'startup' }, 'idle'],
      [{ toolName: 'bash', toolResult: {} }, 'tool', 'bash'],
      [{ stopReason: 'end_turn' }, 'waiting'],
      [{ reason: 'complete' }, 'done'],
    ].map(([e, ...r]) => [
      { sessionId: 's-e2e', cwd: `${PRIV}/proj-gh`, ...dirty, ...(e as object) },
      ...r,
    ]) as [object, string, string?][],
  },
}

describe('observe hooks (E2E)', () => {
  for (const [provider, flow] of Object.entries(FLOWS)) {
    it(`${provider}: sessionStart → tool → stop → sessionEnd shows the agent with the right status, no leaks`, async () => {
      const srv = await startServer()
      cleanup.push(srv.close)

      for (const [stdin, status, tool] of flow.steps) {
        // The script prints nothing and exits 0 (hook() rejects on a non-zero exit).
        expect(await hook(provider, srv.url, stdin)).toBe('')
        const agent = srv.office.query.agent(flow.id)!
        expect(agent, `${provider} agent after ${JSON.stringify(stdin).slice(0, 60)}`).toBeDefined()
        expect(agent.status).toBe(status)
        if (tool) expect(agent.tool).toBe(tool)
        expect(agent).toMatchObject({ provider, source: 'hook' })
      }

      // Privacy: nothing sensitive reached the core, whatever the payloads carried.
      const all = JSON.stringify(srv.office.query.agent(flow.id))
      for (const bad of [SECRET, EMAIL, PRIV, 'transcript']) expect(all).not.toContain(bad)
      expect(srv.office.query.agent(flow.id)!.name).toMatch(/^proj-/)
    })
  }

  it('copilot subagent shows as a child of the session', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)
    await hook('copilot', srv.url, { sessionId: 's2', cwd: PRIV + '/p', source: 'new' })
    await hook('copilot', srv.url, { sessionId: 's2', cwd: PRIV + '/p', agentName: 'explore' })
    expect(srv.office.query.agent('gh:s2.explore')).toMatchObject({
      parentId: 'gh:s2',
      status: 'thinking',
    })
  })

  it('fails open: server down and wrong token still exit 0 with empty stdout', async () => {
    expect(await hook('cursor', 'http://127.0.0.1:1', FLOWS.cursor!.steps[0]![0])).toBe('')
    const srv = await startServer()
    cleanup.push(srv.close)
    const bad = join(mkdtempSync(join(tmpdir(), 'ao-obs-bad-')), 'token')
    writeFileSync(bad, 'wrong')
    expect(
      await hook('cursor', srv.url, FLOWS.cursor!.steps[0]![0], { AGENT_OFFICE_TOKEN_FILE: bad }),
    ).toBe('')
    expect(srv.office.query.agent('cu:conv-e2e')).toBeUndefined()
  })

  it('de-dup: an event for an id a managed session owns is dropped; AGENT_OFFICE_MANAGED=1 posts nothing', async () => {
    const scheduler = new TimerScheduler()
    const runner = new FakeAgentRunner({
      provider: 'cursor',
      prefix: 'cu:',
      caps: ['send-message'],
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
      runner: new FakeAgentRunner(),
      providers: [{ provider: 'cursor', runner }],
      runtimes: new Map([['cursor', runner]]),
    })
    await office.providers.setEnabled('cursor', true)
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
    cleanup.push(async () => {
      await office.sessions!.stopAll()
      await server.close()
      scheduler.dispose()
    })
    const url = `http://127.0.0.1:${server.port}`

    // agent-office starts a Cursor session itself; it owns the id cu:sess-1.
    const id = await office.sessions!.start({
      provider: 'cursor',
      cwd: tmpdir(),
      name: 'managed',
      mode: 'default',
      extraDirs: [],
      chrome: false,
      first: { text: 'hi', context: [], use: [] },
    })
    expect(id).toBe('cu:sess-1')
    expect(office.query.agent(id)).toMatchObject({ source: 'managed' })

    // Cursor also fires its hooks for that same conversation: the observer's event must be ignored.
    const stdin = {
      conversation_id: 'sess-1',
      hook_event_name: 'postToolUse',
      tool_name: 'Grep',
      workspace_roots: ['/p/x'],
    }
    expect(await hook('cursor', url, stdin)).toBe('')
    expect(office.query.agent(id)).toMatchObject({ source: 'managed' })
    expect(office.query.agent(id)!.tool).not.toBe('Grep')

    // Inside a managed session the script exits before any network call, so another id never appears.
    await hook('cursor', url, { ...stdin, conversation_id: 'other' }, { AGENT_OFFICE_MANAGED: '1' })
    expect(office.query.agent('cu:other')).toBeUndefined()
    // …while outside one the same payload is accepted.
    await hook('cursor', url, { ...stdin, conversation_id: 'other' })
    expect(office.query.agent('cu:other')).toMatchObject({ source: 'hook', tool: 'Grep' })
  })
})
