import { ACTIVITY_KINDS as SHARED } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_KINDS, newActivity, toActivityView } from './activity.ts'
import { ValidationError } from './errors.ts'

describe('activity events', () => {
  it('ACT-kinds come from shared', () => {
    expect(ACTIVITY_KINDS).toBe(SHARED)
  })

  it('ACT-new: validates the kind, caps text 160 and query 80, strips control chars', () => {
    const e = newActivity({
      id: 'act_aaaaaaaaaaaa',
      projectId: 'prj_a',
      ts: 5,
      kind: 'mcp.retrieval',
      actor: 'codex',
      text: `Retrieved\u0007 ${'x'.repeat(300)}`,
      refs: { sessionId: 'ses_a' },
      data: {
        tool: 'search_memory',
        query: `q\u0000${'y'.repeat(200)}`,
        returned: [{ id: 'mem_a', version: 1 }],
      },
    })
    expect(e.text.length).toBeLessThanOrEqual(160)
    expect(e.text).not.toContain('\u0007')
    expect(e.data?.query?.length).toBeLessThanOrEqual(80)
    expect(e.data?.query).not.toContain('\u0000')
    expect(() =>
      newActivity({
        id: 'a',
        projectId: 'p',
        ts: 1,
        kind: 'tool.used' as never,
        actor: 'x',
        text: '',
      }),
    ).toThrow(ValidationError)
  })

  it('ACT-view omits internal data', () => {
    const e = newActivity({
      id: 'act_a',
      projectId: 'prj_a',
      ts: 5,
      kind: 'memory.approved',
      actor: 'you',
      text: 'Approved “Auth”',
      refs: { memoryId: 'mem_a' },
      data: { memoryIds: ['mem_a'] },
    })
    expect(toActivityView(e)).toEqual({
      id: 'act_a',
      projectId: 'prj_a',
      ts: 5,
      kind: 'memory.approved',
      actor: 'you',
      text: 'Approved “Auth”',
      refs: { memoryId: 'mem_a' },
    })
  })
})
