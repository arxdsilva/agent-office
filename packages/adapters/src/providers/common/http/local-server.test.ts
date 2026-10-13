import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { httpJson } from './http-json.ts'
import { freePort, LocalServerError, startLocalServer } from './local-server.ts'

const FAKE = fileURLToPath(
  new URL('../../../../test/fakes/fake-opencode-server.mjs', import.meta.url),
)
const dir = mkdtempSync(join(tmpdir(), 'ao-local-server-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const base = (
  env: Record<string, string> = {},
  extra: Partial<Parameters<typeof startLocalServer>[0]> = {},
) => ({
  bin: process.execPath,
  args: ({ host, port }: { host: string; port: number }) => [
    FAKE,
    'serve',
    '--hostname',
    host,
    '--port',
    String(port),
  ],
  cwd: dir,
  env: { ELECTRON_RUN_AS_NODE: '1', ...env },
  readyPath: '/global/health',
  passwordEnv: 'OPENCODE_SERVER_PASSWORD',
  username: 'opencode',
  ...extra,
})

const Health = z.looseObject({ healthy: z.literal(true) })

describe('freePort', () => {
  it('returns a bindable loopback port', async () => {
    const p = await freePort()
    expect(p).toBeGreaterThan(0)
    const s = createServer()
    await new Promise<void>((r, j) => s.once('error', j).listen(p, '127.0.0.1', r))
    s.close()
  })
})

describe('startLocalServer', () => {
  it('starts on 127.0.0.1 with a per-run password, is ready, and stops', async () => {
    const log = join(dir, 'a.log')
    const s = await startLocalServer(base({ FAKE_OC_LOG: log, FAKE_OC_READY_DELAY_MS: '150' }))
    expect(s.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(s.headers.authorization).toMatch(/^Basic /)
    expect(s.alive()).toBe(true)
    // Authenticated calls work; without the header the server refuses.
    expect(
      await httpJson(`${s.baseUrl}/global/health`, { schema: Health, headers: s.headers }),
    ).toMatchObject({ healthy: true })
    await expect(httpJson(`${s.baseUrl}/global/health`, { schema: Health })).rejects.toMatchObject({
      kind: 'auth',
    })
    // Every ready poll carried the secret.
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.filter((l) => l.authed).length).toBeGreaterThan(0)
    await s.stop()
    expect(s.alive()).toBe(false)
    expect((await s.exited).signal ?? (await s.exited).code).toBeDefined()
  })

  it('two runs get different secrets', async () => {
    const a = await startLocalServer(base())
    const b = await startLocalServer(base())
    expect(a.headers.authorization).not.toBe(b.headers.authorization)
    await Promise.all([a.stop(), b.stop()])
  })

  it('without passwordEnv there is no secret', async () => {
    const s = await startLocalServer(base({}, { passwordEnv: undefined }))
    expect(s.headers).toEqual({})
    await s.stop()
  })

  it('fails with "exited" when the process dies before it is ready', async () => {
    await expect(startLocalServer(base({ FAKE_OC_EXIT: '3' }))).rejects.toMatchObject({
      kind: 'exited',
    })
  })

  it('fails with "spawn" for a missing binary or folder', async () => {
    await expect(startLocalServer({ ...base(), bin: join(dir, 'nope') })).rejects.toBeInstanceOf(
      LocalServerError,
    )
    await expect(startLocalServer({ ...base(), cwd: join(dir, 'missing') })).rejects.toMatchObject({
      kind: 'spawn',
    })
  })

  it('times out (and kills the process) when never ready', async () => {
    const t0 = Date.now()
    await expect(
      startLocalServer(base({ FAKE_OC_READY_DELAY_MS: '5000' }, { timeoutMs: 300 })),
    ).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(4000)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const s = await startLocalServer(base({ FAKE_OC_IGNORE_TERM: '1' }, { killGraceMs: 200 }))
    const t0 = Date.now()
    await s.stop()
    expect(s.alive()).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect((await s.exited).signal).toBe('SIGKILL')
  })
})
