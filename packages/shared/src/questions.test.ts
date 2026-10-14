import { describe, expect, it } from 'vitest'
import { answersToInput, questionFromToolInput, questionInReply } from './questions.ts'

describe('questionFromToolInput', () => {
  it('maps an AskUserQuestion input and caps every field', () => {
    const q = questionFromToolInput({
      questions: [
        {
          question: 'Which library?'.padEnd(400, 'x'),
          header: 'Library',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B' },
            { label: 'C' },
            { label: 'D' },
            { label: 'E (dropped)' },
          ],
          multiSelect: true,
        },
      ],
    })
    expect(q?.prompts).toHaveLength(1)
    expect(q!.prompts[0]!.question).toHaveLength(300)
    expect(q!.prompts[0]!.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D'])
    expect(q!.prompts[0]!.multiSelect).toBe(true)
  })
  it('returns undefined for other tool inputs and strips control characters', () => {
    expect(questionFromToolInput({ command: 'rm -rf /' })).toBeUndefined()
    expect(questionFromToolInput(null)).toBeUndefined()
    expect(questionFromToolInput({ questions: [] })).toBeUndefined()
    const q = questionFromToolInput({ questions: [{ question: 'a\u0007b?', options: [] }] })
    expect(q!.prompts[0]!.question).toBe('a b?')
  })
})

describe('questionInReply', () => {
  it('returns the last question sentence, ignoring code and links', () => {
    expect(questionInReply('Done. Should I also update the docs?')).toBe(
      'Should I also update the docs?',
    )
    expect(questionInReply('See https://x.y/why? and ```is this ok?``` then stop.')).toBeUndefined()
    expect(questionInReply('Which one?\nI picked A.')).toBe('Which one?')
  })
  it('truncates long questions', () => {
    const q = questionInReply(`${'why '.repeat(60)}?`)
    expect(q!.length).toBeLessThanOrEqual(160)
    expect(q!.endsWith('…')).toBe(true)
  })
})

describe('answersToInput', () => {
  it('merges capped answers into the original input', () => {
    const out = answersToInput(
      { questions: [1] },
      { 'Which?': 'A, B', ['k'.repeat(400)]: 'v'.repeat(600) },
    )
    expect(out.questions).toEqual([1])
    const a = out.answers as Record<string, string>
    expect(a['Which?']).toBe('A, B')
    expect(Object.keys(a).some((k) => k.length === 300)).toBe(true)
    expect(Object.values(a).some((v) => v.length === 500)).toBe(true)
  })
})
