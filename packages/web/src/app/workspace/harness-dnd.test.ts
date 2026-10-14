import { describe, expect, it } from 'vitest'
import { summary } from './__fixtures__/harness.ts'
import {
  accepts,
  announce,
  dropIntent,
  insertionIndex,
  moveId,
  placeId,
  sortLibrary,
  type DropContext,
  type HarnessDrag,
} from './harness-dnd.ts'

const A = 'hrn_aaaaaaaaaa'
const B = 'hrn_bbbbbbbbbb'
const C = 'hrn_cccccccccc'
const P1 = 'prj_aaaaaaaaaa'
const P2 = 'prj_bbbbbbbbbb'

const ctx = (over: Partial<DropContext> = {}): DropContext => ({
  scopeProjectId: P1,
  applied: [A, B],
  library: [A, B, C],
  attached: (p) => (p === P1 ? [A, B] : []),
  ...over,
})
const lib = (harnessId: string, status: HarnessDrag['status'] = 'published'): HarnessDrag => ({
  harnessId,
  source: 'library',
  status,
})
const row = (harnessId: string): HarnessDrag => ({
  harnessId,
  source: 'applied',
  status: 'published',
})

describe('dropIntent (§DnD table)', () => {
  it('a published library card on the drop zone attaches it to the scope project', () => {
    expect(dropIntent(lib(C), { kind: 'applied-zone' }, ctx())).toEqual({
      kind: 'attach',
      projectId: P1,
    })
  })
  it('a published card on an Applied row attaches it at that position', () => {
    expect(dropIntent(lib(C), { kind: 'applied-row', harnessId: A, after: false }, ctx())).toEqual({
      kind: 'attach',
      projectId: P1,
      ids: [C, A, B],
    })
  })
  it('an already attached card dropped on a row reorders to that row', () => {
    expect(dropIntent(lib(B), { kind: 'applied-row', harnessId: A, after: false }, ctx())).toEqual({
      kind: 'reorder',
      projectId: P1,
      ids: [B, A],
    })
    expect(dropIntent(lib(B), { kind: 'applied-zone' }, ctx())).toEqual({ kind: 'none' })
    expect(dropIntent(lib(A), { kind: 'applied-zone' }, ctx())).toEqual({
      kind: 'reorder',
      projectId: P1,
      ids: [B, A],
    })
  })
  it('rejects drafts and archived harnesses on Applied and on projects', () => {
    expect(dropIntent(lib(C, 'draft'), { kind: 'applied-zone' }, ctx())).toMatchObject({
      kind: 'reject',
      reason: 'draft',
    })
    expect(dropIntent(lib(C, 'archived'), { kind: 'project', projectId: P2 }, ctx())).toMatchObject(
      { kind: 'reject', reason: 'archived', projectId: P2 },
    )
  })
  it('rejects an Applied drop when no project is in scope', () => {
    expect(dropIntent(lib(C), { kind: 'applied-zone' }, ctx({ scopeProjectId: null }))).toEqual({
      kind: 'reject',
      reason: 'no-scope',
    })
  })
  it('a card on a sidebar project attaches to that project; already there is a reject', () => {
    expect(dropIntent(lib(C), { kind: 'project', projectId: P2 }, ctx())).toEqual({
      kind: 'attach',
      projectId: P2,
    })
    expect(dropIntent(lib(A), { kind: 'project', projectId: P1 }, ctx())).toMatchObject({
      kind: 'reject',
      reason: 'already',
    })
  })
  it('an Applied row onto another row reorders before/after', () => {
    expect(dropIntent(row(A), { kind: 'applied-row', harnessId: B, after: true }, ctx())).toEqual({
      kind: 'reorder',
      projectId: P1,
      ids: [B, A],
    })
    expect(dropIntent(row(A), { kind: 'applied-row', harnessId: B, after: false }, ctx())).toEqual({
      kind: 'none',
    })
    expect(dropIntent(row(A), { kind: 'applied-row', harnessId: A, after: true }, ctx())).toEqual({
      kind: 'none',
    })
    expect(dropIntent(row(A), { kind: 'applied-zone' }, ctx())).toMatchObject({ kind: 'reorder' })
  })
  it('an Applied row onto the library detaches; onto a project does nothing', () => {
    expect(dropIntent(row(A), { kind: 'library' }, ctx())).toEqual({
      kind: 'detach',
      projectId: P1,
    })
    expect(dropIntent(row(A), { kind: 'library-card', harnessId: C, after: false }, ctx())).toEqual(
      { kind: 'detach', projectId: P1 },
    )
    expect(dropIntent(row(A), { kind: 'project', projectId: P2 }, ctx())).toEqual({ kind: 'none' })
    expect(dropIntent(row(A), { kind: 'library' }, ctx({ scopeProjectId: null }))).toEqual({
      kind: 'none',
    })
  })
  it('a library card onto another card arranges the library (any status)', () => {
    expect(
      dropIntent(lib(C, 'draft'), { kind: 'library-card', harnessId: A, after: false }, ctx()),
    ).toEqual({ kind: 'reorder-library', ids: [C, A, B] })
    expect(dropIntent(lib(A), { kind: 'library-card', harnessId: A, after: false }, ctx())).toEqual(
      { kind: 'none' },
    )
    expect(dropIntent(lib(A), { kind: 'library-card', harnessId: B, after: false }, ctx())).toEqual(
      { kind: 'none' },
    )
    expect(dropIntent(lib(A), { kind: 'library' }, ctx())).toEqual({ kind: 'none' })
  })
  it('without a drag nothing is a target', () => {
    expect(dropIntent(null, { kind: 'applied-zone' }, ctx())).toEqual({ kind: 'none' })
    expect(accepts({ kind: 'none' })).toBe(false)
    expect(accepts({ kind: 'reject', reason: 'draft' })).toBe(false)
    expect(accepts({ kind: 'attach', projectId: P1 })).toBe(true)
  })
})

