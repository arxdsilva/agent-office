import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth } from './auth.ts'
import { buildApp } from './http.ts'
import { MessageStore } from './messages.ts'
import { AgentStore } from './store.ts'

const TOKEN = 'a'.repeat(64)
const HOST = 'localhost:4317'
const json = { 'content-type': 'application/json' }
const authed = { ...json, host: HOST, authorization: `Bearer ${TOKEN}` }

function setup(opts: { staticDir?: string; rateLimitPerSec?: number } = {}) {
  const store = new AgentStore({
    idleAfterMs: 1e9,
    expireAfterMs: 1e9,
    doneTtlMs: 1e9,
    interactiveTtlMs: 1e9,
  })
  const messages = new MessageStore()
  const auth = createAuth({ token: TOKEN, port: 4317, devOrigins: ['http://localhost:5173'] })
  const app = buildApp({ store, messages, auth, ...opts })
  apps.push(app)
  return { app, store, messages }
}
const apps: ReturnType<typeof buildApp>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()))
})

describe('guards', () => {
  it('rejects foreign Host headers with 421 (DNS rebinding)', async () => {
    const { app } = setup()
    const r = await app.inject({ url: '/api/agents', headers: { host: 'evil.com' } })
    expect(r.statusCode).toBe(421)
  })

  it('rejects foreign Origin with 403', async () => {
    const { app } = setup()
    const r = await app.inject({
      url: '/api/agents',
      headers: { host: HOST, origin: 'https://evil.com' },
    })
    expect(r.statusCode).toBe(403)
  })

  it('health needs no token', async () => {
    const { app } = setup()
    const r = await app.inject({ url: '/api/health', headers: { host: HOST } })
    expect(r.json()).toEqual({ ok: true, agents: 0 })
  })
})

describe('POST /api/events', () => {
  it('401 without token', async () => {
    const { app } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...json, host: HOST },
      payload: { agentId: 'a' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('202 for the minimal {agentId} payload (compatibility guard)', async () => {
    const { app, store } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: { agentId: 'a' },
    })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ accepted: 1 })
    expect(store.get('a')?.source).toBe('http')
  })

  it('202 for a batch', async () => {
    const { app } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: [{ agentId: 'a' }, { agentId: 'b', status: 'tool', tool: 'Bash' }],
    })
    expect(r.json()).toEqual({ accepted: 2 })
  })

  it('400 with issues for invalid bodies', async () => {
    const { app } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: { status: 'x' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().issues.length).toBeGreaterThan(0)
  })
})

