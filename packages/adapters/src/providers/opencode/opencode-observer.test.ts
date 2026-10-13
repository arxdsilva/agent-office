import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentEvent } from '@agent-office/shared'
import { AgentEventSchema } from '@agent-office/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mapOpenCodeEvent,
  newObserverContext,
  OpenCodeObserver,
  type OpenCodeObserverState,
} from './opencode-observer.ts'

const SECRET_DIR = '/Users/alice/clients/acme-secret-merger'
const SECRET_URL = 'https://internal.example.com/admin?token=sk-live-SENTINEL'
const SECRET_PROMPT = 'PROMPT-CANARY please wire $500k to account 1234'
const SECRET_OUT = 'OUTPUT-CANARY AWS_SECRET_ACCESS_KEY=abc'
const SECRET_ENV = 'ENV-CANARY=hunter2'

/** Every event type the observer cares about, stuffed with secret-looking values. */
const FRAMES: unknown[] = [
  { payload: { type: 'server.connected', properties: {} } },
  {
    directory: SECRET_DIR,
    payload: {
      type: 'session.created',
      properties: {
        sessionID: 'ses_a1',
        info: {
          id: 'ses_a1',
          title: SECRET_PROMPT,
          directory: SECRET_DIR,
          time: { created: 1, updated: 1 },
        },
      },
    },
  },
  {
    directory: SECRET_DIR,
    payload: {
      type: 'session.created',
      properties: {
        sessionID: 'ses_c1',
        info: {
          id: 'ses_c1',
          parentID: 'ses_a1',
          title: SECRET_PROMPT,
          directory: SECRET_DIR,
          time: { created: 2 },
        },
      },
    },
  },
  {
    payload: {
      type: 'session.status',
      properties: { sessionID: 'ses_a1', status: { type: 'busy' } },
    },
  },
  {
    payload: {
      type: 'message.updated',
      properties: {
        sessionID: 'ses_a1',
        info: {
          id: 'msg_u',
          role: 'user',
          sessionID: 'ses_a1',
          time: { created: 3 },
          system: SECRET_PROMPT,
        },
      },
    },
  },
  {
    payload: {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a1',
        part: { type: 'text', text: SECRET_PROMPT, sessionID: 'ses_a1' },
      },
    },
  },
  {
    payload: {
      type: 'message.updated',
      properties: {
        sessionID: 'ses_a1',
        info: {
          id: 'msg_a',
          role: 'assistant',
          sessionID: 'ses_a1',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          path: { cwd: SECRET_DIR, root: SECRET_DIR },
          time: { created: 4 },
        },
      },
    },
  },
  {
    payload: {
      type: 'message.part.updated',
      properties: { sessionID: 'ses_a1', part: { type: 'step-start' } },
    },
  },
  {
    payload: {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a1',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: {
            status: 'running',
            input: { command: `curl ${SECRET_URL}`, env: SECRET_ENV },
            title: SECRET_URL,
          },
        },
      },
    },
  },
  // The same running tool again: deduplicated.
  {
    payload: {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a1',
        part: { type: 'tool', tool: 'bash', state: { status: 'running' } },
      },
    },
  },
  {
    payload: {
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a1',
        part: { type: 'tool', tool: 'bash', state: { status: 'completed', output: SECRET_OUT } },
      },
    },
  },
  {
    payload: { type: 'message.part.delta', properties: { sessionID: 'ses_a1', delta: SECRET_OUT } },
  },
  {
    payload: {
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_a1',
        permission: 'bash',
        patterns: [SECRET_URL],
        metadata: { cmd: SECRET_ENV },
      },
    },
  },
  { payload: { type: 'session.idle', properties: { sessionID: 'ses_a1' } } },
  {
    payload: {
      type: 'session.error',
      properties: {
        sessionID: 'ses_c1',
        error: { name: 'APIError', data: { message: SECRET_OUT } },
      },
    },
  },
  { payload: { type: 'file.edited', properties: { file: SECRET_DIR + '/x.ts' } } },
  { payload: { type: 'tui.prompt.append', properties: { text: SECRET_PROMPT } } },
  {
    payload: {
      type: 'session.deleted',
      properties: { sessionID: 'ses_c1', info: { id: 'ses_c1', time: { created: 1 } } },
    },
  },
  {
    payload: {
      type: 'session.status',
      properties: { sessionID: '../../etc/passwd', status: { type: 'busy' } },
    },
  },
  {
    payload: {
      type: 'session.status',
      properties: { sessionID: 'ses_a1', status: { type: 'retry', message: SECRET_OUT } },
    },
  },
  { payload: 'not an object' },
  null,
]

function mapAll(frames: unknown[], skip?: (id: string) => boolean): AgentEvent[] {
  const ctx = newObserverContext()
  const out: AgentEvent[] = []
  for (const f of frames) {
    const e = mapOpenCodeEvent(f, ctx, { now: 1234, ...(skip ? { skip } : {}) })
    if (e) out.push(e)
  }
  return out
}

