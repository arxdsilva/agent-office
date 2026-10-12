import type {
  AgentInbox,
  OfficeQuery,
  ReportActivity,
  ReportCapabilities,
  UserChat,
} from '@agent-office/core'
import {
  AgentEventBatchSchema,
  AgentReplySchema,
  CapabilityDeclBatchSchema,
  ChatMessageSchema,
} from '@agent-office/shared'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type { Auth } from './auth.ts'
import { httpStatusFor } from './errors.ts'

/** Mock-mode only: spawn N extra agents for perf testing. */
export interface MockControl {
  spawn(n: number): void
}

/** The driving ports this adapter needs — nothing concrete. */
export interface HttpApiPorts {
  activity: ReportActivity
  inbox: AgentInbox
  chat: UserChat
  query: OfficeQuery
  /** Generic providers declare what their agents can use (docs/capabilities.md §4). */
  capabilities?: ReportCapabilities
  mock?: MockControl
}

const MAX_WAIT_SEC = 25
const MAX_DECLS = 64
const PROVIDER = /^[A-Za-z0-9._:-]{1,100}$/

/**
 * Public local HTTP API (Claude Code hook, external agents, CLI). Routes only translate:
 * parse with zod → call a port → map the result/error to HTTP. Public contract: additive only.
 */
export function buildHttpApi(ports: HttpApiPorts, auth: Auth) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 })

  // Host allowlist blocks DNS rebinding; Origin check blocks cross-site browser requests.
  app.addHook('onRequest', async (req, reply) => {
    if (!auth.hostAllowed(req.headers.host))
      return reply.code(421).header('connection', 'close').send({ error: 'host not allowed' })
    if (!auth.originAllowed(req.headers.origin))
      return reply.code(403).header('connection', 'close').send({ error: 'origin not allowed' })
  })

  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth.bearerOk(req.headers.authorization))
      return reply.code(401).send({ error: 'missing or invalid token' })
  }

  app.setErrorHandler((err, _req, reply) => {
    const status = httpStatusFor(err)
    reply.code(status).send({ error: status === 500 ? 'internal error' : (err as Error).message })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }))

  app.get('/api/health', async () => ({ ok: true, agents: ports.query.agents().length }))
  app.get('/api/agents', async () => ports.query.agents())

  app.post('/api/events', { preHandler: requireToken }, async (req, reply) => {
    const parsed = AgentEventBatchSchema.safeParse(req.body)
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid event', issues: parsed.error.issues })
    const events = (Array.isArray(parsed.data) ? parsed.data : [parsed.data]).map((e) => ({
      source: 'http',
      ...e,
    }))
    ports.activity.report(events)
    return reply.code(202).send({ accepted: events.length })
  })

  app.get<{ Params: { id: string } }>('/api/agents/:id/messages', async (req) =>
    ports.chat.history(req.params.id),
  )

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/messages',
    { preHandler: requireToken },
    async (req, reply) => {
      const parsed = ChatMessageSchema.safeParse(req.body)
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid message', issues: parsed.error.issues })
      return reply.code(202).send({ message: ports.chat.send(req.params.id, parsed.data.text) })
    },
  )

  app.get<{ Params: { id: string }; Querystring: { claim?: string; wait?: string } }>(
    '/api/agents/:id/inbox',
    { preHandler: requireToken },
    async (req) => {
      const { id } = req.params
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), MAX_WAIT_SEC)
      if (wait > 0) {
        const ac = new AbortController()
        req.raw.once('close', () => ac.abort())
        await ports.inbox.waitForMessages(id, wait * 1000, ac.signal)
      }
      const claim = req.query.claim === '1' || req.query.claim === 'true'
      return { messages: claim ? ports.inbox.claim(id) : ports.inbox.peek(id) }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/replies',
    { preHandler: requireToken },
    async (req, reply) => {
      const parsed = AgentReplySchema.safeParse(req.body)
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid reply', issues: parsed.error.issues })
      const { text, inReplyTo, requireAwaiting } = parsed.data
      const message = ports.inbox.reply(req.params.id, text, {
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(requireAwaiting ? { requireAwaiting } : {}),
      })
      return message ? reply.code(202).send({ message }) : reply.code(204).send()
    },
  )

  if (ports.capabilities) {
    const capabilities = ports.capabilities
    app.post<{ Params: { provider: string } }>(
      '/api/providers/:provider/capabilities',
      { preHandler: requireToken },
      async (req, reply) => {
        const { provider } = req.params
        if (!PROVIDER.test(provider)) return reply.code(400).send({ error: 'invalid provider' })
        if (Array.isArray(req.body) && req.body.length > MAX_DECLS)
          return reply.code(413).send({ error: `at most ${MAX_DECLS} capabilities per request` })
        const parsed = CapabilityDeclBatchSchema.safeParse(req.body)
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: 'invalid capabilities', issues: parsed.error.issues })
        capabilities.declare(provider, parsed.data)
        return reply.code(202).send({ declared: parsed.data.length })
      },
    )
  }

  if (ports.mock) {
    const mock = ports.mock
    app.post<{ Querystring: { n?: string } }>(
      '/api/mock',
      { preHandler: requireToken },
      async (req, reply) => {
        const n = Math.min(Math.max(Number(req.query.n) || 0, 0), 1000)
        mock.spawn(n)
        return reply.code(202).send({ spawned: n })
      },
    )
  }

  return app
}

export type HttpApi = ReturnType<typeof buildHttpApi>
