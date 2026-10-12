import { z } from 'zod'
import {
  type Capability,
  MAX_MESSAGE_CHARS,
  type Agent,
  type ChatMessage,
  type ServerMessage,
} from './protocol.ts'

/**
 * IPC contract between the Electron main process and the renderer (exposed by the preload as
 * `window.agentOffice`). Additive changes only — see ARCHITECTURE rule.
 */
export { IPC } from './ipc-channels.ts'

export const WindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(400),
  height: z.number().int().min(300),
})

/** Renderer quality presets. `auto` starts at `high` and lets the renderer step down/up by FPS. */
export const GRAPHICS_QUALITIES = ['auto', 'low', 'medium', 'high', 'ultra'] as const
export const GraphicsQualitySchema = z.enum(GRAPHICS_QUALITIES)
export type GraphicsQuality = z.infer<typeof GraphicsQualitySchema>

export const SettingsSchema = z.object({
  /** Local HTTP API port used by the Claude Code hook and external agents. */
  port: z.number().int().min(1024).max(65535).default(4317),
  notifications: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),
  /** Read Claude Code transcripts from ~/.claude/projects. */
  claudeAdapter: z.boolean().default(true),
  autoUpdate: z.boolean().default(true),
  /**
   * Discover capabilities from Claude Code config (MCP server names, skill descriptions, rule
   * titles; docs/capabilities.md §4). Only used with `claudeAdapter`. Needs a backend restart.
   */
  discoverCapabilities: z.boolean().default(true),
  /** Simulated agents (development and demos). */
  mock: z.boolean().default(false),
  /** 3D render quality preset. Applied live by the renderer (no backend restart). */
  graphicsQuality: GraphicsQualitySchema.default('auto'),
  windowBounds: WindowBoundsSchema.optional(),
})
export type Settings = z.infer<typeof SettingsSchema>
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
export const SettingsPatchSchema = SettingsSchema.partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>
export interface SettingsResult {
  settings: Settings
  restartRequired: boolean
}

export const SendMessageArgsSchema = z.object({
  agentId: z.string().min(1).max(200),
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
})
export type SendResult = { ok: true; message: ChatMessage } | { ok: false; error: string }

export type HookStatus = 'installed' | 'outdated' | 'not-installed'

export type UpdatePolicy = 'auto' | 'notify-only' | 'off'
export interface UpdateState {
  policy: UpdatePolicy
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  /** Release page, for notify-only installs. */
  url?: string
  error?: string
}

export interface Banner {
  kind: 'error' | 'info'
  text: string
  /** Optional follow-up the UI offers next to the text (e.g. "Fix in Connect" for a busy port). */
  action?: 'open-connect'
}

/**
 * Live connection facts for the Connect panel and the empty state. Paths are '~'-abbreviated
 * fixed locations; counts only. **Never contains the token.**
 */
export interface ConnectionInfo {
  api: {
    /** Bind host, usually 127.0.0.1. */
    host: string
    /** Listening port, else the effective configured port. */
    port: number
    listening: boolean
    /** The last start failed because the port was in use. */
    portBusy: boolean
    /** e.g. '~/.agent-office/token'. */
    tokenFile: string
  }
  claude: {
    /** Effective `claudeAdapter` (after env overrides). */
    enabled: boolean
    /** Set when AGENT_OFFICE_CLAUDE forces it for this run. */
    override?: 'on' | 'off'
    /** e.g. '~/.claude/projects'. */
    projectsDir: string
    projectsDirFound: boolean
    /** Top-level session transcripts changed within the expiry window (subagents excluded). */
    activeSessions: number
  }
  hook: HookStatus
  mock: { enabled: boolean; override?: 'on' | 'off' }
}

export type TestEventResult = { ok: true } | { ok: false; error: string }

/** Text the renderer may put on the clipboard (written by main; the renderer permission stays denied). */
export const CopyTextSchema = z.string().min(1).max(4000)

export interface Snapshot {
  agents: Agent[]
  messages: ChatMessage[]
  /** Adapters, skills and rules per provider (docs/capabilities.md). Optional for older producers. */
  capabilities?: Capability[]
}

/** What the renderer can call. Implemented by the preload over ipcRenderer. */
export interface AgentOfficeApi {
  ready(): Promise<Snapshot>
  onMessage(cb: (m: ServerMessage) => void): () => void
  onSelect(cb: (agentId: string) => void): () => void
  sendMessage(agentId: string, text: string): Promise<SendResult>
  settings: {
    get(): Promise<Settings>
    set(patch: SettingsPatch): Promise<SettingsResult>
  }
  hook: {
    status(): Promise<HookStatus>
    install(): Promise<HookStatus>
    uninstall(): Promise<HookStatus>
  }
  app: {
    version(): Promise<string>
    onBanner(cb: (b: Banner | null) => void): () => void
    /** Main asks the UI to open the settings dialog (tray menu). */
    onOpenSettings(cb: () => void): () => void
    /** Writes text to the system clipboard (validated by CopyTextSchema in main). */
    copyText(text: string): Promise<void>
    /** Main asks the UI to open the Connect panel (tray menu). */
    onOpenConnect(cb: () => void): () => void
  }
  connections: {
    info(): Promise<ConnectionInfo>
    /** Pushed (≤ 1/s) after backend restarts, settings or hook changes, and session-count changes. */
    onChange(cb: (i: ConnectionInfo) => void): () => void
    /** Posts a fixed test agent through the real HTTP API (auth included); it leaves after 20 s. */
    test(): Promise<TestEventResult>
  }
  updates: {
    check(): Promise<UpdateState>
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
}
