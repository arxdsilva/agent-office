import { describe, expect, it } from 'vitest'
import { autoImportOutcome, autoImportToggled } from './auto-import-vm.ts'

describe('autoImportToggled (Settings checkbox)', () => {
  it('checking asks to turn on and keeps the box off until confirmed', () => {
    expect(autoImportToggled(true)).toEqual({ dialog: 'confirm-on', checked: false })
  })
  it('unchecking asks what to do with the imported memory and keeps the box on meanwhile', () => {
    expect(autoImportToggled(false)).toEqual({ dialog: 'confirm-off', checked: true })
  })
})

describe('autoImportOutcome (dialog buttons)', () => {
  it('Turn on saves autoImportHistory: true and nothing else', () => {
    expect(autoImportOutcome('on-ok')).toEqual({
      patch: { autoImportHistory: true },
      removeImported: false,
      checked: true,
    })
  })
  it('Cancel saves nothing and reverts the box', () => {
    expect(autoImportOutcome('on-cancel')).toEqual({ removeImported: false, checked: false })
  })
  it('Keep imported memory turns it off without removing', () => {
    expect(autoImportOutcome('off-keep')).toEqual({
      patch: { autoImportHistory: false },
      removeImported: false,
      checked: false,
    })
  })
  it('Also remove imported memory turns it off and removes', () => {
    expect(autoImportOutcome('off-remove')).toEqual({
      patch: { autoImportHistory: false },
      removeImported: true,
      checked: false,
    })
  })
  it('dismissing the off dialog (Esc) leaves it on', () => {
    expect(autoImportOutcome('off-dismiss')).toEqual({ removeImported: false, checked: true })
  })
  it('never lets the renderer send the main-only approval time', () => {
    for (const c of ['on-ok', 'off-keep', 'off-remove'] as const)
      expect(Object.keys(autoImportOutcome(c).patch ?? {})).toEqual(['autoImportHistory'])
  })
})
