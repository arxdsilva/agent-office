// Driving adapter: agent-office's project MCP server (docs/projects.md §5) on the local API.
// JSON-only Streamable HTTP: every POST carries one JSON-RPC message and gets one JSON answer (no
// SSE, no sessions). Every call goes through McpMemoryAccess, which authorizes it against the
// token's principal. Never logs or echoes message bodies.
import {
  DomainError,
  type McpMemoryAccess,
  type McpPrincipal,
  RateLimitedError,
  ValidationError,
} from '@agent-office/core'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** Newest first; `initialize` echoes the client's version when it is listed here. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const MCP_BODY_LIMIT = 64 * 1024

const SERVER_INFO = { name: 'agent-office', version: '1' }
/** `mcp_` + 32 random bytes (hex or base64url); anything else is rejected before the port. */
const BEARER = /^Bearer (mcp_[A-Za-z0-9_-]{16,200})$/

type Id = string | number
type Obj = Record<string, unknown>

const ERR = {
  parse: { code: -32700, message: 'parse error' },
  invalid: { code: -32600, message: 'invalid request' },
  method: { code: -32601, message: 'method not found' },
  internal: { code: -32603, message: 'internal error' },
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (v: unknown): v is Id =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

const principals = new WeakMap<FastifyRequest, McpPrincipal>()

function errorBody(id: Id | null, error: { code: number; message: string }) {
  return { jsonrpc: '2.0', id, error }
}

function textResult(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Registers `POST /mcp` (and 405 for GET/DELETE) on the existing API app. */
export function registerMcpRoute(app: FastifyInstance, access: McpMemoryAccess): void {
  // The app-wide onRequest hook (Host allowlist, Origin check) runs first; then this token check,
  // before the body is read, so anonymous callers learn nothing (401, empty body).
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = BEARER.exec(req.headers.authorization ?? '')
    let p: McpPrincipal | null = null
    try {
      p = m ? access.principal(m[1]!) : null
    } catch {
      p = null
    }
    if (!p) return reply.code(401).send()
    principals.set(req, p)
  }

  const answer = (reply: FastifyReply, id: Id, result: unknown) =>
    reply.code(200).type('application/json').send({ jsonrpc: '2.0', id, result })

  app.route({
    method: 'POST',
    url: '/mcp',
    bodyLimit: MCP_BODY_LIMIT,
    onRequest: authenticate,
    errorHandler: (err: FastifyError, _req, reply) => {
      const status = err.statusCode ?? 500
      if (status === 400) return reply.code(400).send(errorBody(null, ERR.parse))
      if (status === 413)
        return reply
          .code(413)
          .send(errorBody(null, { code: ERR.invalid.code, message: 'request too large' }))
      if (status === 415) return reply.code(415).send(errorBody(null, ERR.invalid))
      return reply.code(500).send(errorBody(null, ERR.internal))
    },
    handler: async (req, reply) => {
      const version = req.headers['mcp-protocol-version']
      if (version !== undefined && !MCP_PROTOCOL_VERSIONS.includes(String(version)))
        return reply
          .code(400)
          .send(
            errorBody(null, { code: ERR.invalid.code, message: 'unsupported protocol version' }),
          )

      const msg = req.body
      if (!isObj(msg) || msg.jsonrpc !== '2.0')
        return reply.code(400).send(errorBody(null, ERR.invalid))
      if (!('method' in msg)) {
        // A client's response to a server request (we send none): accept and ignore.
        if (isId(msg.id) && ('result' in msg || 'error' in msg)) return reply.code(202).send()
        return reply.code(400).send(errorBody(null, ERR.invalid))
      }
      if (typeof msg.method !== 'string') return reply.code(400).send(errorBody(null, ERR.invalid))
      if (!('id' in msg)) return reply.code(202).send() // notifications/initialized, cancelled, …
      if (!isId(msg.id)) return reply.code(400).send(errorBody(null, ERR.invalid))

      const id = msg.id
      const principal = principals.get(req)!
      try {
        return answer(reply, id, await dispatch(access, principal, msg.method, msg.params))
      } catch (err) {
        const e = err instanceof RpcError ? { code: err.code, message: err.message } : ERR.internal
        return reply.code(200).type('application/json').send(errorBody(id, e))
      }
    },
  })

  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    errorHandler: (_err, _req, reply) => reply.code(405).header('allow', 'POST').send(),
    handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send(),
  })
}

async function dispatch(
  access: McpMemoryAccess,
  principal: McpPrincipal,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const asked = isObj(params) ? params.protocolVersion : undefined
      const protocolVersion =
        typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0]
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: access.tools(principal) }
    case 'tools/call':
      return callTool(access, principal, params)
    default:
      throw new RpcError(ERR.method.code, ERR.method.message)
  }
}

async function callTool(access: McpMemoryAccess, principal: McpPrincipal, params: unknown) {
  if (!isObj(params) || typeof params.name !== 'string')
    throw new RpcError(-32602, 'invalid params')
  const args = params.arguments ?? {}
  if (!isObj(args)) throw new RpcError(-32602, 'invalid params')
  const name = params.name
  if (!access.tools(principal).some((t) => t.name === name))
    throw new RpcError(-32602, 'unknown tool')
  try {
    const r = await access.call(principal, name, args)
    return {
      content: [{ type: 'text', text: r.text }],
      structuredContent: r.structured,
      ...(r.isError ? { isError: true } : {}),
    }
  } catch (err) {
    // ValidationError messages are authored by the core (no user data); others stay generic.
    if (err instanceof ValidationError) throw new RpcError(-32602, err.message)
    if (err instanceof RateLimitedError)
      return textResult('Rate limit reached for this session. Try again in a minute.')
    if (err instanceof DomainError) return textResult('Not allowed for this session.')
    throw err
  }
}
