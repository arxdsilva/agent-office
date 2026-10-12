import {
  builtinDecls,
  mcpDecl,
  type Logger,
  type ReportCapabilities,
  type Scheduler,
} from '@agent-office/core'
import type { CapabilityDecl } from '@agent-office/shared'

const PROVIDER = 'claude-code'
export const DISCOVERY_INTERVAL_MS = 60_000

/** Adapter-local ports, implemented by ClaudeConfigReader and ClaudeKnowledgeReader. */
export interface McpServerSource {
  mcpServers(cwds: string[]): Promise<string[]>
}
export interface KnowledgeSource {
  read(cwds: string[]): Promise<CapabilityDecl[]>
}

export interface CapabilityDiscoveryOptions {
  capabilities: ReportCapabilities
  config: McpServerSource
  knowledge: KnowledgeSource
  /** Cwds of active sessions (from the transcript tailer). */
  cwds: () => string[]
  scheduler: Scheduler
  intervalMs?: number
  log?: Logger
}

/**
 * Driving adapter: declares what Claude Code agents can use (built-in adapters, configured MCP
 * servers, skills, rules, memory titles) at start, every 60 s, and when a new session cwd appears.
 */
export class ClaudeCapabilityDiscovery {
  private running: Promise<void> | undefined
  private again = false
  private cancel: (() => void) | undefined

  constructor(private o: CapabilityDiscoveryOptions) {}

  start(): void {
    this.cancel = this.o.scheduler.every(this.o.intervalMs ?? DISCOVERY_INTERVAL_MS, () =>
      this.refresh(),
    )
    this.refresh()
  }

  stop(): void {
    this.cancel?.()
    this.cancel = undefined
  }

  /** Requests a scan; one already running is followed by exactly one more. */
  refresh(): void {
    void this.scan()
  }

  /** Resolves when no scan is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  /** One discovery pass. Never throws. */
  scan(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.pass().finally(() => {
      this.running = undefined
      if (this.again) {
        this.again = false
        void this.scan()
      }
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const cwds = this.o.cwds()
    let failed = false
    const safe = async <T>(p: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await p()
      } catch {
        failed = true
        return []
      }
    }
    const [servers, knowledge] = await Promise.all([
      safe(() => this.o.config.mcpServers(cwds)),
      safe(() => this.o.knowledge.read(cwds)),
    ])
    // No paths or error text in logs: they may name private files.
    if (failed) this.o.log?.warn('claude-code: capability discovery partly failed')
    this.o.capabilities.declare(PROVIDER, [
      ...builtinDecls(),
      ...servers.map(mcpDecl),
      ...knowledge,
    ])
  }
}
