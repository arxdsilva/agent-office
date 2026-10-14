import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HookService } from '@agent-office/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSettingsFile } from '../src/fs/claude-settings-store.ts'
import { FsHookRunner } from '../src/fs/hook-runner.ts'
import { createAuth } from '../src/http/auth.ts'
import { buildHttpApi } from '../src/http/http-api.ts'
import { startHttpServer } from '../src/http/server.ts'
import { startServer, TOKEN } from './helpers.ts'
import { makeOffice } from './support.ts'

const HOOK = fileURLToPath(new URL('../../../hooks/agent-office-hook.mjs', import.meta.url))

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

/** Runs the generated wrapper the way Claude Code does, with AGENT_OFFICE_URL absent from the env. */
function runWrapper(wrapper: string, input: object, tokenFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENT_OFFICE_TOKEN_FILE: tokenFile,
  }
  delete env.AGENT_OFFICE_URL
  return new Promise<string>((resolve, reject) => {
    const child = execFile('/bin/sh', [wrapper], { env }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    )
    child.stdin!.end(JSON.stringify(input))
  })
}

/** Reports the Claude session on the given server, then queues one UI message for it. */
async function queueMessage(srv: Awaited<ReturnType<typeof startServer>>, text: string) {
  await srv.api('/api/events', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'cc:sess-port', provider: 'claude-code' }),
  })
  const res = await srv.api(`/api/agents/${encodeURIComponent('cc:sess-port')}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  expect(res.status).toBe(202)
}

describe('hook wrapper follows the API port (E2E)', () => {
  it.skipIf(process.platform === 'win32')(
    'reaches the server on a custom port, and the new one after a port change + heal',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-port-'))
      const tokenFile = join(dir, 'token')
      writeFileSync(tokenFile, TOKEN)
      const first = await startServer()
      let firstOpen = true
      cleanup.push(() => firstOpen && first.close())

      // The app installs the hook; the wrapper's url follows whatever port the API listens on now.
      let current = first
      const runner = new FsHookRunner({
        dir: join(dir, 'hook'),
        execPath: process.execPath,
        script: HOOK,
        platform: process.platform,
        runAsNode: false,
        url: () => current.url,
      })
      const hooks = new HookService({
        claude: new ClaudeSettingsFile(join(dir, 'claude', 'settings.json')),
        runner,
      })
      expect(await hooks.install()).toBe('installed')

      // A UI message waits on the first server; the Stop hook (no AGENT_OFFICE_URL) claims it there.
      await queueMessage(first, 'first port message')
      const stop1 = JSON.parse(
        await runWrapper(
          runner.wrapperPath,
          { hook_event_name: 'Stop', session_id: 'sess-port' },
          tokenFile,
        ),
      )
      expect(stop1.reason).toContain('first port message')

      // The user changes the port: a new server comes up, the old one goes away, and the app heals.
      const second = await startServer()
      cleanup.push(() => second.close())
      await first.close()
      firstOpen = false
      current = second
      await hooks.heal()
      expect(await hooks.status()).toBe('installed')

      // The same wrapper path now reaches the new server and claims its message.
      await queueMessage(second, 'second port message')
      const stop2 = JSON.parse(
        await runWrapper(
          runner.wrapperPath,
          { hook_event_name: 'Stop', session_id: 'sess-port' },
          tokenFile,
        ),
      )
      expect(stop2.reason).toContain('second port message')
    },
  )
})

describe('hook adds the current flow step (E2E)', () => {
  /** The fake office behind a real HTTP server, with a stubbed flow for agent `cc:sess-flow`. */
  async function serverWithFlow(progress: (id: string) => unknown) {
    const { office, scheduler } = makeOffice({})
    let current = createAuth({ token: TOKEN, port: 0 })
    const auth = { ...current, hostAllowed: (h: string | undefined) => current.hostAllowed(h) }
    const app = buildHttpApi(
      {
        activity: office.activity,
        inbox: office.inbox,
        chat: office.chat,
        query: office.query,
        flow: { progress: progress as never },
      },
      {
        ...auth,
        originAllowed: (o) => current.originAllowed(o),
        bearerOk: (h) => current.bearerOk(h),
      },
    )
    const server = await startHttpServer(app, { host: '127.0.0.1', port: 0 })
    current = createAuth({ token: TOKEN, port: server.port })
    cleanup.push(async () => {
      await server.close()
      scheduler.dispose()
    })
    return `http://127.0.0.1:${server.port}`
  }

  const run = (wrapper: string, tokenFile: string) =>
    runWrapper(wrapper, { hook_event_name: 'UserPromptSubmit', session_id: 'sess-flow' }, tokenFile)

  async function install(url: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-flow-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, TOKEN)
    const runner = new FsHookRunner({
      dir: join(dir, 'hook'),
      execPath: process.execPath,
      script: HOOK,
      platform: process.platform,
      runAsNode: false,
      url: () => url,
    })
    await new HookService({
      claude: new ClaudeSettingsFile(join(dir, 'claude', 'settings.json')),
      runner,
    }).install()
    return { wrapper: runner.wrapperPath, tokenFile }
  }

  it.skipIf(process.platform === 'win32')(
    'puts the active step on the UserPromptSubmit context, metadata only',
    async () => {
      const url = await serverWithFlow(() => ({
        current: 'stp_aaaaaaaa',
        steps: [
          {
            stepId: 'stp_aaaaaaaa',
            name: 'Plan',
            goal: 'Write the plan',
            checks: [{ label: 'SECRET' }],
          },
        ],
      }))
      const { wrapper, tokenFile } = await install(url)
      const out = JSON.parse(await run(wrapper, tokenFile))
      expect(out.hookSpecificOutput.additionalContext).toBe(
        'Current flow step: Plan — Write the plan',
      )
    },
  )

  it.skipIf(process.platform === 'win32')('prints nothing when the flow throws', async () => {
    const url = await serverWithFlow(() => {
      throw new Error('boom')
    })
    const { wrapper, tokenFile } = await install(url)
    expect(await run(wrapper, tokenFile)).toBe('')
  })
})
