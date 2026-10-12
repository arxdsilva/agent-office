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
}

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
  }
  updates: {
    check(): Promise<UpdateState>
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
}
