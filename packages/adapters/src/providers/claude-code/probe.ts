import type { ProbeResult, ProviderProbe } from '@agent-office/core'
import { probeCli } from '../common/probe.ts'

const TIMEOUT_MS = 3000

export interface ClaudeProbeOptions {
  /** Path of the installed `claude` CLI, or undefined when none is found. */
  resolve: () => string | undefined
  timeoutMs?: number
}

/** `2.1.270 (Claude Code)` → `2.1.270`. */
export function parseClaudeVersion(stdout: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(stdout)?.[1]
}

/** Detects the Claude Code CLI with `--version`. Never starts a session; never throws. */
export class ClaudeProbe implements ProviderProbe {
  readonly provider = 'claude-code' as const
  constructor(private readonly o: ClaudeProbeOptions) {}

  async detect(): Promise<ProbeResult> {
    let bin: string | undefined
    try {
      bin = this.o.resolve()
    } catch {
      bin = undefined
    }
    if (!bin) return { installed: false, flagsOk: false, auth: 'unknown' }
    try {
      const r = await probeCli(bin, ['--version'], this.o.timeoutMs ?? TIMEOUT_MS)
      if (r.timedOut) return { installed: true, flagsOk: false, auth: 'unknown', error: 'timeout' }
      const version = r.code === 0 ? parseClaudeVersion(r.stdout) : undefined
      if (!version) return { installed: true, flagsOk: false, auth: 'unknown', error: 'protocol' }
      return { installed: true, version, flagsOk: true, auth: 'unknown' }
    } catch {
      return { installed: false, flagsOk: false, auth: 'unknown', error: 'spawn' }
    }
  }
}