describe('mapOpenCodeEvent', () => {
  it('emits metadata-only events for oc:<sessionId>', () => {
    const out = mapAll(FRAMES)
    const brief = out.map((e) => [e.agentId, e.status, e.tool, e.model].filter(Boolean).join(' '))
    expect(brief).toEqual([
      'oc:ses_a1 idle',
      'oc:ses_c1 idle',
      'oc:ses_a1 thinking',
      'oc:ses_a1 claude-sonnet-4-5',
      'oc:ses_a1 tool Bash',
      'oc:ses_a1 thinking',
      'oc:ses_a1 waiting',
      'oc:ses_c1 error',
      'oc:ses_c1 done',
      'oc:ses_a1 thinking',
    ])
    const first = out[0]!
    expect(first).toEqual({
      agentId: 'oc:ses_a1',
      provider: 'opencode',
      source: 'opencode',
      status: 'idle',
      name: 'acme-secret-merger',
      topic: 'acme-secret-merger',
      ts: 1234,
    })
    expect(out[1]!.parentId).toBe('oc:ses_a1')
    expect(out[3]!.modelProvider).toBe('anthropic')
    for (const e of out) expect(AgentEventSchema.safeParse(e).success).toBe(true)
  })

  it('never leaks prompts, outputs, paths, URLs or env values (sentinels)', () => {
    const all = JSON.stringify(mapAll(FRAMES))
    for (const s of [
      SECRET_DIR,
      SECRET_URL,
      SECRET_PROMPT,
      SECRET_OUT,
      SECRET_ENV,
      'sk-live',
      'CANARY',
      '/Users',
      'passwd',
    ])
      expect(all).not.toContain(s)
    for (const e of mapAll(FRAMES)) {
      expect(e.text).toBeUndefined()
      for (const v of Object.values(e))
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(100)
    }
  })

  it('skips sessions agent-office manages itself', () => {
    expect(mapAll(FRAMES, (id) => id === 'ses_a1').every((e) => e.agentId !== 'oc:ses_a1')).toBe(
      true,
    )
  })

  it('handles project basenames safely and archived sessions as done', () => {
    const ctx = newObserverContext()
    const ev = (info: unknown) =>
      mapOpenCodeEvent({ payload: { type: 'session.updated', properties: { info } } }, ctx, {
        now: 1,
      })
    // Nothing to say (no status, no usable project name): no event at all.
    expect(ev({ id: 'ses_x', directory: '/', time: { created: 1 } })).toBeUndefined()
    expect(
      ev({ id: 'ses_y', directory: 'C:\\Users\\bob\\proj', time: { created: 1 } })!.topic,
    ).toBe('proj')
    expect(ev({ id: 'ses_z', time: { created: 1, archived: 9 } })!.status).toBe('done')
    expect(
      ev({ id: 'ses_q', directory: '/a/' + 'n'.repeat(300), time: { created: 1 } }),
    ).toBeUndefined()
  })
})

describe('OpenCodeObserver', () => {
  let close: (() => void)[] = []
  afterEach(() => {
    for (const c of close) c()
    close = []
  })

  async function server(
    handler: (res: ServerResponse, n: number, path: string, auth?: string) => void,
  ) {
    let n = 0
    const srv = createServer((req, res) =>
      handler(res, n++, req.url ?? '', req.headers.authorization),
    )
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    close.push(() => {
      srv.closeAllConnections()
      srv.close()
    })
    return (srv.address() as AddressInfo).port
  }
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('connects read-only to /global/event, reports events and reconnects', async () => {
    const paths: string[] = []
    const auths: (string | undefined)[] = []
    const port = await server((res, n, path, auth) => {
      paths.push(path)
      auths.push(auth)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ directory: SECRET_DIR, payload: { type: 'session.status', properties: { sessionID: `ses_n${n}`, status: { type: 'busy' } } } })}\n\n`,
      )
    })
    const reported: AgentEvent[] = []
    const states: OpenCodeObserverState[] = []
    const obs = new OpenCodeObserver({
      activity: { report: (e) => (reported.push(...e), e.length) },
      onState: (s) => states.push(s),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    expect(obs.state()).toBe('off')
    obs.configure({ enabled: true, port })
    obs.configure({ enabled: true, port }) // same config: no reconnect storm
    await until(() => reported.length >= 2)
    expect(reported[0]).toMatchObject({
      agentId: 'oc:ses_n0',
      status: 'thinking',
      provider: 'opencode',
    })
    expect(paths.every((p) => p === '/global/event')).toBe(true)
    expect(auths.every((a) => a === undefined)).toBe(true)
    expect(states).toContain('connected')
    obs.configure({ enabled: false })
    expect(obs.state()).toBe('off')
    const n = reported.length
    await new Promise((r) => setTimeout(r, 60))
    expect(reported.length).toBe(n)
  })

  it('reports unreachable and auth-required, and stop() ends it', async () => {
    const states: OpenCodeObserverState[] = []
    const obs = new OpenCodeObserver({
      activity: { report: () => 0 },
      onState: (s) => states.push(s),
      backoff: { initialMs: 5, maxMs: 10 },
    })
    obs.configure({ enabled: true, port: 1 })
    await until(() => states.includes('unreachable'))
    const port = await server((res) => void res.writeHead(401).end())
    obs.configure({ enabled: true, port })
    await until(() => obs.state() === 'auth-required')
    obs.stop()
    expect(obs.state()).toBe('off')
    // Enabled without a port: off.
    obs.configure({ enabled: true })
    expect(obs.state()).toBe('off')
  })

  it('a throwing activity sink does not break the stream', async () => {
    const port = await server((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ payload: { type: 'session.idle', properties: { sessionID: 'ses_t' } } })}\n\n`,
      )
      res.write(`data: {broken json\n\n`)
      res.write(
        `data: ${JSON.stringify({ payload: { type: 'session.idle', properties: { sessionID: 'ses_u' } } })}\n\n`,
      )
    })
    let calls = 0
    const obs = new OpenCodeObserver({
      activity: {
        report: () => {
          calls++
          throw new Error('sink down')
        },
      },
    })
    obs.configure({ enabled: true, port })
    await until(() => calls >= 2)
    obs.stop()
  })
})