describe('agents and messages', () => {
  it('GET /api/agents lists agents', async () => {
    const { app, store } = setup()
    store.apply({ agentId: 'a' })
    const r = await app.inject({ url: '/api/agents', headers: { host: HOST } })
    expect(r.json().map((a: { id: string }) => a.id)).toEqual(['a'])
  })

  it('POST /messages: 404 for unknown agent, 202 + unread for known', async () => {
    const { app, store } = setup()
    const miss = await app.inject({
      method: 'POST',
      url: '/api/agents/x/messages',
      headers: authed,
      payload: { text: 'hi' },
    })
    expect(miss.statusCode).toBe(404)
    store.apply({ agentId: 'a' })
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agents/a/messages',
      headers: authed,
      payload: { text: 'hi' },
    })
    expect(ok.statusCode).toBe(202)
    expect(ok.json().message).toMatchObject({ text: 'hi', state: 'queued' })
    expect(store.get('a')?.unread).toBe(1)
  })

  it('POST /messages: 400 for empty text, 401 without token', async () => {
    const { app, store } = setup()
    store.apply({ agentId: 'a' })
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents/a/messages',
      headers: authed,
      payload: { text: '' },
    })
    expect(bad.statusCode).toBe(400)
    const anon = await app.inject({
      method: 'POST',
      url: '/api/agents/a/messages',
      headers: { ...json, host: HOST },
      payload: { text: 'x' },
    })
    expect(anon.statusCode).toBe(401)
  })

  it('POST /messages: 429 past the per-agent rate limit', async () => {
    const { app, store } = setup({ rateLimitPerSec: 2 })
    store.apply({ agentId: 'a' })
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/agents/a/messages',
        headers: authed,
        payload: { text: 'x' },
      })
    expect((await send()).statusCode).toBe(202)
    expect((await send()).statusCode).toBe(202)
    expect((await send()).statusCode).toBe(429)
  })

  it('GET /messages returns history', async () => {
    const { app, messages } = setup()
    messages.enqueue('a', 'hello')
    const r = await app.inject({ url: '/api/agents/a/messages', headers: { host: HOST } })
    expect(r.json().map((m: { text: string }) => m.text)).toEqual(['hello'])
  })

  it('inbox claims messages, marks the agent interactive and clears unread', async () => {
    const { app, store, messages } = setup()
    store.apply({ agentId: 'a' })
    messages.enqueue('a', 'do it')
    const r = await app.inject({ url: '/api/agents/a/inbox?claim=1', headers: authed })
    expect(r.json().messages.map((m: { text: string }) => m.text)).toEqual(['do it'])
    expect(store.get('a')).toMatchObject({ interactive: true, unread: 0 })
    const again = await app.inject({ url: '/api/agents/a/inbox?claim=1', headers: authed })
    expect(again.json().messages).toEqual([])
  })

  it('inbox without claim only peeks', async () => {
    const { app, messages } = setup()
    messages.enqueue('a', 'x')
    const r = await app.inject({ url: '/api/agents/a/inbox', headers: authed })
    expect(r.json().messages).toHaveLength(1)
    expect(messages.unread('a')).toBe(1)
  })

  it('inbox long-poll is released by a new message', async () => {
    const { app, messages } = setup()
    const pending = app.inject({ url: '/api/agents/a/inbox?claim=1&wait=5', headers: authed })
    setTimeout(() => messages.enqueue('a', 'late'), 50)
    const r = await pending
    expect(r.json().messages.map((m: { text: string }) => m.text)).toEqual(['late'])
  })

  it('inbox requires the token', async () => {
    const { app } = setup()
    const r = await app.inject({ url: '/api/agents/a/inbox', headers: { host: HOST } })
    expect(r.statusCode).toBe(401)
  })

  it('replies are recorded; requireAwaiting skips when nothing is waiting', async () => {
    const { app, messages } = setup()
    const skip = await app.inject({
      method: 'POST',
      url: '/api/agents/a/replies',
      headers: authed,
      payload: { text: 'unprompted', requireAwaiting: true },
    })
    expect(skip.statusCode).toBe(204)
    messages.enqueue('a', 'q')
    messages.claim('a')
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agents/a/replies',
      headers: authed,
      payload: { text: 'answer', requireAwaiting: true },
    })
    expect(ok.statusCode).toBe(202)
    expect(messages.history('a').map((m) => m.state)).toEqual(['replied', 'replied'])
  })

  it('replies validate the body', async () => {
    const { app } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/a/replies',
      headers: authed,
      payload: {},
    })
    expect(r.statusCode).toBe(400)
  })

  it('GET /api/session returns the token for the local UI', async () => {
    const { app } = setup()
    const r = await app.inject({
      url: '/api/session',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
    })
    expect(r.json()).toEqual({ token: TOKEN })
  })
})

describe('static UI', () => {
  it('serves index.html with the token injected, plus SPA fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-web-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(
      join(dir, 'index.html'),
      '<head><meta name="agent-office-token" content=""></head>',
    )
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    const { app } = setup({ staticDir: dir })
    const index = await app.inject({ url: '/', headers: { host: HOST } })
    expect(index.body).toContain(`content="${TOKEN}"`)
    const asset = await app.inject({ url: '/assets/app.js', headers: { host: HOST } })
    expect(asset.body).toBe('console.log(1)')
    const spa = await app.inject({ url: '/some/route', headers: { host: HOST } })
    expect(spa.body).toContain(TOKEN)
    const apiMiss = await app.inject({ url: '/api/nope', headers: { host: HOST } })
    expect(apiMiss.statusCode).toBe(404)
  })

  it('serves assets built after startup and 404s missing files instead of returning HTML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ao-web-'))
    writeFileSync(join(dir, 'index.html'), '<meta name="agent-office-token" content="">')
    const { app } = setup({ staticDir: dir })
    await app.ready()
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'new-hash.js'), 'export {}')
    const fresh = await app.inject({ url: '/assets/new-hash.js', headers: { host: HOST } })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.headers['content-type']).toContain('javascript')
    const missing = await app.inject({ url: '/assets/gone.js', headers: { host: HOST } })
    expect(missing.statusCode).toBe(404)
  })
})

describe('POST /api/mock', () => {
  it('is only available when a mock source is given', async () => {
    const { app } = setup()
    const r = await app.inject({
      method: 'POST',
      url: '/api/mock?n=3',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    })
    expect(r.statusCode).toBe(404)
  })

  it('spawns n agents (capped)', async () => {
    const store = new AgentStore({
      idleAfterMs: 1e9,
      expireAfterMs: 1e9,
      doneTtlMs: 1e9,
      interactiveTtlMs: 1e9,
    })
    const spawned: number[] = []
    const app = buildApp({
      store,
      messages: new MessageStore(),
      auth: createAuth({ token: TOKEN, port: 4317 }),
      mock: { spawn: (n) => spawned.push(n) },
    })
    apps.push(app)
    const r = await app.inject({
      method: 'POST',
      url: '/api/mock?n=5000',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    })
    expect(r.statusCode).toBe(202)
    expect(spawned).toEqual([1000])
  })
})
