// Detects an ACP agent's CLI without starting a session: `<bin> --version`, then the profile's
// help call must mention the ACP surface. Login state is only known once a session starts, so
// auth is always 'unknown' here. Never throws; one time budget for the whole detect().
import { execFile } from 'node:child_process'
import type { ProbeResult, ProviderProbe } from '@agent-office/core'
import { runtimeEnv } from '../process.ts'
import type { AcpProfile } from './acp-profile.ts'

export interface AcpProbeOptions {
  /** Overrides the profile's binary. */
  bin?: string
  /** Arguments before the probe's own (tests run the fake as `node fake.mjs …`). */
  argsPrefix?: string[]
  /** Extra environment for the probe calls (our token is always removed). */
  env?: Record<string, string | undefined>
  /** Budget for the whole detect(). Default 3000 ms. */
  timeoutMs?: number
}

const VERSION = /(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/
// Copilot's help is ~14 KB with `--acp` near the end: read all of it (bounded), match, keep nothing.
const MAX_HELP = 256 * 1024

interface CliOut {
  stdout: string
  /** yargs CLIs (OpenCode, Kilo) print help on stderr. Matched against `acpFlag` only. */
  stderr: string
  timedOut: boolean
}

function run(
  bin: string,
  args: string[],
  ms: number,
  env: Record<string, string>,
): Promise<CliOut> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { shell: false, timeout: ms, maxBuffer: MAX_HELP, windowsHide: true, env },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errOut = String(stderr ?? '')
        if (!err) return resolve({ stdout: out, stderr: errOut, timedOut: false })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (e.killed) return resolve({ stdout: out, stderr: errOut, timedOut: true })
        // Exited non-zero (some CLIs print help with code 1), or the help was over the cap.
        if (typeof e.code === 'number' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve({ stdout: out, stderr: errOut, timedOut: false })
        reject(err)
      },
    )
  })
}

export class AcpProbe implements ProviderProbe {
  readonly provider: AcpProfile['provider']

  constructor(
    private profile: AcpProfile,
    private o: AcpProbeOptions = {},
  ) {
    this.provider = profile.provider
  }

  async detect(): Promise<ProbeResult> {
    const bin = this.o.bin ?? this.profile.bin
    const pre = this.o.argsPrefix ?? []
    const env = runtimeEnv(this.o.env)
    const deadline = Date.now() + (this.o.timeoutMs ?? 3000)
    const left = () => Math.max(1, deadline - Date.now())
    try {
      const v = await run(bin, [...pre, '--version'], left(), env)
      if (v.timedOut) return { installed: true, flagsOk: false, auth: 'unknown', error: 'timeout' }
      const version = VERSION.exec(v.stdout)?.[1]
      const base = { installed: true, ...(version ? { version } : {}) }
      const help = await run(bin, [...pre, ...(this.profile.helpArgs ?? ['--help'])], left(), env)
      if (help.timedOut) return { ...base, flagsOk: false, auth: 'unknown', error: 'timeout' }
      return { ...base, flagsOk: this.profile.acpFlag.test(help.stdout) || this.profile.acpFlag.test(help.stderr), auth: 'unknown' }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT' || code === 'EACCES')
        return { installed: false, flagsOk: false, auth: 'unknown' }
      return { installed: false, flagsOk: false, auth: 'unknown', error: 'spawn' }
    }
  }
}
