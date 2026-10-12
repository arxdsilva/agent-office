import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import {
  AgentEventBatchSchema,
  AgentReplySchema,
  ChatMessageSchema,
  type Agent,
  type ChatMessage,
  type ServerMessage,
} from '@agent-office/shared'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type { Auth } from './auth.ts'
import type { MessageStore } from './messages.ts'
import type { AgentStore } from './store.ts'

export interface AppOptions {
  store: AgentStore
  messages: MessageStore
  auth: Auth
  /** Built web client (packages/web/dist); served when it exists. */
  staticDir?: string
  rateLimitPerSec?: number
  logger?: boolean
  /** Present only in mock mode: enables POST /api/mock?n= for perf testing. */
  mock?: { spawn(n: number): void }
}

const MAX_WAIT_SEC = 25
const SNAPSHOT_MESSAGES_PER_AGENT = 50

export function buildApp(opts: AppOptions) {
  const { store, messages, auth } = opts
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 })
  const rateLimit = createRateLimiter(opts.rateLimitPerSec ?? 10)

  // Every request: Host allowlist (DNS rebinding) and Origin check (cross-site requests).
  app.addHook('onRequest', async (req, reply) => {
    const deny = (code: number, error: string) => {
      // A refused WebSocket upgrade never gets a normal response lifecycle; drop its socket.
      if (req.headers.upgrade) reply.raw.once('finish', () => req.raw.socket.destroy())
      return reply.code(code).header('connection', 'close').send({ error })
    }
    if (!auth.hostAllowed(req.headers.host)) return deny(421, 'host not allowed')
    if (!auth.originAllowed(req.headers.origin)) return deny(403, 'origin not allowed')
  })

  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth.bearerOk(req.headers.authorization))
      return reply.code(401).send({ error: 'missing or invalid token' })
  }

  app.get('/api/health', async () => ({ ok: true, agents: store.list().length }))

  app.get('/api/session', async () => ({ token: auth.token }))

  app.get('/api/agents', async () => store.list())

  app.post('/api/events', { preHandler: requireToken }, async (req, reply) => {
    const parsed = AgentEventBatchSchema.safeParse(req.body)
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid event', issues: parsed.error.issues })
    const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data]
    const now = Date.now()
    for (const e of events) store.apply({ source: 'http', ...e }, now)
    return reply.code(202).send({ accepted: events.length })
  })

  app.get<{ Params: { id: string } }>('/api/agents/:id/messages', async (req) =>
    messages.history(req.params.id),
  )

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/messages',
    { preHandler: requireToken },
    async (req, reply) => {
      const { id } = req.params
      if (!store.get(id)) return reply.code(404).send({ error: 'unknown agent' })
      const parsed = ChatMessageSchema.safeParse(req.body)
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid message', issues: parsed.error.issues })
      if (!rateLimit(id)) return reply.code(429).send({ error: 'too many messages' })
      const message = messages.enqueue(id, parsed.data.text)
      return reply.code(202).send({ message })
    },
  )

  app.get<{ Params: { id: string }; Querystring: { claim?: string; wait?: string } }>(
    '/api/agents/:id/inbox',
    { preHandler: requireToken },
    async (req) => {
      const { id } = req.params
      const claim = req.query.claim === '1' || req.query.claim === 'true'
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), MAX_WAIT_SEC)
      store.markInteractive(id)
      if (wait > 0) {
        const ac = new AbortController()
        req.raw.once('close', () => ac.abort())
        await messages.waitFor(id, wait * 1000, ac.signal)
      }
      const list = claim
        ? messages.claim(id)
        : messages.history(id).filter((m) => m.state === 'queued')
      return { messages: list }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/agents/:id/replies',
    { preHandler: requireToken },
    async (req, reply) => {
      const { id } = req.params
      const parsed = AgentReplySchema.safeParse(req.body)
      if (!parsed.success)
        return reply.code(400).send({ error: 'invalid reply', issues: parsed.error.issues })
      const { text, inReplyTo, requireAwaiting } = parsed.data
      if (requireAwaiting && messages.awaitingReply(id).length === 0) return reply.code(204).send()
      const message = messages.reply(id, text, inReplyTo)
      return reply.code(202).send({ message })
    },
  )

  if (opts.mock) {
    const mock = opts.mock
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

  // Keep each agent's unread badge in sync with its inbox.
  const onChat = (m: { agentId: string }) => store.setUnread(m.agentId, messages.unread(m.agentId))
  messages.on('chat', onChat)
  const onRemove = (id: string) => messages.drop(id)
  store.on('remove', onRemove)
  app.addHook('onClose', async () => {
    messages.off('chat', onChat)
    store.off('remove', onRemove)
  })

  app.register(fastifyWebsocket)
  app.register(async (scope) => {
    scope.get<{ Querystring: { token?: string } }>('/ws', { websocket: true }, (socket, req) => {
      if (!auth.tokenOk(req.query.token)) return socket.close(4401, 'invalid token')
      const send = (msg: ServerMessage) =>
        socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg))
      const upsert = (agent: Agent) => send({ type: 'upsert', agent })
      const remove = (id: string) => send({ type: 'remove', id })
      const chat = (message: ChatMessage) => send({ type: 'chat', message })
      send({
        type: 'snapshot',
        agents: store.list(),
        messages: messages.recent(SNAPSHOT_MESSAGES_PER_AGENT),
      })
      store.on('upsert', upsert)
      store.on('remove', remove)
      messages.on('chat', chat)
      socket.on('close', () => {
        store.off('upsert', upsert)
        store.off('remove', remove)
        messages.off('chat', chat)
      })
    })
  })

  if (opts.staticDir && existsSync(join(opts.staticDir, 'index.html'))) {
    const dir = opts.staticDir
    const html = () =>
      readFileSync(join(dir, 'index.html'), 'utf8').replace(
        '<meta name="agent-office-token" content="">',
        `<meta name="agent-office-token" content="${auth.token}">`,
      )
    // wildcard routing serves files created after startup (rebuilds while the server runs).
    app.register(fastifyStatic, { root: dir, index: false })
    app.get('/', (_req, reply) => reply.type('text/html').send(html()))
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0]!
      // Missing files (anything with an extension) are real 404s, not the SPA page.
      if (
        req.method !== 'GET' ||
        path.startsWith('/api/') ||
        path.startsWith('/ws') ||
        /\.[a-z0-9]+$/i.test(path)
      ) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.type('text/html').send(html())
    })
  }

  return app
}

/** Allows `perSec` calls per key in any rolling one-second window. */
function createRateLimiter(perSec: number) {
  const hits = new Map<string, number[]>()
  return (key: string, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 1000)
    if (recent.length >= perSec) {
      hits.set(key, recent)
      return false
    }
    recent.push(now)
    hits.set(key, recent)
    return true
  }
}
