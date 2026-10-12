// Detects the Codex CLI without starting a session: `codex --version`, `codex app-server --help`,
// then `account/read` on a short-lived app-server (no thread, no turn). Never throws; 3 s in total.
import { tmpdir } from 'node:os'
import type { ProbeResult, ProviderProbe } from '@agent-office/core'
import { JsonRpcPeer } from '../common/jsonrpc.ts'
import { probeCli } from '../common/probe.ts'
import { spawnRuntime } from '../common/process.ts'
import { AccountReadResult, M } from './codex-protocol.ts'

export interface CodexProbeOptions {
  /** Default 'codex'. */
  bin?: string
  /** Arguments before the subcommand (tests run the fake as `node fake.mjs …`). */
  argsPrefix?: string[]
  /** Extra environment for the short-lived app-server. */
  env?: Record<string, string | undefined>
  /** Budget for the whole detect(). Default 3000 ms. */
  timeoutMs?: number
}

const VERSION = /(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/

export class CodexProbe implements ProviderProbe {
  readonly provider = 'codex' as const

  constructor(private o: CodexProbeOptions = {}) {}

  async detect(): Promise<ProbeResult> {
    const bin = this.o.bin ?? 'codex'
    const pre = this.o.argsPrefix ?? []
    const deadline = Date.now() + (this.o.timeoutMs ?? 3000)
    const left = () => Math.max(1, deadline - Date.now())
    try {
      const v = await probeCli(bin, [...pre, '--version'], left())
      if (v.timedOut) return { installed: true, flagsOk: false, auth: 'unknown', error: 'timeout' }
      const version = VERSION.exec(v.stdout)?.[1]
      const base = { installed: true, ...(version ? { version } : {}) }
      const help = await probeCli(bin, [...pre, 'app-server', '--help'], left())
      if (help.timedOut) return { ...base, flagsOk: false, auth: 'unknown', error: 'timeout' }
      if (!/generate-json-schema|--listen/.test(help.stdout))
        return { ...base, flagsOk: false, auth: 'unknown' }
      const auth = await this.auth(bin, [...pre, 'app-server'], left())
      return { ...base, flagsOk: true, ...auth }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT' || code === 'EACCES')
        return { installed: false, flagsOk: false, auth: 'unknown' }
      return { installed: false, flagsOk: false, auth: 'unknown', error: 'spawn' }
    }
  }

  private async auth(
    bin: string,
    args: string[],
    ms: number,
  ): Promise<Pick<ProbeResult, 'auth' | 'error'>> {
    const proc = spawnRuntime(bin, args, {
      cwd: tmpdir(),
      ...(this.o.env ? { env: this.o.env } : {}),
      killGraceMs: 500,
    })
    const peer = new JsonRpcPeer(proc.stdout, proc.stdin, { dialect: 'codex' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Pick<ProbeResult, 'auth' | 'error'>>((resolve) => {
      timer = setTimeout(() => resolve({ auth: 'unknown', error: 'timeout' }), ms)
    })
    const check = (async (): Promise<Pick<ProbeResult, 'auth' | 'error'>> => {
      try {
        await peer.request(M.initialize, {
          clientInfo: { name: 'agent-office', title: 'agent-office', version: '1' },
        })
        peer.notify(M.initialized)
        const r = AccountReadResult.parse(
          await peer.request(M.accountRead, { refreshToken: false }),
        )
        return { auth: r.requiresOpenaiAuth && !r.account ? 'needed' : 'ok' }
      } catch {
        return { auth: 'unknown', error: 'protocol' }
      }
    })()
    try {
      return await Promise.race([check, timeout])
    } finally {
      clearTimeout(timer)
      peer.close()
      await proc.kill()
    }
  }
}
