import type { Agent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { trayModel } from './tray.ts'

const agent = (id: string, status: Agent['status'], lastSeen = 0): Agent => ({
  id,
  name: id.toUpperCase(),
  provider: 'p',
  topic: `topic ${id}`,
  status,
  source: 's',
  since: 0,
  lastSeen,
  interactive: false,
  unread: 0,
})

describe('trayModel', () => {
  it('summarizes busy and waiting agents in the title and lists waiting agents newest first', () => {
    const m = trayModel(
      [
        agent('a', 'tool'),
        agent('b', 'thinking'),
        agent('c', 'waiting', 1),
        agent('d', 'waiting', 2),
      ],
      true,
    )
    expect(m.title).toBe('⚙2 ✔2')
    expect(m.tooltip).toBe('agent-office — 4 agents, 2 waiting')
    const selects = m.items.flatMap((i) =>
      i !== 'separator' && i.action?.type === 'select' ? [i.action.agentId] : [],
    )
    expect(selects).toEqual(['d', 'c'])
    expect(m.items).toContainEqual({ label: 'Claude Code hook: installed ✓', enabled: false })
  })

  it('offers hook installation and has an empty title when idle', () => {
    const m = trayModel([agent('a', 'idle')], false)
    expect(m.title).toBe('')
    expect(m.items).toContainEqual({
      label: 'Install Claude Code hook…',
      action: { type: 'install-hook' },
    })
    expect(m.items.at(-1)).toEqual({ label: 'Quit agent-office', action: { type: 'quit' } })
  })

  it('caps the waiting list', () => {
    const many = Array.from({ length: 10 }, (_, i) => agent(`w${i}`, 'waiting', i))
    const m = trayModel(many, true)
    expect(m.items.filter((i) => i !== 'separator' && i.action?.type === 'select')).toHaveLength(8)
    expect(m.items).toContainEqual({ label: '  …and 2 more', enabled: false })
  })
})
