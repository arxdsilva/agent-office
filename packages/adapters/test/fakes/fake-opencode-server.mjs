#!/usr/bin/env node
// A stand-in for `opencode serve` (OpenCode 1.19.0 server API, verified against its /doc OpenAPI):
// exactly the read-only endpoints agent-office uses. It never runs a model and holds only the
// invented fixture it is given. Started as `fake-opencode-server.mjs serve --hostname H --port P`.
//
// Env:
//   OPENCODE_SERVER_PASSWORD   require HTTP Basic (user OPENCODE_SERVER_USERNAME or "opencode")
//   FAKE_OC_FIXTURE            JSON file: { sessions: GlobalSession[], messages: {id: [{info, parts}]},
//                              events: Event[] (payloads, streamed on each /global/event connect) }
//   FAKE_OC_LOG                append one JSON line per request: {method, path, authed}
//   FAKE_OC_IGNORE_TERM=1      ignore SIGTERM (to test SIGKILL escalation)
//   FAKE_OC_READY_DELAY_MS     wait before listening
//   FAKE_OC_EXIT=<code>        exit at once with this code (never ready)
//   FAKE_OC_SSE_CLOSE=1        end the event stream after the fixture events (reconnect tests)
//   FAKE_OC_EVENT_INTERVAL_MS  delay between streamed events (default 5)
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
if (argv[0] !== 'serve') {
  process.stderr.write('usage: serve --hostname H --port P\n')
  process.exit(2)
}
if (process.env.FAKE_OC_EXIT) process.exit(Number(process.env.FAKE_OC_EXIT))
if (process.env.FAKE_OC_IGNORE_TERM === '1') process.on('SIGTERM', () => {})

const host = flag('--hostname', '127.0.0.1')
const port = Number(flag('--port', '0'))
const fixture = process.env.FAKE_OC_FIXTURE
  ? JSON.parse(readFileSync(process.env.FAKE_OC_FIXTURE, 'utf8'))
  : { sessions: [], messages: {}, events: [] }
const password = process.env.OPENCODE_SERVER_PASSWORD
const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
const expected = password
  ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  : undefined
const interval = Number(process.env.FAKE_OC_EVENT_INTERVAL_MS ?? 5)

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bool = (v) => v === 'true' || v === '1'

function listSessions(q) {
  let list = [...(fixture.sessions ?? [])]
  if (bool(q.get('roots'))) list = list.filter((s) => !s.parentID)
  const dir = q.get('directory')
  if (dir) list = list.filter((s) => s.directory === dir)
  list = list.filter((s) => !s.time?.archived)
  list.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  const limit = q.get('limit')
  return limit ? list.slice(0, Number(limit)) : list
}

async function stream(res, wrap) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (payload, directory) =>
    res.write(
      `data: ${JSON.stringify(wrap ? { ...(directory ? { directory } : {}), payload } : payload)}\n\n`,
    )
  send({ id: 'evt_0', type: 'server.connected', properties: {} })
  for (const e of fixture.events ?? []) {
    if (res.destroyed) return
    await sleep(interval)
    const { directory, ...payload } = e
    send(payload, directory)
  }
  if (process.env.FAKE_OC_SSE_CLOSE === '1') res.end()
  else {
    const t = setInterval(() => res.write(': keep-alive\n\n'), 1000)
    res.on('close', () => clearInterval(t))
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}`)
  const authed = !expected || req.headers.authorization === expected
  if (process.env.FAKE_OC_LOG)
    appendFileSync(
      process.env.FAKE_OC_LOG,
      JSON.stringify({ method: req.method, path: url.pathname, authed }) + '\n',
    )
  if (!authed) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' })
    return res.end()
  }
  if (req.method !== 'GET') return json(res, 405, {})
  const p = url.pathname
  if (p === '/global/health') return json(res, 200, { healthy: true, version: '1.19.0' })
  if (p === '/experimental/session') return json(res, 200, listSessions(url.searchParams))
  if (p === '/session') return json(res, 200, listSessions(url.searchParams))
  const m = /^\/session\/([^/]+)\/message$/.exec(p)
  if (m) {
    const all = fixture.messages?.[decodeURIComponent(m[1])]
    if (!all) return json(res, 404, {})
    const limit = url.searchParams.get('limit')
    return json(res, 200, limit ? all.slice(-Number(limit)) : all)
  }
  if (p === '/global/event') return void stream(res, true)
  if (p === '/event') return void stream(res, false)
  json(res, 404, {})
})

setTimeout(
  () =>
    server.listen(port, host, () => {
      const a = server.address()
      process.stdout.write(`opencode server listening on http://${host}:${a.port}\n`)
    }),
  Number(process.env.FAKE_OC_READY_DELAY_MS ?? 0),
)
