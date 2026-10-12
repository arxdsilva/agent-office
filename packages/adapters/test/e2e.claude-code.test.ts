import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock, ManualScheduler } from '@agent-office/core/testing'
import { ClaudeCodeTailer } from '../src/sources/claude-code/tailer.ts'
import { NodeTranscriptFiles } from '../src/sources/claude-code/transcript-files.ts'
import { is, observe, startServer, TOKEN } from './helpers.ts'

const HOOK = fileURLToPath(new URL('../../../hooks/agent-office-hook.mjs', import.meta.url))

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

/** Runs the real hook script the way Claude Code does: JSON on stdin, JSON (or nothing) on stdout. */
function runHook(input: object, env: Record<string, string>) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin!.end(JSON.stringify(input))
  })
}

describe('Claude Code adapter + hook (E2E)', () => {
  it('shows a session with its subagent, delivers a UI message via the hook, and records the reply', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)

    // A fake ~/.claude/projects with one session (titled) and one subagent with a meta file. Content is invented.
    const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-cc-'))
    const project = join(dir, '-home-dev-shop')
    const subDir = join(project, 'sess-e2e', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const now = new Date().toISOString()
    const line = (o: object) =>
      JSON.stringify({ sessionId: 'sess-e2e', cwd: '/home/dev/shop', timestamp: now, ...o })
    writeFileSync(
      join(project, 'sess-e2e.jsonl'),
      [
        line({ type: 'user', message: { content: 'start' } }),
        JSON.stringify({ type: 'ai-title', sessionId: 'sess-e2e', aiTitle: 'Checkout bug' }),
        line({
          type: 'assistant',
          message: {
            model: 'claude-opus-5-5',
            content: [{ type: 'tool_use', name: 'Bash', input: {} }],
          },
        }),
      ].join('\n') + '\n',
    )
    writeFileSync(
      join(subDir, 'agent-sub1.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Find the bug' }),
    )
    writeFileSync(
      join(subDir, 'agent-sub1.jsonl'),
      line({ type: 'user', isSidechain: true, agentId: 'sub1', message: { content: 'go' } }) + '\n',
    )

    const ui = observe(srv.office)
    cleanup.push(ui.stop)

    // One polling pass of the real adapter: the session lands in the claude-code zone under its title,
    // and the subagent sits with its parent.
    const source = new ClaudeCodeTailer({
      dir,
      files: new NodeTranscriptFiles(),
      activity: srv.office.activity,
      clock: new FakeClock(Date.now()),
      scheduler: new ManualScheduler(),
      expireAfterMs: 600_000,
    })
    await source.tick()
    await ui.next(
      is('upsert', (m) => m.agent.id === 'cc:sess-e2e' && m.agent.topic === 'Checkout bug'),
    )
    expect(srv.office.query.agent('cc:sess-e2e')).toMatchObject({
      provider: 'claude-code',
      status: 'tool',
      tool: 'Bash',
    })
    expect(srv.office.query.agent('cc:sub1')).toMatchObject({
      name: 'Explore',
      parentId: 'cc:sess-e2e',
    })

    // The user types a message to the session in the UI.
    const sent = await srv.api(`/api/agents/${encodeURIComponent('cc:sess-e2e')}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: 'also check the coupon code path' }),
    })
    expect(sent.status).toBe(202)

    // Claude's turn ends → the Stop hook claims the message and tells Claude to continue with it.
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, TOKEN)
    const env = { AGENT_OFFICE_URL: srv.url, AGENT_OFFICE_TOKEN_FILE: tokenFile }
    const stop1 = JSON.parse(
      await runHook({ hook_event_name: 'Stop', session_id: 'sess-e2e' }, env),
    )
    expect(stop1.decision).toBe('block')
    expect(stop1.reason).toContain('also check the coupon code path')
    await ui.next(is('chat', (m) => m.message.state === 'delivered'))
    expect(srv.office.query.agent('cc:sess-e2e')?.interactive).toBe(true)

    // Claude answers and stops again → the hook posts the answer as the reply; nothing new to deliver.
    const stop2 = await runHook(
      {
        hook_event_name: 'Stop',
        session_id: 'sess-e2e',
        last_assistant_message: 'Coupon path is fine too.',
      },
      env,
    )
    expect(stop2).toBe('')
    const reply = await ui.next(is('chat', (m) => m.message.from === 'agent'))
    expect(reply.message.text).toBe('Coupon path is fine too.')

    // A later, unrelated Stop must not record anything (nothing is awaiting a reply).
    await runHook(
      { hook_event_name: 'Stop', session_id: 'sess-e2e', last_assistant_message: 'unrelated' },
      env,
    )
    expect(srv.office.chat.history('cc:sess-e2e').filter((m) => m.from === 'agent')).toHaveLength(1)
  })

  it('shows the permission mode a terminal session reports through the hook (CC-mode)', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)

    // A terminal session whose last prompt ran in the default mode. The line is a second old, so
    // the hook's report (stamped by the server now) is the later write.
    const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-cc-mode-'))
    const project = join(dir, '-home-dev-shop')
    mkdirSync(project, { recursive: true })
    writeFileSync(
      join(project, 'sess-mode.jsonl'),
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-mode',
        cwd: '/home/dev/shop',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        permissionMode: 'default',
        message: { content: 'start' },
      }) + '\n',
    )
    const source = new ClaudeCodeTailer({
      dir,
      files: new NodeTranscriptFiles(),
      activity: srv.office.activity,
      clock: new FakeClock(Date.now()),
      scheduler: new ManualScheduler(),
      expireAfterMs: 600_000,
    })
    await source.tick()
    expect(srv.office.query.agent('cc:sess-mode')?.permissionMode).toBe('default')

    // The user presses Shift+Tab into Plan mode and prompts: the hook reports the new mode.
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, TOKEN)
    const env = { AGENT_OFFICE_URL: srv.url, AGENT_OFFICE_TOKEN_FILE: tokenFile }
    const out = await runHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-mode', permission_mode: 'plan' },
      env,
    )
    expect(out).toBe('')
    expect(srv.office.query.agent('cc:sess-mode')?.permissionMode).toBe('plan')

    // Inside a session agent-office runs itself, the hook stays silent and reports nothing.
    await runHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-mode', permission_mode: 'auto' },
      { ...env, AGENT_OFFICE_MANAGED: '1' },
    )
    expect(srv.office.query.agent('cc:sess-mode')?.permissionMode).toBe('plan')
  })
})
