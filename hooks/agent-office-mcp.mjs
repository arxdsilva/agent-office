#!/usr/bin/env node
// agent-office MCP bridge: stdio ⇄ HTTP (docs/projects.md §5).
//
// An agent (Claude Code, Codex, an ACP agent) starts this as a stdio MCP server through the
// generated wrapper in <userData>/mcp/. Each NDJSON JSON-RPC message from stdin is POSTed to
// agent-office's local `/mcp` endpoint with the session's MCP token; each JSON answer is written
// to stdout as one line. Notifications get no output.
//
// It never crashes the agent and never logs: on any failure a request gets a JSON-RPC error, a
// notification gets nothing, and nothing is written to stderr (no token, no message content).
// The token is sent only to a loopback http URL. Exits when stdin closes.
//
// Env: AGENT_OFFICE_MCP_URL (http://127.0.0.1:<port>/mcp), AGENT_OFFICE_MCP_TOKEN (mcp_…).
// No dependencies: Node built-ins only.
import { fileURLToPath } from 'node:url'

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/mcp$/
const UNREACHABLE = { code: -32603, message: 'agent-office is not reachable' }

/** @param {unknown} url */
export function loopbackUrl(url) {
  return typeof url === 'string' && LOOPBACK.test(url)
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isId = (v) => typeof v === 'string' || typeof v === 'number'

/**
 * Forwards one stdin line; returns what to write to stdout ('' for nothing).
 * @param {string} line
 * @param {{url?: string, token?: string, fetch: typeof fetch, timeoutMs: number, state: {version?: string}}} deps
 * @returns {Promise<string>}
 */
export async function forward(line, deps) {
  if (!line.trim()) return ''
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  const id = isObj(msg) && 'method' in msg && isId(msg.id) ? msg.id : undefined
  const fail = () => (id === undefined ? '' : reply({ jsonrpc: '2.0', id, error: UNREACHABLE }))
  if (!deps.token || !loopbackUrl(deps.url)) return fail()
  try {
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${deps.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (deps.state.version) headers['mcp-protocol-version'] = deps.state.version
    const res = await deps.fetch(/** @type {string} */ (deps.url), {
      method: 'POST',
      headers,
      body: line,
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    const text = await res.text()
    if (id === undefined) return '' // notifications and client responses: nothing to relay
    let body
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      return fail()
    }
    if (!isObj(body) || body.jsonrpc !== '2.0' || !('result' in body || 'error' in body))
      return fail()
    if (res.status === 200 && isObj(msg) && msg.method === 'initialize') {
      const v = isObj(body.result) ? body.result.protocolVersion : undefined
      if (typeof v === 'string') deps.state.version = v
    }
    // Errors answered before the server saw the id (e.g. 400 invalid request) carry id null.
    return reply({ ...body, id })
  } catch {
    return fail()
  }
}

/** @param {unknown} m */
const reply = (m) => `${JSON.stringify(m)}\n`

/**
 * Reads NDJSON from `input`, forwards each line concurrently, writes answers with `write`.
 * Resolves when input ends and every in-flight request has been answered.
 * @param {AsyncIterable<string | Buffer>} input
 * @param {(s: string) => void} write
 * @param {Parameters<typeof forward>[1]} deps
 */
export async function runBridge(input, write, deps) {
  const pending = new Set()
  const send = (line) => {
    const p = forward(line.replace(/\r$/, ''), deps).then((out) => {
      if (out) write(out)
    })
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }
  let buf = ''
  for await (const chunk of input) {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      send(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  if (buf) send(buf)
  await Promise.allSettled([...pending])
}

/* v8 ignore start -- process glue; exercised by the child-process tests in agent-office-mcp.test.ts */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The agent closing our stdout (EPIPE) or anything unexpected: exit quietly, never print.
  process.stdout.on('error', () => process.exit(0))
  process.on('uncaughtException', () => process.exit(0))
  process.stdin.setEncoding('utf8')
  runBridge(process.stdin, (s) => process.stdout.write(s), {
    url: process.env.AGENT_OFFICE_MCP_URL,
    token: process.env.AGENT_OFFICE_MCP_TOKEN,
    fetch,
    timeoutMs: 30_000,
    state: {},
  }).finally(() => {
    process.exitCode = 0
  })
}
/* v8 ignore stop */
