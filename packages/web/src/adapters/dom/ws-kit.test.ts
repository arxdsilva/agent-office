import { afterEach, describe, expect, it, vi } from 'vitest'
import { vmButton } from './ws-kit.ts'

/** A just-enough element: no DOM environment is installed for the web unit tests. */
function fakeEl() {
  const listeners: Record<string, (() => void)[]> = {}
  return {
    dataset: {} as Record<string, string>,
    disabled: false,
    textContent: '',
    className: '',
    type: '',
    id: '',
    title: '',
    setAttribute() {},
    addEventListener(t: string, fn: () => void) {
      ;(listeners[t] ??= []).push(fn)
    },
    click() {
      for (const f of listeners.click ?? []) f()
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('vmButton', () => {
  it('fires its callback even when the ButtonVM has no action (dialog buttons)', () => {
    vi.stubGlobal('document', { createElement: () => fakeEl() })
    const run = vi.fn()
    const b = vmButton(
      { id: 'preview', label: 'Preview', enabled: true },
      'secondary',
      run,
    ) as never as ReturnType<typeof fakeEl>
    b.click()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(undefined)
  })
  it('passes the action when there is one, exactly once', () => {
    vi.stubGlobal('document', { createElement: () => fakeEl() })
    const run = vi.fn()
    const action = { type: 'open-office' as const }
    const b = vmButton(
      { id: 'x', label: 'X', enabled: true, action },
      '',
      run,
    ) as never as ReturnType<typeof fakeEl>
    b.click()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(action)
  })
})
