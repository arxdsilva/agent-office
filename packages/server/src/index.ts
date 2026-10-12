import { fileURLToPath } from 'node:url'
import { createAuth, loadOrCreateToken } from './auth.ts'
import { loadConfig } from './config.ts'
import { buildApp } from './http.ts'
import { MessageStore } from './messages.ts'
import { ClaudeCodeSource } from './sources/claude-code.ts'
import { MockSource } from './sources/mock.ts'
import { AgentStore } from './store.ts'

const config = loadConfig()
const token = loadOrCreateToken(config.home)
const auth = createAuth({
  token,
  port: config.port,
  allowedHosts: config.allowedHosts,
  devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
})
const store = new AgentStore({
  idleAfterMs: config.idleAfterMs,
  expireAfterMs: config.expireAfterMs,
  doneTtlMs: 30_000,
  interactiveTtlMs: 600_000,
})
const messages = new MessageStore()

const claude = config.claudeEnabled
  ? new ClaudeCodeSource({
      dir: config.claudeProjectsDir,
      store,
      expireAfterMs: config.expireAfterMs,
      log: (m) => console.warn(m),
    })
  : undefined
const mock = config.mockEnabled ? new MockSource({ store, messages }) : undefined

const app = buildApp({
  store,
  messages,
  auth,
  staticDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
  ...(mock ? { mock } : {}),
})

const sweep = setInterval(() => store.sweep(), 2000)
claude?.start()
if (mock) {
  mock.seed()
  mock.start()
}

await app.listen({ port: config.port, host: config.host })
console.log(
  `agent-office listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
)
console.log(
  `sources: http${claude ? ', claude-code' : ''}${mock ? ', mock' : ''} · token: ${config.home}/token`,
)

const shutdown = async () => {
  clearInterval(sweep)
  claude?.stop()
  mock?.stop()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
