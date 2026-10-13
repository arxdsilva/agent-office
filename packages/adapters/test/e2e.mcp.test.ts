// The project MCP server end to end (docs/projects.md §5): the real Fastify app on port 0 with a
// fake McpMemoryAccess, driven by the official MCP SDK client (conformance), by the real stdio bridge
// through the real launcher wrapper, and by the fake Codex and ACP agents' `/mcp` scenario through
// the real CodexRunner and AcpRunner. Nothing here touches a real CLI or the user's settings.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnerSession, RunnerStart } from '@agent-office/core'
import { MemoryLogger } from '@agent-office/core/testing'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createAuth, type Auth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import { McpLauncher } from '../src/mcp/mcp-launcher.ts'
import { AcpRunner, CodexRunner, CURSOR_PROFILE } from '../src/providers/index.ts'
import { fakeMcpAccess, GOOD_TOKEN, PREFACE } from './fakes/fake-mcp-access.ts'
import { makeOffice } from './support.ts'

const BRIDGE = join(import.meta.dirname, '..', '..', '..', 'hooks', 'agent-office-mcp.mjs')
const FAKE_CODEX = join(import.meta.dirname, 'fakes', 'fake-codex-app-server.mjs')
const FAKE_ACP = join(import.meta.dirname, 'fakes', 'fake-acp-agent.mjs')
const API_TOKEN = 'f'.repeat(64)

const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-mcp-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

/** Real core + real API with the MCP route, on a random port; plus a launcher for the bridge. */
async function startMcpServer() {
  const { office, scheduler } = makeOffice()
  const access = fakeMcpAccess()
  let current = createAuth({ token: API_TOKEN, port: 0 })
  const auth: Auth = {
    token: API_TOKEN,
    hostAllowed: (h) => current.hostAllowed(h),
    originAllowed: (o) => current.originAllowed(o),
    bearerOk: (h) => current.bearerOk(h),
    tokenOk: (t) => current.tokenOk(t),
  }
  const app = buildHttpApi(
    {
      activity: office.activity,
      inbox: office.inbox,
      chat: office.chat,
      query: office.query,
      mcp: access,
    },
    auth,
  )
  const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
  current = createAuth({ token: API_TOKEN, port: server.port })
  cleanup.push(
    () => server.close(),
    () => scheduler.dispose(),
  )
  const base = `http://127.0.0.1:${server.port}`
  const launcher = new McpLauncher({
    userData: mkdtempSync(join(dir, 'ud-')),
    execPath: process.execPath,
    script: BRIDGE,
    platform: process.platform,
    runAsNode: false,
    url: () => base,
  })
  await launcher.ensureInstalled()
  return { access, base, launcher }
}

const newClient = () => new Client({ name: 'conformance', version: '1' })

describe('MCP SDK conformance', () => {
  it('Streamable HTTP: initialize, list tools and call search_memory', async () => {
    const { base, access } = await startMcpServer()
    const client = newClient()
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${GOOD_TOKEN}` } },
    })
    await client.connect(transport)
    cleanup.push(() => client.close())
    expect(client.getServerVersion()).toMatchObject({ name: 'agent-office' })
    expect(client.getServerCapabilities()).toEqual({ tools: {} })

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('search_memory')

    const r = await client.callTool({ name: 'search_memory', arguments: { query: 'deploy' } })
    expect(r.isError).toBeFalsy()
    expect((r.content as { type: string; text: string }[])[0]!.text.startsWith(PREFACE)).toBe(true)
    expect(r.structuredContent).toEqual({
      items: [{ id: 'mem_2', title: 'Deploys go through make release', version: 1, kind: 'fact' }],
    })
    expect(access.calls.map((c) => c.principal.sessionId)).toEqual(['ms_1'])
    await client.ping()
  })

  it('Streamable HTTP: a bad token cannot connect', async () => {
    const { base } = await startMcpServer()
    const client = newClient()
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer mcp_${'0'.repeat(64)}` } },
    })
    await expect(client.connect(transport)).rejects.toThrow()
  })

  it('stdio: through the launcher wrapper and the real bridge; nothing on stderr', async () => {
    const { launcher } = await startMcpServer()
    const mcp = launcher.launch(GOOD_TOKEN)
    const transport = new StdioClientTransport({
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (c) => (stderr += c))
    const client = newClient()
    await client.connect(transport)
    cleanup.push(() => client.close())

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('search_memory')
    const r = await client.callTool({ name: 'search_memory', arguments: { query: 'pnpm' } })
    expect(r.structuredContent).toMatchObject({ items: [{ id: 'mem_1' }] })
    // Tool errors from the core come back as JSON-RPC errors through the bridge.
    await expect(client.callTool({ name: 'boom', arguments: {} })).rejects.toThrow(/internal error/)
    await client.close()
    // No-leak: the bridge never writes the token or message bodies anywhere but stdout.
    expect(stderr).toBe('')
  })
})

// The fake agents act as MCP clients for `/mcp <query>` prompts (test/fakes/mcp-probe.mjs).
const START: RunnerStart = {
  cwd: dir,
  mode: 'default',
  extraDirs: [],
  chrome: false,
  allowBypass: false,
}

async function ask(s: RunnerSession, prompt: string): Promise<string> {
  s.onPermission(async () => ({ behavior: 'allow' }))
  const result = new Promise<string>((resolve) => s.onResult((r) => resolve(r.text)))
  await s.sessionId
  s.push(prompt)
  return result
}

describe('managed sessions retrieve over MCP (fake agents)', () => {
  const codex = () =>
    new CodexRunner({
      bin: process.execPath,
      args: [FAKE_CODEX, 'app-server'],
      env: {},
      log: new MemoryLogger(),
    })
  const acp = () =>
    new AcpRunner(CURSOR_PROFILE, {
      bin: process.execPath,
      args: [FAKE_ACP, '--profile', 'cursor'],
      env: {},
      log: new MemoryLogger(),
    })

  for (const [name, make] of [
    ['Codex (thread/start config.mcp_servers)', codex],
    ['ACP (session/new mcpServers)', acp],
  ] as const) {
    it(`${name}: finds the approved memory through the bridge`, async () => {
      const { launcher, access } = await startMcpServer()
      const s = make().start({ ...START, mcp: launcher.launch(GOOD_TOKEN) })
      cleanup.push(() => s.close())
      // The fake agent spawns the wrapper, initializes, calls search_memory and replies with titles.
      expect(await ask(s, '/mcp pnpm')).toBe('mcp: Use pnpm, not npm')
      expect(access.calls).toMatchObject([{ tool: 'search_memory', args: { query: 'pnpm' } }])
    })

    it(`${name}: no hits → none; a revoked token or no MCP → unavailable`, async () => {
      const { launcher, access } = await startMcpServer()
      const s = make().start({ ...START, mcp: launcher.launch(GOOD_TOKEN) })
      cleanup.push(() => s.close())
      expect(await ask(s, '/mcp kubernetes')).toBe('mcp: none')
      access.revoke()
      const s2 = make().start({ ...START, mcp: launcher.launch(GOOD_TOKEN) })
      cleanup.push(() => s2.close())
      expect(await ask(s2, '/mcp pnpm')).toBe('mcp: unavailable')
      const s3 = make().start(START)
      cleanup.push(() => s3.close())
      expect(await ask(s3, '/mcp pnpm')).toBe('mcp: unavailable')
    })
  }
})
