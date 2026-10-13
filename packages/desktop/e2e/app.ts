import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'

export const PORT = 4318

/** A fresh, isolated profile: own userData, token dir and Claude settings file. Never touches the real ones. */
export function newProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'ao-app-'))
  return {
    dir,
    userData: join(dir, 'userData'),
    home: join(dir, 'home'),
    claudeSettings: join(dir, 'claude', 'settings.json'),
    token: () => readFileSync(join(dir, 'home', 'token'), 'utf8').trim(),
  }
}

export type Profile = ReturnType<typeof newProfile>

export interface LaunchOptions {
  /** Extra env; a value of `undefined` removes that variable (e.g. `{ AGENT_OFFICE_MOCK: undefined }`). */
  env?: Record<string, string | undefined>
  /** Wait for the first agent tag (default true). Set false for empty-office tests. */
  waitForAgents?: boolean
}

export async function launch(
  profile: Profile = newProfile(),
  opts: LaunchOptions = {},
): Promise<{ app: ElectronApplication; win: Page; profile: Profile; errors: string[] }> {
  // Software GL (headless Linux CI): Auto picks Minimal there, which hides far name tags. Show every
  // tag so specs can click them; the preset stays Auto (quality.spec checks that default). Specs that
  // save their own settings (the graphics specs) are left alone.
  const settingsFile = join(profile.userData, 'settings.json')
  if (process.env.AGENT_OFFICE_FORCE_SOFTWARE_GL === '1' && !existsSync(settingsFile)) {
    mkdirSync(profile.userData, { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ graphicsAdvanced: { labels: 'all' } }))
  }
  // Drop inherited ELECTRON_* vars (e.g. ELECTRON_RUN_AS_NODE from VS Code terminals would start plain Node).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith('ELECTRON_') && v !== undefined),
  ) as Record<string, string>
  const merged: Record<string, string | undefined> = {
    ...env,
    AGENT_OFFICE_USER_DATA: profile.userData,
    AGENT_OFFICE_HOME: profile.home,
    CLAUDE_SETTINGS_FILE: profile.claudeSettings,
    AGENT_OFFICE_MOCK: '1',
    AGENT_OFFICE_CLAUDE: '0',
    PORT: String(PORT),
    ...opts.env,
  }
  const app = await _electron.launch({
    args: ['.'],
    cwd: join(import.meta.dirname, '..'),
    env: Object.fromEntries(
      Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  if (opts.waitForAgents ?? true)
    // 45 s: the first launch on a cold CI runner (Gatekeeper scanning Electron) can take > 20 s.
    await win.locator('.tag').first().waitFor({ state: 'attached', timeout: 45_000 })
  else await win.locator('#loading').waitFor({ state: 'hidden', timeout: 30_000 })
  return { app, win, profile, errors }
}
