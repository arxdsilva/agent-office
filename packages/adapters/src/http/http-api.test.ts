import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeOffice } from '../../test/support.ts'
import { createAuth } from './auth.ts'
import { buildHttpApi, type HttpApiPorts, type MockControl } from './http-api.ts'

const TOKEN = 'a'.repeat(64)
const HOST = 'localhost:4317'
const json = { 'content-type': 'application/json' }
const authed = { ...json, host: HOST, authorization: `Bearer ${TOKEN}` }
const bearerOnly = { host: HOST, authorization: `Bearer ${TOKEN}` }

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup(
  opts: { rateLimitPerSec?: number; mock?: MockControl; flow?: HttpApiPorts['flow'] } = {},
) {
  const { office, scheduler } = makeOffice(opts)
  const app = buildHttpApi(
    {
      activity: office.activity,
      inbox: office.inbox,
      chat: office.chat,
      query: office.query,
      capabilities: office.capabilities,
      ...(opts.mock ? { mock: opts.mock } : {}),
      ...(opts.flow ? { flow: opts.flow } : {}),
    },
    createAuth({ token: TOKEN, port: 4317 }),
  )
  cleanups.push(
    () => app.close(),
    () => scheduler.dispose(),
  )
  return { app, office }
}

describe('guards', () => {
  it('421 for foreign Host, 403 for foreign Origin, health needs no token', async () => {
    const { app } = setup()
    expect(
      (await app.inject({ url: '/api/agents', headers: { host: 'evil.com' } })).statusCode,
    ).toBe(421)
    expect(
      (
        await app.inject({
          url: '/api/agents',
          headers: { host: HOST, origin: 'https://evil.com' },
        })
      ).statusCode,
    ).toBe(403)
    expect((await app.inject({ url: '/api/health', headers: { host: HOST } })).json()).toEqual({
      ok: true,
      agents: 0,
    })
  })

  it('the old browser surfaces are gone: /, /ws and /api/session are 404', async () => {
    const { app } = setup()
    for (const url of ['/', '/ws', '/api/session', '/assets/x.js']) {
      expect((await app.inject({ url, headers: { host: HOST } })).statusCode).toBe(404)
    }
  })
})

