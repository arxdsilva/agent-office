// Pure mapping between Codex app-server messages and agent-office events/decisions
// (docs/provider-integrations.md §5.1, §5.3, §5.4). Events carry status and tool names only:
// never command text, paths, diffs, queries or reasoning text.
import type { RunnerDecision, RunnerPermission } from '@agent-office/core'
import type { AgentEvent, ModeOption } from '@agent-office/shared'
import type { AskForApproval, CodexDecision, SandboxMode, SandboxPolicy } from './codex-protocol.ts'

export type EventPatch = Omit<AgentEvent, 'agentId'>

export const CODEX_MODES: ModeOption[] = [
  { id: 'read-only', label: 'Read only' },
  { id: 'ask', label: 'Ask before changes' },
  { id: 'auto', label: 'Auto in workspace' },
  { id: 'full-access', label: 'Full access (dangerous)', dangerous: true },
]
export const CODEX_DEFAULT_MODE = 'ask'

const PRESETS: Record<string, { approvalPolicy: AskForApproval; sandbox: SandboxMode }> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access' },
}

export function modePreset(
  id: string,
): { approvalPolicy: AskForApproval; sandbox: SandboxMode } | undefined {
  const p = PRESETS[id]
  return p ? { ...p } : undefined
}

/** The per-turn `sandboxPolicy` for a sandbox mode; extra folders become writable roots. */
export function sandboxPolicy(mode: SandboxMode, extraDirs: string[]): SandboxPolicy {
  if (mode === 'read-only') return { type: 'readOnly' }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  return extraDirs.length
    ? { type: 'workspaceWrite', writableRoots: [...extraDirs] }
    : { type: 'workspaceWrite' }
}

const HEAD = /^[a-z0-9._-]{1,20}$/
const SHELL_WRAP = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+['"]?\s*(.*)$/s

/** `cmd:<word>` grammar (docs/capabilities.md §3): the first token, unwrapped from `sh -c`. */
export function commandHead(command: string): string | undefined {
  let c = command.trim()
  const wrapped = SHELL_WRAP.exec(c)
  if (wrapped) c = wrapped[1]!.trim()
  const head = c.split(/\s+/)[0] ?? ''
  return HEAD.test(head) ? head : undefined
}

const TOOL_ITEMS: Record<string, string> = {
  commandExecution: 'Bash',
  fileChange: 'Edit',
  mcpToolCall: 'mcp',
  webSearch: 'WebSearch',
}

/** `item/started` / `item/completed` → event patch (undefined = nothing to report). */
export function itemEvent(
  item: { type: string } & Record<string, unknown>,
  phase: 'started' | 'completed',
): EventPatch | undefined {
  const tool = TOOL_ITEMS[item.type]
  if (phase === 'completed') return tool ? { status: 'thinking' } : undefined
  if (item.type === 'reasoning') return { status: 'thinking' }
  if (!tool) return undefined
  if (tool === 'Bash' && typeof item.command === 'string') {
    const head = commandHead(item.command)
    if (head) return { status: 'tool', tool, target: `cmd:${head}` }
  }
  return { status: 'tool', tool }
}

/** One line, ≤ 80 characters: the agent bubble only. */
export function replySnippet(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}

/** `turn/completed` → event patch. */
export function turnCompletedEvent(status: string, reply: string): EventPatch | undefined {
  switch (status) {
    case 'completed': {
      const text = replySnippet(reply)
      return text ? { status: 'waiting', text } : { status: 'waiting' }
    }
    case 'interrupted':
      return { status: 'idle' }
    case 'failed':
      return { status: 'error' }
    default:
      return undefined
  }
}

/**
 * An approval request → the core's permission shape. The tool is normalized so the shared
 * `summarizeToolRequest` builds the card (Bash: `command`; Edit: `file_path`); the raw values stay
 * on the adapter→core boundary, like the Claude runner's tool input.
 */
export function approvalToPermission(
  kind: 'command' | 'fileChange',
  params: Record<string, unknown>,
  item: ({ type: string } & Record<string, unknown>) | undefined,
  cwd: string,
): RunnerPermission {
  if (kind === 'command') {
    const command =
      typeof params.command === 'string'
        ? params.command
        : typeof item?.command === 'string'
          ? item.command
          : ''
    return { tool: 'Bash', input: { command }, cwd }
  }
  const changes = Array.isArray(item?.changes) ? (item.changes as unknown[]) : []
  const first = changes[0] as { path?: unknown } | undefined
  const file_path = typeof first?.path === 'string' ? first.path : ''
  return { tool: 'Edit', input: { file_path }, cwd }
}

const MCP_TOOL = /^[A-Za-z0-9_.-]{1,64}$/
const RUN_TOOL = /to run tool "([^"]{1,64})"/

/**
 * A Codex MCP tool approval (`mcpServer/elicitation/request` with
 * `_meta.codex_approval_kind: "mcp_tool_call"`) from agent-office's own project server → the
 * core's permission shape, as `mcp__<server>__<tool>` like Claude's MCP tools. The tool arguments
 * never leave the adapter. Anything else (another server, a form or URL elicitation) → undefined.
 */
export function elicitationToPermission(
  params: Record<string, unknown>,
  ourServer: string | undefined,
  cwd: string,
): RunnerPermission | undefined {
  if (!ourServer || params.serverName !== ourServer) return undefined
  if (params.mode !== undefined && params.mode !== 'form') return undefined
  const meta = params._meta
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  if (m.codex_approval_kind !== 'mcp_tool_call') return undefined
  const title = typeof m.tool_title === 'string' ? m.tool_title : undefined
  const fromMessage =
    typeof params.message === 'string' ? RUN_TOOL.exec(params.message)?.[1] : undefined
  const tool = title ?? fromMessage
  if (!tool || !MCP_TOOL.test(tool)) return undefined
  return { tool: `mcp__${ourServer}__${tool}`, input: {}, cwd }
}

/** Never `acceptForSession`: "allow for this session" is agent-office's own allow-set. */
export function decisionToCodex(d: RunnerDecision | 'cancel'): CodexDecision {
  if (d === 'cancel') return 'cancel'
  return d.behavior === 'allow' ? 'accept' : 'decline'
}