describe('insertionIndex', () => {
  const tops = [0, 40, 80]
  const hs = [40, 40, 40]
  it('inserts above a row when the pointer is above its midpoint, below otherwise', () => {
    expect(insertionIndex(tops, hs, 5)).toBe(0)
    expect(insertionIndex(tops, hs, 25)).toBe(1)
    expect(insertionIndex(tops, hs, 59)).toBe(1)
    expect(insertionIndex(tops, hs, 61)).toBe(2)
    expect(insertionIndex(tops, hs, 500)).toBe(3)
    expect(insertionIndex([], [], 5)).toBe(0)
  })
})

describe('moveId / placeId', () => {
  it('moves within bounds and clamps', () => {
    expect(moveId([A, B, C], A, 2)).toEqual([B, C, A])
    expect(moveId([A, B, C], C, -3)).toEqual([C, A, B])
    expect(moveId([A, B, C], C, 99)).toEqual([A, B, C])
    expect(moveId([A, B], C, 0)).toEqual([A, B])
  })
  it('places before/after a target and appends when the target is unknown', () => {
    expect(placeId([A, B, C], C, A, false)).toEqual([C, A, B])
    expect(placeId([A, B, C], A, C, true)).toEqual([B, C, A])
    expect(placeId([A, B], C, 'hrn_x', false)).toEqual([A, B, C])
    expect(placeId([A, B], A, 'hrn_x', false)).toEqual([A, B])
  })
})

describe('sortLibrary', () => {
  it('follows the order, puts unknown ids after (newest first) and archived last', () => {
    const list = [
      summary({ id: A, createdAt: 1 }),
      summary({ id: B, createdAt: 5 }),
      summary({ id: C, createdAt: 9 }),
      summary({ id: 'hrn_dddddddddd', createdAt: 20, status: 'archived' }),
    ]
    expect(sortLibrary(list, [B]).map((x) => x.id)).toEqual([B, C, A, 'hrn_dddddddddd'])
    expect(sortLibrary(list, [A, 'hrn_gone', C]).map((x) => x.id)).toEqual([
      A,
      C,
      B,
      'hrn_dddddddddd',
    ])
  })
})

describe('announce', () => {
  const n = { harness: 'TDD', project: 'Shop API', position: 1 }
  it('says every outcome and every rejection in words', () => {
    expect(announce({ kind: 'attach', projectId: P1 }, n)).toBe('Applied TDD to Shop API')
    expect(announce({ kind: 'reorder', projectId: P1, ids: [A] }, n)).toBe(
      'Moved TDD to position 1',
    )
    expect(announce({ kind: 'detach', projectId: P1 }, n)).toBe('Detach TDD from Shop API?')
    expect(announce({ kind: 'reorder-library', ids: [] }, n)).toBe('Moved TDD in the library')
    expect(announce({ kind: 'reject', reason: 'draft' }, n)).toBe('Publish TDD first')
    expect(announce({ kind: 'reject', reason: 'archived' }, n)).toBe(
      'Archived harnesses cannot be applied',
    )
    expect(announce({ kind: 'reject', reason: 'already' }, n)).toBe(
      'TDD is already applied to Shop API',
    )
    expect(announce({ kind: 'reject', reason: 'no-scope' }, n)).toContain('Pick a project')
    expect(announce({ kind: 'none' }, n)).toBe('')
    expect(announce({ kind: 'reorder', projectId: P1, ids: [A, B] }, { harness: 'X' })).toBe(
      'Moved X to position 2',
    )
  })
})
