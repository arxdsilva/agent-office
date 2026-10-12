import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HOOK_MARKER, type HookRunner } from '@agent-office/core'
import { writeFileAtomic } from './atomic.ts'

export interface HookRunnerOptions {
  /** Where the wrapper script lives (app user-data dir). */
  dir: string
  /** Binary that runs the hook: the Electron app itself (packaged) or `node` (dev). */
  execPath: string
  /** Absolute path of hooks/agent-office-hook.mjs. */
  script: string
  platform: string
  /** true when execPath is Electron and must behave as plain Node. */
  runAsNode: boolean
  /**
   * Live API base url (e.g. http://127.0.0.1:4317), read on every write so a port change reaches
   * the hook after heal(). Omitted: the hook uses its built-in default.
   */
  url?: () => string
  /** Wrapper basename without extension. Default: the Claude hook's marker. */
  name?: string
  /** Extra arguments for the script; today only the provider id (`--provider <id>`). */
  args?: { provider: string }
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/
const SAFE_PROVIDER = /^[a-z-]{1,20}$/

/** Loopback http only; validated before it is interpolated into a shell or cmd script. */
const SAFE_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/

/**
 * Claude Code runs our hook through a small wrapper so users don't need Node on PATH: the wrapper
 * execs the app's own binary in Node mode. Rewritten on each launch (HookService.heal) so it keeps
 * pointing at the current binary after updates or moves.
 */
export class FsHookRunner implements HookRunner {
  readonly wrapperPath: string

  private readonly extra: string

  constructor(private o: HookRunnerOptions) {
    const name = o.name ?? HOOK_MARKER
    if (!SAFE_NAME.test(name)) throw new Error('unsafe hook wrapper name')
    if (o.args && !SAFE_PROVIDER.test(o.args.provider)) throw new Error('unsafe hook provider')
    this.extra = o.args ? ` --provider ${o.args.provider}` : ''
    this.wrapperPath = join(o.dir, o.platform === 'win32' ? `${name}.cmd` : `${name}.sh`)
  }

  command(): string {
    return `"${this.wrapperPath}"`
  }

  async ensureInstalled(): Promise<void> {
    const { execPath, script, runAsNode } = this.o
    const url = this.o.url?.()
    if (url !== undefined && !SAFE_URL.test(url)) throw new Error('unsafe hook url')
    if (this.o.platform === 'win32') {
      const setUrl = url ? `if not defined AGENT_OFFICE_URL set "AGENT_OFFICE_URL=${url}"\r\n` : ''
      const env = runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''
      await writeFileAtomic(
        this.wrapperPath,
        `@echo off\r\n${setUrl}${env}"${execPath}" "${script}"${this.extra}\r\n`,
      )
      return
    }
    const setUrl = url ? `AGENT_OFFICE_URL="\${AGENT_OFFICE_URL:-${url}}" ` : ''
    const env = runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
    await writeFileAtomic(
      this.wrapperPath,
      `#!/bin/sh\n# agent-office hook wrapper (generated)\n${setUrl}${env}exec "${execPath}" "${script}"${this.extra}\n`,
    )
    await chmod(this.wrapperPath, 0o755)
  }

  async remove(): Promise<void> {
    await rm(this.wrapperPath, { force: true })
  }
}
