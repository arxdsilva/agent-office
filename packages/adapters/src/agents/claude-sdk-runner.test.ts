import type {
  HookInput,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ActionPolicy, PolicyDecision } from '@agent-office/core'
import { agentRunnerContract, MemoryLogger } from '@agent-office/core/testing'
import type { AgentEvent } from '@agent-office/shared'
import { describe, expect, it } from 'vitest'
import { createOffice } from '@agent-office/core'
import {
  FakeClaudeSettingsStore,
  FakeHookRunner,
  FakeSettingsRepository,
  FakeWindow,
  fakePlatform,
  RecordingLoginItem,
  RecordingNotifier,
  RecordingTray,
  ScriptedUpdater,
} from '@agent-office/core/testing'
import {
  InMemoryAgentRepository,
  InMemoryCapabilityRepository,
  InMemoryEventBus,
  InMemoryMessageRepository,
} from '../memory/index.ts'
import { RandomIds, SystemClock, TimerScheduler } from '../system/index.ts'
import { AsyncQueue, ClaudeSdkRunner, type QueryFn } from './claude-sdk-runner.ts'

/** A `query` double: the test plays the SDK by pushing messages; prompts and controls are recorded. */
function sdkDouble(
  opts: {
    failWith?: Error
    models?: unknown
    /** Like Claude CLI 2.1.270: system/init (the session id) only after the first prompt. */
    initOnFirstPrompt?: string
  } = {},
) {
  const out = new AsyncQueue<SDKMessage>()
  const prompts: string[] = []
  const controls: string[] = []
  const calls: { options?: Options }[] = []
  let promptClosed = false
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ ...(options ? { options } : {}) })
    if (opts.failWith) throw opts.failWith
    void (async () => {
      for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
        prompts.push(String(m.message.content))
        if (opts.initOnFirstPrompt && prompts.length === 1)
          out.push({
            type: 'system',
            subtype: 'init',
            session_id: opts.initOnFirstPrompt,
          } as unknown as SDKMessage)
      }
      promptClosed = true
    })()
    const gen = (async function* () {
      for await (const m of out) {
        if (m instanceof Error) throw m
        yield m
      }
    })()
    return Object.assign(gen, {
      setPermissionMode: async (m: string) => void controls.push(`mode:${m}`),
      setModel: async (m?: string) => void controls.push(`model:${m}`),
      interrupt: async () => void controls.push('interrupt'),
      supportedModels: async () =>
        opts.models ?? [
          { value: 'default', displayName: 'Default (recommended)', description: 'd' },
          { value: 'opus[1m]', displayName: 'Opus (1M context)', description: '' },
        ],
      close: () => {
        controls.push('close')
        out.close()
      },
    }) as unknown as Query
  }
  const options = () => calls.at(-1)?.options as Options
  const emit = (m: unknown) => out.push(m as SDKMessage)
  return {
    queryFn,
    prompts,
    controls,
    options,
    promptClosed: () => promptClosed,
    emit,
    fail: (e: Error) => out.push(e as unknown as SDKMessage),
    init: (id: string) =>
      emit({
        type: 'system',
        subtype: 'init',
        session_id: id,
        cwd: '/work/shop-api',
        model: 'claude-x',
      }),
    toolUse: (name: string, input: Record<string, unknown>) =>
      emit({
        type: 'assistant',
        session_id: 's',
        parent_tool_use_id: null,
        message: { model: 'claude-x', content: [{ type: 'tool_use', name, input }] },
      }),
    result: (text: string, extra: Record<string, unknown> = {}) =>
      emit({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra }),
    ask: async (tool: string, input: Record<string, unknown>) =>
      (await options().canUseTool!(tool, input, {
        signal: new AbortController().signal,
        toolUseID: 't',
      } as never))!,
  }
}

const tick = async (n = 50) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
const START = {
  cwd: '/work/shop-api',
  mode: 'default' as const,
  extraDirs: [],
  chrome: false,
  allowBypass: false,
}

function make(over: Partial<ConstructorParameters<typeof ClaudeSdkRunner>[0]> = {}) {
  const sdk = sdkDouble()
  const log = new MemoryLogger()
  const runner = new ClaudeSdkRunner({
    queryFn: sdk.queryFn,
    env: { HOME: '/Users/me', PATH: '/usr/bin' },
    log,
    ...over,
  })
  return { sdk, runner, log }
}

