import { describe, expect, it } from 'vitest'
import { keyIntent, type KeyInfo } from './palette.ts'

const base: KeyInfo = {
  key: 'x',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  foreignDialogOpen: false,
}

describe('keyIntent', () => {
  it('Cmd+K and Ctrl+K toggle the palette', () => {
    expect(keyIntent({ ...base, key: 'k', metaKey: true })).toBe('toggle-palette')
    expect(keyIntent({ ...base, key: 'K', ctrlKey: true })).toBe('toggle-palette')
  })
  it('plain k, or k with extra modifiers, is just typing', () => {
    expect(keyIntent({ ...base, key: 'k' })).toBeNull()
    expect(keyIntent({ ...base, key: 'k', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(keyIntent({ ...base, key: 'k', metaKey: true, altKey: true })).toBeNull()
  })
  it('Esc is offered to the controller', () => {
    expect(keyIntent({ ...base, key: 'Escape' })).toBe('escape')
  })
  it('does nothing while an IME composes or a foreign dialog (Settings, Connect) is open', () => {
    expect(keyIntent({ ...base, key: 'Escape', isComposing: true })).toBeNull()
    expect(keyIntent({ ...base, key: 'k', metaKey: true, foreignDialogOpen: true })).toBeNull()
    expect(keyIntent({ ...base, key: 'Escape', foreignDialogOpen: true })).toBeNull()
  })
})
