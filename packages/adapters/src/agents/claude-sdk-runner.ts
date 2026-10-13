// Driven adapter: runs managed Claude Code sessions through the Claude Agent SDK. The only module
// (with its siblings in agents/) allowed to import the SDK. Activity is mapped by the transcript
// line-mapper, so managed sessions obey the same privacy limits as tailed ones.
import type {
  CanUseTool,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentRunner,
  Logger,
  RunnerDecision,
  RunnerExit,
  RunnerPermission,
  RunnerSession,
  RunnerStart,
} from '@agent-office/core'
import type { AgentEvent, ModelOption, PermissionMode } from '@agent-office/shared'
import { lineToEvent, newParseContext } from '../sources/claude-code/line-mapper.ts'

export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

export interface ClaudeSdkRunnerOptions {
  /** Injected in tests; defaults to the SDK's `query` (loaded lazily). */
  queryFn?: QueryFn
  /** `pathToClaudeCodeExecutable` (packaged builds ship without the SDK's bundled binary). */
  executable?: string
  /** Environment for the Claude Code process (a process.env snapshot). */
  env: Record<string, string | undefined>
  log: Logger
  /** For the line-mapper's rule/skill/memory recognition. */
  claudeHome?: string
  projectsDir?: string
  now?: () => number
}

const MAX_RESULT = 4000

/** Minimal unbounded async queue; stays open until `close()` (the SDK needs open input for controls). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

const AUTH = /\b(login|log in|logged in|auth\w*|credential\w*|api key|oauth)\b/i
const RUNTIME = /ENOENT|not found|spawn|executable/i

/** Maps an SDK failure to an exit reason; never keeps the message text (it may hold paths). */
function classify(err: unknown): { exit: RunnerExit; tag: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  const msg = err instanceof Error ? err.message : String(err)
  if (code === 'ENOENT') return { exit: { error: 'runtime' }, tag: 'ENOENT' }
  if (AUTH.test(msg)) return { exit: { error: 'auth' }, tag: 'auth' }
  if (RUNTIME.test(msg)) return { exit: { error: 'runtime' }, tag: code ?? 'runtime' }
  const name = err instanceof Error ? err.name : 'Error'
  return { exit: { error: 'crash' }, tag: code ? `${name} ${code}` : name }
}

export class ClaudeSdkRunner implements AgentRunner {
  constructor(private o: ClaudeSdkRunnerOptions) {}

  start(s: RunnerStart): RunnerSession {
    return new SdkSession(this.o, s)
  }
}

class SdkSession implements RunnerSession {
  readonly sessionId: Promise<string>
  private resolveId!: (id: string) => void
  private rejectId!: (e: RunnerExit) => void
  private started = false
  private exited = false
  private closed = false
  private authFailed = false
  private queue = new AsyncQueue<SDKUserMessage>()
  private query: Promise<Query>
  private resolveQuery!: (q: Query) => void
  private rejectQuery!: (e: unknown) => void
  private q: Query | undefined
  private ctx
  private events = new Set<(e: Omit<AgentEvent, 'agentId'>) => void>()
  private results = new Set<(r: { text: string; isError: boolean }) => void>()
  private permissionFn: ((r: RunnerPermission) => Promise<RunnerDecision>) | undefined
  private exitFns = new Set<(e: RunnerExit) => void>()

  constructor(
    private o: ClaudeSdkRunnerOptions,
    private s: RunnerStart,
  ) {
    this.ctx = newParseContext({
      ...(o.claudeHome ? { claudeHome: o.claudeHome } : {}),
      ...(o.projectsDir ? { projectsDir: o.projectsDir } : {}),
    })
    this.sessionId = new Promise((res, rej) => {
      this.resolveId = res
      this.rejectId = rej
    })
    this.sessionId.catch(() => {})
    this.query = new Promise((res, rej) => {
      this.resolveQuery = res
      this.rejectQuery = rej
    })
    this.query.catch(() => {})
    void this.run()
  }

