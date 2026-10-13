import type { ReportActivity, SessionObservation } from '@agent-office/core'
import type { AgentEvent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { observeWorkspace } from './workspace-observer.ts'

const KEY = 'wk_' + 'a'.repeat(32)

function setup(report: () => number = () => 1) {
  const reported: AgentEvent[][] = []
  const located: [string, string, { workspaceKey?: string }][] = []
  const inner: ReportActivity = {
    report: (e) => {
      reported.push(e)
      return report()
    },
  }
  const observation: SessionObservation = {
    located: async (a, p, w) => {
      located.push([a, p, w])
    },
  }
  return { reported, located, wrapped: observeWorkspace(inner, observation) }
}

describe('observeWorkspace', () => {
  it('reports first, then locates events that carry a workspace key', () => {
    const s = setup()
    const n = s.wrapped.report([
      { agentId: 'a1', provider: 'cursor', workspace: KEY },
      { agentId: 'a2', status: 'idle' },
    ])
    expect(n).toBe(1)
    expect(s.reported).toHaveLength(1)
    expect(s.located).toEqual([['a1', 'cursor', { workspaceKey: KEY }]])
  })

  it('falls back to the source when the event has no provider', () => {
    const s = setup()
    s.wrapped.report([{ agentId: 'a1', source: 'http', workspace: KEY }])
    expect(s.located[0]?.[1]).toBe('http')
  })

  it('never lets an observation failure break reporting', () => {
    const inner: ReportActivity = { report: () => 1 }
    const wrapped = observeWorkspace(inner, {
      located: () => Promise.reject(new Error('boom')),
    })
    expect(wrapped.report([{ agentId: 'a', workspace: KEY }])).toBe(1)
  })
})
