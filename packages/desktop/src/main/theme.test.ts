import { describe, expect, it } from 'vitest'
import { bindTheme, createQuitGuard, themeSource, windowBackground } from './theme.ts'

class FakeNativeTheme {
  themeSource: 'system' | 'light' | 'dark' = 'system'
  osDark = false
  private fns: (() => void)[] = []
  get shouldUseDarkColors() {
    return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
  }
  on(_event: 'updated', fn: () => void) {
    this.fns.push(fn)
    return this
  }
  /** What Electron does after a themeSource change or an OS switch. */
  emit() {
    for (const fn of this.fns) fn()
  }
}

describe('themeSource (TH-1)', () => {
  it('maps each setting to nativeTheme.themeSource', () => {
    expect(themeSource('system')).toBe('system')
    expect(themeSource('light')).toBe('light')
    expect(themeSource('dark')).toBe('dark')
  })
  it('falls back to system for a missing or unknown value', () => {
    expect(themeSource(undefined)).toBe('system')
    expect(themeSource('neon' as never)).toBe('system')
  })
})

describe('windowBackground (TH-1)', () => {
  it('is dark or light to match the page background', () => {
    expect(windowBackground(true)).toBe('#12151b')
    expect(windowBackground(false)).toBe('#e9edf3')
  })
})

describe('bindTheme (TH-2)', () => {
  it('applies the saved theme and repaints the window when the theme updates', () => {
    const nt = new FakeNativeTheme()
    const colors: string[] = []
    const theme = bindTheme({ nativeTheme: nt, setBackground: (c) => colors.push(c) })

    theme.apply('dark')
    expect(nt.themeSource).toBe('dark')
    nt.emit()
    expect(colors.at(-1)).toBe('#12151b')

    theme.apply('light')
    nt.emit()
    expect(nt.themeSource).toBe('light')
    expect(colors.at(-1)).toBe('#e9edf3')
  })

  it('follows the OS when set to system', () => {
    const nt = new FakeNativeTheme()
    const colors: string[] = []
    const theme = bindTheme({ nativeTheme: nt, setBackground: (c) => colors.push(c) })
    theme.apply('system')
    nt.osDark = true
    nt.emit()
    expect(colors.at(-1)).toBe('#12151b')
  })

  it('skips a no-op change', () => {
    const nt = new FakeNativeTheme()
    let sets = 0
    const proxy = {
      get themeSource() {
        return nt.themeSource
      },
      set themeSource(v) {
        sets++
        nt.themeSource = v
      },
      get shouldUseDarkColors() {
        return nt.shouldUseDarkColors
      },
      on: (e: 'updated', fn: () => void) => nt.on(e, fn),
    }
    const theme = bindTheme({ nativeTheme: proxy, setBackground: () => {} })
    theme.apply('dark')
    theme.apply('dark')
    expect(sets).toBe(1)
  })

  it('reports the current window background', () => {
    const nt = new FakeNativeTheme()
    const theme = bindTheme({ nativeTheme: nt, setBackground: () => {} })
    theme.apply('dark')
    expect(theme.background()).toBe('#12151b')
  })
})

describe('createQuitGuard (Q-1)', () => {
  function setup(count: number, answer: boolean) {
    const calls: string[] = []
    const guard = createQuitGuard({
      count: () => count,
      confirm: async (n) => {
        calls.push(`confirm:${n}`)
        return answer
      },
      stopAll: async () => {
        calls.push('stopAll')
      },
    })
    return { guard, calls }
  }

  it('quits without asking when no managed session runs', async () => {
    const { guard, calls } = setup(0, false)
    expect(await guard.confirmQuit()).toBe(true)
    expect(calls).toEqual([])
  })

  it('asks with the session count; Cancel keeps running', async () => {
    const { guard, calls } = setup(2, false)
    expect(await guard.confirmQuit()).toBe(false)
    expect(calls).toEqual(['confirm:2'])
  })

  it('Quit stops every managed session first', async () => {
    const { guard, calls } = setup(2, true)
    expect(await guard.confirmQuit()).toBe(true)
    expect(calls).toEqual(['confirm:2', 'stopAll'])
  })

  it('shows one confirm at a time (a second quit while asking waits for the same answer)', async () => {
    let resolve!: (v: boolean) => void
    let asked = 0
    const guard = createQuitGuard({
      count: () => 1,
      confirm: () => {
        asked++
        return new Promise<boolean>((r) => (resolve = r))
      },
      stopAll: () => {},
    })
    const a = guard.confirmQuit()
    const b = guard.confirmQuit()
    resolve(true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(asked).toBe(1)
  })

  it('still quits when stopAll fails', async () => {
    const guard = createQuitGuard({
      count: () => 1,
      confirm: async () => true,
      stopAll: async () => {
        throw new Error('boom')
      },
    })
    expect(await guard.confirmQuit()).toBe(true)
  })

  it('formats the copy', () => {
    const { guard } = setup(1, true)
    expect(guard.message(1)).toBe('1 managed session will stop. Quit anyway?')
    expect(guard.message(2)).toBe('2 managed sessions will stop. Quit anyway?')
  })
})
