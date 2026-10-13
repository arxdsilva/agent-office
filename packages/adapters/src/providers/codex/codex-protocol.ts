// A tolerant zod subset of the Codex app-server protocol (v2, codex-cli 0.162.1): exactly the
// messages the runner and probe use. Unknown fields pass through; missing optional ones are fine.
// `CODEX_RELIES_ON` lists every method/field used here; scripts/codex-schema-check.mjs verifies it
// against `codex app-server generate-json-schema` for the installed version.
import { z } from 'zod'

export const ASK_FOR_APPROVAL = ['untrusted', 'on-request', 'never'] as const
export type AskForApproval = (typeof ASK_FOR_APPROVAL)[number]
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type SandboxMode = (typeof SANDBOX_MODES)[number]
/** Decisions we send. Never `acceptForSession` (it persists in Codex beyond our session). */
export type CodexDecision = 'accept' | 'decline' | 'cancel'

export type SandboxPolicy =
  | { type: 'readOnly' }
  | { type: 'workspaceWrite'; writableRoots?: string[] }
  | { type: 'dangerFullAccess' }

export const AccountReadResult = z.looseObject({
  requiresOpenaiAuth: z.boolean(),
  account: z.looseObject({ type: z.string() }).nullish(),
})

export const ThreadStartResult = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
})

const TurnStatus = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
const Turn = z.looseObject({
  id: z.string(),
  status: TurnStatus.or(z.string()),
  error: z.looseObject({ message: z.string().optional() }).nullish(),
})
export type CodexTurn = z.infer<typeof Turn>

export const TurnStartResult = z.looseObject({ turn: Turn })
export const TurnNotification = z.looseObject({ threadId: z.string(), turn: Turn })

/** A ThreadItem; only `type` and `id` are relied on, the rest is read defensively by the mapper. */
export const ThreadItem = z.looseObject({ type: z.string(), id: z.string() })
export type CodexItem = z.infer<typeof ThreadItem> & Record<string, unknown>
export const ItemNotification = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  item: ThreadItem,
})

export const AgentMessageDelta = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
})

export const CommandApprovalParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  command: z.string().nullish(),
})
export const FileChangeApprovalParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
})

/**
 * `mcpServer/elicitation/request`: an MCP server (or Codex itself, for an MCP tool approval) asks
 * the user. A tool approval carries `_meta.codex_approval_kind: "mcp_tool_call"` and offers
 * `_meta.persist` choices, which we never pick (one-time answers only).
 */
export const McpElicitationParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string().nullish(),
  serverName: z.string(),
  mode: z.string().optional(),
  message: z.string().optional(),
  _meta: z.unknown().optional(),
})
/** Our answers: no `_meta`, so never a persisted ("session" / "always") approval. */
export type McpElicitationResponse =
  | { action: 'accept'; content: Record<string, never> }
  | { action: 'decline' }
  | { action: 'cancel' }

export const ModelListResult = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      description: z.string().nullish(),
      hidden: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
})

/** Method names, in one place. */
export const M = {
  initialize: 'initialize',
  initialized: 'initialized',
  accountRead: 'account/read',
  threadStart: 'thread/start',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  modelList: 'model/list',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  mcpElicitation: 'mcpServer/elicitation/request',
} as const

/**
 * What this adapter relies on, checked against the installed Codex's generated JSON schema.
 * `params`/`definitions`: definition name → property names; `enums`: definition → values.
 */
export const CODEX_RELIES_ON = {
  clientRequests: [
    M.initialize,
    M.accountRead,
    M.threadStart,
    M.turnStart,
    M.turnInterrupt,
    M.modelList,
  ],
  clientNotifications: [M.initialized],
  serverNotifications: [
    M.turnStarted,
    M.turnCompleted,
    M.itemStarted,
    M.itemCompleted,
    M.agentMessageDelta,
  ],
  serverRequests: [M.commandApproval, M.fileChangeApproval, M.mcpElicitation],
  definitions: {
    InitializeParams: ['clientInfo'],
    ClientInfo: ['name', 'title', 'version'],
    GetAccountParams: ['refreshToken'],
    GetAccountResponse: ['requiresOpenaiAuth', 'account'],
    // `config`: free-form config.toml overrides; carries `mcp_servers` (experimental, docs/projects.md §5).
    ThreadStartParams: [
      'cwd',
      'model',
      'approvalPolicy',
      'sandbox',
      'config',
      'developerInstructions',
    ],
    ThreadStartResponse: ['thread'],
    Thread: ['id'],
    TurnStartParams: ['threadId', 'input', 'model', 'approvalPolicy', 'sandboxPolicy'],
    TurnStartResponse: ['turn'],
    TurnInterruptParams: ['threadId', 'turnId'],
    Turn: ['id', 'status', 'error'],
    TurnError: ['message'],
    TurnStartedNotification: ['threadId', 'turn'],
    TurnCompletedNotification: ['threadId', 'turn'],
    ItemStartedNotification: ['threadId', 'turnId', 'item'],
    ItemCompletedNotification: ['threadId', 'turnId', 'item'],
    AgentMessageDeltaNotification: ['threadId', 'turnId', 'itemId', 'delta'],
    CommandExecutionRequestApprovalParams: ['threadId', 'turnId', 'itemId', 'command'],
    CommandExecutionRequestApprovalResponse: ['decision'],
    FileChangeRequestApprovalParams: ['threadId', 'turnId', 'itemId'],
    FileChangeRequestApprovalResponse: ['decision'],
    FileUpdateChange: ['path'],
    McpServerElicitationRequestParams: ['threadId', 'turnId', 'serverName'],
    McpServerElicitationRequestResponse: ['action', 'content', '_meta'],
    ModelListParams: ['includeHidden', 'cursor'],
    ModelListResponse: ['data', 'nextCursor'],
    Model: ['id', 'model', 'displayName', 'description', 'hidden'],
  } as Record<string, string[]>,
  enums: {
    AskForApproval: [...ASK_FOR_APPROVAL],
    SandboxMode: [...SANDBOX_MODES],
    TurnStatus: ['completed', 'interrupted', 'failed', 'inProgress'],
    CommandExecutionApprovalDecision: ['accept', 'decline', 'cancel'],
    FileChangeApprovalDecision: ['accept', 'decline', 'cancel'],
    McpServerElicitationAction: ['accept', 'decline', 'cancel'],
    UserInput: ['text'],
    SandboxPolicy: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
    ThreadItem: [
      'agentMessage',
      'reasoning',
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'webSearch',
    ],
  } as Record<string, string[]>,
  /** Variant-specific fields: `<Union>.<variant type>` → properties. */
  variants: {
    'ThreadItem.agentMessage': ['text'],
    'ThreadItem.commandExecution': ['command'],
    'ThreadItem.fileChange': ['changes'],
    'SandboxPolicy.workspaceWrite': ['writableRoots'],
    'UserInput.text': ['text'],
  } as Record<string, string[]>,
}
