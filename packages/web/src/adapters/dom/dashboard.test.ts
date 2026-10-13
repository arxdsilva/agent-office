import { describe, expect, it } from 'vitest'
import type { DashboardVM } from '../../app/workspace/types.ts'
import { dayGroup, metricsOf, splitMeta } from './dashboard.ts'

describe('dayGroup', () => {
  it('maps the row day to a heading', () => {
    expect(dayGroup('today')).toBe('Today')
    expect(dayGroup(undefined)).toBe('Today')
    expect(dayGroup('yesterday')).toBe('Yesterday')
    expect(dayGroup('2026-10-09')).toBe('2026-10-09')
  })
})

describe('splitMeta', () => {
  it('splits actor and time on the last separator', () => {
    expect(splitMeta('Claude Code · 3m ago')).toEqual({ who: 'Claude Code', when: '3m ago' })
    expect(splitMeta('3m ago')).toEqual({ who: '', when: '3m ago' })
  })
})

describe('metricsOf', () => {
  it('reads the structured metrics', () => {
    const vm = {
      metrics: {
        activeAgents: 2,
        waiting: 1,
        sessions: 7,
        approvedMemories: 4,
        pendingMemories: 1,
        openTasks: 3,
      },
    } as unknown as DashboardVM
    const m = Object.fromEntries(metricsOf(vm).map((x) => [x.id, x]))
    expect(m.agents).toMatchObject({ value: '2', note: '1 waiting for you' })
    expect(m.sessions!.value).toBe('7')
    expect(m.memories).toMatchObject({ value: '4', note: '1 pending review' })
    expect(m.tasks!.value).toBe('3')
  })
})