agentRunnerContract('ClaudeSdkRunner', () => {
  const { sdk, runner } = make()
  return {
    runner,
    init: sdk.init,
    toolUse: sdk.toolUse,
    result: sdk.result,
    ask: sdk.ask,
    prompts: () => sdk.prompts,
    controls: () => sdk.controls,
  }
})

describe('ClaudeSdkRunner', () => {
  it('SDK-1 maps start options to SDK options', async () => {
    const { sdk, runner } = make({ executable: '/Users/me/.local/bin/claude' })
    runner.start({ ...START, model: 'sonnet', mode: 'plan', extraDirs: ['/w/lib'], chrome: true })
    await tick()
    expect(sdk.options()).toMatchObject({
      cwd: '/work/shop-api',
      model: 'sonnet',
      permissionMode: 'plan',
      additionalDirectories: ['/w/lib'],
      settingSources: ['user', 'project', 'local'],
      allowDangerouslySkipPermissions: false,
      env: { HOME: '/Users/me', PATH: '/usr/bin', AGENT_OFFICE_MANAGED: '1' },
      extraArgs: { chrome: null },
      pathToClaudeCodeExecutable: '/Users/me/.local/bin/claude',
    })
  })

  it('leaves chrome, model and the executable unset when not given', async () => {
    const { sdk, runner } = make()
    runner.start(START)
    await tick()
    const o = sdk.options()
    expect(o.extraArgs).toBeUndefined()
    expect(o.model).toBeUndefined()
    expect(o.pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('MCP-1 passes RunnerStart.mcp as a stdio mcpServers entry', async () => {
    const { sdk, runner } = make()
    const mcp = {
      name: 'agent-office',
      command: '/u/mcp/agent-office-mcp.sh',
      args: [],
      env: { AGENT_OFFICE_MCP_URL: 'http://127.0.0.1:4317/mcp', AGENT_OFFICE_MCP_TOKEN: 'mcp_x' },
    }
    runner.start({ ...START, mcp })
    await tick()
    expect(sdk.options().mcpServers).toEqual({
      'agent-office': { type: 'stdio', command: mcp.command, args: [], env: mcp.env },
    })
  })

  it('MCP-2 without RunnerStart.mcp the options have no mcpServers key', async () => {
    const { sdk, runner } = make()
    runner.start(START)
    await tick()
    expect('mcpServers' in sdk.options()).toBe(false)
  })

  it('RES-1 passes RunnerStart.resume as the SDK resume option, and only then', async () => {
    const { sdk, runner } = make()
    runner.start({ ...START, resume: '0b7c-session' })
    await tick()
    expect(sdk.options().resume).toBe('0b7c-session')
    const plain = make()
    plain.runner.start(START)
    await tick()
    expect('resume' in plain.sdk.options()).toBe(false)
  })

  it('SDK-2 skips permissions only for bypass mode with allowBypass', async () => {
    const run = async (mode: 'bypassPermissions' | 'default', allowBypass: boolean) => {
      const { sdk, runner } = make()
      runner.start({ ...START, mode, allowBypass })
      await tick()
      return sdk.options().allowDangerouslySkipPermissions
    }
    expect(await run('bypassPermissions', true)).toBe(true)
    expect(await run('bypassPermissions', false)).toBe(false)
    expect(await run('default', true)).toBe(false)
  })

  it('SDK-3 streams pushes in order and keeps the input open until close', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    sdk.init('sess-1')
    await s.sessionId
    s.push('a')
    s.push('b')
    await tick()
    expect(sdk.prompts).toEqual(['a', 'b'])
    expect(sdk.promptClosed()).toBe(false)
    await s.close()
    await tick()
    expect(sdk.promptClosed()).toBe(true)
    await s.close() // idempotent
    expect(sdk.controls.filter((c) => c === 'close')).toHaveLength(1)
  })

  it('SDK-4 delegates controls and maps supported models', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    sdk.init('sess-1')
    await s.setMode('acceptEdits')
    await s.setModel('opus')
    await s.interrupt()
    expect(sdk.controls).toEqual(['mode:acceptEdits', 'model:opus', 'interrupt'])
    expect(await s.supportedModels()).toEqual([
      { id: 'default', label: 'Default (recommended)', description: 'd' },
      { id: 'opus[1m]', label: 'Opus (1M context)' },
    ])
  })

  it('SDK-5 maps tool calls like transcript lines: short, path-free', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    const events: Omit<AgentEvent, 'agentId'>[] = []
    s.onEvent((e) => events.push(e))
    sdk.init('sess-1')
    await s.sessionId
    sdk.toolUse('Bash', {
      command: 'git push https://user:tok@example.com/secret/repo /Users/me/private',
      description: 'Push the branch '.repeat(20),
    })
    // Subagent frames and unmapped types are ignored.
    sdk.emit({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [] } })
    sdk.emit({ type: 'rate_limit_event' })
    sdk.emit({ type: 'system', subtype: 'status', status: null })
    await tick()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      status: 'tool',
      tool: 'Bash',
      target: 'cmd:git',
      model: 'claude-x',
    })
    expect(events[0]).not.toHaveProperty('agentId')
    expect(events[0]!.text!.length).toBeLessThanOrEqual(80)
    const json = JSON.stringify(events)
    expect(json).not.toContain('/Users/me')
    expect(json).not.toContain('tok@')
    expect(typeof events[0]!.ts).toBe('number')
  })

  it('SDK-6 turns a result into onResult, capped at 4000 chars', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    const results: { text: string; isError: boolean }[] = []
    s.onResult((r) => results.push(r))
    sdk.init('sess-1')
    sdk.result('x'.repeat(5000))
    sdk.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['boom'],
    })
    await tick()
    expect(results[0]!.text).toHaveLength(4000)
    expect(results[1]).toEqual({ text: '', isError: true })
  })

  it('SDK-7 canUseTool reaches onPermission; no handler denies', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    sdk.init('sess-1')
    await tick()
    await expect(sdk.ask('Bash', { command: 'ls' })).resolves.toMatchObject({ behavior: 'deny' })
    const seen: unknown[] = []
    s.onPermission(async (r) => {
      seen.push(r)
      return { behavior: 'allow' }
    })
    await expect(sdk.ask('Bash', { command: 'ls' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    })
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'ls' }, cwd: '/work/shop-api' }])
  })

  describe('SDK-8 error mapping', () => {
    const exitOf = async (err: Error, init = false) => {
      const { sdk, runner, log } = make()
      const s = runner.start(START)
      const exits: unknown[] = []
      s.onExit((e) => exits.push(e))
      if (init) sdk.init('sess-1')
      sdk.fail(err)
      const id = await s.sessionId.catch((e: unknown) => e)
      await tick()
      return { exits, id, log }
    }

    it('auth', async () => {
      const { exits, id } = await exitOf(new Error('Invalid API key · Please run /login'))
      expect(id).toEqual({ error: 'auth' })
      expect(exits).toEqual([{ error: 'auth' }])
    })

    it('runtime (missing executable) is logged without the message text', async () => {
      const err = Object.assign(new Error('spawn /secret/path/claude ENOENT'), { code: 'ENOENT' })
      const { exits, log } = await exitOf(err)
      expect(exits).toEqual([{ error: 'runtime' }])
      expect(log.lines.join('\n')).not.toContain('/secret')
      expect(log.lines.join('\n')).toContain('ENOENT')
    })

    it('crash after start', async () => {
      const { exits, id } = await exitOf(new Error('something broke'), true)
      expect(id).toBe('sess-1')
      expect(exits).toEqual([{ error: 'crash' }])
    })

    it('a query function that throws synchronously', async () => {
      const sdk = sdkDouble({ failWith: new Error('Claude Code executable not found') })
      const runner = new ClaudeSdkRunner({ queryFn: sdk.queryFn, env: {}, log: new MemoryLogger() })
      const s = runner.start(START)
      await expect(s.sessionId).rejects.toEqual({ error: 'runtime' })
      await expect(s.setMode('plan')).rejects.toBeTruthy()
    })

    it('an auth status error, then a stream end before init', async () => {
      const { sdk, runner } = make()
      const s = runner.start(START)
      sdk.emit({ type: 'auth_status', isAuthenticating: false, output: [], error: 'not logged in' })
      await tick()
      await s.close()
      await expect(s.sessionId).rejects.toEqual({ error: 'auth' })
    })

    it('a clean close after start exits without an error', async () => {
      const { sdk, runner } = make()
      const s = runner.start(START)
      const exits: unknown[] = []
      s.onExit((e) => exits.push(e))
      sdk.init('sess-1')
      await s.sessionId
      await s.close()
      await tick()
      expect(exits).toEqual([{}])
    })
  })
})

