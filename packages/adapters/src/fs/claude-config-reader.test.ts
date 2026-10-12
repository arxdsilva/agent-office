import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeConfigReader } from './claude-config-reader.ts'

// An invented ~/.claude.json: servers carry secret-looking commands, args and env that must never leak.
const CONFIG = {
  numStartups: 3,
  oauthAccount: { emailAddress: 'someone@example.com' },
  mcpServers: {
    github: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secret' } },
    'warehouse-db': { type: 'http', url: 'https://u:pw@db.example.com/?key=sk-live' },
  },
  projects: {
    '/home/dev/projects/shop': {
      mcpServers: { stripe: { command: 'stripe-mcp', env: { STRIPE_KEY: 'sk_live_x' } } },
      history: [{ display: 'private prompt' }],
    },
    '/home/dev/projects/other': { mcpServers: { linear: {} } },
  },
}

function file(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ao-ccfg-'))
  const path = join(dir, '.claude.json')
  writeFileSync(path, content)
  return path
}

describe('ClaudeConfigReader', () => {
  it('returns only the keys of top-level mcpServers and of the active cwds', async () => {
    const r = new ClaudeConfigReader(file(JSON.stringify(CONFIG)))
    expect(await r.mcpServers([])).toEqual(['github', 'warehouse-db'])
    expect(await r.mcpServers(['/home/dev/projects/shop', '/nowhere'])).toEqual([
      'github',
      'warehouse-db',
      'stripe',
    ])
  })

  it('never returns commands, args, URLs, env or other config', async () => {
    const r = new ClaudeConfigReader(file(JSON.stringify(CONFIG)))
    const out = JSON.stringify(
      await r.mcpServers(['/home/dev/projects/shop', '/home/dev/projects/other']),
    )
    for (const s of [
      'npx',
      'ghp_secret',
      'sk-live',
      'sk_live',
      'db.example.com',
      'someone',
      'private',
    ])
      expect(out).not.toContain(s)
  })

  it('dedups, drops malformed names and caps the list', async () => {
    const servers = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, {}]))
    const r = new ClaudeConfigReader(
      file(
        JSON.stringify({
          mcpServers: { ...servers, 'bad name': {}, ['x'.repeat(101)]: {} },
          projects: { '/p': { mcpServers: { s1: {} } } },
        }),
      ),
    )
    const got = await r.mcpServers(['/p'])
    expect(got).toHaveLength(24)
    expect(got).not.toContain('bad name')
    expect(new Set(got).size).toBe(got.length)
  })

  it('missing, invalid, oversized or oddly shaped files give []', async () => {
    expect(await new ClaudeConfigReader('/nowhere/.claude.json').mcpServers([])).toEqual([])
    expect(await new ClaudeConfigReader(file('{not json')).mcpServers([])).toEqual([])
    expect(await new ClaudeConfigReader(file('[1,2]')).mcpServers(['/p'])).toEqual([])
    expect(
      await new ClaudeConfigReader(
        file(JSON.stringify({ mcpServers: ['a'], projects: 1 })),
      ).mcpServers(['/p']),
    ).toEqual([])
    const big = file(JSON.stringify({ mcpServers: { a: {} }, pad: 'x'.repeat(2048) }))
    expect(await new ClaudeConfigReader(big, { maxBytes: 1024 }).mcpServers([])).toEqual([])
  })
})
