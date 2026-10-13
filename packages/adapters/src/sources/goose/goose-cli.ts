// Runs `goose` read-only, for the history source and transcript reader: `session list --format json`
// and `session export --format json`. Fixed arguments, `shell:false`, bounded time and output.
// The CLI is the only reader of goose's database; nothing is copied and no path is logged.
import { execFile } from 'node:child_process'
import { runtimeEnv } from '../../providers/common/process.ts'

export type GooseCli = (args: string[]) => Promise<string>

const MAX_OUT = 32 * 1024 * 1024
const TIMEOUT_MS = 15_000

export function nodeGooseCli(
  o: { bin?: string; env?: Record<string, string | undefined> } = {},
): GooseCli {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        o.bin ?? 'goose',
        args,
        {
          shell: false,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_OUT,
          windowsHide: true,
          env: runtimeEnv(o.env),
        },
        (err, stdout) => (err ? reject(new Error('goose failed')) : resolve(String(stdout))),
      )
    })
}
