// Real-CLI verification (plan "multi-provider platform" §9; docs/provider-integrations.md §10).
// For each installed and logged-in provider CLI, starts a managed session through the REAL adapter in
// a temp folder and checks each capability with harmless prompts. Nothing outside the temp folder is
// touched; every session is closed. Prints a pass / fail / n/a matrix (and JSON with --json).
//
//   pnpm exec tsx scripts/verify-providers.ts [--only codex,cursor] [--json]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { AgentRunner, ProviderProbe, RunnerSession } from '@agent-office/core'
import { CodexProbe, CodexRunner } from '../packages/adapters/src/providers/index.ts'

type Result = 'pass' | 'fail' | 'n/a'
const CHECKS = [
  'detect',
  'auth',
  'start',
  'stream',
  'approve',
  'reply',
  'deny',
  'interrupt',
  'models',
  'modes',
  'stop',
] as const
type Check = (typeof CHECKS)[number]

interface Target {
  id: string
  probe: ProviderProbe
  runner: AgentRunner
  /** Process name pattern for the leftover-process check. */
  processPattern: string
  /** A mode that asks before running commands, and a different one to switch to. */
  askMode?: string
  otherMode?: string
}

const TARGETS: Target[] = [
  {
    id: 'codex',
    probe: new CodexProbe({}),
    runner: new CodexRunner({}),
    processPattern: 'codex app-server',
    askMode: 'ask',
    otherMode: 'read-only',
  },
]

const STEP_MS = 120_000
const COMMAND_PROMPT =
  'Run exactly this shell command in the current folder: node -e "console.log(6*7)" — then reply with only its output. Do not modify any file.'

function withTimeout<T>(p: Promise<T>, ms = STEP_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms)),
  ])
}

function countProcesses(pattern: string): number {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean).length
  } catch {
    return 0
  }
}

async function verify(t: Target): Promise<Record<Check, Result> & { notes: string[] }> {
  const r = Object.fromEntries(CHECKS.map((c) => [c, 'n/a'])) as Record<Check, Result>
  const notes: string[] = []
  const probe = await t.probe.detect()
  r.detect = probe.installed && probe.flagsOk ? 'pass' : 'fail'
  if (r.detect !== 'pass') return { ...r, notes: ['not installed or flags missing'] }
  r.auth = probe.auth === 'ok' ? 'pass' : probe.auth === 'unknown' ? 'n/a' : 'fail'
  if (probe.auth === 'needed') return { ...r, notes: ['login required'] }

  const dir = mkdtempSync(join(tmpdir(), `ao-verify-${t.id}-`))
  writeFileSync(join(dir, 'hello.txt'), 'hello from agent-office verification\n')
  const before = countProcesses(t.processPattern)
  let s: RunnerSession | undefined
  try {
    s = t.runner.start({
      cwd: dir,
      mode: 'default',
      modeId: t.askMode,
      extraDirs: [],
      chrome: false,
      allowBypass: false,
    })
    await withTimeout(s.sessionId)
    r.start = 'pass'

    const statuses = new Set<string>()
    s.onEvent((e) => e.status && statuses.add(e.status))
    const results: { text: string; isError: boolean }[] = []
    const nextResult = () =>
      withTimeout(
        new Promise<{ text: string; isError: boolean }>((ok) => {
          const off = s!.onResult((x) => {
            off()
            results.push(x)
            ok(x)
          })
        }),
      )
    let decide: 'allow' | 'deny' = 'allow'
    let asked = 0
    s.onPermission(async (p) => {
      asked++
      notes.push(`permission asked: ${p.tool}`)
      return decide === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied by verification' }
    })

    // Approve: the command is not on the auto-allowed list, so a permission request must arrive.
    let res = nextResult()
    s.push(COMMAND_PROMPT)
    const first = await res
    r.stream = statuses.size > 0 ? 'pass' : 'fail'
    r.approve = asked > 0 ? 'pass' : 'fail'
    r.reply = !first.isError && first.text.includes('42') ? 'pass' : 'fail'
    if (r.reply === 'fail') notes.push(`reply: ${first.text.slice(0, 80)}`)

    // Deny: the turn still finishes (the agent reports it couldn't run the command).
    decide = 'deny'
    const askedBefore = asked
    res = nextResult()
    s.push('Run the same command again and reply with its output.')
    const second = await res
    r.deny = asked > askedBefore && !second.text.includes('42') ? 'pass' : 'fail'

    // Interrupt: a long answer, interrupted after it starts.
    res = nextResult()
    s.push('Count from 1 to 400, one number per line, without using any tools.')
    await new Promise((ok) => setTimeout(ok, 4000))
    await s.interrupt()
    await res.then(
      () => (r.interrupt = 'pass'),
      () => (r.interrupt = 'fail'),
    )

    const models = await s.supportedModels().catch(() => [])
    r.models = models.length > 0 ? 'pass' : 'fail'
    if (t.otherMode && s.setModeId) {
      await s.setModeId(t.otherMode).then(
        () => (r.modes = 'pass'),
        () => (r.modes = 'fail'),
      )
    }
  } catch (e) {
    notes.push(`error: ${(e as Error).message}`)
  } finally {
    await s?.close().catch(() => {})
    await new Promise((ok) => setTimeout(ok, 2500))
    r.stop = s ? (countProcesses(t.processPattern) <= before ? 'pass' : 'fail') : 'n/a'
    rmSync(dir, { recursive: true, force: true })
  }
  return { ...r, notes }
}

const { values } = parseArgs({ options: { only: { type: 'string' }, json: { type: 'boolean' } } })
const only = values.only?.split(',')
const rows: (Record<string, unknown> & { id: string })[] = []
for (const t of TARGETS.filter((x) => !only || only.includes(x.id))) {
  process.stdout.write(`verifying ${t.id}…\n`)
  rows.push({ id: t.id, ...(await verify(t)) })
}
if (values.json) console.log(JSON.stringify(rows, null, 2))
else {
  console.log(['provider', ...CHECKS].join('\t'))
  for (const row of rows) {
    console.log([row.id, ...CHECKS.map((c) => row[c])].join('\t'))
    for (const n of row.notes as string[]) console.log(`  · ${n}`)
  }
}
process.exit(rows.some((row) => CHECKS.some((c) => row[c] === 'fail')) ? 1 : 0)
