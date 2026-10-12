import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HookFormat } from '@agent-office/core'

export const COPILOT_HOOK_FORMAT: HookFormat = 'copilot-file'

/** Our own file `~/.copilot/hooks/agent-office.json`; `COPILOT_HOOKS_DIR` replaces the directory. */
export function copilotHooksPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(env.COPILOT_HOOKS_DIR || join(home, '.copilot', 'hooks'), 'agent-office.json')
}
