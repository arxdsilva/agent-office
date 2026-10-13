import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { ActionPolicy, PolicyAction, PolicyDecision } from '@agent-office/core'
import { describe, expect, it } from 'vitest'
import { claudeHarnessOptions, type ChildEvent } from './claude-policy.ts'

const SENTINEL = 'zz-secret-input-zz'

function policy(
  decide: (a: PolicyAction) => PolicyDecision = () => ({
    action: 'allow',
    ruleIds: [],
    reason: '',
    basis: 'exact',
  }),
  more: Partial<ActionPolicy> = {},
): ActionPolicy & { calls: PolicyAction[] } {
  const calls: PolicyAction[] = []
  return {
    calls,
    evaluate: (a) => {
      calls.push(a)
      return decide(a)
    },
    instructions: 'Never edit generated files.',
    native: {
      deniedTools: [],
      denyPaths: [],
      askPaths: [],
      denyCommands: [],
      askCommands: [],
      fsIsolation: 'off',
    },
    interceptAll: true,
    unsupported: [],
    ...more,
  }
}

const decision = (action: PolicyDecision['action'], reason = 'r'): PolicyDecision => ({
  action,
  ruleIds: ['rul_1'],
  reason,
  basis: 'exact',
})

function ctx(mode = 'default') {
  const children: ChildEvent[] = []
  return {
    cwd: '/work/app',
    mode: () => mode,
    child: (c: ChildEvent) => children.push(c),
    children,
  }
}

const base = { session_id: 's', transcript_path: '/t', cwd: '/work/app' }
const call = (h: HookCallback | undefined, input: Record<string, unknown>) =>
  h!(input as unknown as HookInput, 'tu_1', { signal: new AbortController().signal })

const pre = (input: Record<string, unknown> = {}) => ({
  ...base,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'src/a.ts', content: SENTINEL },
  tool_use_id: 'tu_1',
  ...input,
})

