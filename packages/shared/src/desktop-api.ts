import { z } from 'zod'
import { MAX_MESSAGE_CHARS, type Agent, type ChatMessage, type ServerMessage } from './protocol.ts'

/**
 * IPC contract between the Electron main process and the renderer (exposed by the preload as
 * `window.agentOffice`). Additive changes only — see ARCHITECTURE rule.
 */
export const IPC = {
  ready: 'office:ready',
  push: 'office:push',
  select: 'office:select',
  send: 'chat:send',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  hookStatus: 'hook:status',
  hookInstall: 'hook:install',
  hookUninstall: 'hook:uninstall',
  version: 'app:version',
  banner: 'app:banner',
  openSettings: 'app:open-settings',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateState: 'update:state',
} as const

export const WindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(400),
  height: z.number().int().min(300),
})

export const SettingsSchema = z.object({
  /** Local HTTP API port used by the Claude Code hook and external agents. */
  port: z.number().int().min(1024).max(65535).default(4317),
  notifications: z.boolean().default(true),
  launchAtLogin: z.boolean().default(false),
  /** Read Claude Code transcripts from ~/.claude/projects. */
  claudeAdapter: z.boolean().default(true),
  autoUpdate: z.boolean().default(true),
  /** Simulated agents (development and demos). */
  mock: z.boolean().default(false),
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
