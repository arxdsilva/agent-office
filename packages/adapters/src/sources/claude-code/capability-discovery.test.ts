import { ManualScheduler } from '@agent-office/core/testing'
import type { CapabilityDecl } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeCapabilityDiscovery } from './capability-discovery.ts'

const skill: CapabilityDecl = { id: 'skill:x', category: 'skill', kind: 'skill', label: 'x' }

function setup(o: { failKnowledge?: boolean } = {}) {
  const declared: [string, CapabilityDecl[]][] = []
  const asked: string[][] = []
  let cwds = ['/w/shop']
  const scheduler = new ManualScheduler()
  const warnings: string[] = []
  const d = new ClaudeCapabilityDiscovery({
    capabilities: { declare: (p, ds) => void declared.push([p, ds]) },
    config: {
      mcpServers: async (c) => (asked.push(c), ['github', 'claude_ai_Gmail']),
    },
    knowledge: {
      read: async () => {
        if (o.failKnowledge) throw new Error('EACCES /secret/path')
        return [skill]
      },
    },
    cwds: () => cwds,
    scheduler,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
  })
  return { d, declared, asked, scheduler, warnings, setCwds: (c: string[]) => (cwds = c) }
}

describe('ClaudeCapabilityDiscovery', () => {
  it('declares built-ins, configured MCP servers and knowledge for claude-code', async () => {
    const s = setup()
    await s.d.scan()
    expect(s.asked).toEqual([['/w/shop']])
    const [provider, decls] = s.declared[0]!
    expect(provider).toBe('claude-code')
    expect(decls.map((x) => x.id)).toEqual([
      'fs',
      'shell',
      'web',
      'subagents',
      'mcp:github',
      'mcp:claude_ai_Gmail',
      'skill:x',
    ])
    expect(decls.find((x) => x.id === 'mcp:claude_ai_Gmail')?.label).toBe('Gmail')
  })

  it('scans at start and every 60 s, and stops', async () => {
    const s = setup()
    s.d.start()
    await s.d.idle()
    expect(s.declared).toHaveLength(1)
    expect(s.scheduler.jobs[0]!.ms).toBe(60_000)
    s.scheduler.runAll()
    await s.d.idle()
    expect(s.declared).toHaveLength(2)
    s.d.stop()
    expect(s.scheduler.jobs[0]!.cancelled).toBe(true)
  })

  it('a new cwd triggers a rescan; overlapping requests coalesce into one more scan', async () => {
    const s = setup()
    const first = s.d.scan()
    s.setCwds(['/w/shop', '/w/web'])
    s.d.refresh()
    s.d.refresh()
    await first
    await s.d.idle()
    expect(s.declared).toHaveLength(2)
    expect(s.asked[1]).toEqual(['/w/shop', '/w/web'])
  })

  it('a failing reader still declares the rest and never logs paths', async () => {
    const s = setup({ failKnowledge: true })
    await s.d.scan()
    expect(s.declared[0]![1].map((x) => x.id)).toContain('mcp:github')
    expect(s.warnings).toEqual(['claude-code: capability discovery partly failed'])
  })
})
