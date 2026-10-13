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
import { MemoryIdSchema, ProjectIdSchema, RepoRefSchema } from './projects.ts'
import type * as P from './projects.ts'
import type * as H from './harness.ts'
import {
  ModeIdSchema,
  ProviderIdSchema,
  type HookStatus,
  type ProviderId,
  type ProviderStatus,
} from './providers.ts'

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
/**
 * '3d' Classic, 'pixel' 2D RPG, 'minimal' the static agent hierarchy (docs/minimal-mode.md).
 * 'special' (Horizon) was removed: a saved one is read as '3d' (`SettingsSchema.viewMode`).
 */
export const VIEW_MODES = ['3d', 'pixel', 'minimal'] as const
export type ViewMode = (typeof VIEW_MODES)[number]
/** Sims-style wall visibility in the 3D modes (graphics contract §13). */
export const WALL_MODES = ['up', 'cutaway', 'down'] as const
export type WallMode = (typeof WALL_MODES)[number]
const Volume = (d: number) => z.number().min(0).max(1).default(d)
/**
 * Preferences of the removed 'special' view mode (Night City, then Horizon). Unused; kept so saved
 * settings stay valid (settings are additive).
 */
export const SpecialSettingsSchema = z.object({
  camera: z.enum(['third', 'first', 'overview']).default('third'),
  audio: z
    .object({
      master: Volume(0.6),
      effects: Volume(0.7),
      ambient: Volume(0.5),
      /** Audio is opt-in: muted until the user turns it on. */
      muted: z.boolean().default(true),
    })
    .default({ master: 0.6, effects: 0.7, ambient: 0.5, muted: true }),
  atmosphere: z.enum(['low', 'medium', 'high']).default('medium'),
  rain: z.boolean().default(true),
  reducedMotion: z.boolean().default(false),
  /** The first-time explanation of Night City's graphics needs was shown. */
  introSeen: z.boolean().default(false),
})
export type SpecialSettings = z.infer<typeof SpecialSettingsSchema>
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
  /**
   * Import Claude Code sessions continuously; each session's summary becomes approved project
   * memory (docs/projects.md §8b). Off by default; turned on only after the confirm dialog.
   */
  autoImportHistory: z.boolean().default(false),
  /** When the user confirmed automatic import (set by main only; never accepted from the renderer). */
  autoImportApprovedAt: z.number().int().nonnegative().optional(),
  /** Wall visibility in Classic 3D and Night City: Up, Cutaway (walls in the way fade), Down. */
  wallMode: z.enum(WALL_MODES).default('cutaway'),
  special: SpecialSettingsSchema.default(SpecialSettingsSchema.parse({})),
  /**
   * Observe sessions of an OpenCode server the user runs (`opencode serve`), read-only, on
   * 127.0.0.1:<port>. Off by default; the port is the only thing stored.
   */
  openCodeObserve: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).optional(),
    })
    .default({ enabled: false }),
  /** OpenHands may run in a remote or containerized workspace only after this explicit consent. */
  openHandsRemoteConsent: z.boolean().default(false),
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
  /** '3d' (the office, default), 'pixel' (2D RPG) or 'minimal'. Applied live. A saved 'special' (the removed Horizon) reads as '3d'. */
  viewMode: z.preprocess((v) => (v === 'special' ? '3d' : v), z.enum(VIEW_MODES)).default('3d'),
  /** What the window opens on: 'auto' = the Overview once a project exists, else the Office. */
  startView: z.enum(['auto', 'overview', 'office']).default('auto'),
  /** Shell layout preferences (applied live). */
  layout: z
    .object({ sidebarCollapsed: z.boolean().default(false) })
    .default({ sidebarCollapsed: false }),
  windowBounds: WindowBoundsSchema.optional(),
  /**
   * Per-provider integration switches (docs/provider-integrations.md). Missing = the provider's
   * default: Claude Code follows `claudeAdapter`; every other provider is off until enabled.
   */
  providers: z.partialRecord(ProviderIdSchema, z.object({ enabled: z.boolean() })).default({}),
})
export type Settings = z.infer<typeof SettingsSchema>
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})
export type SettingsPatch = Partial<Settings>
/**
 * A partial update: only the keys given. Zod 4 keeps `.default()` inside `.partial()`, which would
 * fill every missing key with its default and silently reset all other settings on each change, so
 * the top-level defaults are removed first (nested objects such as `graphicsAdvanced` are sent whole).
 */
