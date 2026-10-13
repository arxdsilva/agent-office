// OpenCode history and observation end to end (docs/providers/opencode.md, "History and
// observation"): the real core + encrypted vault, the real OpenCodeServers starting the fake
// `opencode serve` (fakes/fake-opencode-server.mjs) with a per-run password, the real history
// source, transcript reader (through the TranscriptReaders router) and observer. Every fixture
// value is invented; secret-looking ones are sentinels that must never reach events or the vault.
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createOffice, type TranscriptReader } from '@agent-office/core'
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
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../src/memory/index.ts'
import { startLocalServer, type LocalServer } from '../src/providers/common/http/local-server.ts'
import {
  OpenCodeHistorySource,
  OpenCodeObserver,
  OpenCodeServers,
  OpenCodeTranscriptReader,
} from '../src/providers/opencode/index.ts'
import { TranscriptReaders } from '../src/sources/transcript-readers.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../src/system/index.ts'
import { FileRecordLog, TestKeyProvider, TextIndex } from '../src/vault/index.ts'

const FAKE = join(import.meta.dirname, 'fakes', 'fake-opencode-server.mjs')
const root = mkdtempSync(join(tmpdir(), 'ao-e2e-oc-'))
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
const repoAt = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  return dir
}

const SENTINEL_PROMPT = 'PROMPT-CANARY-7731 wire the money'
const SENTINEL_OUT = 'OUTPUT-CANARY-9902 sk-live-abcdef'
const SENTINEL_URL = 'https://intranet.example.com/admin?token=URL-CANARY'

/** Invented OpenCode data: two sessions in two repositories, one child session, events. */
function writeFixture(dir: string, repoA: string, repoB: string): string {
  const fixture = {
    sessions: [
      {
        id: 'ses_alpha1',
        title: 'Tidy the release script',
        directory: repoA,
        time: { created: 1_000, updated: 5_000 },
      },
      {
        id: 'ses_beta1',
        title: 'Fix the flaky test',
        directory: repoB,
        time: { created: 2_000, updated: 4_000 },
      },
      {
        id: 'ses_child1',
        parentID: 'ses_alpha1',
        title: 'subtask',
        directory: repoA,
        time: { created: 3_000, updated: 6_000 },
      },
    ],
    messages: {
      ses_alpha1: [
        {
          info: { id: 'msg_a1', role: 'user', time: { created: 1_100 } },
          parts: [{ type: 'text', text: `Please tidy it ${SENTINEL_PROMPT}` }],
        },
        {
          info: { id: 'msg_a2', role: 'assistant', time: { created: 1_200 } },
          parts: [
            { type: 'reasoning', text: 'REASONING-CANARY' },
            { type: 'text', text: 'Done: the script now uses make release.' },
            {
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: `curl ${SENTINEL_URL}` },
                output: SENTINEL_OUT,
              },
            },
          ],
        },
      ],
      ses_beta1: [
        {
          info: { id: 'msg_b1', role: 'user', time: { created: 2_100 } },
          parts: [{ type: 'text', text: 'flaky' }],
        },
      ],
    },
    events: [
      {
        directory: repoA,
        type: 'session.created',
        properties: {
          sessionID: 'ses_live1',
          info: { id: 'ses_live1', title: SENTINEL_PROMPT, directory: repoA, time: { created: 9 } },
        },
      },
      {
        directory: repoA,
        type: 'session.status',
        properties: { sessionID: 'ses_live1', status: { type: 'busy' } },
      },
      {
        directory: repoA,
        type: 'message.part.updated',
        properties: { sessionID: 'ses_live1', part: { type: 'text', text: SENTINEL_PROMPT } },
      },
      {
        directory: repoA,
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_live1',
          part: {
            type: 'tool',
            tool: 'webfetch',
            state: { status: 'running', input: { url: SENTINEL_URL } },
          },
        },
      },
      { directory: repoA, type: 'session.idle', properties: { sessionID: 'ses_live1' } },
    ],
  }
  const file = join(dir, 'fixture.json')
  writeFileSync(file, JSON.stringify(fixture))
  return file
}

