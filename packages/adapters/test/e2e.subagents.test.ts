import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock, ManualScheduler } from '@agent-office/core/testing'
import { ClaudeCodeTailer } from '../src/sources/claude-code/tailer.ts'
import { NodeTranscriptFiles } from '../src/sources/claude-code/transcript-files.ts'
import { is, observe, startServer } from './helpers.ts'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

describe('Claude Code subagent lifecycle (E2E)', () => {
  it('shows a subagent with its task, follows its tools, and marks it done when its turn ends', async () => {
    const srv = await startServer()
    cleanup.push(srv.close)

    // A fake projects dir: a parent session and one subagent with a meta file. Content is invented.
    const dir = mkdtempSync(join(tmpdir(), 'ao-e2e-sub-'))
    const project = join(dir, '-home-dev-shop')
    const subDir = join(project, 'sess-sub', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const line = (o: object) =>
      JSON.stringify({
        sessionId: 'sess-sub',
        cwd: '/home/dev/shop',
        timestamp: new Date().toISOString(),
        ...o,
      })
    const side = { isSidechain: true, agentId: 'x' }
    writeFileSync(
      join(project, 'sess-sub.jsonl'),
      line({ type: 'user', message: { content: 'start' } }) + '\n',
    )
    writeFileSync(
      join(subDir, 'agent-x.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'Map the auth flow' }),
    )
    const subFile = join(subDir, 'agent-x.jsonl')
    writeFileSync(subFile, line({ type: 'user', ...side, message: { content: 'go' } }) + '\n')

    const ui = observe(srv.office)
    cleanup.push(ui.stop)
    const source = new ClaudeCodeTailer({
      dir,
      files: new NodeTranscriptFiles(),
      activity: srv.office.activity,
      clock: new FakeClock(Date.now()),
      scheduler: new ManualScheduler(),
      expireAfterMs: 600_000,
    })

    // First pass: the child appears under the parent session and carries its task from the meta file.
    await source.tick()
    await ui.next(is('upsert', (m) => m.agent.id === 'cc:x'))
    expect(srv.office.query.agent('cc:x')).toMatchObject({
      parentId: 'cc:sess-sub',
      task: 'Map the auth flow',
    })

    // The subagent runs a tool: activity (tool/text) changes while the task stays put.
    appendFileSync(
      subFile,
      line({
        type: 'assistant',
        ...side,
        message: {
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', name: 'Grep', input: { description: 'Search login' } }],
        },
      }) + '\n',
    )
    await source.tick()
    await ui.next(is('upsert', (m) => m.agent.id === 'cc:x' && m.agent.tool === 'Grep'))
    expect(srv.office.query.agent('cc:x')).toMatchObject({
      tool: 'Grep',
      text: 'Search login',
      task: 'Map the auth flow',
    })

    // The subagent finishes its turn: it is done, completed and has an end time (not "waiting").
    appendFileSync(
      subFile,
      line({
        type: 'assistant',
        ...side,
        message: { content: [{ type: 'text', text: 'summary' }], stop_reason: 'end_turn' },
      }) + '\n',
    )
    await source.tick()
    await ui.next(is('upsert', (m) => m.agent.id === 'cc:x' && m.agent.status === 'done'))
    const done = srv.office.query.agent('cc:x')
    expect(done).toMatchObject({ status: 'done', ended: 'completed', task: 'Map the auth flow' })
    expect(done?.endedAt).toBeTypeOf('number')
    // The parent session is untouched by the child's ending.
    expect(srv.office.query.agent('cc:sess-sub')?.status).not.toBe('done')
  })
})