/** Settings only main writes; a renderer patch carrying them is rejected (`.strict()`). */
const MAIN_ONLY_SETTINGS: readonly string[] = ['autoImportApprovedAt']
export const SettingsPatchSchema: z.ZodType<SettingsPatch> = z
  .object(
    Object.fromEntries(
      Object.entries(SettingsSchema.shape)
        .filter(([k]) => !MAIN_ONLY_SETTINGS.includes(k))
        .map(([k, v]) => [k, v instanceof z.ZodDefault ? v.removeDefault() : v]),
    ) as unknown as typeof SettingsSchema.shape,
  )
  // A patch picks a current mode only (the 'special' → '3d' mapping is for saved settings).
  .extend({ viewMode: z.enum(VIEW_MODES) })
  .partial()
  .strict() as unknown as z.ZodType<SettingsPatch>
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

export const NewSessionArgsSchema = z
  .object({
    /** Which runtime starts the session (needs the provider's `launch` capability). */
    provider: ProviderIdSchema.default('claude-code'),
    /** Must resolve to a picked folder (optional when `repo` names a project repository). */
    folder: ContextRefIdSchema.optional(),
    /** The project the session belongs to (preselected inside a project). */
    projectId: ProjectIdSchema.optional(),
    /** One of the project's repositories, used as the working directory. */
    repo: RepoRefSchema.optional(),
    /** Context bundle items (memory ids) the user kept in the preview; sent as a data block. */
    context_memories: z.array(MemoryIdSchema).max(40).optional(),
    name: z.string().trim().min(1).max(40).optional(),
    model: z.string().min(1).max(80).optional(),
    mode: PermissionModeSchema.default('default'),
    /** Provider-specific mode (Codex presets, ACP modes); Claude Code uses `mode`. */
    modeId: ModeIdSchema.optional(),
    extraFolders: z.array(ContextRefIdSchema).max(5).default([]),
    chrome: z.boolean().default(false),
    text: z.string().min(1).max(MAX_MESSAGE_CHARS),
    context: z.array(ContextRefIdSchema).max(10).optional(),
    use: z.array(UseIdSchema).max(5).optional(),
  })
  .refine((a) => a.folder !== undefined || a.repo !== undefined, {
    path: ['folder'],
    message: 'a folder or a project repository is required',
  })
export type NewSessionArgs = z.input<typeof NewSessionArgsSchema>
export const SessionCallSchema = z.object({ agentId: z.string().min(1).max(200) })
export const SetModeArgsSchema = SessionCallSchema.extend({ mode: PermissionModeSchema })
export const SetModelArgsSchema = SessionCallSchema.extend({ model: z.string().min(1).max(80) })
export const SetModeIdArgsSchema = SessionCallSchema.extend({ modeId: ModeIdSchema })
export const ProviderCallSchema = z.object({ provider: ProviderIdSchema })
export const ProviderEnableArgsSchema = ProviderCallSchema.extend({ enabled: z.boolean() })
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
  | {
      ok: false
      error: string
      /** `harness`: a strict harness has a required rule this runtime cannot enforce (docs/harness.md). */
      code: 'auth' | 'runtime' | 'folder' | 'limit' | 'harness' | 'other'
    }
export type SendResult = { ok: true; message: ChatMessage } | { ok: false; error: string }

