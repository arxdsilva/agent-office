#!/usr/bin/env node
// Adds/removes the agent-office hook in Claude Code's user settings (~/.claude/settings.json).
// Usage: node scripts/hook-install.mjs install|uninstall [--yes]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const MARKER = 'agent-office-hook.mjs'
const EVENTS = ['Stop', 'UserPromptSubmit']

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER)

/** Returns a copy of `settings` with our hook removed from every event. */
export function removeHooks(settings) {
  const out = structuredClone(settings ?? {})
  if (!out.hooks) return out
  for (const event of EVENTS) {
    const groups = (out.hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0)
    if (groups.length) out.hooks[event] = groups
    else delete out.hooks[event]
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks
  return out
}

/** Returns a copy of `settings` with our hook registered for Stop and UserPromptSubmit (idempotent). */
export function addHooks(settings, command) {
  const out = removeHooks(settings)
  out.hooks ??= {}
  for (const event of EVENTS) {
    out.hooks[event] = [
      ...(out.hooks[event] ?? []),
      { hooks: [{ type: 'command', command, timeout: 5 }] },
    ]
  }
  return out
}

/**
 * @param {string[]} argv
 * @param {{settingsFile: string, hookPath: string, log: (s: string) => void, confirm: (q: string) => Promise<boolean>}} io
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io) {
  const [cmd] = argv
  if (cmd !== 'install' && cmd !== 'uninstall') {
    io.log('usage: hook-install.mjs install|uninstall [--yes]')
    return 2
  }
  let current = {}
  if (existsSync(io.settingsFile)) {
    try {
      current = JSON.parse(readFileSync(io.settingsFile, 'utf8'))
    } catch {
      io.log(`${io.settingsFile} is not valid JSON; fix it first.`)
      return 2
    }
  }
  const next = cmd === 'install' ? addHooks(current, `node "${io.hookPath}"`) : removeHooks(current)
  const before = JSON.stringify(current, null, 2)
  const after = JSON.stringify(next, null, 2)
  if (before === after) {
    io.log(
      cmd === 'install'
        ? 'agent-office hook already installed.'
        : 'agent-office hook not installed.',
    )
    return 0
  }
  io.log(
    `${cmd === 'install' ? 'Adding' : 'Removing'} agent-office hook (Stop, UserPromptSubmit) in ${io.settingsFile}:`,
  )
  io.log(after)
  if (!argv.includes('--yes') && !(await io.confirm('Apply? [y/N] '))) {
    io.log('Aborted, nothing changed.')
    return 1
  }
  if (existsSync(io.settingsFile))
    copyFileSync(io.settingsFile, `${io.settingsFile}.agent-office.bak`)
  mkdirSync(dirname(io.settingsFile), { recursive: true })
  writeFileSync(io.settingsFile, after + '\n')
  io.log(cmd === 'install' ? 'Installed. New Claude Code turns will pick it up.' : 'Removed.')
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url))
  const code = await run(process.argv.slice(2), {
    settingsFile: process.env.CLAUDE_SETTINGS_FILE || join(homedir(), '.claude', 'settings.json'),
    hookPath: join(here, '..', 'hooks', MARKER),
    log: (s) => console.log(s),
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(q)
      rl.close()
      return /^y(es)?$/i.test(answer.trim())
    },
  })
  process.exit(code)
}
