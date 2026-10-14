import { HarnessDraftSchema } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { createHarness, publishHarness } from './harness.ts'
import { MAX_INSTRUCTIONS } from './harness-instructions.ts'
import { resolveEffective } from './harness-resolve.ts'
import { HARNESS_TEMPLATES, templateSteps } from './harness-templates.ts'
import { createProject } from './project.ts'

let n = 0
const newId = (p: string) => `${p}_${String(++n).padStart(10, '0')}`
const project = createProject({ id: 'prj_aaaaaaaaaaaa', name: 'Shop', now: 1 })

describe('harness templates', () => {
  it('has the eleven templates with unique ids', () => {
    expect(HARNESS_TEMPLATES.map((t) => t.id)).toEqual([
      'content-pipeline',
      'research-brief',
      'support-reply',
      'release-checklist',
      'incident-writeup',
      'go-backend',
      'typescript',
      'tdd',
      'security-privacy',
      'docs-review',
      'custom',
    ])
  })

  for (const t of HARNESS_TEMPLATES)
    it(`${t.id}: parses, its gate refs resolve, and its instructions fit the budget`, () => {
      expect(HarnessDraftSchema.safeParse(t.draft).success).toBe(true)
      expect(t.ruleCount).toBe(t.draft.rules?.length ?? 0)
      expect(t.gateCount).toBe(t.draft.gates?.length ?? 0)
      const h = createHarness(t.draft, { id: 'hrn_aaaaaaaaaa', now: 1, newId })
      const gateIds = new Set(h.gates.map((g) => g.id))
      for (const s of h.steps ?? [])
        for (const c of s.exit) if (c.kind === 'gate') expect(gateIds.has(c.gateId)).toBe(true)
      if (t.id === 'custom') return
      const pub = publishHarness(h, 2)
      const e = resolveEffective({ project, harnesses: [pub], provider: 'claude-code', now: 3 })
      expect(e.instructions.length).toBeGreaterThan(0)
      expect(e.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
    })

  it('the flow templates have steps; the content pipeline blocks publishing before its last step', () => {
    const byId = new Map(HARNESS_TEMPLATES.map((t) => [t.id, t]))
    expect(templateSteps(byId.get('content-pipeline')!).map((s) => s.name)).toEqual([
      'Research',
      'Outline',
      'Draft',
      'Review',
      'Publish',
    ])
    const steps = templateSteps(byId.get('content-pipeline')!)
    expect(steps.slice(0, 4).every((s) => s.policies?.[0]?.paths?.includes('published/**'))).toBe(
      true,
    )
    expect(steps[4]!.policies).toBeUndefined()
    for (const id of ['research-brief', 'support-reply', 'release-checklist', 'incident-writeup'])
      expect(templateSteps(byId.get(id)!).length).toBeGreaterThan(2)
    for (const id of ['go-backend', 'typescript', 'tdd', 'security-privacy', 'docs-review'])
      expect(templateSteps(byId.get(id)!)).toEqual([])
  })
})
