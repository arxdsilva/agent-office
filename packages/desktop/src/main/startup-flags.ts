// Process-level graphics flags, decided before `app.whenReady` (plan §2.4, §7 HW-1, G4, G5).
// Pure: index.ts reads settings.json synchronously and applies the result to Electron.
import type { Settings } from '@agent-office/shared'

type Env = Record<string, string | undefined>

export interface StartupFlags {
  /** Call `app.disableHardwareAcceleration()` (the "Hardware acceleration" setting is off). */
  disableHardwareAcceleration: boolean
  /** Chromium switches for `app.commandLine.appendSwitch(name, value?)`. */
  switches: [name: string, value?: string][]
}

const on = (v: string | undefined) => v === '1'

export function startupFlags(
  settings: Pick<Settings, 'hardwareAcceleration'>,
  env: Env,
): StartupFlags {
  const disable = settings.hardwareAcceleration === false
  const forceSoftware = on(env.AGENT_OFFICE_FORCE_SOFTWARE_GL)
  const switches: StartupFlags['switches'] = []
  // Test seam (G4, `make perf-low`): CPU rendering through ANGLE + SwiftShader, the closest
  // stand-in for a weak machine. The GPU sandbox can refuse SwiftShader on some hosts.
  if (forceSoftware) switches.push(['use-angle', 'swiftshader'])
  // Chromium no longer falls back to SwiftShader for WebGL on its own; without this switch software
  // rendering means no WebGL at all. Only our own app:// content runs (CSP 'self').
  if (forceSoftware || disable) switches.push(['enable-unsafe-swiftshader'])
  if (forceSoftware) switches.push(['disable-gpu-sandbox'])
  return { disableHardwareAcceleration: disable, switches }
}

/** `hardwareAcceleration` from the raw settings.json text; anything but an explicit false is on. */
export function savedHardwareAcceleration(raw: string | undefined): boolean {
  try {
    const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw)
    return (parsed as { hardwareAcceleration?: unknown } | null)?.hardwareAcceleration !== false
  } catch {
    return true
  }
}

/** The renderer URL's query: `debug=1` (capture scripts) and `forceWebglFail=1` (G5 seam). */
export function rendererQuery(env: Env): string {
  const params = [
    ...(on(env.AGENT_OFFICE_DEBUG) ? ['debug=1'] : []),
    ...(on(env.AGENT_OFFICE_FORCE_WEBGL_FAIL) ? ['forceWebglFail=1'] : []),
  ]
  return params.length ? `?${params.join('&')}` : ''
}

/**
 * A settings listener that calls `onFlip` once when `hardwareAcceleration` no longer matches the
 * value this process started with (the switch only applies at launch, so the app relaunches).
 */
export function watchHardwareAcceleration(
  startedWith: boolean,
  onFlip: () => void,
): (settings: Pick<Settings, 'hardwareAcceleration'>) => void {
  let flipped = false
  return (s) => {
    if (flipped || s.hardwareAcceleration === startedWith) return
    flipped = true
    onFlip()
  }
}

/**
 * What to do once the new `hardwareAcceleration` is saved: relaunch with the new flags, or just
 * quit under AGENT_OFFICE_NO_RELAUNCH=1 (E2E: a relaunched app would escape Playwright's control).
 */
export const afterHardwareChange = (env: Env): 'relaunch' | 'quit' =>
  on(env.AGENT_OFFICE_NO_RELAUNCH) ? 'quit' : 'relaunch'