/** One app run over a vault directory, with OpenCode as the only history source. */
async function boot(vaultDir: string, home: string, servers: OpenCodeServers) {
  const scheduler = new TimerScheduler()
  const transcripts: TranscriptReader = new TranscriptReaders({
    default: { page: async () => ({ messages: [], more: false }), search: async () => [] },
    byPrefix: { oc: new OpenCodeTranscriptReader({ servers }) },
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
    vault: new FileRecordLog({
      dir: vaultDir,
      keys: new TestKeyProvider({ master: 'e2e-opencode' }),
    }),
    repoIdentity: new GitRepoIdentity({ salt: loadOrCreateWorkspaceSalt(home) }),
    history: { opencode: new OpenCodeHistorySource({ servers }) },
    transcripts,
    searchIndex: new TextIndex(),
    random: { token: (n) => randomBytes(n).toString('hex') },
  })
  const projects = office.projects!
  await projects.load()
  const close = async () => {
    await projects.store.flush()
    scheduler.dispose()
  }
  return { office, projects, close }
}

describe('OpenCode end to end', () => {
  it('imports history → assigned or suggested by repo → transcript pages → restart over the same vault', async () => {
    const dir = mkdtempSync(join(root, 'run-'))
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const vaultDir = join(dir, 'userData', 'vault')
    const repoA = repoAt(join(dir, 'shop-api'))
    const repoB = repoAt(join(dir, 'shared-lib'))
    const fixture = writeFixture(dir, repoA, repoB)
    const reqLog = join(dir, 'requests.log')

    // The real server access, starting the fake `opencode serve` with a fresh password.
    let starts = 0
    const servers = new OpenCodeServers({
      cwd: join(dir, 'userData', 'opencode-history'),
      bin: () => process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1', FAKE_OC_FIXTURE: fixture, FAKE_OC_LOG: reqLog },
      start: (o) => {
        starts++
        return startLocalServer({ ...o, args: (a) => [FAKE, ...o.args(a)] })
      },
    })
    cleanup.push(() => servers.close())

    const a = await boot(vaultDir, home, servers)
    let closed = false
    cleanup.push(async () => {
      if (!closed) await a.close()
    })
    // Shop links shop-api (one project → auto-assigned); two projects link shared-lib (→ suggestions).
    const shop = await a.projects.catalog.create({ name: 'Shop', folders: [repoA] })
    const libA = await a.projects.catalog.create({ name: 'Lib A', folders: [repoB] })
    const libB = await a.projects.catalog.create({ name: 'Lib B', folders: [repoB] })

    // The user imports history: the two top-level sessions arrive as references; the child is not one.
    expect(await a.projects.history.importHistory({ limit: 50 })).toEqual({
      imported: 2,
      skipped: 0,
    })
    // Idempotent.
    expect(await a.projects.history.importHistory({ limit: 50 })).toEqual({
      imported: 0,
      skipped: 2,
    })
    expect(starts).toBe(1) // one short-lived server served both listings

    const [alpha] = await until(() => {
      const l = a.projects.sessions.list({ scope: shop.id })
      return l.length ? l : undefined
    })
    expect(alpha).toMatchObject({
      origin: 'imported',
      provider: 'opencode',
      title: 'Tidy the release script',
      state: 'inactive',
      hasTranscript: true,
    })
    const beta = a.projects.sessions.list({}).find((s) => s.title === 'Fix the flaky test')!
    expect(beta.projectId ?? null).toBeNull()
    expect(JSON.stringify(beta)).toContain(libA.id)
    expect(JSON.stringify(beta)).toContain(libB.id)

    // The transcript is read on demand through the server API: text and tool names only.
    const page = await a.projects.sessions.messages({ sessionId: alpha!.id, limit: 50 })
    expect(page.messages.map((m) => [m.role, m.text, m.tools ?? []])).toEqual([
      ['user', `Please tidy it ${SENTINEL_PROMPT}`, []],
      ['agent', 'Done: the script now uses make release.', ['Bash']],
    ])
    expect(JSON.stringify(page)).not.toContain('REASONING-CANARY')
    expect(JSON.stringify(page)).not.toContain(SENTINEL_OUT)
    expect(JSON.stringify(page)).not.toContain('URL-CANARY')

    // Every request was a GET carrying the per-run password.
    const reqs = readFileSync(reqLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; authed: boolean })
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.every((r) => r.method === 'GET' && r.authed)).toBe(true)

    // Restart over the same vault: the records survive and the transcript still reads (refs are
    // self-describing, no re-listing needed).
    await a.close()
    closed = true
    await servers.close()
    const b = await boot(vaultDir, home, servers)
    cleanup.push(() => b.close())
    const again = b.projects.sessions
      .list({ scope: shop.id })
      .find((s) => s.title === 'Tidy the release script')!
    expect(again.origin).toBe('imported')
    const page2 = await b.projects.sessions.messages({ sessionId: again.id, limit: 1 })
    expect(page2.messages.map((m) => m.text)).toEqual(['Done: the script now uses make release.'])
    expect(page2.more).toBe(true)

    // Only references were kept: no prompt, no transcript text, no path in the vault.
    await b.projects.store.flush()
    const bytes = allBytes(vaultDir).toString('latin1')
    for (const s of [SENTINEL_PROMPT, 'make release', repoA, repoB]) expect(bytes).not.toContain(s)
  })

  it('observes a user-run server: metadata-only events, no credentials sent, off on disable', async () => {
    const dir = mkdtempSync(join(root, 'obs-'))
    const repoA = join(dir, 'acme-secret-repo')
    mkdirSync(repoA)
    const fixture = writeFixture(dir, repoA, repoA)
    const reqLog = join(dir, 'requests.log')
    // The user's own `opencode serve` (no password here; we never send one).
    const user: LocalServer = await startLocalServer({
      bin: process.execPath,
      args: ({ host, port }) => [FAKE, 'serve', '--hostname', host, '--port', String(port)],
      cwd: dir,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_OC_FIXTURE: fixture,
        FAKE_OC_LOG: reqLog,
        FAKE_OC_SSE_CLOSE: '1',
      },
      readyPath: '/global/health',
    })
    cleanup.push(() => user.stop())
    const servers = new OpenCodeServers({ cwd: join(dir, 'h'), bin: () => undefined })
    const a = await boot(join(dir, 'vault'), join(dir, 'home'), servers)
    cleanup.push(() => a.close())

    const states: string[] = []
    const observer = new OpenCodeObserver({
      activity: a.office.activity,
      onState: (s) => states.push(s),
      backoff: { initialMs: 50, maxMs: 200 },
    })
    cleanup.push(() => observer.stop())
    // Settings → observe on, with the user's port.
    observer.configure({ enabled: true, port: Number(new URL(user.baseUrl).port) })

    // The live session shows up with its project basename and walks through its statuses.
    const agent = await until(() => {
      const ag = a.office.query.agent('oc:ses_live1')
      return ag?.status === 'waiting' ? ag : undefined
    })
    expect(agent).toMatchObject({
      provider: 'opencode',
      name: 'acme-secret-repo',
      topic: 'acme-secret-repo',
    })
    expect(states).toContain('connected')

    // Nothing but metadata reached the office.
    const snap = JSON.stringify(a.office.query.snapshot())
    for (const s of [SENTINEL_PROMPT, SENTINEL_URL, 'URL-CANARY', SENTINEL_OUT, dir])
      expect(snap).not.toContain(s)

    // The stream ended (FAKE_OC_SSE_CLOSE): the observer reconnects on its own.
    await until(() => readFileSync(reqLog, 'utf8').split('/global/event').length > 2)

    // Read-only: the observer only ever GETs the event stream (the health polls are this test
    // starting the "user" server).
    const reqs = readFileSync(reqLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; path: string })
    expect(
      reqs
        .filter((r) => r.path !== '/global/health')
        .every((r) => r.method === 'GET' && r.path === '/global/event'),
    ).toBe(true)

    observer.configure({ enabled: false })
    expect(observer.state()).toBe('off')
  })
})
