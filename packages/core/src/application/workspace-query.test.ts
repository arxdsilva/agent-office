import type { ProjectMessage } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { FakeRecordLog } from '../../test/fakes/index.ts'
import { harness, withProject } from '../../test/projects-harness.ts'
import { NotFoundError } from '../domain/errors.ts'

const note = (projectId: string, title: string, kind = 'note') => ({
  projectId,
  scope: 'project' as const,
  kind: kind as 'note',
  title,
  body: 'b',
})
const running = { chrome: false, pending: 0, phase: 'running' as const }

describe('WorkspaceQueryService', () => {
  it('WQ-overview answers “what needs my attention”', async () => {
    const h = harness({}, new FakeRecordLog(new Map(), 'memory-only'))
    const prj = await withProject(h)
    await h.projects.memory.create(note(prj, 'Use JWT', 'decision'))
    h.putAgent({
      id: 'cx:1',
      provider: 'codex',
      name: 'codex work',
      status: 'waiting',
      projectId: prj,
      managed: running,
    })
    h.putAgent({ id: 'cc:2', name: 'loose' })
    h.putAgent({ id: 'cc:3', status: 'thinking', managed: { ...running, pending: 1 } })
    const t = h.projects.mcp.mint({ projectId: prj, provider: 'codex' })!
    await h.projects.mcp.call(h.projects.mcp.principal(t.token)!, 'propose_memory', {
      kind: 'note',
      title: 'p',
      body: 'b',
    })
    const ses = h.projects.sessions.list({ scope: prj })[0]!.id
    await h.projects.handoffs.prepare({
      sessionId: ses,
      toProvider: 'claude-code',
      objective: 'go',
    })
    h.removeAgent('cc:2')
    const o = h.projects.workspace.overview()
    expect(o.vault).toBe('memory-only')
    expect(
      o.projects.map((p) => [p.name, p.activeAgents, p.approvedMemories, p.pendingMemories]),
    ).toEqual([['Shop', 1, 1, 1]])
    expect(o.waiting.map((w) => [w.agentId, w.projectId])).toEqual([
      ['cx:1', prj],
      ['cc:3', null],
    ])
    expect(o.pendingApprovals).toBe(1)
    expect(o.flowApprovals).toEqual([])
    expect(o.projects[0]!.harnessIds).toEqual([])
    expect(o.recentDecisions.map((d) => d.title)).toEqual(['Use JWT'])
    expect(o.unfinishedHandoffs).toHaveLength(1)
    expect(o.unassignedSessions).toBe(2)
    expect(o.recentCompletions).toEqual([]) // nothing assigned has finished yet
  })

  it('WQ-overview: flow approvals waiting on the user count as pending approvals; harnessIds in Applied order', async () => {
    const h = harness({
      enforcementOf: () => ({
        instructions: 'native',
        toolDeny: 'hook',
        pathDeny: 'hook',
        commandDeny: 'hook',
        fsIsolation: 'none',
        subagents: 'inherited',
      }),
    })
    const prj = await withProject(h)
    const a = await h.projects.harness.create({
      name: 'Flow',
      steps: [
        { name: 'Outline', goal: 'Agreed', exit: [{ kind: 'approval', prompt: 'Outline ok' }] },
      ],
    })
    const b = await h.projects.harness.create({
      name: 'Std',
      gates: [{ name: 'c', argv: ['make'] }],
    })
    for (const d of [a, b]) {
      await h.projects.harness.publish(d.id)
      await h.projects.harness.attach(prj, d.id)
    }
    await h.projects.harness.reorder(prj, [b.id, a.id])
    const ap = (await h.projects.policy.prepare({
      projectId: prj,
      provider: 'claude-code',
      cwd: '/work/shop',
      mode: 'default',
    }))!
    h.putAgent({ id: 'cc:f', name: 'Writer', projectId: prj, managed: running })
    h.projects.policy.bind({ agentId: 'cc:f', sessionId: 'f', projectId: prj, policy: ap })
    const o = h.projects.workspace.overview()
    expect(o.projects[0]!.harnessIds).toEqual([b.id, a.id])
    expect(o.flowApprovals).toMatchObject([
      {
        projectId: prj,
        projectName: 'Shop',
        agentId: 'cc:f',
        agentName: 'Writer',
        prompt: 'Outline ok',
      },
    ])
    expect(o.pendingApprovals).toBe(1)
  })

  it('WQ-dashboard: active agents, activity, tasks, knowledge, sessions', async () => {
    const h = harness()
    const prj = await withProject(h)
    await h.projects.memory.create(note(prj, 'D', 'decision'))
    h.putAgent({
      id: 'cc:1',
      name: 'shop',
      status: 'tool',
      tool: 'Bash',
      projectId: prj,
      managed: running,
    })
    const task = await h.projects.tasks.create(prj, 'Ship logout')
    await h.projects.tasks.addEvidence(task.id, { level: 'committed', ref: 'abc123' })
    await h.projects.tasks.setState(task.id, 'done')
    const d = h.projects.workspace.dashboard(prj)
    expect(d.project.name).toBe('Shop')
    expect(d.active).toEqual([
      { agentId: 'cc:1', name: 'shop', provider: 'claude-code', status: 'tool', activity: 'Bash' },
    ])
    expect(d.knowledge).toMatchObject({ approved: 1, pending: 0 })
    expect(d.knowledge.decisions.map((x) => x.title)).toEqual(['D'])
    expect(d.tasks.map((t) => [t.title, t.evidence])).toEqual([['Ship logout', 'committed']])
    expect(d.completed).toEqual([
      { taskId: task.id, title: 'Ship logout', evidence: 'committed', at: expect.any(Number) },
    ])
    expect(d.sessions.map((s) => s.title)).toEqual(['shop'])
    expect(d.activity.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['session.started', 'task.created', 'task.completed']),
    )
    expect(JSON.stringify(d)).not.toContain('/work')
    expect(() => h.projects.workspace.dashboard('prj_unknown00000')).toThrow(NotFoundError)
    expect(h.projects.workspace.overview().recentCompletions.map((a) => a.kind)).toContain(
      'task.completed',
    )
  })

  it('WQ-watch maps store changes to ProjectMessage pushes', async () => {
    const h = harness()
    await h.projects.load()
    const got: ProjectMessage[] = []
    const off = h.projects.workspace.watch((m) => got.push(m))
    const p = await h.projects.catalog.create({ name: 'Shop', folders: ['/work/shop'] })
    await h.projects.memory.create(note(p.id, 'N'))
    h.putAgent({ id: 'cc:1' })
    await h.projects.observation.located('cc:1', 'claude-code', { cwd: '/work/shop' })
    const t = h.projects.mcp.mint({ projectId: p.id, provider: 'codex' })!
    await h.projects.mcp.call(h.projects.mcp.principal(t.token)!, 'list_decisions', {})
    off()
    const types = new Set(got.map((m) => m.type))
    for (const k of ['projects', 'memory', 'session', 'activity', 'agent-project', 'retrieval'])
      expect(types.has(k as never), k).toBe(true)
    expect(JSON.stringify(got)).not.toContain('/work')
    expect(JSON.stringify(got)).not.toContain('tr_')
    const n = got.length
    await h.projects.memory.create(note(p.id, 'after'))
    expect(got.length).toBe(n)
  })
})
