import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import {
  approveMemory,
  createImportedMemory,
  createMemory,
  editMemory,
  isMoveTombstone,
  mergeMemories,
  moveTombstone,
  rehomeImportedMemory,
  rejectMemory,
  retractMemory,
  reviseImportedMemory,
  supersedeByCap,
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

describe('auto-imported session knowledge (docs/projects.md §8b)', () => {
  const session = { id: 'ses_aaaaaaaaaaaa', title: 'Tidy the release script' }
  const imported = (projectId: string | null = P) =>
    createImportedMemory({
      id: 'mem_iiiiiiiiiiii',
      session,
      summary: 'Tidy the release script\n• Renamed the target.\nDuration: 3 min',
      projectId,
      now: 100,
      approvedAt: 50,
    })

  it('MEM-import: approved note with session-import provenance; the scope follows the project', () => {
    const m = imported()
    expect(m).toMatchObject({
      id: 'mem_iiiiiiiiiiii',
      version: 1,
      projectId: P,
      scope: 'project',
      kind: 'note',
      state: 'approved',
      title: 'Session: Tidy the release script',
      updatedAt: 100,
      provenance: {
        origin: 'session-import',
        provider: 'claude-code',
        sessionId: session.id,
        createdBy: 'auto-import',
        createdAt: 100,
        reviewedAt: 50,
      },
    })
    expect(imported(null)).toMatchObject({ projectId: null, scope: 'session' })
    expect(toMemoryView(m).provenance.origin).toBe('session-import')
  })

  it('MEM-import-clean: control characters stripped, body ≤ 2000, title ≤ 120, empty title named', () => {
    const m = createImportedMemory({
      id: 'mem_iiiiiiiiiiii',
      session: { id: session.id, title: 'x'.repeat(300) },
      summary: `a\u0007b\u202e${'y'.repeat(3000)}`,
      projectId: P,
      now: 1,
      approvedAt: 1,
    })
    expect(m.title.length).toBeLessThanOrEqual(120)
    expect(m.body.length).toBeLessThanOrEqual(2000)
    expect(m.body.startsWith('ab')).toBe(true)
    const blank = createImportedMemory({
      id: 'mem_iiiiiiiiiiii',
      session: { id: session.id, title: '  ' },
      summary: 'Something done',
      projectId: P,
      now: 1,
      approvedAt: 1,
    })
    expect(blank.title).toBe('Session: Untitled session')
    expect(() =>
      createImportedMemory({
        id: 'mem_iiiiiiiiiiii',
        session,
        summary: '   ',
        projectId: P,
        now: 1,
        approvedAt: 1,
      }),
    ).toThrow(ValidationError)
  })

  it('MEM-revise: unchanged text returns the same object; changed text is a new version', () => {
    const m = imported()
    expect(reviseImportedMemory(m, m.body, 200)).toBe(m)
    const v2 = reviseImportedMemory(m, 'New summary', 200)
    expect(v2).toMatchObject({ id: m.id, version: 2, body: 'New summary', updatedAt: 200 })
    expect(v2.provenance).toEqual(m.provenance)
    const t2 = reviseImportedMemory(m, m.body, 200, 'Renamed session')
    expect(t2).toMatchObject({ version: 2, title: 'Session: Renamed session' })
    expect(() => reviseImportedMemory(retractMemory(m, 1), 'x', 2)).toThrow(ValidationError)
    expect(() => reviseImportedMemory(user(), 'x', 2)).toThrow(ValidationError)
  })

  it('MEM-rehome: project ↔ null changes scope with a new version; the same place is a no-op', () => {
    const m = imported(null)
    expect(rehomeImportedMemory(m, null, 5)).toBe(m)
    const inP = rehomeImportedMemory(m, P, 5)
    expect(inP).toMatchObject({ version: 2, projectId: P, scope: 'project', updatedAt: 5 })
    expect(rehomeImportedMemory(inP, null, 6)).toMatchObject({
      version: 3,
      projectId: null,
      scope: 'session',
    })
    expect(() => rehomeImportedMemory(user(), null, 1)).toThrow(ValidationError)
  })

  it('MEM-retract: approved → rejected (a new version); other states throw', () => {
    const m = imported()
    const r = retractMemory(m, 300)
    expect(r).toMatchObject({ version: 2, state: 'rejected', updatedAt: 300 })
    expect(() => retractMemory(r, 301)).toThrow(ValidationError)
    expect(() => retractMemory(proposal(), 301)).toThrow(ValidationError)
  })

  it('MEM-cap: an approved item is superseded by the cap; others throw', () => {
    const c = supersedeByCap(imported(), 400)
    expect(c).toMatchObject({ version: 2, state: 'superseded', supersededBy: 'cap' })
    expect(() => supersedeByCap(c, 401)).toThrow(ValidationError)
  })

  it('MEM-tombstone: marks the old partition copy of a moved version', () => {
    const m = imported(null)
    const moved = rehomeImportedMemory(m, P, 5)
    const t = moveTombstone(m, moved)
    expect(t).toMatchObject({
      id: m.id,
      version: moved.version,
      projectId: null,
      state: 'superseded',
      supersededBy: m.id,
    })
    expect(isMoveTombstone(t)).toBe(true)
    expect(isMoveTombstone(moved)).toBe(false)
    expect(isMoveTombstone(supersedeByCap(m, 1))).toBe(false)
  })
})