describe('claudeHarnessOptions', () => {
  it('without a harness: only the subagent hooks, nothing else', () => {
    const o = claudeHarnessOptions(undefined, ctx())
    expect(Object.keys(o).sort()).toEqual(['hooks'])
    expect(Object.keys(o.hooks!).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SubagentStart',
      'SubagentStop',
    ])
  })

  it('compiles instructions, denied tools and hooks; PreToolUse has no matcher', () => {
    const o = claudeHarnessOptions(
      policy(undefined, { native: { ...policy().native, deniedTools: ['WebFetch', 'Task'] } }),
      ctx(),
    )
    expect(o.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Never edit generated files.',
    })
    expect(o.disallowedTools).toEqual(['WebFetch', 'Task'])
    expect(o.hooks!.PreToolUse![0]!.matcher).toBeUndefined()
    expect(o).not.toHaveProperty('sandbox')
    expect(o).not.toHaveProperty('allowedTools')
  })

  it('caps the instructions at 16 KB and omits empty parts', () => {
    const o = claudeHarnessOptions(policy(undefined, { instructions: 'x'.repeat(20_000) }), ctx())
    expect((o.systemPrompt as { append: string }).append).toHaveLength(16 * 1024)
    const none = claudeHarnessOptions(policy(undefined, { instructions: '' }), ctx())
    expect(none).not.toHaveProperty('systemPrompt')
    expect(none).not.toHaveProperty('disallowedTools')
  })

  it.each([
    ['prefer', false],
    ['require', true],
  ] as const)('fsIsolation %s → SDK sandbox (failIfUnavailable %s)', (fs, fail) => {
    const o = claudeHarnessOptions(
      policy(undefined, {
        native: { ...policy().native, fsIsolation: fs, denyPaths: ['packages/shared/**', '/etc'] },
      }),
      ctx(),
    )
    expect(o.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: fail,
      filesystem: { denyWrite: ['/work/app/packages/shared/**', '/etc'] },
    })
    expect(o.sandbox).not.toHaveProperty('autoAllowBashIfSandboxed')
  })

  it('PreToolUse deny → deny with the reason; the action is evaluated with role main', async () => {
    const p = policy(() => decision('deny', 'Generated files are read-only'))
    const o = claudeHarnessOptions(p, ctx())
    const out = await call(o.hooks!.PreToolUse![0]!.hooks[0], pre())
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Generated files are read-only',
      },
    })
    expect(p.calls[0]).toEqual({
      tool: 'Edit',
      input: { file_path: 'src/a.ts', content: SENTINEL },
      cwd: '/work/app',
      provider: 'claude-code',
      agentRole: 'main',
    })
  })

  it('PreToolUse ask → ask; under bypassPermissions → deny', async () => {
    const p = policy(() => decision('ask', 'Needs review'))
    const ask = await call(claudeHarnessOptions(p, ctx()).hooks!.PreToolUse![0]!.hooks[0], pre())
    expect(ask).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'Needs review' },
    })
    const bypass = await call(
      claudeHarnessOptions(p, ctx('bypassPermissions')).hooks!.PreToolUse![0]!.hooks[0],
      pre(),
    )
    expect(bypass).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('harness requires approval'),
      },
    })
    const viaInput = await call(
      claudeHarnessOptions(p, ctx()).hooks!.PreToolUse![0]!.hooks[0],
      pre({ permission_mode: 'bypassPermissions' }),
    )
    expect(viaInput).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('PreToolUse allow → no opinion ({}), never "allow"', async () => {
    const out = await call(
      claudeHarnessOptions(policy(), ctx()).hooks!.PreToolUse![0]!.hooks[0],
      pre(),
    )
    expect(out).toEqual({})
  })

  it('an exception in evaluate denies', async () => {
    const p = policy(() => {
      throw new Error('boom')
    })
    const out = await call(claudeHarnessOptions(p, ctx()).hooks!.PreToolUse![0]!.hooks[0], pre())
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('a non-object tool_input is evaluated as {}', async () => {
    const p = policy()
    await call(
      claudeHarnessOptions(p, ctx()).hooks!.PreToolUse![0]!.hooks[0],
      pre({ tool_input: 'x' }),
    )
    expect(p.calls[0]!.input).toEqual({})
  })

  it('subagents: start/tool/thinking/stop child events, role from agent_type, context on start', async () => {
    const p = policy()
    const c = ctx()
    const o = claudeHarnessOptions(p, c)
    const start = await call(o.hooks!.SubagentStart![0]!.hooks[0], {
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'code-reviewer',
    })
    expect(start).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: 'Never edit generated files.',
      },
    })
    await call(
      o.hooks!.PreToolUse![0]!.hooks[0],
      pre({
        agent_id: 'a1',
        agent_type: 'code-reviewer',
        tool_name: 'Bash',
        tool_input: { command: SENTINEL },
      }),
    )
    expect(p.calls[0]!.agentRole).toBe('code-reviewer')
    await call(o.hooks!.PostToolUse![0]!.hooks[0], {
      ...base,
      hook_event_name: 'PostToolUse',
      agent_id: 'a1',
      agent_type: 'code-reviewer',
      tool_name: 'Bash',
      tool_input: { command: SENTINEL },
      tool_response: SENTINEL,
      tool_use_id: 'tu',
    })
    await call(o.hooks!.SubagentStop![0]!.hooks[0], {
      ...base,
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'a1',
      agent_type: 'code-reviewer',
      agent_transcript_path: '/t/a1',
      last_assistant_message: SENTINEL,
    })
    expect(c.children).toEqual([
      {
        childId: 'cc:a1',
        kind: 'code-reviewer',
        event: { status: 'thinking', name: 'code-reviewer', kind: 'code-reviewer' },
      },
      { childId: 'cc:a1', kind: 'code-reviewer', event: { status: 'tool', tool: 'Bash' } },
      { childId: 'cc:a1', kind: 'code-reviewer', event: { status: 'thinking' } },
      { childId: 'cc:a1', kind: 'code-reviewer', event: { status: 'done', ended: 'completed' } },
    ])
    expect(JSON.stringify(c.children)).not.toContain(SENTINEL)
  })

  it('main-thread tool hooks emit no child events', async () => {
    const c = ctx()
    const o = claudeHarnessOptions(undefined, c)
    expect(await call(o.hooks!.PreToolUse![0]!.hooks[0], pre())).toEqual({})
    await call(o.hooks!.PostToolUse![0]!.hooks[0], { ...pre(), hook_event_name: 'PostToolUse' })
    expect(c.children).toEqual([])
  })

  it('without a harness SubagentStart adds no context', async () => {
    const o = claudeHarnessOptions(undefined, ctx())
    const out = await call(o.hooks!.SubagentStart![0]!.hooks[0], {
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'Explore',
    })
    expect(out).toEqual({})
  })

  it('drops unsafe agent ids and over-long tool names', async () => {
    const c = ctx()
    const o = claudeHarnessOptions(undefined, c)
    await call(o.hooks!.SubagentStart![0]!.hooks[0], {
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: '../../x y',
      agent_type: 'Explore',
    })
    await call(
      o.hooks!.PreToolUse![0]!.hooks[0],
      pre({ agent_id: 'a2', tool_name: 'T'.repeat(300) }),
    )
    expect(c.children).toHaveLength(1)
    expect(c.children[0]!.childId).toBe('cc:a2')
    expect(c.children[0]!.event.tool!.length).toBeLessThanOrEqual(100)
  })
})