describe('ClaudeSdkRunner with the real core', () => {
  it('SDK-9 starts a managed session when the CLI reports its id only after the first prompt', async () => {
    const sdk = sdkDouble({ initOnFirstPrompt: 'sess-late' })
    const runner = new ClaudeSdkRunner({ queryFn: sdk.queryFn, env: {}, log: new MemoryLogger() })
    const scheduler = new TimerScheduler()
    const office = createOffice({
      agents: new InMemoryAgentRepository(),
      capabilities: new InMemoryCapabilityRepository(),
      messages: new InMemoryMessageRepository(),
      bus: new InMemoryEventBus(),
      clock: new SystemClock(),
      ids: new RandomIds(),
      scheduler,
      settingsRepo: new FakeSettingsRepository(),
      loginItem: new RecordingLoginItem(),
      claudeSettings: new FakeClaudeSettingsStore(),
      hookRunner: new FakeHookRunner(),
      notifier: new RecordingNotifier(),
      tray: new RecordingTray(),
      window: new FakeWindow(),
      updater: new ScriptedUpdater(),
      platform: fakePlatform({ packaged: false }),
      releaseUrl: 'https://example.invalid',
      runner,
    })
    try {
      const id = await office.sessions!.start({
        ...START,
        name: 'late-id',
        first: { text: 'Hello there', context: [], use: [] },
      })
      expect(id).toBe('cc:sess-late')
      // Pushed exactly once, before the id was known.
      expect(sdk.prompts).toEqual(['Hello there'])
      await office.sessions!.stop(id)
    } finally {
      scheduler.dispose()
    }
  })
})

