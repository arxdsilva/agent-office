import { describe, expect, it } from 'vitest'
import { harnessBuilderVM } from './harness-builder-vm.ts'
import { detail, preview, report, summary } from './__fixtures__/harness.ts'
import { P1, project } from './__fixtures__/projects.ts'
import { initialState, reduce } from './state.ts'

describe('harnessBuilderVM', () => {
  const base = () => reduce(initialState(), { type: 'projects', projects: [project()] })

  it('lists the four tabs and the active one', () => {
    const vm = harnessBuilderVM(
      reduce(base(), { type: 'harness-ui', patch: { open: true, tab: 'import' } }),
    )
    expect(vm.tabs.map((t) => [t.id, t.active])).toEqual([
      ['library', false],
      ['editor', false],
      ['import', true],
      ['coverage', false],
    ])
  })

  it('asks for a project before importing or showing coverage', () => {
    const vm = harnessBuilderVM(base())
    expect(vm.import.detect.enabled).toBe(false)
    expect(vm.coverage.projectName).toBeNull()
  })

  it('words each confirm with the harness and the project', () => {
    let s = reduce(base(), { type: 'harnesses', list: [summary()] })
    s = reduce(s, {
      type: 'harness-ui',
      patch: { projectId: P1, confirm: { kind: 'attach', harnessId: 'hrn_aaaaaaaaaa' } },
    })
    const vm = harnessBuilderVM(s)
    expect(vm.confirm).toMatchObject({ open: true, okLabel: 'Attach' })
    expect(vm.confirm.text).toContain('"Team standards"')
    expect(vm.confirm.text).toContain('Alpha')
    expect(harnessBuilderVM(base()).confirm.open).toBe(false)
  })

  it('enables Create only with a selection and a name', () => {
    let s = reduce(base(), { type: 'import-preview', preview: preview() })
    expect(harnessBuilderVM(s).import.create.enabled).toBe(true)
    s = reduce(s, { type: 'harness-ui', patch: { selection: { selected: [], gates: [] } } })
    expect(harnessBuilderVM(s).import.create.enabled).toBe(false)
  })

  it('carries the editor and the provider coverage', () => {
    let s = reduce(base(), { type: 'harness-detail', detail: detail() })
    s = reduce(s, { type: 'harness-ui', patch: { coverage: [report()], editorTab: 'providers' } })
    const vm = harnessBuilderVM(s)
    expect(vm.editor?.providers).toHaveLength(1)
    expect(vm.coverage.reports).toHaveLength(1)
  })
})
