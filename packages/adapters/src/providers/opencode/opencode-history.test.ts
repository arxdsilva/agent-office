import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { HttpError } from '../common/http/http-json.ts'
import { startLocalServer } from '../common/http/local-server.ts'
import {
  OpenCodeHistorySource,
  OpenCodeServers,
  type OpenCodeServerAccess,
} from './opencode-history.ts'
import { refOf, sessionOfRef, toolName } from './opencode-protocol.ts'

const FAKE = fileURLToPath(new URL('../../../test/fakes/fake-opencode-server.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'ao-oc-hist-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SECRET_DIR = '/Users/alice/secret-client/acme-merger'
const fixture = {
  sessions: [
    {
      id: 'ses_old1',
      title: 'Old one',
      directory: '/work/alpha',
      time: { created: 1000, updated: 2000 },
    },
    {
      id: 'ses_new1',
      title: `  A very long title ${'x'.repeat(120)} `,
      directory: SECRET_DIR,
      time: { created: 3000, updated: 9000 },
    },
    {
      id: 'ses_child',
      parentID: 'ses_new1',
      title: 'child',
      directory: '/w',
      time: { created: 1, updated: 9999 },
    },
    { id: 'ses_arch', title: 'archived', time: { created: 1, updated: 8000, archived: 5 } },
    { id: '../../etc', title: 'bad id', time: { created: 1, updated: 1 } },
    { id: 'ses_notime', title: 'no time' },
    { id: 'ses_untitled', directory: '/work/beta', time: { created: 10, updated: 11 } },
    { id: 'ses_rel', title: '', directory: 'relative/dir', time: { created: 10, updated: 12 } },
  ],
  messages: {},
  events: [],
}
const fixtureFile = join(root, 'fixture.json')
writeFileSync(fixtureFile, JSON.stringify(fixture))

const fakeStart: typeof startLocalServer = (o) =>
  startLocalServer({
    ...o,
    bin: process.execPath,
    args: (a) => [FAKE, ...o.args(a)],
    env: {
      ...o.env,
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_OC_FIXTURE: fixtureFile,
      FAKE_OC_LOG: join(root, 'req.log'),
    },
  })

let servers: OpenCodeServers[] = []
afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
})
const make = (o: Partial<ConstructorParameters<typeof OpenCodeServers>[0]> = {}) => {
  const s = new OpenCodeServers({
    bin: () => 'opencode',
    cwd: join(root, 'cwd'),
    start: fakeStart,
    ...o,
  })
  servers.push(s)
  return s
}

describe('protocol helpers', () => {
  it('refs round-trip and reject anything that is not a session id', () => {
    expect(refOf('ses_abc')).toBe('tr_oc_ses_abc')
    expect(sessionOfRef('tr_oc_ses_abc')).toBe('ses_abc')
    for (const bad of ['tr_ses_abc', 'tr_oc_../x', 'tr_oc_ses_a/b', 'tr_go_ses_a', 'tr_oc_'])
      expect(sessionOfRef(bad)).toBeUndefined()
  })

  it('tool ids map to the shared names; odd strings are dropped', () => {
    expect(toolName('bash')).toBe('Bash')
    expect(toolName('webfetch')).toBe('WebFetch')
    expect(toolName('mcp_github_search')).toBe('mcp_github_search')
    expect(toolName('rm -rf /')).toBeUndefined()
    expect(toolName(42)).toBeUndefined()
  })
})

