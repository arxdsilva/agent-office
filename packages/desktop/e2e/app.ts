import { mkdtempSync, readFileSync } from 'node:fs'
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

export async function launch(
  profile: Profile = newProfile(),
): Promise<{ app: ElectronApplication; win: Page; profile: Profile; errors: string[] }> {
  // Drop inherited ELECTRON_* vars (e.g. ELECTRON_RUN_AS_NODE from VS Code terminals would start plain Node).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => !k.startsWith('ELECTRON_') && v !== undefined),
  ) as Record<string, string>
  const app = await _electron.launch({
    args: ['.'],
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...env,
      AGENT_OFFICE_USER_DATA: profile.userData,
      AGENT_OFFICE_HOME: profile.home,
      CLAUDE_SETTINGS_FILE: profile.claudeSettings,
      AGENT_OFFICE_MOCK: '1',
      AGENT_OFFICE_CLAUDE: '0',
      PORT: String(PORT),
    },
  })
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.locator('.tag').first().waitFor({ state: 'attached', timeout: 20_000 })
  return { app, win, profile, errors }
}
