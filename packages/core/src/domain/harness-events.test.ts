import { describe, expect, it } from 'vitest'
import { newHarnessEvent, redactSummary, toEventView } from './harness-events.ts'

const base = {
  id: 'hev_1',
  projectId: 'prj_1',
  sessionId: 'ses_1',
  agentId: 'cc:1',
  ts: 5,
  ruleIds: ['rul_a'],
}

describe('harness events', () => {
  it('no-leak: a secret in tool input never reaches the event', () => {
    const e = newHarnessEvent({
      ...base,
      kind: 'action-denied',
      tool: 'Bash',
      input: {
        command: 'curl -H "Authorization: Bearer SECRET-9f3a" https://x',
        other: 'RAW-INPUT',
      },
      cwd: '/work/shop',
    })
    const json = JSON.stringify(e)
    expect(json).not.toContain('SECRET-9f3a')
    expect(json).not.toContain('RAW-INPUT')
    expect(e.detail.summary!.length).toBeLessThanOrEqual(120)
    expect(e.detail.tool).toBe('Bash')
  })

  it('file tools get a cwd-relative path; non-tool events carry gate details', () => {
    expect(
      newHarnessEvent({
        ...base,
        kind: 'action-allowed',
        tool: 'Edit',
        input: { file_path: '/work/shop/src/a.ts' },
        cwd: '/work/shop',
        agentRole: 'Explore',
      }).detail,
    ).toEqual({ tool: 'Edit', summary: 'src/a.ts', agentRole: 'Explore' })
    const g = newHarnessEvent({
      ...base,
      kind: 'validation-failed',
      gateId: 'gat_1',
      exitCode: 2,
      durationMs: 30,
      harnessVersions: ['hrn_a@1'],
    })
    expect(g.detail).toEqual({
      gateId: 'gat_1',
      exitCode: 2,
      durationMs: 30,
      harnessVersions: ['hrn_a@1'],
    })
    expect(toEventView(g)).toEqual({
      id: 'hev_1',
      ts: 5,
      kind: 'validation-failed',
      ruleIds: ['rul_a'],
      gateId: 'gat_1',
    })
    expect(
      toEventView(
        newHarnessEvent({ ...base, kind: 'action-asked', tool: 'Read', input: {}, cwd: '' }),
      ),
    ).toMatchObject({ tool: 'Read', summary: '' })
  })

  it.each([
    ['curl -u user:hunter2 https://x', 'hunter2'],
    ['TOKEN=abc123 make', 'abc123'],
    ['git clone https://me:pw123@github.com/x', 'pw123'],
    ['mysql --password=pa55 db', 'pa55'],
    ['echo ghp_0123456789abcdefghijklmnopqrstuv', 'ghp_0123456789abcdefghijklmnopqrstuv'],
    ['x api_key: zz-top', 'zz-top'],
  ])('redacts %s', (s, secret) => {
    expect(redactSummary(s)).not.toContain(secret)
  })
})

describe('question privacy (docs/harness.md §8)', () => {
  it('never stores the question text in the audit summary', () => {
    const e = newHarnessEvent({
      id: 'hev_q',
      projectId: 'prj_a',
      sessionId: 'ses_a',
      agentId: 'cc:a',
      ts: 1,
      kind: 'action-allowed',
      ruleIds: [],
      tool: 'AskUserQuestion',
      input: { questions: [{ question: 'Deploy SECRET-Q now?', options: [{ label: 'Yes' }] }] },
    })
    expect(JSON.stringify(e)).not.toContain('SECRET-Q')
    expect(e.detail.summary).toBe('Asked you a question')
  })
})