describe('POST /api/events', () => {
  it('HTTP-spoof: producers cannot mark an agent as managed (unknown keys are stripped)', async () => {
    const { app, office } = setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: {
        agentId: 'cc:spoof',
        source: 'claude-code',
        managed: { phase: 'running', chrome: true, pending: 0 },
        permissionMode: 'plan',
      },
    })
    expect(res.statusCode).toBe(202)
    const agent = office.query.agent('cc:spoof')
    expect(agent).toBeDefined()
    expect(agent).not.toHaveProperty('managed')
    expect(JSON.stringify(office.query.snapshot())).not.toContain('"managed"')
  })

  it('401 without token; 202 for the minimal payload (compatibility guard) and for batches', async () => {
    const { app, office } = setup()
    const anon = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...json, host: HOST },
      payload: { agentId: 'a' },
    })
    expect(anon.statusCode).toBe(401)
    const one = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: { agentId: 'a' },
    })
    expect(one.statusCode).toBe(202)
    expect(one.json()).toEqual({ accepted: 1 })
    expect(office.query.agent('a')?.source).toBe('http')
    const batch = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: authed,
      payload: [{ agentId: 'b' }, { agentId: 'c' }],
    })
    expect(batch.json()).toEqual({ accepted: 2 })
  })

  it('202 for task + ended; 400 for an unknown ending or a task over 200 chars', async () => {
    const { app } = setup()
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/events', headers: authed, payload })
    expect(
      (await post({ agentId: 'a', task: 'Map the auth flow', ended: 'completed' })).statusCode,
    ).toBe(202)
    expect((await post({ agentId: 'a', ended: 'bogus' })).statusCode).toBe(400)
    expect((await post({ agentId: 'a', task: 'x'.repeat(201) })).statusCode).toBe(400)
    expect((await post({ agentId: 'a' })).statusCode).toBe(202)
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

describe('agents, messages, inbox, replies', () => {
  it('GET /api/agents lists agents', async () => {
    const { app, office } = setup()
    office.activity.report([{ agentId: 'a' }])
    expect(
      (await app.inject({ url: '/api/agents', headers: { host: HOST } }))
        .json()
        .map((a: { id: string }) => a.id),
    ).toEqual(['a'])
  })

  it('POST /messages maps domain errors: 404 unknown agent, 400 invalid, 401 no token, 429 rate limit', async () => {
    const { app, office } = setup({ rateLimitPerSec: 2 })
    const send = (id: string, payload: unknown, headers: Record<string, string> = authed) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${id}/messages`,
        headers,
        payload: payload as object,
      })
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
    expect(
      (await app.inject({ url: '/api/agents/a/inbox?claim=1', headers: bearerOnly })).json()
        .messages,
    ).toEqual([])
    expect(
      (await app.inject({ url: '/api/agents/a/inbox', headers: { host: HOST } })).statusCode,
    ).toBe(401)
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
    const reply = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/agents/a/replies', headers: authed, payload })
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
    expect(
      (await setup().app.inject({ method: 'POST', url: '/api/mock?n=3', headers: bearerOnly }))
        .statusCode,
    ).toBe(404)
    const spawned: number[] = []
    const { app } = setup({ mock: { spawn: (n) => spawned.push(n) } })
    const r = await app.inject({ method: 'POST', url: '/api/mock?n=5000', headers: bearerOnly })
    expect(r.statusCode).toBe(202)
    expect(spawned).toEqual([1000])
  })
})

describe('POST /api/providers/:provider/capabilities', () => {
  const url = '/api/providers/langgraph/capabilities'
  const decl = (id: string) => ({ id, category: 'adapter', kind: 'database', label: id })

  it('202 declares capabilities, which then appear in the snapshot', async () => {
    const { app, office } = setup()
    const res = await app.inject({
      method: 'POST',
      url,
      headers: authed,
      payload: [decl('mcp:pg')],
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ declared: 1 })
    expect(office.query.snapshot().capabilities).toEqual([
      expect.objectContaining({ id: 'mcp:pg', provider: 'langgraph', declared: true }),
    ])
  })

  it('401 without the token', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...json, host: HOST },
      payload: [decl('a')],
    })
    expect(res.statusCode).toBe(401)
  })

  it('400 for invalid bodies or provider names', async () => {
    const { app } = setup()
    for (const payload of [{ id: 'x' }, [{ id: 'x', category: 'nope', kind: 'api', label: 'x' }]])
      expect((await app.inject({ method: 'POST', url, headers: authed, payload })).statusCode).toBe(
        400,
      )
    const bad = await app.inject({
      method: 'POST',
      url: '/api/providers/bad%20name/capabilities',
      headers: authed,
      payload: [decl('a')],
    })
    expect(bad.statusCode).toBe(400)
  })

  it('413 for more than 64 declarations', async () => {
    const { app } = setup()
    const payload = Array.from({ length: 65 }, (_, i) => decl(`d${i}`))
    expect((await app.inject({ method: 'POST', url, headers: authed, payload })).statusCode).toBe(
      413,
    )
  })

  it('host and origin guards apply', async () => {
    const { app } = setup()
    const evil = await app.inject({
      method: 'POST',
      url,
      headers: { ...authed, host: 'evil.com' },
      payload: [decl('a')],
    })
    expect(evil.statusCode).toBe(421)
    const site = await app.inject({
      method: 'POST',
      url,
      headers: { ...authed, origin: 'https://evil.com' },
      payload: [decl('a')],
    })
    expect(site.statusCode).toBe(403)
  })

  it('404 when no capabilities port is wired', async () => {
    const { office, scheduler } = makeOffice()
    const app = buildHttpApi(
      { activity: office.activity, inbox: office.inbox, chat: office.chat, query: office.query },
      createAuth({ token: TOKEN, port: 4317 }),
    )
    cleanups.push(
      () => app.close(),
      () => scheduler.dispose(),
    )
    const res = await app.inject({ method: 'POST', url, headers: authed, payload: [] })
    expect(res.statusCode).toBe(404)
  })
})

describe('inbox flow step', () => {
  const view = (current: string | null) => ({
    current,
    steps: [
      { stepId: 'stp_aaaaaaaa', name: 'Plan', goal: 'Write the plan', secret: '/Users/me/x' },
      { stepId: 'stp_bbbbbbbb', name: 'Build', goal: 'Make it' },
    ],
  })
  const inbox = (app: ReturnType<typeof setup>['app'], q = '') =>
    app.inject({ url: `/api/agents/a/inbox${q}`, headers: bearerOnly })

  it('adds only the active step name and goal', async () => {
    const progress = vi.fn((_id: string) => view('stp_aaaaaaaa') as never)
    const { app } = setup({ flow: { progress } })
    const body = (await inbox(app, '?claim=1')).json()
    expect(body.step).toEqual({ name: 'Plan', goal: 'Write the plan' })
    expect(JSON.stringify(body)).not.toContain('/Users')
    expect(progress).toHaveBeenCalledWith('a')
  })

  it('caps name at 80 and goal at 200 characters', async () => {
    const v = {
      current: 's',
      steps: [{ stepId: 's', name: 'n'.repeat(300), goal: 'g'.repeat(300) }],
    }
    const { app } = setup({ flow: { progress: () => v as never } })
    const { step } = (await inbox(app)).json()
    expect([step.name.length, step.goal.length]).toEqual([80, 200])
  })

  it('omits step when there is no flow, no progress or no active step', async () => {
    expect((await inbox(setup().app)).json()).not.toHaveProperty('step')
    for (const v of [null, view(null), view('stp_zzzzzzzz')])
      expect(
        (await inbox(setup({ flow: { progress: () => v as never } }).app)).json(),
      ).not.toHaveProperty('step')
  })

  it('fails open when progress throws', async () => {
    const { app } = setup({
      flow: {
        progress: () => {
          throw new Error('boom /Users/me')
        },
      },
    })
    const r = await inbox(app, '?claim=1')
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ messages: [] })
  })
})
