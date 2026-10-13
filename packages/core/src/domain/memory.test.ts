import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  approveMemory,
  createMemory,
  editMemory,
  mergeMemories,
  rejectMemory,
  supersedeMemory,
  toMemoryView,
  type MemoryItem,
} from './memory.ts'

const P = 'prj_aaaaaaaaaaaa'
const user = (over: Partial<Parameters<typeof createMemory>[0]> = {}) =>
  createMemory({
    id: 'mem_aaaaaaaaaaaa',
    projectId: P,
    scope: 'project',
    kind: 'note',
    title: 'Use pnpm',
    body: 'We use pnpm workspaces.',
    origin: 'user',
    createdBy: 'you',
    now: 10,
    ...over,
  })
const proposal = () =>
  user({
    id: 'mem_bbbbbbbbbbbb',
    kind: 'decision',
    origin: 'agent-proposal',
    provider: 'codex',
    sessionId: 'ses_aaaaaaaaaaaa',
  })

describe('memory items (docs/projects.md §1)', () => {
  it('MEM-create: user items are approved; agent proposals are pending; decisions get a status', () => {
    expect(user()).toMatchObject({
      version: 1,
      state: 'approved',
      provenance: { origin: 'user', createdAt: 10, reviewedAt: 10 },
    })
    expect(proposal()).toMatchObject({
      state: 'pending',
      decision: { status: 'proposed' },
      provenance: { origin: 'agent-proposal', provider: 'codex', sessionId: 'ses_aaaaaaaaaaaa' },
    })
  })

  it('MEM-validate: title ≤ 120, body ≤ 4000, non-empty; scope/project consistency', () => {
    expect(() => user({ title: ' ' })).toThrow(ValidationError)
    expect(() => user({ title: 'x'.repeat(121) })).toThrow(ValidationError)
    expect(() => user({ body: 'x'.repeat(4001) })).toThrow(ValidationError)
    expect(() => user({ projectId: null, scope: 'project' })).toThrow(ValidationError)
    expect(user({ projectId: P, scope: 'global' }).projectId).toBeNull()
    expect(user({ projectId: null, scope: 'session' }).projectId).toBeNull()
    expect(() => user({ kind: 'secret' as never })).toThrow(ValidationError)
  })

  it('MEM-approve/reject: only pending items can be reviewed', () => {
    const a = approveMemory(proposal(), 20)
    expect(a).toMatchObject({ state: 'approved', decision: { status: 'accepted' } })
    expect(a.provenance.reviewedAt).toBe(20)
    expect(rejectMemory(proposal(), 20).state).toBe('rejected')
    expect(() => approveMemory(a, 21)).toThrow(ValidationError)
    expect(() => rejectMemory(a, 21)).toThrow(ValidationError)
    expect(() => approveMemory(rejectMemory(proposal(), 1), 2)).toThrow(ValidationError)
  })

  it('MEM-edit creates a new version, keeps the lineage id and provenance', () => {
    const e = editMemory(user(), { body: 'pnpm 10', kind: 'constraint' }, 30)
    expect(e).toMatchObject({
      id: 'mem_aaaaaaaaaaaa',
      version: 2,
      body: 'pnpm 10',
      kind: 'constraint',
    })
    expect(e.provenance.origin).toBe('user')
    expect(editMemory(e, { scope: 'global' }, 31)).toMatchObject({
      projectId: null,
      scope: 'global',
    })
    expect(() =>
      editMemory(editMemory(e, { scope: 'global' }, 31), { scope: 'project' }, 32),
    ).toThrow(ValidationError)
    expect(() => editMemory(rejectMemory(proposal(), 1), { body: 'x' }, 2)).toThrow(ValidationError)
    expect(editMemory(proposal(), { title: 'T2' }, 3)).toMatchObject({
      state: 'pending',
      version: 2,
    })
  })

  it('MEM-supersede: approved → superseded, pointing at the approved replacement', () => {
    const repl = user({ id: 'mem_cccccccccccc', title: 'Use pnpm 10', now: 40 })
    const { old, replacement } = supersedeMemory(user(), repl, 40)
    expect(old).toMatchObject({ state: 'superseded', supersededBy: 'mem_cccccccccccc', version: 2 })
    expect(replacement.state).toBe('approved')
    expect(() => supersedeMemory(proposal(), repl, 41)).toThrow(ValidationError)
    const dec = approveMemory(proposal(), 1)
    expect(supersedeMemory(dec, repl, 2).old.decision).toEqual({ status: 'deprecated' })
  })

  it('MEM-merge: one approved item listing mergedFrom; sources superseded', () => {
    const a = user()
    const b = user({ id: 'mem_dddddddddddd', title: 'pnpm again' })
    const into = user({ id: 'mem_eeeeeeeeeeee', title: 'pnpm (merged)' })
    const r = mergeMemories([a, b], into, 50)
    expect(r.merged).toMatchObject({ state: 'approved', mergedFrom: [a.id, b.id] })
    expect(r.sources.every((s) => s.state === 'superseded' && s.supersededBy === into.id)).toBe(
      true,
    )
    expect(() => mergeMemories([a], into, 50)).toThrow(ValidationError)
    expect(() => mergeMemories([a, proposal()], into, 50)).toThrow(ValidationError)
    expect(() => mergeMemories([a, a], into, 50)).toThrow(ValidationError)
  })

  it('MEM-view carries provenance but never createdBy internals beyond the view', () => {
    const v = toMemoryView(proposal() as MemoryItem)
    expect(v).toMatchObject({ id: 'mem_bbbbbbbbbbbb', version: 1, state: 'pending' })
    expect(Object.keys(v.provenance).sort()).toEqual([
      'createdAt',
      'origin',
      'provider',
      'sessionId',
    ])
  })
})
