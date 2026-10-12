import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HookFormat } from '@agent-office/core'

export const GEMINI_HOOK_FORMAT: HookFormat = 'gemini-settings'

/** `~/.gemini/settings.json` (hooks live under its `hooks` key), or `GEMINI_SETTINGS_FILE`. */
export function geminiSettingsPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.GEMINI_SETTINGS_FILE || join(home, '.gemini', 'settings.json')
}
