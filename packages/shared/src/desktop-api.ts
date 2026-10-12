import { z } from 'zod'
import {
  type Capability,
  MAX_MESSAGE_CHARS,
  PermissionModeSchema,
  type PermissionMode,
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
export const GRAPHICS_QUALITIES = ['auto', 'minimal', 'low', 'medium', 'high', 'ultra'] as const
export const GraphicsQualitySchema = z.enum(GRAPHICS_QUALITIES)
export type GraphicsQuality = z.infer<typeof GraphicsQualitySchema>

/** Per-feature graphics overrides; 'auto' takes the value from the preset (low-spec plan §2.1). */
export const GraphicsAdvancedSchema = z.object({
  resolution: z.enum(['auto', '0.5', '0.67', '0.75', '1']).default('auto'),
  fps: z.enum(['auto', '30', '60', 'unlimited']).default('auto'),
  shadows: z.enum(['auto', 'off', 'contact', 'full']).default('auto'),
  effects: z.enum(['auto', 'off', 'on']).default('auto'),
  characters: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  labels: z.enum(['auto', 'selected', 'nearby', 'all']).default('auto'),
  links: z.enum(['auto', 'off', 'static', 'animated']).default('auto'),
  building: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
})
export type GraphicsAdvanced = z.infer<typeof GraphicsAdvancedSchema>
export const BATTERY_PRESETS = ['off', 'minimal', 'low', 'medium'] as const

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
  /** UI theme. 'system' follows the OS. Applied live (main sets nativeTheme.themeSource). */
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Offer the "Bypass permissions" mode for managed sessions (off by default; confirm to enable). */
  allowBypassPermissions: z.boolean().default(false),
  /** Per-feature overrides on top of `graphicsQuality`. */
  graphicsAdvanced: GraphicsAdvancedSchema.default(GraphicsAdvancedSchema.parse({})),
  /** Lower the frame rate (15 fps) while the window isn't focused. */
  powerSaverBlur: z.boolean().default(true),
  /** Stop rendering while the window is hidden or minimized. */
  powerSaverHidden: z.boolean().default(true),
  /** While on battery, use this preset instead (off = keep the chosen preset). */
  batteryPreset: z.enum(BATTERY_PRESETS).default('off'),
  /** Off = software rendering (needs a restart). */
  hardwareAcceleration: z.boolean().default(true),
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

/** Opaque handle for a file/folder picked in main (the renderer never sees full paths). */
export const CONTEXT_REF = /^ctx_[a-z0-9]{12}$/
export const ContextRefIdSchema = z.string().regex(CONTEXT_REF)
/** Capability ids a message may ask the agent to use (docs/capabilities.md §1). */
export const UseIdSchema = z
  .string()
  .regex(/^(?:(?:mcp|api):[A-Za-z0-9_.-]{1,80}|shell|web|subagents|skill:[A-Za-z0-9:_-]{1,80})$/)

export const SendMessageArgsSchema = z.object({
  agentId: z.string().min(1).max(200),
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  /** Files/folders from `context.pick` (≤ 10). */
  context: z.array(ContextRefIdSchema).max(10).optional(),
  /** Tools/adapters the agent should use for this message (≤ 5). */
  use: z.array(UseIdSchema).max(5).optional(),
})
export interface SendOptions {
  context?: string[]
  use?: string[]
}

/** A picked file or folder as the renderer sees it. */
export interface ContextRef {
  ref: string
  kind: 'file' | 'folder'
  /** Basename. */
  label: string
  /** '~'-abbreviated location for the tooltip (full path only outside home). */
  hint: string
}

export const NewSessionArgsSchema = z.object({
  /** Must resolve to a picked folder. */
  folder: ContextRefIdSchema,
  name: z.string().trim().min(1).max(40).optional(),
  model: z.string().min(1).max(80).optional(),
  mode: PermissionModeSchema.default('default'),
  extraFolders: z.array(ContextRefIdSchema).max(5).default([]),
  chrome: z.boolean().default(false),
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  context: z.array(ContextRefIdSchema).max(10).optional(),
  use: z.array(UseIdSchema).max(5).optional(),
})
export type NewSessionArgs = z.input<typeof NewSessionArgsSchema>
export const SessionCallSchema = z.object({ agentId: z.string().min(1).max(200) })
export const SetModeArgsSchema = SessionCallSchema.extend({ mode: PermissionModeSchema })
export const SetModelArgsSchema = SessionCallSchema.extend({ model: z.string().min(1).max(80) })
export const PERMISSION_DECISIONS = ['allow', 'allow-session', 'deny'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]
export const AnswerArgsSchema = SessionCallSchema.extend({
  requestId: z.string().regex(/^perm_[a-z0-9]{10}$/),
  decision: z.enum(PERMISSION_DECISIONS),
})
export const PickKindSchema = z.enum(['files', 'folder'])
export interface ModelOption {
  id: string
  label: string
  description?: string
}
export type StartResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string; code: 'auth' | 'runtime' | 'folder' | 'limit' | 'other' }
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

export interface PowerState {
  onBattery: boolean
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
  sendMessage(agentId: string, text: string, opts?: SendOptions): Promise<SendResult>
  /** Native file/folder picker in main; returns opaque refs. */
  context: {
    pick(kind: 'files' | 'folder'): Promise<ContextRef[]>
  }
  /** Claude Code sessions started and owned by agent-office (Agent SDK). */
  sessions: {
    start(args: NewSessionArgs): Promise<StartResult>
    setMode(agentId: string, mode: PermissionMode): Promise<void>
    setModel(agentId: string, model: string): Promise<void>
    /** Models of a running session, or the cached/fallback list without an id. */
    models(agentId?: string): Promise<ModelOption[]>
    interrupt(agentId: string): Promise<void>
    stop(agentId: string): Promise<void>
    answer(agentId: string, requestId: string, decision: PermissionDecision): Promise<void>
  }
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
    /** Power source changes (Electron powerMonitor). */
    onPower(cb: (s: PowerState) => void): () => void
    power(): Promise<PowerState>
    /** Main reports the window hidden/minimized (false) or shown/restored (true): the power saver. */
    onWindowVisibility(cb: (visible: boolean) => void): () => void
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
