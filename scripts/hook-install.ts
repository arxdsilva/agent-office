// Dev CLI: install/uninstall the agent-office hook in ~/.claude/settings.json without the desktop app.
// Usage: tsx scripts/hook-install.ts install|uninstall|status [--yes]
// Thin driving adapter over the core's HookManagement port.
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { ClaudeSettingsFile, FsHookRunner } from '@agent-office/adapters'
import { DomainError, HookService, type HookManagement } from '@agent-office/core'

export interface CliIo {
  settingsFile: string
  /** ~/.agent-office — the dev wrapper lives in <home>/hook. */
  home: string
  hookScript: string
  log: (line: string) => void
  confirm: (question: string) => Promise<boolean>
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const [cmd] = argv
  const hooks: HookManagement = new HookService({
    claude: new ClaudeSettingsFile(io.settingsFile),
    runner: new FsHookRunner({ dir: join(io.home, 'hook'), execPath: 'node', script: io.hookScript, platform: process.platform, runAsNode: false }),
  })
  try {
    if (cmd === 'status') {
      io.log(await hooks.status())
      return 0
    }
    if (cmd !== 'install' && cmd !== 'uninstall') {
      io.log('usage: hook-install.ts install|uninstall|status [--yes]')
      return 2
    }
    io.log(`${cmd === 'install' ? 'Add' : 'Remove'} the agent-office hook (Stop, UserPromptSubmit) in ${io.settingsFile}? A backup is written first.`)
    if (!argv.includes('--yes') && !(await io.confirm('Apply? [y/N] '))) {
      io.log('Aborted, nothing changed.')
      return 1
    }
    io.log(`hook: ${cmd === 'install' ? await hooks.install() : await hooks.uninstall()}`)
    return 0
  } catch (err) {
    if (err instanceof DomainError) {
      io.log(err.message)
      return 2
    }
    throw err
  }
}

/* v8 ignore start -- process glue */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url))
  const code = await run(process.argv.slice(2), {
    settingsFile: process.env.CLAUDE_SETTINGS_FILE || join(homedir(), '.claude', 'settings.json'),
    home: process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office'),
    hookScript: join(here, '..', 'hooks', 'agent-office-hook.mjs'),
    log: (l) => console.log(l),
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(q)
      rl.close()
      return /^y(es)?$/i.test(answer.trim())
    },
  })
  process.exit(code)
}
/* v8 ignore stop */
