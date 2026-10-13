// Compiles a harness (`ActionPolicy`, docs/harness.md §3) into Claude Agent SDK options: the
// instruction block as a system-prompt append, denied tools, a PreToolUse hook that raises every
// tool call (main thread and subagents) to the policy, the SDK sandbox when the harness asks for
// it, and the subagent lifecycle hooks that feed `RunnerSession.onChild`. Never returns
// `permissionDecision: 'allow'` and never uses `allowedTools` (both would skip the user's approval).
import { resolve } from 'node:path'
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk'
import type { ActionPolicy, Logger, PolicyDecision } from '@agent-office/core'
import type { AgentEvent } from '@agent-office/shared'

export const MAX_INSTRUCTIONS = 16 * 1024
const BYPASS_REASON =
  'The project harness requires approval for this action (harness requires approval); bypass mode cannot ask.'
const ERROR_REASON = 'The project harness could not evaluate this action, so it was blocked.'
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/
const MAX_NAME = 100

export interface ChildEvent {
  childId: string
  kind?: string
  event: Omit<AgentEvent, 'agentId' | 'parentId'>
}

export interface ClaudePolicyContext {
  cwd: string
  /** The session's current permission mode (a hook input's `permission_mode` wins). */
  mode(): string
  /** Subagent activity, metadata only (no tool input, no text). */
  child(c: ChildEvent): void
  log?: Logger
}

export type ClaudeHarnessOptions = Pick<
  Options,
  'hooks' | 'disallowedTools' | 'systemPrompt' | 'sandbox'
>

type In = HookInput & {
  agent_id?: string
  agent_type?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: unknown
}

const short = (s: unknown): string | undefined =>
  typeof s === 'string' && s ? s.slice(0, MAX_NAME) : undefined

function childOf(i: In): { childId: string; kind?: string } | undefined {
  if (typeof i.agent_id !== 'string' || !AGENT_ID.test(i.agent_id)) return undefined
  const kind = short(i.agent_type)
  return { childId: `cc:${i.agent_id}`, ...(kind ? { kind } : {}) }
}

function preToolOutput(d: 'deny' | 'ask', reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d,
      permissionDecisionReason: reason.slice(0, 1000),
    },
  }
}

export function claudeHarnessOptions(
  policy: ActionPolicy | undefined,
  ctx: ClaudePolicyContext,
): ClaudeHarnessOptions {
  const instructions = policy?.instructions ? policy.instructions.slice(0, MAX_INSTRUCTIONS) : ''

  const preToolUse: HookCallback = async (raw) => {
    const i = raw as In
    const c = childOf(i)
    const tool = short(i.tool_name)
    if (c && tool) ctx.child({ ...c, event: { status: 'tool', tool } })
    if (!policy) return {}
    let d: PolicyDecision
    try {
      const input =
        i.tool_input && typeof i.tool_input === 'object' && !Array.isArray(i.tool_input)
          ? (i.tool_input as Record<string, unknown>)
          : {}
      d = policy.evaluate({
        tool: typeof i.tool_name === 'string' ? i.tool_name : '',
        input,
        cwd: ctx.cwd,
        provider: 'claude-code',
        agentRole: short(i.agent_type) ?? 'main',
      })
    } catch (err) {
      ctx.log?.warn(
        `claude-sdk: harness evaluate failed (${err instanceof Error ? err.name : 'error'})`,
      )
      return preToolOutput('deny', ERROR_REASON)
    }
    if (d.action === 'deny')
      return preToolOutput('deny', d.reason || 'Blocked by the project harness.')
    if (d.action === 'ask') {
      const mode = i.permission_mode ?? ctx.mode()
      if (mode === 'bypassPermissions') return preToolOutput('deny', BYPASS_REASON)
      return preToolOutput('ask', d.reason || 'The project harness asks for approval.')
    }
    return {}
  }

  const postToolUse: HookCallback = async (raw) => {
    const c = childOf(raw as In)
    if (c) ctx.child({ ...c, event: { status: 'thinking' } })
    return {}
  }

  const subagentStart: HookCallback = async (raw) => {
    const c = childOf(raw as In)
    if (c) {
      const name = c.kind ?? 'subagent'
      ctx.child({ ...c, event: { status: 'thinking', name, kind: name } })
    }
    return instructions
      ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: instructions } }
      : {}
  }

  const subagentStop: HookCallback = async (raw) => {
    const c = childOf(raw as In)
    if (c) ctx.child({ ...c, event: { status: 'done', ended: 'completed' } })
    return {}
  }

  const one = (fn: HookCallback): HookCallbackMatcher[] => [{ hooks: [fn] }]
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    PreToolUse: one(preToolUse),
    PostToolUse: one(postToolUse),
    SubagentStart: one(subagentStart),
    SubagentStop: one(subagentStop),
  }
  if (!policy) return { hooks }

  const n = policy.native
  return {
    hooks,
    ...(instructions
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } }
      : {}),
    ...(n.deniedTools.length ? { disallowedTools: [...n.deniedTools] } : {}),
    ...(n.fsIsolation !== 'off'
      ? {
          sandbox: {
            enabled: true,
            allowUnsandboxedCommands: false,
            failIfUnavailable: n.fsIsolation === 'require',
            filesystem: { denyWrite: n.denyPaths.map((p) => resolve(ctx.cwd, p)) },
          },
        }
      : {}),
  }
}
