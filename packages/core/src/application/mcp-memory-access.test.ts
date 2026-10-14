import { describe, expect, it } from 'vitest'
import { harness, withProject } from '../../test/projects-harness.ts'
import { DATA_PREFACE } from '../domain/handoff.ts'
import { ForbiddenError, RateLimitedError, ValidationError } from '../domain/errors.ts'

const note = (projectId: string | null, title: string, over: Record<string, unknown> = {}) => ({
  projectId,
  scope: (projectId ? 'project' : 'global') as 'project',
  kind: 'note' as const,
  title,
  body: `${title} body`,
  ...over,
})

async function setup() {
  const h = harness()
  const prj = await withProject(h)
  const other = (await h.projects.catalog.create({ name: 'Other', folders: [] })).id
  const minted = h.projects.mcp.mint({ projectId: prj, provider: 'codex' })!
  return { h, prj, other, minted }
}

describe('McpMemoryAccessService — tokens', () => {
  it('MCP-mint: mcp_ + hex, only when the policy allows the provider; bind → session id; revoke → null', async () => {
    const { h, prj, minted } = await setup()
    expect(minted.token).toMatch(/^mcp_[A-Za-z0-9_-]{16,200}$/)
    expect(minted.token).toMatch(/^mcp_[0-9a-f]{64}$/)
    expect(h.projects.mcp.mint({ projectId: prj, provider: 'cursor' })).toBeNull()
    expect(h.projects.mcp.mint({ projectId: 'prj_unknown00000', provider: 'codex' })).toBeNull()
    expect(h.projects.mcp.principal(minted.token)).toMatchObject({
      kind: 'mcp',
      projectId: prj,
      provider: 'codex',
      access: 'read-propose',
      sessionId: '',
    })
    h.putAgent({
      id: 'cx:1',
      provider: 'codex',
      projectId: prj,
      managed: { chrome: false, pending: 0, phase: 'running' },
    })
    h.projects.mcp.bind(minted.tokenId, 'cx:1')
    expect(h.projects.mcp.principal(minted.token)!.sessionId).toMatch(/^ses_/)
    expect(h.projects.mcp.principal('mcp_unknown')).toBeNull()
    expect(h.projects.mcp.principal('')).toBeNull()
    h.projects.mcp.revoke(minted.tokenId)
    expect(h.projects.mcp.principal(minted.token)).toBeNull()
    const again = h.projects.mcp.mint({ projectId: prj, provider: 'codex' })!
    h.projects.mcp.revokeAll()
    expect(h.projects.mcp.principal(again.token)).toBeNull()
  })

  it('MCP-no SecureRandom → no tokens at all', async () => {
    const h = harness({ random: undefined })
    const prj = await withProject(h)
    expect(h.projects.mcp.mint({ projectId: prj, provider: 'codex' })).toBeNull()
  })

  it('MCP-a revoked principal object can no longer call', async () => {
    const { h, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    h.projects.mcp.revoke(minted.tokenId)
    await expect(h.projects.mcp.call(p, 'search_memory', { query: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('MCP-tools: propose_memory only with read-propose', async () => {
    const { h, prj, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    expect(h.projects.mcp.tools(p).map((t) => t.name)).toEqual([
      'search_memory',
      'get_project_context',
      'list_decisions',
      'propose_memory',
    ])
    const pol = h.projects.catalog.get(prj).policy
    await h.projects.catalog.update({
      projectId: prj,
      policy: { ...pol, providers: { ...pol.providers, codex: 'read' } },
    })
    expect(h.projects.mcp.tools(p).map((t) => t.name)).not.toContain('propose_memory')
    for (const t of h.projects.mcp.tools(p)) expect(t.inputSchema).toMatchObject({ type: 'object' })
  })
})

describe('McpMemoryAccessService — tools (docs/projects.md §5)', () => {
  it('MCP-search_memory: approved own + listed global only; preface, provenance, retrieval activity', async () => {
    const { h, prj, other, minted } = await setup()
    const own = await h.projects.memory.create(note(prj, 'Deploy with fly'))
    await h.projects.memory.create(note(other, 'Deploy secret of other project'))
    await h.projects.memory.create(note(null, 'Deploy global rule'))
    await h.projects.memory.create(note(null, 'Deploy workspace rule', { scope: 'workspace' }))
    await h.projects.memory.propose(h.projects.mcp.principal(minted.token)!, {
      kind: 'note',
      title: 'Deploy pending',
      body: 'b',
    })
    const p = h.projects.mcp.principal(minted.token)!
    const r = await h.projects.mcp.call(p, 'search_memory', { query: 'deploy' })
    expect(r.text.startsWith(DATA_PREFACE)).toBe(true)
    const items = r.structured.items as {
      id: string
      title: string
      version: number
      provenance: { origin: string }
    }[]
    expect(items.map((i) => i.title).sort()).toEqual(['Deploy global rule', 'Deploy with fly'])
    expect(items.find((i) => i.id === own.id)).toMatchObject({
      version: 1,
      provenance: { origin: 'user' },
    })
    expect(JSON.stringify(r)).not.toContain('other project')
    expect(JSON.stringify(r)).not.toContain('pending')
    const act = h.projects.store.activityOf(prj).filter((e) => e.kind === 'mcp.retrieval')
    expect(act[0]?.data).toMatchObject({ tool: 'search_memory', query: 'deploy' })
    expect(act[0]?.data?.returned?.length).toBe(2)
  })

  it('MCP-caps: body ≤ 2000, total ≤ 12000, control characters stripped, limit ≤ 8', async () => {
    const { h, prj, minted } = await setup()
    for (let i = 0; i < 10; i++)
      await h.projects.memory.create(
        note(prj, `Big ${i}`, { body: `big\u0007\u001b[31m ${'x'.repeat(3990)}` }),
      )
    const p = h.projects.mcp.principal(minted.token)!
    const r = await h.projects.mcp.call(p, 'search_memory', { query: 'big', limit: 8 })
    const items = r.structured.items as { body: string }[]
    expect(items.length).toBeLessThanOrEqual(8)
    for (const i of items) {
      expect(i.body.length).toBeLessThanOrEqual(2000)
      expect(i.body).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    }
    expect(r.text.length).toBeLessThanOrEqual(12_000)
    expect(JSON.stringify(r.structured).length).toBeLessThanOrEqual(14_000)
    await expect(
      h.projects.mcp.call(p, 'search_memory', { query: 'big', limit: 9 }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(h.projects.mcp.call(p, 'search_memory', {})).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(h.projects.mcp.call(p, 'nope', {})).rejects.toBeInstanceOf(ValidationError)
  })

  it('MCP-get_project_context returns the included ranked bundle; list_decisions filters by status', async () => {
    const { h, prj, minted } = await setup()
    await h.projects.memory.create(note(prj, 'Always run tests', { kind: 'instruction' }))
    const d = await h.projects.memory.create(note(prj, 'Use JWT', { kind: 'decision' }))
    const p = h.projects.mcp.principal(minted.token)!
    const ctx = await h.projects.mcp.call(p, 'get_project_context', { objective: 'auth' })
    expect((ctx.structured.items as { title: string }[]).map((i) => i.title)).toEqual([
      'Always run tests',
      'Use JWT',
    ])
    expect(ctx.structured.project).toEqual({ id: prj, name: 'Shop' })
    const dec = await h.projects.mcp.call(p, 'list_decisions', {})
    expect(
      (dec.structured.items as { id: string; decision: unknown }[]).map((i) => [i.id, i.decision]),
    ).toEqual([[d.id, { status: 'accepted' }]])
    expect(
      (await h.projects.mcp.call(p, 'list_decisions', { status: 'deprecated' })).structured.items,
    ).toEqual([])
  })

  it('MCP-propose_memory: pending item, ≤ 10 per session per hour, body ≤ 2000', async () => {
    const { h, prj, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    const r = await h.projects.mcp.call(p, 'propose_memory', {
      kind: 'decision',
      title: 'Use JWT',
      body: 'b',
      rationale: 'r',
    })
    expect(r.text.startsWith(DATA_PREFACE)).toBe(true)
    const id = r.structured.id as string
    expect(h.projects.store.memory.get(id)).toMatchObject({ state: 'pending', projectId: prj })
    // A proposal is not a retrieval: the activity shows memory.proposed, never "retrieved 0 items".
    await Promise.resolve()
    expect(h.projects.store.activityOf(prj).some((e) => e.kind === 'mcp.retrieval')).toBe(false)
    await expect(
      h.projects.mcp.call(p, 'propose_memory', {
        kind: 'note',
        title: 't',
        body: 'x'.repeat(2001),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
    for (let i = 0; i < 9; i++)
      await h.projects.mcp.call(p, 'propose_memory', { kind: 'note', title: `t${i}`, body: 'b' })
    h.clock.advance(61_000) // past the per-minute window
    await expect(
      h.projects.mcp.call(p, 'propose_memory', { kind: 'note', title: 'one too many', body: 'b' }),
    ).rejects.toBeInstanceOf(RateLimitedError)
    h.clock.advance(3_600_000)
    await expect(
      h.projects.mcp.call(p, 'propose_memory', { kind: 'note', title: 'later', body: 'b' }),
    ).resolves.toBeTruthy()
  })

  it('MCP-rate limit: 20 calls per minute per token', async () => {
    const { h, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    for (let i = 0; i < 20; i++) await h.projects.mcp.call(p, 'list_decisions', {})
    await expect(h.projects.mcp.call(p, 'list_decisions', {})).rejects.toBeInstanceOf(
      RateLimitedError,
    )
    h.clock.advance(60_001)
    await expect(h.projects.mcp.call(p, 'list_decisions', {})).resolves.toBeTruthy()
  })

  it('MCP-policy none or an archived project denies every call (re-checked per call)', async () => {
    const { h, prj, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    const pol = h.projects.catalog.get(prj).policy
    await h.projects.catalog.update({
      projectId: prj,
      policy: { ...pol, providers: { codex: 'none' } },
    })
    await expect(h.projects.mcp.call(p, 'search_memory', { query: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    expect(h.projects.mcp.tools(p)).toEqual([])
    await h.projects.catalog.update({ projectId: prj, policy: pol, archived: true })
    await expect(h.projects.mcp.call(p, 'list_decisions', {})).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('MCP-a forged principal for another project is refused', async () => {
    const { h, other, minted } = await setup()
    const p = h.projects.mcp.principal(minted.token)!
    await expect(
      h.projects.mcp.call({ ...p, projectId: other }, 'search_memory', { query: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      h.projects.mcp.call(
        { ...p, access: 'read-propose', tokenId: 'tok_forged' },
        'list_decisions',
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('MCP-retrieval bumps the Context Hub through onRetrieval', async () => {
    const seen: string[] = []
    const h = harness({ onRetrieval: (provider) => seen.push(provider) })
    const prj = await withProject(h)
    const t = h.projects.mcp.mint({ projectId: prj, provider: 'codex' })!
    await h.projects.mcp.call(h.projects.mcp.principal(t.token)!, 'list_decisions', {})
    expect(seen).toEqual(['codex'])
  })
})

describe('McpMemoryAccessService — flows', () => {
  async function flowSetup() {
    const h = harness({
      enforcementOf: () => ({
        instructions: 'native',
        toolDeny: 'approval',
        pathDeny: 'none',
        commandDeny: 'none',
        fsIsolation: 'none',
        subagents: 'none',
      }),
    })
    const prj = await withProject(h)
    const d = await h.projects.harness.create({
      name: 'Pipeline',
      steps: [
        { name: 'Research', goal: 'Notes exist', exit: [{ kind: 'report' }] },
        { name: 'Outline', goal: 'Agreed', exit: [{ kind: 'approval', prompt: 'Outline ok' }] },
      ],
    })
    await h.projects.harness.publish(d.id)
    await h.projects.harness.attach(prj, d.id)
    const session = async (agentId: string, withFlow: boolean) => {
      const minted = h.projects.mcp.mint({ projectId: prj, provider: 'codex' })!
      h.putAgent({ id: agentId, provider: 'codex', projectId: prj })
      h.projects.mcp.bind(minted.tokenId, agentId)
      if (withFlow) {
        const ap = (await h.projects.policy.prepare({
          projectId: prj,
          provider: 'codex',
          cwd: '/work/shop',
          mode: 'default',
        }))!
        h.projects.policy.bind({ agentId, sessionId: agentId, projectId: prj, policy: ap })
      }
      return h.projects.mcp.principal(minted.token)!
    }
    const steps = h.projects.store.harness(d.id)!.steps!
    return { h, prj, steps, session }
  }

  it('MCP-report_step: declared only with a flow; the only harness tool; scoped to the own session', async () => {
    const { h, steps, session } = await flowSetup()
    const mine = await session('cx:1', true)
    const other = await session('cx:2', false)
    const names = (p: typeof mine) => h.projects.mcp.tools(p).map((t) => t.name)
    expect(names(mine)).toEqual([
      'search_memory',
      'get_project_context',
      'list_decisions',
      'propose_memory',
      'report_step',
    ])
    expect(names(other)).not.toContain('report_step')
    // No tool can change rules, policies, gates or approvals.
    for (const n of names(mine)) expect(n).not.toMatch(/harness|rule|gate|approve|polic|skip/)

    // A session without a flow cannot report, even with another session's step id or a forged principal.
    await expect(
      h.projects.mcp.call(other, 'report_step', { stepId: steps[0]!.id }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      h.projects.mcp.call({ ...other, sessionId: mine.sessionId }, 'report_step', {
        stepId: steps[0]!.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    const r = await h.projects.mcp.call(mine, 'report_step', { stepId: steps[0]!.id, note: 'ok' })
    expect(r.structured).toEqual({ stepId: steps[0]!.id, state: 'done', current: steps[1]!.id })
    // Approvals cannot be passed by the agent.
    await expect(
      h.projects.mcp.call(mine, 'report_step', { stepId: steps[1]!.id }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      h.projects.mcp.call(mine, 'report_step', { stepId: 'not-a-step' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      h.projects.mcp.call(mine, 'report_step', { stepId: steps[1]!.id, note: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('MCP-get_project_context carries the flow block only for a session with a flow', async () => {
    const { h, steps, session } = await flowSetup()
    const mine = await session('cx:1', true)
    const other = await session('cx:2', false)
    const r = await h.projects.mcp.call(mine, 'get_project_context', {})
    expect(r.structured.flow).toEqual({
      current: steps[0]!.id,
      steps: [
        { id: steps[0]!.id, name: 'Research', goal: 'Notes exist', exit: ['you report it done'] },
        {
          id: steps[1]!.id,
          name: 'Outline',
          goal: 'Agreed',
          exit: ['user approval "Outline ok"'],
        },
      ],
    })
    expect(r.text).toContain(`Current flow step: Research (${steps[0]!.id})`)
    const o = await h.projects.mcp.call(other, 'get_project_context', {})
    expect(o.structured.flow).toBeUndefined()
  })
})
