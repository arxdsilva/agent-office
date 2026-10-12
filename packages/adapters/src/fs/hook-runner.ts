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
}

/**
 * Claude Code runs our hook through a small wrapper so users don't need Node on PATH: the wrapper
 * execs the app's own binary in Node mode. Rewritten on each launch (HookService.heal) so it keeps
 * pointing at the current binary after updates or moves.
 */
export class FsHookRunner implements HookRunner {
  readonly wrapperPath: string

  constructor(private o: HookRunnerOptions) {
    this.wrapperPath = join(
      o.dir,
      o.platform === 'win32' ? `${HOOK_MARKER}.cmd` : `${HOOK_MARKER}.sh`,
    )
  }

  command(): string {
    return `"${this.wrapperPath}"`
  }

  async ensureInstalled(): Promise<void> {
    const { execPath, script, runAsNode } = this.o
    if (this.o.platform === 'win32') {
      const env = runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''
      await writeFileAtomic(this.wrapperPath, `@echo off\r\n${env}"${execPath}" "${script}"\r\n`)
      return
    }
    const env = runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
    await writeFileAtomic(
      this.wrapperPath,
      `#!/bin/sh\n# agent-office hook wrapper (generated)\n${env}exec "${execPath}" "${script}"\n`,
    )
    await chmod(this.wrapperPath, 0o755)
  }

  async remove(): Promise<void> {
    await rm(this.wrapperPath, { force: true })
  }
}
