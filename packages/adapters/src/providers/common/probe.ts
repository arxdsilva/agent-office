import { execFile } from 'node:child_process'

export interface CliProbeResult {
  /** First 4 KB of stdout. */
  stdout: string
  code: number | null
  timedOut: boolean
}

const MAX_STDOUT = 4096

/**
 * Runs `<bin> <args>` once for detection: no shell, the caller's environment untouched, killed
 * after `timeoutMs`. Rejects only when the binary cannot be spawned (missing, not executable).
 */
export function probeCli(bin: string, args: string[], timeoutMs: number): Promise<CliProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { shell: false, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const out = String(stdout ?? '').slice(0, MAX_STDOUT)
        if (!err) return resolve({ stdout: out, code: 0, timedOut: false })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (e.killed) return resolve({ stdout: out, code: null, timedOut: true })
        if (typeof e.code === 'number')
          return resolve({ stdout: out, code: e.code, timedOut: false })
        reject(err)
      },
    )
  })
}