describe('ClaudeSdkRunner harness', () => {
  const SENTINEL = 'zz-tool-input-sentinel-zz'
  const harness = (
    action: PolicyDecision['action'] | 'throw',
    more: Partial<ActionPolicy['native']> = {},
  ): ActionPolicy => ({
    evaluate: () => {
      if (action === 'throw') throw new Error('x')
      return { action, ruleIds: ['rul_1'], reason: 'Rule says no', basis: 'exact' }
    },
    instructions: 'Run make check before finishing.',
    native: {
      deniedTools: ['WebFetch'],
      denyPaths: ['packages/shared'],
      askPaths: [],
      denyCommands: [],
      askCommands: [],
      fsIsolation: 'off',
      ...more,
    },
    interceptAll: true,
    unsupported: [],
  })
  const hook =
    (
      sdk: ReturnType<typeof sdkDouble>,
      ev: 'PreToolUse' | 'PostToolUse' | 'SubagentStart' | 'SubagentStop',
    ) =>
    (input: Record<string, unknown>) =>
      sdk.options().hooks![ev]![0]!.hooks[0]!(
        {
          session_id: 's',
          transcript_path: '/t',
          cwd: '/work/shop-api',
          hook_event_name: ev,
          ...input,
        } as unknown as HookInput,
        'tu',
        { signal: new AbortController().signal },
      )

  it('declares its enforcement without a decl', () => {
    const { runner } = make()
    expect('decl' in runner).toBe(false)
    expect(runner.enforcement).toEqual({
      instructions: 'native',
      toolDeny: 'hook',
      pathDeny: 'hook',
      commandDeny: 'partial',
      fsIsolation: 'sandbox',
      subagents: 'inherited',
      nonInterceptingModes: ['bypassPermissions'],
      interceptingMode: 'default',
    })
  })

  it('HRN-1 passes the compiled harness as SDK options; keeps MCP and the managed marker', async () => {
    const { sdk, runner } = make()
    const mcp = { name: 'agent-office', command: '/u/mcp.sh', args: [], env: {} }
    runner.start({ ...START, mcp, harness: harness('allow', { fsIsolation: 'require' }) })
    await tick()
    const o = sdk.options()
    expect(o.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Run make check before finishing.',
    })
    expect(o.disallowedTools).toEqual(['WebFetch'])
    expect(o.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyWrite: ['/work/shop-api/packages/shared'] },
    })
    expect(o.hooks!.PreToolUse![0]!.matcher).toBeUndefined()
    expect(o).not.toHaveProperty('allowedTools')
    expect(o.env).toMatchObject({ AGENT_OFFICE_MANAGED: '1' })
    expect(o.mcpServers).toHaveProperty('agent-office')
  })

  it('HRN-2 without a harness: no systemPrompt, sandbox or disallowedTools', async () => {
    const { sdk, runner } = make()
    runner.start(START)
    await tick()
    const o = sdk.options()
    expect(o).not.toHaveProperty('systemPrompt')
    expect(o).not.toHaveProperty('sandbox')
    expect(o).not.toHaveProperty('disallowedTools')
    expect(o.hooks).toHaveProperty('SubagentStart')
  })

  it.each([
    ['deny', 'default', 'deny'],
    ['ask', 'default', 'ask'],
    ['ask', 'bypassPermissions', 'deny'],
    ['throw', 'default', 'deny'],
  ] as const)('HRN-3 policy %s in mode %s → %s', async (action, mode, want) => {
    const { sdk, runner } = make()
    runner.start({
      ...START,
      mode,
      allowBypass: mode === 'bypassPermissions',
      harness: harness(action),
    })
    await tick()
    const out = await hook(
      sdk,
      'PreToolUse',
    )({ tool_name: 'Edit', tool_input: { file_path: 'a' }, tool_use_id: 'x' })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: want } })
  })

  it('HRN-4 the bypass check follows setMode', async () => {
    const { sdk, runner } = make()
    const s = runner.start({ ...START, harness: harness('ask') })
    sdk.init('sess-1')
    await s.sessionId
    await s.setMode('bypassPermissions')
    const out = await hook(
      sdk,
      'PreToolUse',
    )({ tool_name: 'Edit', tool_input: {}, tool_use_id: 'x' })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('HRN-5 allow → {} (never allow)', async () => {
    const { sdk, runner } = make()
    runner.start({ ...START, harness: harness('allow') })
    await tick()
    expect(
      await hook(sdk, 'PreToolUse')({ tool_name: 'Read', tool_input: {}, tool_use_id: 'x' }),
    ).toEqual({})
  })

  it('SUB-1 subagents surface through onChild; permissions carry the agent; no input leaks', async () => {
    const { sdk, runner } = make()
    const s = runner.start({ ...START, harness: harness('allow') })
    const kids: unknown[] = []
    const events: unknown[] = []
    s.onChild!((c) => kids.push(c))
    s.onEvent((e) => events.push(e))
    const perms: unknown[] = []
    s.onPermission(async (r) => {
      perms.push(r)
      return { behavior: 'allow' }
    })
    sdk.init('sess-1')
    await s.sessionId
    await hook(sdk, 'SubagentStart')({ agent_id: 'ag7', agent_type: 'Explore' })
    await hook(
      sdk,
      'PreToolUse',
    )({
      agent_id: 'ag7',
      agent_type: 'Explore',
      tool_name: 'Grep',
      tool_input: { pattern: SENTINEL },
      tool_use_id: 'x',
    })
    await sdk.options().canUseTool!('Grep', { pattern: SENTINEL }, {
      signal: new AbortController().signal,
      toolUseID: 'x',
      agentID: 'ag7',
    } as never)
    await hook(
      sdk,
      'PostToolUse',
    )({
      agent_id: 'ag7',
      agent_type: 'Explore',
      tool_name: 'Grep',
      tool_input: { pattern: SENTINEL },
      tool_response: SENTINEL,
      tool_use_id: 'x',
    })
    await hook(
      sdk,
      'SubagentStop',
    )({
      agent_id: 'ag7',
      agent_type: 'Explore',
      agent_transcript_path: '/t',
      stop_hook_active: false,
      last_assistant_message: SENTINEL,
    })
    expect(kids).toEqual([
      {
        childId: 'cc:ag7',
        kind: 'Explore',
        event: { status: 'thinking', name: 'Explore', kind: 'Explore' },
      },
      { childId: 'cc:ag7', kind: 'Explore', event: { status: 'tool', tool: 'Grep' } },
      { childId: 'cc:ag7', kind: 'Explore', event: { status: 'thinking' } },
      { childId: 'cc:ag7', kind: 'Explore', event: { status: 'done', ended: 'completed' } },
    ])
    expect(perms[0]).toMatchObject({ tool: 'Grep', agent: { id: 'ag7', type: 'Explore' } })
    expect(JSON.stringify([kids, events])).not.toContain(SENTINEL)
  })

  it('SUB-2 main-thread permissions have no agent', async () => {
    const { sdk, runner } = make()
    const s = runner.start(START)
    const perms: Record<string, unknown>[] = []
    s.onPermission(async (r) => {
      perms.push(r as never)
      return { behavior: 'allow' }
    })
    await tick()
    await sdk.ask('Bash', { command: 'ls' })
    expect(perms[0]).not.toHaveProperty('agent')
  })
})

describe('AsyncQueue', () => {
  it('delivers pushed items to a waiting reader and ends on close', async () => {
    const q = new AsyncQueue<number>()
    const got: number[] = []
    const reader = (async () => {
      for await (const n of q) got.push(n)
    })()
    q.push(1)
    await tick()
    q.push(2)
    q.close()
    q.push(3) // ignored after close
    await reader
    expect(got).toEqual([1, 2])
  })
})
