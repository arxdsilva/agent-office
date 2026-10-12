import { afterEach, describe, expect, it } from 'vitest'
import { makeOffice } from '../../test/support.ts'
import { createAuth } from './auth.ts'
import { buildHttpApi, type MockControl } from './http-api.ts'

const TOKEN = 'a'.repeat(64)
const HOST = 'localhost:4317'
const json = { 'content-type': 'application/json' }
const authed = { ...json, host: HOST, authorization: `Bearer ${TOKEN}` }
const bearerOnly = { host: HOST, authorization: `Bearer ${TOKEN}` }

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup(opts: { rateLimitPerSec?: number; mock?: MockControl } = {}) {
  const { office, scheduler } = makeOffice(opts)
  const app = buildHttpApi(
    { activity: office.activity, inbox: office.inbox, chat: office.chat, query: office.query, ...(opts.mock ? { mock: opts.mock } : {}) },
    createAuth({ token: TOKEN, port: 4317 }),
  )
  cleanups.push(() => app.close(), () => scheduler.dispose())
  return { app, office }
}

describe('guards', () => {
  it('421 for foreign Host, 403 for foreign Origin, health needs no token', async () => {
    const { app } = setup()
    expect((await app.inject({ url: '/api/agents', headers: { host: 'evil.com' } })).statusCode).toBe(421)
    expect((await app.inject({ url: '/api/agents', headers: { host: HOST, origin: 'https://evil.com' } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/health', headers: { host: HOST } })).json()).toEqual({ ok: true, agents: 0 })
  })

  it('the old browser surfaces are gone: /, /ws and /api/session are 404', async () => {
    const { app } = setup()
    for (const url of ['/', '/ws', '/api/session', '/assets/x.js']) {
      expect((await app.inject({ url, headers: { host: HOST } })).statusCode).toBe(404)
    }
  })
})

describe('POST /api/events', () => {
  it('401 without token; 202 for the minimal payload (compatibility guard) and for batches', async () => {
    const { app, office } = setup()
    const anon = await app.inject({ method: 'POST', url: '/api/events', headers: { ...json, host: HOST }, payload: { agentId: 'a' } })
    expect(anon.statusCode).toBe(401)
    const one = await app.inject({ method: 'POST', url: '/api/events', headers: authed, payload: { agentId: 'a' } })
    expect(one.statusCode).toBe(202)
    expect(one.json()).toEqual({ accepted: 1 })
    expect(office.query.agent('a')?.source).toBe('http')
    const batch = await app.inject({ method: 'POST', url: '/api/events', headers: authed, payload: [{ agentId: 'b' }, { agentId: 'c' }] })
    expect(batch.json()).toEqual({ accepted: 2 })
  })

  it('400 with issues for invalid bodies', async () => {
    const { app } = setup()
    const r = await app.inject({ method: 'POST', url: '/api/events', headers: authed, payload: { status: 'x' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().issues.length).toBeGreaterThan(0)
  })
})

describe('agents, messages, inbox, replies', () => {
  it('GET /api/agents lists agents', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    expect((await app.inject({ url: '/api/agents', headers: { host: HOST } })).json().map((a: { id: string }) => a.id)).toEqual(['a'])
  })

  it('POST /messages maps domain errors: 404 unknown agent, 400 invalid, 401 no token, 429 rate limit', async () => {
    const { app, office } = setup({ rateLimitPerSec: 2 })
    const send = (id: string, payload: unknown, headers: Record<string, string> = authed) =>
      app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, headers, payload: payload as object })
    expect((await send('ghost', { text: 'hi' })).statusCode).toBe(404)
    office.activity.report([{ agentId: 'a' }])
    expect((await send('a', { text: '' })).statusCode).toBe(400)
    expect((await send('a', { text: 'x' }, { ...json, host: HOST })).statusCode).toBe(401)
    const ok = await send('a', { text: 'hi' })
    expect(ok.statusCode).toBe(202)
    expect(ok.json().message).toMatchObject({ text: 'hi', state: 'queued' })
    await send('a', { text: 'two' })
    expect((await send('a', { text: 'three' })).statusCode).toBe(429)
    expect(office.query.agent('a')?.unread).toBe(2)
  })

  it('GET /messages returns history', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    office.chat.send('a', 'hello')
    const r = await app.inject({ url: '/api/agents/a/messages', headers: { host: HOST } })
    expect(r.json().map((m: { text: string }) => m.text)).toEqual(['hello'])
  })

  it('inbox claim delivers once and marks interactive; without claim it only peeks; requires token', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    office.chat.send('a', 'do it')
    const peek = await app.inject({ url: '/api/agents/a/inbox', headers: bearerOnly })
    expect(peek.json().messages).toHaveLength(1)
    const r = await app.inject({ url: '/api/agents/a/inbox?claim=1', headers: bearerOnly })
    expect(r.json().messages.map((m: { text: string }) => m.text)).toEqual(['do it'])
    expect(office.query.agent('a')).toMatchObject({ interactive: true, unread: 0 })
    expect((await app.inject({ url: '/api/agents/a/inbox?claim=1', headers: bearerOnly })).json().messages).toEqual([])
    expect((await app.inject({ url: '/api/agents/a/inbox', headers: { host: HOST } })).statusCode).toBe(401)
  })

  it('inbox long-poll is released by a new message', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    const pending = app.inject({ url: '/api/agents/a/inbox?claim=1&wait=5', headers: bearerOnly })
    setTimeout(() => office.chat.send('a', 'late'), 50)
    expect((await pending).json().messages.map((m: { text: string }) => m.text)).toEqual(['late'])
  })

  it('replies: 204 when requireAwaiting and nothing waits, 202 otherwise, 400 invalid', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    const reply = (payload: object) => app.inject({ method: 'POST', url: '/api/agents/a/replies', headers: authed, payload })
    expect((await reply({ text: 'unprompted', requireAwaiting: true })).statusCode).toBe(204)
    office.chat.send('a', 'q')
    office.inbox.claim('a')
    expect((await reply({ text: 'answer', requireAwaiting: true })).statusCode).toBe(202)
    expect(office.chat.history('a').map((m) => m.state)).toEqual(['replied', 'replied'])
    expect((await reply({})).statusCode).toBe(400)
  })
})

describe('POST /api/mock', () => {
  it('404 without a mock control; spawns a capped number of agents with one', async () => {
    expect((await setup().app.inject({ method: 'POST', url: '/api/mock?n=3', headers: bearerOnly })).statusCode).toBe(404)
    const spawned: number[] = []
    const { app } = setup({ mock: { spawn: (n) => spawned.push(n) } })
    const r = await app.inject({ method: 'POST', url: '/api/mock?n=5000', headers: bearerOnly })
    expect(r.statusCode).toBe(202)
    expect(spawned).toEqual([1000])
  })
})
