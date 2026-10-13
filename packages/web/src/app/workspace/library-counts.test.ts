import { describe, expect, it } from 'vitest'
import { P1, P2, handoff, memory } from './__fixtures__/projects.ts'
import { libraryCounts } from './library-counts.ts'

describe('libraryCounts', () => {
  it('counts approved memories per kind, pending, accepted decisions and open handoffs of one project', () => {
    const mems = [
      memory({ id: 'mem_aaaaaaaaaa', kind: 'decision', decision: { status: 'accepted' } }),
      memory({ id: 'mem_bbbbbbbbbb', kind: 'decision', decision: { status: 'proposed' } }),
      memory({ id: 'mem_cccccccccc', kind: 'note' }),
      memory({ id: 'mem_dddddddddd', kind: 'note', state: 'pending' }),
      memory({ id: 'mem_eeeeeeeeee', kind: 'note', projectId: P2 }),
    ]
    const c = libraryCounts(
      mems,
      [handoff(), handoff({ projectId: P2 }), handoff({ state: 'launched' as never })],
      P1,
    )
    expect(c).toEqual({
      byKind: { decision: 2, note: 1 },
      pending: 1,
      handoffs: 1,
      acceptedDecisions: 1,
    })
  })
})
