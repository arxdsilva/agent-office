import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HookFormat } from '@agent-office/core'

export const CURSOR_HOOK_FORMAT: HookFormat = 'cursor-json'

/** `~/.cursor/hooks.json`, or `CURSOR_HOOKS_FILE` (tests and custom setups). */
export function cursorHooksPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.CURSOR_HOOKS_FILE || join(home, '.cursor', 'hooks.json')
}
