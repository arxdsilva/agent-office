import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerStart } from '@agent-office/core'
import { writeFileAtomic } from '../fs/atomic.ts'

export interface McpLauncherOptions {
  /** The app's user-data dir; the wrapper goes to `<userData>/mcp/`. */
  userData: string
  /** Binary that runs the bridge: the Electron app itself (packaged) or `node` (dev). */
  execPath: string
  /** Absolute path of hooks/agent-office-mcp.mjs. */
  script: string
  platform: string
  /** true when execPath is Electron and must behave as plain Node. */
  runAsNode: boolean
  /** Live API base url (e.g. http://127.0.0.1:4317), read on every launch (port 0, port changes). */
  url: () => string
}

export type McpServerLaunch = NonNullable<RunnerStart['mcp']>

export const MCP_SERVER_NAME = 'agent-office'
const WRAPPER = 'agent-office-mcp'

/** Loopback http only: the token must never be sent anywhere else. */
const SAFE_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/
/** `mcp_` + 32 random bytes (hex or base64url). */
const SAFE_TOKEN = /^mcp_[A-Za-z0-9_-]{16,200}$/
/** Characters that would escape the double-quoted path in the sh / cmd wrapper. */
const UNSAFE_POSIX = /["$`\\\r\n]/
const UNSAFE_WIN = /["%\r\n]/

/**
 * Writes the stdio wrapper agents start as agent-office's MCP server (docs/projects.md §5), the
 * same execPath + ELECTRON_RUN_AS_NODE pattern as FsHookRunner, and builds `RunnerStart.mcp` for
 * one managed session. The wrapper holds no url and no token: both go through the process env.
 */
export class McpLauncher {
  readonly wrapperPath: string

  constructor(private o: McpLauncherOptions) {
    const unsafe = o.platform === 'win32' ? UNSAFE_WIN : UNSAFE_POSIX
    if (unsafe.test(o.execPath) || unsafe.test(o.script)) throw new Error('unsafe mcp wrapper path')
    this.wrapperPath = join(
      o.userData,
      'mcp',
      o.platform === 'win32' ? `${WRAPPER}.cmd` : `${WRAPPER}.sh`,
    )
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
      `#!/bin/sh\n# agent-office MCP bridge wrapper (generated)\n${env}exec "${execPath}" "${script}"\n`,
    )
    await chmod(this.wrapperPath, 0o755)
  }

  /** The stdio server entry for one session's token. Throws on a non-loopback url or bad token. */
  launch(token: string): McpServerLaunch {
    const url = this.o.url()
    if (!SAFE_URL.test(url)) throw new Error('unsafe mcp url')
    if (!SAFE_TOKEN.test(token)) throw new Error('malformed mcp token')
    return {
      name: MCP_SERVER_NAME,
      command: this.wrapperPath,
      args: [],
      env: { AGENT_OFFICE_MCP_URL: `${url}/mcp`, AGENT_OFFICE_MCP_TOKEN: token },
    }
  }

  async remove(): Promise<void> {
    await rm(this.wrapperPath, { force: true })
  }
}
