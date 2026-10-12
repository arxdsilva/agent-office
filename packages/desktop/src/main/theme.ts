// Appearance and quit decisions for the Electron entry (plan §2.6, §6.4, §6.7). No Electron import:
// index.ts passes nativeTheme and dialogs in, so the rules are unit-tested with fakes.
import type { Settings } from '@agent-office/shared'

export type ThemeSource = 'system' | 'light' | 'dark'

/** Settings['theme'] → nativeTheme.themeSource. Anything unexpected follows the OS. */
export function themeSource(t: Settings['theme'] | undefined): ThemeSource {
  return t === 'light' || t === 'dark' ? t : 'system'
}

/** The window's native background, matching `--bg`/`--loading-bg` so no flash shows before paint. */
export function windowBackground(isDark: boolean): '#12151b' | '#e9edf3' {
  return isDark ? '#12151b' : '#e9edf3'
}

/** The slice of Electron's nativeTheme this module uses. */
export interface NativeThemeLike {
  themeSource: ThemeSource
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', fn: () => void): unknown
}

/**
 * Applies the theme setting to nativeTheme (Chromium then flips `prefers-color-scheme` in the page)
 * and repaints the native window background on every theme update (setting or OS change).
 */
export function bindTheme(o: { nativeTheme: NativeThemeLike; setBackground(color: string): void }) {
  const background = () => windowBackground(o.nativeTheme.shouldUseDarkColors)
  o.nativeTheme.on('updated', () => o.setBackground(background()))
  return {
    apply(t: Settings['theme'] | undefined): void {
      const next = themeSource(t)
      if (o.nativeTheme.themeSource !== next) o.nativeTheme.themeSource = next
      o.setBackground(background())
    },
    background,
  }
}

/** Mirrors SESSION_COPY.quit (web); the desktop package cannot import the renderer. */
export const QUIT_COPY = {
  confirm: (n: number) => `${n} managed session${n === 1 ? '' : 's'} will stop. Quit anyway?`,
  quit: 'Quit',
  cancel: 'Cancel',
} as const

/**
 * Before quitting with managed sessions running: ask once, and on Quit stop them all.
 * Concurrent quit requests (tray + Cmd+Q) share one confirm.
 */
export function createQuitGuard(o: {
  count(): number
  confirm(n: number): Promise<boolean>
  stopAll(): Promise<void> | void
}) {
  let pending: Promise<boolean> | undefined
  async function run(): Promise<boolean> {
    const n = o.count()
    if (n <= 0) return true
    if (!(await o.confirm(n))) return false
    try {
      await o.stopAll()
    } catch {
      // Quitting anyway: the sessions die with the process.
    }
    return true
  }
  return {
    confirmQuit(): Promise<boolean> {
      pending ??= run().finally(() => {
        pending = undefined
      })
      return pending
    },
    message: QUIT_COPY.confirm,
  }
}