export type { HookStatus }

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
  /** Every provider integration's status (docs/provider-integrations.md). Optional for older mains. */
  providers?: ProviderStatus[]
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
  /** Sessions started and owned by agent-office, for every provider with a managed runtime. */
  sessions: {
    start(args: NewSessionArgs): Promise<StartResult>
    /** Provider-specific mode (Codex presets, ACP modes). Needs the session's `change-mode` cap. */
    setModeId(agentId: string, modeId: string): Promise<void>
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
  /** Projects-first workspace (docs/projects.md): projects, sessions, memory, context, handoffs. */
  projects: {
    overview(): Promise<P.GlobalOverview>
    list(): Promise<P.ProjectSummary[]>
    dashboard(projectId: string): Promise<P.ProjectDashboard>
    create(args: P.NewProjectArgs): Promise<P.ProjectSummary>
    update(args: z.input<typeof P.UpdateProjectArgsSchema>): Promise<P.ProjectSummary>
    /** Adds picked folders (`ctx_` refs) as repositories. */
    addRepos(projectId: string, folders: string[]): Promise<P.ProjectSummary>
    removeRepo(projectId: string, repo: string): Promise<P.ProjectSummary>
    sessions(args: z.input<typeof P.SessionListArgsSchema>): Promise<P.SessionSummary[]>
    messages(
      args: z.input<typeof P.SessionMessagesArgsSchema>,
    ): Promise<{ messages: P.SessionMessageView[]; more: boolean }>
    assign(sessionId: string, projectId: string | null): Promise<P.SessionSummary>
    memories(args: z.input<typeof P.MemoryListArgsSchema>): Promise<P.MemoryView[]>
    createMemory(draft: P.MemoryDraft): Promise<P.MemoryView>
    reviewMemory(memoryId: string, action: 'approve' | 'reject'): Promise<P.MemoryView>
    editMemory(args: z.input<typeof P.MemoryEditArgsSchema>): Promise<P.MemoryView>
    supersedeMemory(memoryId: string, replacement: P.MemoryDraft): Promise<P.MemoryView>
    mergeMemories(memoryIds: string[], into: P.MemoryDraft): Promise<P.MemoryView>
    contextPreview(args: z.input<typeof P.ContextPreviewArgsSchema>): Promise<P.ContextBundleView>
    inspect(agentId: string): Promise<P.ContextInspection>
    prepareHandoff(args: z.input<typeof P.HandoffPrepareArgsSchema>): Promise<P.HandoffView>
    updateHandoff(args: z.input<typeof P.HandoffUpdateArgsSchema>): Promise<P.HandoffView>
    /** Starts the target provider's managed session with the reviewed bundle. */
    launchHandoff(handoffId: string): Promise<StartResult>
    search(args: z.input<typeof P.SearchArgsSchema>): Promise<P.SearchHit[]>
    tasks(projectId: string): Promise<P.TaskView[]>
    createTask(args: z.input<typeof P.TaskCreateArgsSchema>): Promise<P.TaskView>
    updateTask(args: z.input<typeof P.TaskUpdateArgsSchema>): Promise<P.TaskView>
    /** Experimental. Explicit user action; reads ~/.claude/projects metadata, copies nothing. */
    importHistory(args?: z.input<typeof P.ImportHistoryArgsSchema>): Promise<P.ImportResult>
    /** Experimental: resumes a Claude session natively as a managed session. */
    resumeSession(sessionId: string): Promise<StartResult>
    /**
     * Rejects every auto-imported memory item (`provenance.origin === 'session-import'`) of a
     * project, or of all projects. Removed items are not recreated by later imports.
     */
    removeImported(projectId?: string): Promise<{ removed: number }>
    /** Automatic import status for the Session Vault line. */
    importStatus(): Promise<P.ImportStatus>
    onPush(cb: (m: P.ProjectMessage) => void): () => void
    /** Harness Builder (docs/harness.md): rule sets, import, coverage, inspection, gates. User actions only. */
    harness: {
      list(): Promise<H.HarnessSummary[]>
      get(harnessId: string): Promise<H.HarnessDetail>
      /** Every stored version, oldest first. */
      versions(harnessId: string): Promise<H.HarnessDetail[]>
      create(draft: H.HarnessDraft): Promise<H.HarnessDetail>
      /** Edits the current draft; on a published harness it opens the next draft version. */
      update(args: H.HarnessUpdateArgs): Promise<H.HarnessDetail>
      publish(harnessId: string): Promise<H.HarnessDetail>
      archive(harnessId: string): Promise<H.HarnessDetail>
      /** Returns the project's attached harnesses. */
      attach(projectId: string, harnessId: string): Promise<H.HarnessSummary[]>
      detach(projectId: string, harnessId: string): Promise<H.HarnessSummary[]>
      templates(): Promise<H.HarnessTemplateView[]>
      createFromTemplate(templateId: string): Promise<H.HarnessDetail>
      /** Scans the project's repositories for rule files (read-only; nothing is executed). */
      importDetect(projectId: string): Promise<H.ImportSourceView[]>
      importPreview(args: H.ImportPreviewArgs): Promise<H.ImportPreview>
      /** Creates a draft harness from reviewed candidates; never publishes, never writes repo files. */
      importCommit(args: H.ImportCommitArgs): Promise<H.HarnessDetail>
      /** What a new session of `provider` on this project would get (New Session dialog). */
      coverage(projectId: string, provider: ProviderId): Promise<H.HarnessPreview>
      inspect(agentId: string): Promise<H.HarnessInspection>
      /** Runs the session's gates through the trusted runner (explicit user action). */
      runGates(args: H.RunGatesArgs): Promise<H.GateResultView[]>
      cancelGates(agentId: string): Promise<void>
      badges(): Promise<H.HarnessBadge[]>
    }
  }
  /** Provider integrations: status, enable/disable, models, observation hooks. */
  providers: {
    list(): Promise<ProviderStatus[]>
    /** Re-runs detection (`--version`/`--help` only; never starts a session). */
    refresh(provider?: ProviderId): Promise<ProviderStatus[]>
    setEnabled(provider: ProviderId, enabled: boolean): Promise<ProviderStatus[]>
    /** Models a new session of this provider can use (live list, else the provider's fallback). */
    models(provider: ProviderId): Promise<ModelOption[]>
    /** Installs the provider's observation hooks (explicit user action; backup first). */
    installHooks(provider: ProviderId): Promise<HookStatus>
    removeHooks(provider: ProviderId): Promise<HookStatus>
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
