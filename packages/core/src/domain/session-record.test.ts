import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  archiveSession,
  assignSession,
  deterministicSummary,
  endSession,
  newSessionRecord,
  reactivateSession,
  toSessionSummary,
} from './session-record.ts'

const rec = () =>
  newSessionRecord({
    id: 'ses_aaaaaaaaaaaa',
    agentId: 'cc:1',
    provider: 'claude-code',
    origin: 'observed',
    title: 'shop',
    now: 100,
  })

describe('session records', () => {
  it('SR-new: unassigned, active, empty history', () => {
    expect(rec()).toMatchObject({
      projectId: null,
      state: 'active',
      startedAt: 100,
      lastSeenAt: 100,
      assignment: { by: 'none', at: 100, history: [] },
      suggestions: [],
      tools: [],
    })
  })

  it('SR-assign keeps every previous assignment in history and clears suggestions', () => {
    const a = assignSession(
      { ...rec(), suggestions: [{ projectId: 'P', rule: 'name', confidence: 'low' }] },
      'prj_a',
      'auto',
      'common-dir',
      110,
    )
    expect(a).toMatchObject({
      projectId: 'prj_a',
      assignment: { by: 'auto', rule: 'common-dir', at: 110 },
    })
    expect(a.suggestions).toEqual([])
    const b = assignSession(a, 'prj_b', 'user', undefined, 120)
    expect(b.assignment.history).toEqual([
      { projectId: null, by: 'none', at: 100 },
      { projectId: 'prj_a', by: 'auto', rule: 'common-dir', at: 110 },
    ])
    expect(assignSession(b, null, 'user', undefined, 130).projectId).toBeNull()
  })

  it('SR-states: end → inactive, reactivate, archive (user only)', () => {
    const e = endSession(rec(), 200)
    expect(e).toMatchObject({ state: 'inactive', endedAt: 200 })
    expect(endSession(e, 300)).toBe(e)
    const r = reactivateSession(e, 400)
    expect(r.state).toBe('active')
    expect(r.endedAt).toBeUndefined()
    const ar = archiveSession(e, 500)
    expect(ar.state).toBe('archived')
    expect(() => archiveSession(rec(), 1)).toThrow(ValidationError)
  })

  it('SR-summary: title + last 3 agent replies + tools + duration, ≤ 2000 chars', () => {
    const s = deterministicSummary(
      { ...rec(), tools: ['Bash', 'Edit'], endedAt: 100 + 3 * 60_000 },
      ['one', 'two', 'three', 'four'.repeat(400)],
    )
    expect(s).toContain('shop')
    expect(s).not.toContain('one')
    expect(s).toContain('two')
    expect(s).toContain('Tools: Bash, Edit')
    expect(s).toContain('3 min')
    expect(s.length).toBeLessThanOrEqual(2000)
  })

  it('SR-view: suggestions carry project names; no transcript ref leaks (only a flag)', () => {
    const r = {
      ...rec(),
      transcriptRef: 'tr_secret',
      suggestions: [{ projectId: 'prj_a', rule: 'name' as const, confidence: 'low' as const }],
    }
    const v = toSessionSummary(r, (id) => (id === 'prj_a' ? 'Shop' : undefined))
    expect(v.hasTranscript).toBe(true)
    expect(JSON.stringify(v)).not.toContain('tr_secret')
    expect(v.suggestions).toEqual([
      { projectId: 'prj_a', name: 'Shop', rule: 'name', confidence: 'low' },
    ])
    expect(v.assignedBy).toBeUndefined()
    const unknown = toSessionSummary(r, () => undefined)
    expect(unknown.suggestions).toEqual([])
  })
})
