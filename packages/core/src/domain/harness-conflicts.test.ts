import { describe, expect, it } from 'vitest'
import { detectConflicts, normalizeRuleText } from './harness-conflicts.ts'

describe('detectConflicts', () => {
  it('finds duplicates by normalized text (one conflict per group)', () => {
    const c = detectConflicts([
      { id: 'a', text: 'Run the tests.' },
      { id: 'b', text: '  run   THE tests ' },
      { id: 'c', text: 'Run the tests!' },
      { id: 'd', text: 'Something else' },
    ])
    expect(c).toEqual([
      {
        kind: 'duplicate',
        ruleIds: ['a', 'b', 'c'],
        text: expect.stringContaining('run the tests'),
      },
    ])
  })

  it.each([
    ['Never use any', 'Always use any'],
    ["Don't commit secrets", 'Commit secrets'],
    ['Do not edit generated files', 'Edit generated files'],
    ['Avoid default exports', 'Prefer default exports'],
    ['Must not skip hooks', 'Must skip hooks'],
    ['No console logs', 'Console logs'],
  ])('negation: %s / %s', (a, b) => {
    expect(
      detectConflicts([
        { id: 'a', text: a },
        { id: 'b', text: b },
      ]),
    ).toEqual([{ kind: 'negation', ruleIds: ['a', 'b'], text: expect.any(String) }])
  })

  it('no negation for unrelated texts or two negatives', () => {
    expect(
      detectConflicts([
        { id: 'a', text: 'Never use any' },
        { id: 'b', text: 'Never use var' },
        { id: 'c', text: 'Do not use var' },
      ]),
    ).toEqual([])
  })

  it('policy-opposite: deny vs ask on an identical target, order-insensitive', () => {
    const c = detectConflicts([
      { id: 'a', text: 'x', name: 'No rm', policy: { effect: 'deny', commands: ['rm', 'dd'] } },
      { id: 'b', text: 'y', policy: { effect: 'ask', commands: ['dd', 'rm'] } },
      { id: 'c', text: 'z', policy: { effect: 'ask', commands: ['rm'] } },
      { id: 'd', text: 'w', policy: { effect: 'deny', commands: ['dd', 'rm'] } },
    ])
    expect(c).toEqual([
      { kind: 'policy-opposite', ruleIds: ['a', 'b'], text: expect.stringContaining('deny wins') },
      { kind: 'policy-opposite', ruleIds: ['d', 'b'], text: expect.any(String) },
    ])
  })

  it('normalizeRuleText', () => {
    expect(normalizeRuleText("  Don't\tdo   THIS!! ")).toBe('dont do this')
  })
})
