import { PROVIDER_IDS, type ProviderStatus } from '@agent-office/shared'
import type { ProbeResult, ProviderProbe } from '../ports/driven.ts'
import { describe, expect, it } from 'vitest'
import {
  FakeAgentRepository,
  FakeAgentRunner,
  FakeClock,
  FakeProviderProbe,
  FakeSettingsRepository,
  ManualScheduler,
  MemoryLogger,
  RecordingLoginItem,
} from '../../test/fakes/index.ts'
import type { AgentState } from '../domain/agent.ts'
import { FALLBACK_MODELS } from './managed-session-service.ts'
import { ProviderService, type ProviderBinding } from './provider-service.ts'
import { SettingsService } from './settings-service.ts'

const codexRunner = () =>
  new FakeAgentRunner({
    provider: 'codex',
    prefix: 'cx:',
    caps: ['launch', 'send-message'],
    modes: [{ id: 'ask', label: 'Ask' }],
    fallbackModels: [{ id: 'gpt-5', label: 'GPT-5' }],
  })

async function setup(bindings: ProviderBinding[], enabled: string[] = []) {
  const repo = new FakeSettingsRepository()
  const settings = new SettingsService({ repo, loginItem: new RecordingLoginItem() })
  if (enabled.length)
    await settings.update({
      providers: Object.fromEntries(enabled.map((id) => [id, { enabled: true }])),
    })
  const agents = new FakeAgentRepository()
  const clock = new FakeClock()
  const scheduler = new ManualScheduler()
  const log = new MemoryLogger()
  let changes = 0
  const live = new Map<string, { id: string; label: string }[]>()
  const svc = new ProviderService({
    bindings,
    settings,
    agents,
    clock,
    scheduler,
    log,
    onChange: () => changes++,
    liveModels: (p) => live.get(p),
  })
  return { svc, settings, agents, clock, scheduler, log, live, changes: () => changes }
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
const byId = (list: ProviderStatus[], id: string) => list.find((s) => s.id === id)!

describe('ProviderService', () => {
  it('PS-1 isolates probes: one throwing and one hanging never affect the others', async () => {
    const ok = new FakeProviderProbe('codex')
    const boom = new FakeProviderProbe('cursor', undefined, 'throw')
    const hang = new FakeProviderProbe('gemini', undefined, 'hang')
    const t = await setup(
      [
        { provider: 'codex', probe: ok, runner: codexRunner() },
        { provider: 'cursor', probe: boom },
        { provider: 'gemini', probe: hang },
      ],
      ['codex', 'cursor', 'gemini'],
    )
    const p = t.svc.list()
    await tick()
    t.scheduler.fireTimers() // the 3 s timeout
    const list = await p
    expect(list.map((s) => s.id)).toEqual([...PROVIDER_IDS])
    expect(byId(list, 'codex')).toMatchObject({
      state: 'managed-available',
      enabled: true,
      version: '1.0.0',
      testedVersion: '0.162.1',
      managedCaps: expect.arrayContaining(['launch']),
      modes: [{ id: 'ask', label: 'Ask' }],
      integration: { managed: 'app-server' },
    })
    expect(byId(list, 'cursor')).toMatchObject({ state: 'error', hint: 'probe-failed' })
    expect(byId(list, 'gemini')).toMatchObject({ state: 'error', hint: 'probe-timeout' })
    expect(byId(list, 'cursor').managedCaps).toEqual([]) // no runtime wired
    expect(t.log.lines.join('\n')).not.toContain('/secret')
  })

  it('PS-2 caches probes for 30 s; refresh re-probes (one provider or all) and notifies', async () => {
    const probe = new FakeProviderProbe('codex')
    const other = new FakeProviderProbe('cursor')
    const t = await setup(
      [
        { provider: 'codex', probe },
        { provider: 'cursor', probe: other },
      ],
      ['codex', 'cursor'],
    )
    await t.svc.list()
    await t.svc.list()
    expect(probe.calls).toBe(1)
    t.clock.advance(31_000)
    await t.svc.list()
    expect(probe.calls).toBe(2)
    await t.svc.refresh('codex')
    expect([probe.calls, other.calls]).toEqual([3, 2])
    await t.svc.refresh()
    expect([probe.calls, other.calls]).toEqual([4, 3])
    expect(t.changes()).toBe(2)
  })

  // PS-6: enabling a provider while "Check all" runs used to start two probes of the same CLI at
  // once (two Codex app-servers); one failed and the card showed an error. In-flight probes are shared.
  it('PS-6 shares an in-flight probe: overlapping list/refresh calls never run the same CLI twice', async () => {
    let calls = 0
    let release!: (r: ProbeResult) => void
    const slow: ProviderProbe = {
      provider: 'codex',
      detect: () => {
        calls++
        return new Promise((ok) => (release = ok))
      },
    }
    const t = await setup([{ provider: 'codex', probe: slow }], ['codex'])
    // The first probe is already running when the next refresh and list arrive.
    const a = t.svc.refresh('codex')
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(calls).toBe(1)
    const b = t.svc.refresh()
    const c = t.svc.list()
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(calls).toBe(1)
    release({ installed: true, version: '1.2.3', flagsOk: true, auth: 'ok' })
    for (const list of await Promise.all([a, b, c]))
      expect(list.find((p) => p.id === 'codex')?.version).toBe('1.2.3')
    // Once settled, a new refresh probes again.
    const d = t.svc.refresh('codex')
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(calls).toBe(2)
    release({ installed: true, version: '1.2.4', flagsOk: true, auth: 'ok' })
    expect((await d).find((p) => p.id === 'codex')?.version).toBe('1.2.4')
  })

  it('PS-3 defaults: Claude follows claudeAdapter, others are off and not probed until enabled', async () => {
    const probe = new FakeProviderProbe('copilot')
    const t = await setup([
      { provider: 'claude-code', runner: new FakeAgentRunner() },
      { provider: 'copilot', probe },
    ])
    let list = await t.svc.list()
    expect(byId(list, 'claude-code')).toMatchObject({ enabled: true, state: 'managed-available' })
    expect(byId(list, 'copilot')).toMatchObject({ enabled: false, state: 'disabled' })
    expect(byId(list, 'chatgpt')).toMatchObject({ state: 'disabled', hint: 'opt-in-tunnel' })
    expect(probe.calls).toBe(0)
    list = await t.svc.setEnabled('copilot', true)
    expect(byId(list, 'copilot')).toMatchObject({ enabled: true, state: 'installed' })
    expect((await t.settings.get()).providers).toEqual({ copilot: { enabled: true } })
    expect(t.changes()).toBe(1)
    await t.settings.update({ claudeAdapter: false })
    expect(byId(await t.svc.list(), 'claude-code').state).toBe('disabled')
    list = await t.svc.setEnabled('claude-code', true)
    expect(byId(list, 'claude-code').enabled).toBe(true)
  })

  it('PS-4 counts live (not done) agents by prefix and reports hook status', async () => {
    const t = await setup(
      [
        { provider: 'codex', probe: new FakeProviderProbe('codex'), runner: codexRunner() },
        {
          provider: 'cursor',
          probe: new FakeProviderProbe('cursor'),
          hooks: { status: async () => 'installed' },
        },
        {
          provider: 'gemini',
          probe: new FakeProviderProbe('gemini'),
          hooks: {
            status: async () => {
              throw new Error('bad json at /Users/me/.gemini/settings.json')
            },
          },
        },
      ],
      ['codex', 'cursor', 'gemini'],
    )
    const agent = (id: string, status: AgentState['status']) =>
      t.agents.put({
        id,
        name: id,
        provider: 'x',
        topic: 't',
        status,
        source: 'managed',
        since: 0,
        lastSeen: 0,
        interactive: false,
        unread: 0,
      })
    agent('cx:1', 'thinking')
    agent('cx:2', 'done')
    agent('cc:3', 'idle')
    const list = await t.svc.list()
    expect(byId(list, 'codex')).toMatchObject({ activeSessions: 1, state: 'connected' })
    expect(byId(list, 'claude-code').activeSessions).toBe(1)
    expect(byId(list, 'cursor')).toMatchObject({ hooks: 'installed', state: 'observe-only' })
    expect(byId(list, 'gemini')).toMatchObject({
      state: 'needs-setup',
      hint: 'hooks-invalid-config',
    })
    expect(byId(list, 'gemini').hooks).toBeUndefined()
    expect(t.log.lines.join('\n')).not.toContain('/Users/me')
  })

  it('PS-5 models: live list, else the runtime fallback, else Claude aliases, else none', async () => {
    const t = await setup([{ provider: 'codex', runner: codexRunner() }])
    expect(await t.svc.models('codex')).toEqual([{ id: 'gpt-5', label: 'GPT-5' }])
    expect(await t.svc.models('claude-code')).toEqual(FALLBACK_MODELS)
    expect(await t.svc.models('cursor')).toEqual([])
    t.live.set('codex', [{ id: 'o5', label: 'o5' }])
    expect(await t.svc.models('codex')).toEqual([{ id: 'o5', label: 'o5' }])
  })
})
