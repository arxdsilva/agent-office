// The fakes are held to the same contracts as the real adapters.
import { describe, expect, it } from 'vitest'
import { agentRunnerContract, managedRuntimeContract } from './contracts/agent-runner.ts'
import { jsonConfigStoreContract, providerProbeContract } from './contracts/providers.ts'
import { repoFilesContract } from './contracts/repo-files.ts'
import { capabilityRepositoryContract } from './contracts/capabilities.ts'
import {
  FakeAgentRunner,
  FakeAgentRepository,
  FakeCapabilityRepository,
  FakeClaudeSettingsStore,
  FakeEventBus,
  FakeGateRunner,
  FakeHookRunner,
  FakeSignal,
  FakeJsonConfigStore,
  FakeMessageRepository,
  FakeProviderProbe,
  FakeRepoFiles,
  FakeSettingsRepository,
} from './fakes/index.ts'
import {
  historySourceContract,
  recordLogContract,
  searchIndexContract,
  transcriptReaderContract,
} from './contracts/projects.ts'
import {
  FakeHistorySource,
  FakeRecordLog,
  FakeSearchIndex,
  FakeTranscriptReader,
} from './fakes/projects.ts'
import {
  agentRepositoryContract,
  eventBusContract,
  messageRepositoryContract,
} from './contracts/repositories.ts'
import {
  claudeSettingsStoreContract,
  hookRunnerContract,
  settingsRepositoryContract,
} from './contracts/stores.ts'

agentRepositoryContract('FakeAgentRepository', () => new FakeAgentRepository())
messageRepositoryContract('FakeMessageRepository', (cap) => new FakeMessageRepository(cap))
eventBusContract('FakeEventBus', () => new FakeEventBus())
settingsRepositoryContract('FakeSettingsRepository', async () => new FakeSettingsRepository())
claudeSettingsStoreContract('FakeClaudeSettingsStore', async (initial) => {
  const store = new FakeClaudeSettingsStore(initial)
  return { store, backup: async () => store.lastBackup }
})
hookRunnerContract('FakeHookRunner', async () => {
  const runner = new FakeHookRunner()
  return { runner, exists: async () => runner.installed }
})
capabilityRepositoryContract('FakeCapabilityRepository', () => new FakeCapabilityRepository())

agentRunnerContract('FakeAgentRunner', () => {
  const runner = new FakeAgentRunner()
  runner.autoInit = false
  const s = () => runner.last()
  return {
    runner,
    init: (id) => {
      Object.assign(s(), { id }) // the contract picks the session id
      s().init()
    },
    toolUse: (name) => s().emit({ status: 'tool', tool: name }),
    result: (text) => s().result(text),
    ask: (tool, input) => s().ask(tool, input),
    prompts: () => s().prompts,
    controls: () => s().calls,
  }
})

providerProbeContract('FakeProviderProbe', () => new FakeProviderProbe('cursor'))
jsonConfigStoreContract('FakeJsonConfigStore', async (initial) => ({
  store: new FakeJsonConfigStore(initial),
}))

managedRuntimeContract('FakeAgentRunner (with decl)', () => {
  const runner = new FakeAgentRunner({
    provider: 'codex',
    prefix: 'cx:',
    caps: ['launch', 'send-message', 'stop', 'change-mode'],
    modes: [
      { id: 'ask', label: 'Ask before changes' },
      { id: 'full-access', label: 'Full access', dangerous: true },
    ],
    defaultModeId: 'ask',
  })
  runner.autoInit = false
  const s = () => runner.last()
  return {
    runner,
    init: (id) => {
      Object.assign(s(), { id })
      s().init()
    },
    toolUse: (name) => s().emit({ status: 'tool', tool: name }),
    result: (text) => s().result(text),
    ask: (tool, input) => s().ask(tool, input),
    prompts: () => s().prompts,
    controls: () => s().calls,
    alive: () => !s().closed,
  }
})

// ── projects-first ports ──
recordLogContract('FakeRecordLog', async () => {
  const log = new FakeRecordLog()
  return {
    log,
    reopen: async () => log.reopen(),
    corrupt: async (p) => {
      // The fake "skips" a corrupt line by dropping it, as the real adapter does on read.
      log.storage.get(p)?.splice(1, 1)
    },
  }
})
searchIndexContract('FakeSearchIndex', () => new FakeSearchIndex())
transcriptReaderContract('FakeTranscriptReader', async () => {
  const reader = new FakeTranscriptReader().set(
    'tr_fixture',
    Array.from({ length: 7 }, (_, i) => ({
      uuid: `u${i}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: i === 3 ? 'about the deploy pipeline' : `message ${i}`,
      ts: 100 + i,
      tools: i % 2 ? ['Bash'] : [],
    })),
  )
  return {
    reader,
    ref: 'tr_fixture',
    total: 7,
    word: 'deploy',
    secret: 'SENTINEL-SECRET-123',
    unknownRef: 'tr_nothing',
  }
})

historySourceContract('FakeHistorySource', async () => ({
  source: new FakeHistorySource(
    [5, 3, 9]
      .map((t, i) => ({
        provider: 'claude-code',
        providerSessionId: `s${i}`,
        transcriptRef: `tr_s${i}`,
        title: `Session ${i}`,
        startedAt: t,
        lastSeenAt: t + 10,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  ),
  total: 3,
  secret: 'SENTINEL-SECRET-123',
}))

describe('FakeGateRunner', () => {
  const spec = (id: string) => ({ id, argv: ['make', 'check'], timeoutMs: 1000 })

  it('passes by default and records every call', async () => {
    const g = new FakeGateRunner()
    const r = await g.run(spec('gat_a'), { cwd: '/w' })
    expect(r).toEqual({ status: 'pass', exitCode: 0, durationMs: 1, outputTail: '' })
    expect(g.calls).toEqual([{ spec: spec('gat_a'), cwd: '/w' }])
  })

  it('returns scripted results by gate id, in order, then repeats the last', async () => {
    const g = new FakeGateRunner().script(
      'gat_a',
      { status: 'fail', exitCode: 2, outputTail: 'boom' },
      { status: 'pass' },
    )
    expect((await g.run(spec('gat_a'), { cwd: '/w' })).status).toBe('fail')
    expect((await g.run(spec('gat_a'), { cwd: '/w' })).status).toBe('pass')
    expect((await g.run(spec('gat_a'), { cwd: '/w' })).status).toBe('pass')
    expect((await g.run(spec('gat_b'), { cwd: '/w' })).exitCode).toBe(0)
  })

  it('a held gate stays running until released, and an abort cancels it', async () => {
    const g = new FakeGateRunner().hold('gat_a')
    const sig = new FakeSignal()
    let done: string | undefined
    const p = g.run(spec('gat_a'), { cwd: '/w', signal: sig }).then((r) => (done = r.status))
    await Promise.resolve()
    expect(done).toBeUndefined()
    expect(g.running()).toEqual(['gat_a'])
    sig.abort()
    await p
    expect(done).toBe('cancelled')

    const q = g.run(spec('gat_a'), { cwd: '/w' })
    g.release('gat_a')
    expect((await q).status).toBe('pass')
  })

  it('an already aborted signal is cancelled immediately', async () => {
    const sig = new FakeSignal()
    sig.abort()
    expect((await new FakeGateRunner().run(spec('g'), { cwd: '/w', signal: sig })).status).toBe(
      'cancelled',
    )
  })
})

// The fake matches the layout's files only; dirs and outside links simply are not in the set.
repoFilesContract('FakeRepoFiles', async (layout) => ({
  repoPath: '/repo',
  port: new FakeRepoFiles(layout.files),
}))