  private options(): Options {
    const { s, o } = this
    const canUseTool: CanUseTool = async (tool, input): Promise<PermissionResult> => {
      if (!this.permissionFn) return { behavior: 'deny', message: 'No approver is connected.' }
      const d = await this.permissionFn({ tool, input, cwd: s.cwd })
      return d.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: d.message }
    }
    return {
      cwd: s.cwd,
      ...(s.model ? { model: s.model } : {}),
      permissionMode: s.mode,
      additionalDirectories: s.extraDirs,
      settingSources: ['user', 'project', 'local'],
      allowDangerouslySkipPermissions: s.mode === 'bypassPermissions' && s.allowBypass,
      // Experimental native resume: the Agent SDK loads the conversation history of that session.
      ...(s.resume ? { resume: s.resume } : {}),
      // The hook exits early on AGENT_OFFICE_MANAGED: managed sessions don't use the inbox.
      env: { ...o.env, AGENT_OFFICE_MANAGED: '1' },
      canUseTool,
      // Claude in Chrome: the CLI's `--chrome` flag (not a typed SDK option).
      ...(s.chrome ? { extraArgs: { chrome: null } } : {}),
      ...(o.executable ? { pathToClaudeCodeExecutable: o.executable } : {}),
      // agent-office's project MCP server (docs/projects.md §5), only when the policy allows it.
      ...(s.mcp
        ? {
            mcpServers: {
              [s.mcp.name]: {
                type: 'stdio' as const,
                command: s.mcp.command,
                args: s.mcp.args,
                env: s.mcp.env,
              },
            },
          }
        : {}),
    }
  }

  private async run(): Promise<void> {
    let q: Query
    try {
      const fn = this.o.queryFn ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      q = fn({ prompt: this.queue, options: this.options() })
    } catch (err) {
      this.rejectQuery(err)
      return this.fail(err)
    }
    this.q = q
    this.resolveQuery(q)
    try {
      for await (const msg of q) this.handle(msg)
    } catch (err) {
      if (!this.closed) return this.fail(err)
    }
    this.finish(this.started ? {} : { error: this.authFailed ? 'auth' : 'crash' })
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && !this.started) {
          this.started = true
          this.resolveId(msg.session_id)
        }
        return
      case 'auth_status':
        if (msg.error) this.authFailed = true
        return
      case 'assistant':
      case 'user': {
        if (msg.parent_tool_use_id) return // subagent frames: not mapped yet
        if (msg.type === 'assistant' && msg.error === 'authentication_failed')
          this.authFailed = true
        const now = this.o.now?.() ?? Date.now()
        const line = JSON.stringify({
          type: msg.type,
          sessionId: msg.session_id ?? 'managed',
          timestamp: new Date(now).toISOString(),
          cwd: this.s.cwd,
          message: msg.message,
        })
        const e = lineToEvent(line, this.ctx)
        if (!e) return
        const { agentId: _id, ...event } = e
        for (const fn of this.events) fn(event)
        return
      }
      case 'result': {
        const text = msg.subtype === 'success' ? (msg.result ?? '').slice(0, MAX_RESULT) : ''
        for (const fn of this.results) fn({ text, isError: msg.is_error })
        return
      }
    }
  }

  private fail(err: unknown): void {
    const { exit, tag } = classify(err)
    const e: RunnerExit = this.authFailed && exit.error === 'crash' ? { error: 'auth' } : exit
    this.o.log.warn(`claude-sdk: session ended (${e.error}: ${tag})`)
    this.finish(e)
  }

  private finish(e: RunnerExit): void {
    if (this.exited) return
    this.exited = true
    this.queue.close()
    if (!this.started) this.rejectId(e.error ? e : { error: 'crash' })
    for (const fn of this.exitFns) fn(e)
  }

  push(prompt: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    })
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await (await this.query).setPermissionMode(mode)
  }

  async setModel(model: string): Promise<void> {
    await (await this.query).setModel(model)
  }

  async supportedModels(): Promise<ModelOption[]> {
    const list: ModelInfo[] = await (await this.query).supportedModels()
    return list.map((m) => ({
      id: m.value,
      label: m.displayName,
      ...(m.description ? { description: m.description } : {}),
    }))
  }

  async interrupt(): Promise<void> {
    await (await this.query).interrupt()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.close()
    this.q?.close()
  }

  onEvent(fn: (e: Omit<AgentEvent, 'agentId'>) => void): () => void {
    this.events.add(fn)
    return () => this.events.delete(fn)
  }

  onResult(fn: (r: { text: string; isError: boolean }) => void): () => void {
    this.results.add(fn)
    return () => this.results.delete(fn)
  }

  onPermission(fn: (r: RunnerPermission) => Promise<RunnerDecision>): void {
    this.permissionFn = fn
  }

  onExit(fn: (e: RunnerExit) => void): void {
    this.exitFns.add(fn)
  }
}
