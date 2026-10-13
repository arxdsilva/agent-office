import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.ts'
import { addEvidence, createTask, setTaskState, strongestEvidence, toTaskView } from './task.ts'

const t = () =>
  createTask({
    id: 'tsk_aaaaaaaaaaaa',
    projectId: 'prj_a',
    title: ' Ship it ',
    source: 'user',
    now: 1,
  })

describe('tasks', () => {
  it('TSK-create trims and validates the title', () => {
    expect(t()).toMatchObject({ title: 'Ship it', state: 'open', evidence: [], sessionIds: [] })
    expect(() =>
      createTask({ id: 'x', projectId: 'p', title: '', source: 'user', now: 1 }),
    ).toThrow(ValidationError)
  })

  it('TSK-transitions: open → doing → done; dropped is terminal; done can reopen', () => {
    const d = setTaskState(setTaskState(t(), 'doing', 2), 'done', 3)
    expect(d).toMatchObject({ state: 'done', doneAt: 3 })
    expect(setTaskState(d, 'open', 4).doneAt).toBeUndefined()
    const x = setTaskState(t(), 'dropped', 5)
    expect(() => setTaskState(x, 'open', 6)).toThrow(ValidationError)
    expect(() => setTaskState(d, 'doing', 6)).toThrow(ValidationError)
  })

  it('TSK-evidence: strongest level wins; tests-verified is planned (refused)', () => {
    const e = addEvidence(addEvidence(t(), { level: 'committed', at: 2, ref: 'abc123' }), {
      level: 'agent-reported',
      at: 3,
    })
    expect(strongestEvidence(e)).toBe('committed')
    expect(strongestEvidence(t())).toBeUndefined()
    expect(() => addEvidence(t(), { level: 'tests-verified', at: 1 })).toThrow(ValidationError)
    expect(toTaskView(e)).toMatchObject({ id: 'tsk_aaaaaaaaaaaa', evidence: 'committed' })
  })
})
