// Used by the fake Codex and ACP agents for their `/mcp <query>` scenario: acts as an MCP client
// the way a real agent does: spawn the given stdio server, initialize, call search_memory, close.
// Returns `mcp: <titles>`, `mcp: none` (no hits) or `mcp: unavailable` (no server, or any error).
import { spawn } from 'node:child_process'

/**
 * @param {{command: string, args?: string[], env?: Record<string, string>} | undefined} server
 * @param {string} query
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export function probeMcp(server, query, timeoutMs = 5000) {
  if (!server?.command) return Promise.resolve('mcp: unavailable')
  return new Promise((resolve) => {
    let done = false
    const finish = (text) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.end()
      resolve(text)
    }
    const timer = setTimeout(() => finish('mcp: unavailable'), timeoutMs)
    const child = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.on('error', () => finish('mcp: unavailable'))
    child.on('close', () => finish('mcp: unavailable'))
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          if (m.error) return finish('mcp: unavailable')
          send({ method: 'notifications/initialized' })
          send({
            id: 2,
            method: 'tools/call',
            params: { name: 'search_memory', arguments: { query } },
          })
        } else if (m.id === 2) {
          const items = m.result?.structuredContent?.items
          if (m.error || m.result?.isError || !Array.isArray(items))
            return finish('mcp: unavailable')
          const titles = items.map((x) => x?.title).filter((t) => typeof t === 'string')
          finish(titles.length ? `mcp: ${titles.join(', ')}` : 'mcp: none')
        }
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-agent', version: '1' },
      },
    })
  })
}