describe('OpenCodeHistorySource', () => {
  it('lists root, non-archived sessions newest first as PastSessions', async () => {
    const src = new OpenCodeHistorySource({ servers: make() })
    const got = await src.list({ limit: 50 })
    expect(got.map((p) => p.providerSessionId)).toEqual([
      'ses_new1',
      'ses_old1',
      'ses_rel',
      'ses_untitled',
    ])
    const n = got[0]!
    expect(n).toMatchObject({
      provider: 'opencode',
      transcriptRef: 'tr_oc_ses_new1',
      cwd: SECRET_DIR,
      startedAt: 3000,
      lastSeenAt: 9000,
    })
    expect(n.title.length).toBeLessThanOrEqual(80)
    expect(n.title.startsWith('A very long title')).toBe(true)
    expect(got.find((p) => p.providerSessionId === 'ses_untitled')!.title).toBe('beta')
    // A relative directory is not a location: no cwd, generic title.
    const rel = got.find((p) => p.providerSessionId === 'ses_rel')!
    expect(rel.cwd).toBeUndefined()
    expect(rel.title).toBe('OpenCode session')
    expect(src.idPattern.test('ses_new1')).toBe(true)
    // Only read-only calls, all with the per-run password.
    const reqs = readFileSync(join(root, 'req.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(reqs.every((r) => r.method === 'GET' && r.authed)).toBe(true)
  })

  it('honours the limit, a disabled gate, and returns [] when OpenCode is unavailable', async () => {
    expect(await new OpenCodeHistorySource({ servers: make() }).list({ limit: 1 })).toHaveLength(1)
    expect(await new OpenCodeHistorySource({ servers: make() }).list({ limit: 0 })).toEqual([])
    expect(
      await new OpenCodeHistorySource({ servers: make(), enabled: () => false }).list({ limit: 5 }),
    ).toEqual([])
    const none = make({ bin: () => undefined })
    expect(await new OpenCodeHistorySource({ servers: none }).list({ limit: 5 })).toEqual([])
    const broken: OpenCodeServerAccess = { use: () => Promise.reject(new HttpError('invalid')) }
    expect(await new OpenCodeHistorySource({ servers: broken }).list({ limit: 5 })).toEqual([])
  })
})

describe('OpenCodeServers', () => {
  it('starts the real way (no seam): fixed args after argsPrefix, password env, --pure', async () => {
    const s = make({
      bin: () => process.execPath,
      argsPrefix: [FAKE],
      env: { ELECTRON_RUN_AS_NODE: '1', FAKE_OC_FIXTURE: fixtureFile },
      start: undefined,
    })
    const got = await new OpenCodeHistorySource({ servers: s }).list({ limit: 2 })
    expect(got.map((p) => p.providerSessionId)).toEqual(['ses_new1', 'ses_old1'])
    expect(s.running()).toBe(true)
    await s.close()
    expect(s.running()).toBe(false)
  })

  it('reuses one short-lived server and stops it when idle', async () => {
    let starts = 0
    const s = make({
      idleMs: 50,
      start: (o) => {
        starts++
        return fakeStart(o)
      },
    })
    const a = await s.use(async (srv) => srv.baseUrl)
    const b = await s.use(async (srv) => srv.baseUrl)
    expect(a).toBe(b)
    expect(starts).toBe(1)
    await new Promise((r) => setTimeout(r, 200))
    expect(s.running()).toBe(false)
    await s.use(async () => 1)
    expect(starts).toBe(2)
  })

  it('concurrent first uses share one start', async () => {
    let starts = 0
    const s = make({ start: (o) => (starts++, fakeStart(o)) })
    await Promise.all([s.use(async () => 1), s.use(async () => 2), s.use(async () => 3)])
    expect(starts).toBe(1)
  })

  it('tries the user-run server first (no credentials sent), falls back to its own', async () => {
    const user = await fakeStart({
      bin: 'x',
      args: ({ host, port }) => ['serve', '--hostname', host, '--port', String(port)],
      cwd: root,
      readyPath: '/global/health',
    })
    try {
      let starts = 0
      const s = make({
        userPort: () => Number(new URL(user.baseUrl).port),
        start: (o) => (starts++, fakeStart(o)),
      })
      const seen = await s.use(async (srv) => ({ url: srv.baseUrl, headers: srv.headers }))
      expect(seen).toEqual({ url: user.baseUrl, headers: {} })
      expect(starts).toBe(0)
      // A failing user server (here: the call fails) → our own server.
      let first = true
      const url = await s.use(async (srv) => {
        if (first) {
          first = false
          throw new HttpError('auth', 401)
        }
        return srv.baseUrl
      })
      expect(url).not.toBe(user.baseUrl)
      expect(starts).toBe(1)
    } finally {
      await user.stop()
    }
  })

  it('a failed start is retried on the next use; non-HTTP errors from fn propagate', async () => {
    let n = 0
    const s = make({
      start: (o) => (++n === 1 ? Promise.reject(new Error('boom')) : fakeStart(o)),
    })
    await expect(s.use(async () => 1)).rejects.toThrow('boom')
    expect(await s.use(async () => 2)).toBe(2)
    await expect(s.use(async () => Promise.reject(new Error('mine')))).rejects.toThrow('mine')
  })
})
