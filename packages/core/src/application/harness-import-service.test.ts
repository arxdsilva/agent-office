import type { RuleSourceFormat, RuleSourceView } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.ts'
import type { RuleSourceFile, RuleSourceReader } from '../ports/driven.ts'
import type { ParseRuleFile } from './harness-import-service.ts'

const FILES: Record<string, string> = {
  'AGENTS.md': 'Always run tests\nNever use any\nNever use any',
  '.cursor/rules/x.mdc': 'Always use any\nDon’t touch generated code',
  Makefile: 'check:',
}
class Reader implements RuleSourceReader {
  roots: string[] = []
  async detect(root: string): Promise<RuleSourceFile[]> {
    this.roots.push(root)
    return [
      ...Object.keys(FILES).map((path) => ({
        path,
        format: 'agents-md' as const,
        bytes: FILES[path]!.length,
        hash: `h-${path}`,
      })),
      { path: '/abs/escape.md', format: 'agents-md', bytes: 1, hash: 'x' },
      { path: '../up.md', format: 'agents-md', bytes: 1, hash: 'x' },
    ]
  }
  async read(_root: string, rel: string) {
    if (rel === 'Makefile' && this.failMake) throw new Error('unreadable')
    return { text: FILES[rel] ?? '', hash: `h-${rel}` }
  }
  failMake = false
}
const formatOf = (p: string): RuleSourceFormat | undefined =>
  p === 'Makefile' ? 'makefile' : p.endsWith('.mdc') ? 'cursor-mdc' : undefined
const parse: ParseRuleFile = (format, text, source: RuleSourceView) => {
  if (format === 'makefile')
    return {
      candidates: [],
      gates: [
        { name: 'make check', argv: ['make', 'check'], source },
        { name: 'piped', argv: ['sh'], source, rejected: 'pipes' },
      ],
    }
  const src = format === 'cursor-mdc' ? { ...source, globs: ['src/**'] } : source
  return {
    candidates: text.split('\n').map((line) => ({
      name: line.slice(0, 20),
      text: line,
      category: 'coding' as const,
      enforcement: 'instruction' as const,
      severity: 'required' as const,
      source: src,
    })),
    gates: [],
  }
}

async function setup(withReader = true) {
  const reader = new Reader()
  const h = harness({
    ...(withReader ? { ruleSources: reader } : {}),
    parseRuleFile: parse,
    formatOf,
  })
  const prj = await withProject(h)
  return { h, prj, reader, imp: h.projects.harnessImport }
}

describe('HarnessImportService', () => {
  it('HI-detect: repo labels and repo-relative paths only', async () => {
    const { prj, imp, reader } = await setup()
    expect(await imp.detect(prj)).toEqual([
      {
        path: 'AGENTS.md',
        repoLabel: 'shop',
        format: 'agents-md',
        bytes: FILES['AGENTS.md']!.length,
      },
      {
        path: '.cursor/rules/x.mdc',
        repoLabel: 'shop',
        format: 'agents-md',
        bytes: FILES['.cursor/rules/x.mdc']!.length,
      },
      {
        path: 'Makefile',
        repoLabel: 'shop',
        format: 'agents-md',
        bytes: FILES['Makefile']!.length,
      },
    ])
    expect(reader.roots).toEqual(['/work/shop'])
    const none = await setup(false)
    expect(await none.imp.detect(none.prj)).toEqual([])
    await expect(none.imp.preview({ projectId: none.prj })).rejects.toThrow('import unavailable')
  })

  it('HI-preview: temp ids, duplicates, negation conflicts, gate suggestions, totals', async () => {
    const { prj, imp } = await setup()
    const p = await imp.preview({ projectId: prj })
    expect(p.previewId).toMatch(/^prv_[a-z0-9]+$/)
    expect(p.candidates.map((c) => c.tempId)).toEqual([
      'cand_1',
      'cand_2',
      'cand_3',
      'cand_4',
      'cand_5',
    ])
    expect(p.candidates[2]!.duplicateOf).toBe('cand_2')
    expect(p.candidates[3]!.conflictsWith).toEqual(['cand_2', 'cand_3'])
    expect(p.candidates[3]!.source).toMatchObject({
      format: 'cursor-mdc',
      path: '.cursor/rules/x.mdc',
      repoLabel: 'shop',
      hash: 'h-.cursor/rules/x.mdc',
      globs: ['src/**'],
    })
    expect(p.gates.map((g) => [g.tempId, g.name, g.rejected])).toEqual([
      ['cand_g1', 'make check', undefined],
      ['cand_g2', 'piped', 'pipes'],
    ])
    expect(p.totals).toMatchObject({ rules: 5, conflicts: p.conflicts.length })
    expect(p.totals.byCategory.coding).toBe(5)
    expect(p.sources.find((s) => s.path === 'AGENTS.md')?.ruleCount).toBe(3)
    const only = await imp.preview({ projectId: prj, paths: ['AGENTS.md'] })
    expect(only.candidates).toHaveLength(3)
  })

  it('HI-commit: a draft with provenance; edits applied; rejected gates refused; never published', async () => {
    const { h, prj, imp } = await setup()
    const p = await imp.preview({ projectId: prj })
    await expect(
      imp.commit({ previewId: p.previewId, name: 'X', selected: ['cand_1'], gates: ['cand_g2'] }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      imp.commit({ previewId: p.previewId, name: 'X', selected: ['cand_9'] }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      imp.commit({
        previewId: p.previewId,
        name: 'X',
        selected: ['cand_1'],
        edits: [{ tempId: 'cand_1', enforcement: 'runtime-policy' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    const d = await imp.commit({
      previewId: p.previewId,
      name: 'Imported',
      selected: ['cand_1', 'cand_4'],
      edits: [{ tempId: 'cand_1', name: 'Tests', category: 'testing' }],
      gates: ['cand_g1'],
      attach: true,
    })
    expect(d).toMatchObject({ status: 'draft', version: 1, name: 'Imported', projectIds: [prj] })
    expect(d.rules[0]).toMatchObject({
      name: 'Tests',
      category: 'testing',
      source: { format: 'agents-md', path: 'AGENTS.md', repoLabel: 'shop' },
    })
    expect(d.rules[0]!.id).toMatch(/^rul_/)
    expect(d.rules[1]).toMatchObject({ appliesTo: { filePatterns: ['src/**'] } })
    expect(d.gates.map((g) => g.argv)).toEqual([['make', 'check']])
    // The preview is consumed.
    await expect(
      imp.commit({ previewId: p.previewId, name: 'Again', selected: [] }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(imp.commit({ previewId: 'bad', name: 'x', selected: [] })).rejects.toBeInstanceOf(
      ValidationError,
    )
    // A rule already in an attached harness marks the candidate as its duplicate.
    const p2 = await imp.preview({ projectId: prj, paths: ['AGENTS.md'] })
    expect(p2.candidates[0]!.duplicateOf).toBe(d.rules[0]!.id)
    void h
  })

  it('HI-unreadable files are skipped; only the user may import', async () => {
    const { prj, imp, reader } = await setup()
    reader.failMake = true
    expect((await imp.preview({ projectId: prj })).gates).toEqual([])
    const runtime = { kind: 'runtime' as const, provider: 'codex', projectId: prj }
    await expect(imp.detect(prj, runtime)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(imp.preview({ projectId: prj }, runtime)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(imp.detect('prj_unknown00000')).rejects.toBeInstanceOf(NotFoundError)
  })
})
