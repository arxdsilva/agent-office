// Renderer ports: the controller talks to the app (gateway) and to the views only through these.
import type {
  AgentOfficeApi,
  ProviderId,
  Banner,
  GraphicsQuality,
  PermissionDecision,
  PermissionMode,
  SettingsPatch,
} from '@agent-office/shared'
import type { Effective, GraphicsStats } from './app/graphics-types.ts'
import type {
  DialogueAction,
  DialogueVM,
  DirectoryVM,
  InteractTarget,
  MinimapVM,
  PixelHudVM,
  TileRect,
} from './app/pixel/types.ts'
import type { ViewMode } from '@agent-office/shared'
import type { LibraryTab, LibrarySort, LibraryVM, ViewEntry } from './app/library-types.ts'
import type {
  NewSessionVM,
  PermissionCardVM,
  SessionHeaderVM,
  UseMenuVM,
} from './app/session-types.ts'
import type { Manifest } from './app/manifest.ts'
import type { CapabilityPanelVM, ProviderSurfaces } from './app/capability-vm.ts'
import type { AgentPlan, BuildingLayout, ClipName, Link } from './app/office-types.ts'
import type { HudVM, PanelVM, SettingsVM } from './app/view-models.ts'
import type {
  ConnectTab,
  ConnectVM,
  EmptyStateVM,
  EmptyTileId,
  SnippetLang,
} from './app/connect-types.ts'

/** Everything the renderer can ask of the main process (implemented by the preload bridge). */
export type OfficeGateway = AgentOfficeApi

/** What the scene learned while loading: the building manifest and the character's clip lengths. */
export interface SceneAssets {
  manifest: Manifest
  /** One-shot clip durations from character.json (seconds), for the director's timing. */
  clipDurations?: Partial<Record<ClipName, number>>
}

export interface SceneView {
  /** Loads the manifest and shared assets behind the loading screen; resolves once the atrium renders. */
  load(manifestUrl: string): Promise<SceneAssets>
  /** Places the building modules (called only when placements changed). */
  setBuilding(layout: BuildingLayout): void
  /** Latest plan per visible agent (steps only when its intent changed); `departed` leave the scene. */
  direct(plans: Map<string, AgentPlan>, departed: string[]): void
  /** Links from agents to the capabilities they use (dash or page-particle arcs). */
  setLinks(links: Link[]): void
  /** What stations, book spines, rule boards and notebooks show, plus call bubbles on name tags. */
  setSurfaces(s: SceneSurfaces): void
  /** The user clicked a station, spine, board or notebook. */
  onPickCapability(fn: (ref: CapabilityRef) => void): void
  /** Ease the camera to a capability's surface, keeping its active links in view (null: stop). */
  focusCapability(ref: CapabilityRef | null): void
  /** Show only the links to this capability at full strength, dim the rest (null: all normal). */
  highlightLinks(capabilityId: string | null): void
  /** Highlights an agent and keeps the camera on it while it walks (null clears). */
  select(id: string | null): void
  /** Apply a render quality preset live (`auto` lets the scene's FPS governor pick). */
  setQuality(q: GraphicsQuality): void
  /** The user clicked an agent (id) or empty space (null). */
  onPick(fn: (id: string | null) => void): void
  /** Ease the camera to a bookmark by id (same ids as the view bar: 'wing:<provider>:0', 'atrium', …). */
  goTo(viewId: string): void
  /** Milliseconds since the user last moved the camera (orbit, zoom, walk, view button). */
  cameraIdleMs(): number
  /** Light or dark scene background and fill light (plan §2.6); no rebuild. */
  setTheme(theme: 'light' | 'dark'): void
  /** Applies the effective graphics settings live (low-spec plan §5.3). Supersedes setQuality. */
  setGraphics(e: Effective): void
  /** Live numbers for Settings → Graphics (sampled; cheap). */
  stats(): GraphicsStats
  /** The GPU context was lost / came back (driver reset). */
  onContextLost(fn: () => void): void
  onContextRestored(fn: () => void): void
  /** Pointer over a capability surface (null when it leaves); screen coordinates in CSS px. */
  onHoverSurface(fn: (ref: CapabilityRef | null, x: number, y: number) => void): void
  /** The camera views available now (the DOM view bar renders them; replaces the scene's own buttons). */
  onViews(fn: (views: ViewEntry[]) => void): void
  // ── Optional, added for the 2D RPG mode (plan §10.2). The 3D scene may ignore them. ──
  /** Releases canvases, GPU resources and listeners (before switching view modes). */
  dispose?(): void
  /** 2D: the player pressed E on (or clicked) something; the controller shows the dialogue. */
  onInteract?(fn: (t: InteractTarget) => void): void
  /** 2D: suspend player input while a DOM dialog or panel has focus. */
  setInputSuspended?(on: boolean): void
  /** 2D: the room the player stands in (for the HUD). */
  onRoom?(fn: (roomName: string) => void): void
  /** 2D: where the player stands, in world metres (minimap), at most 4 Hz. */
  onPlayerMove?(fn: (pos: { x: number; z: number }) => void): void
  /** 2D: the visible tiles of the camera (minimap viewport), at most 4 Hz. */
  onCamera?(fn: (view: TileRect) => void): void
  /** 2D: the minimap's base image (floors, walls, furniture), re-sent when the map changes. */
  onMinimapBase?(
    fn: (img: CanvasImageSource, widthTiles: number, heightTiles: number) => void,
  ): void
  /** 2D: the camera follows an agent without moving the player (Follow); null stops. */
  follow?(agentId: string | null): void
  /** 2D: move the player next to an agent or view region (directory "Go there"). */
  travelTo?(target: { agentId?: string; viewId?: string; pos?: { x: number; z: number } }): void
  /** 2D: pan the camera to a world point (minimap click); any movement key returns it to the player. */
  panTo?(pos: { x: number; z: number }): void
  /** 2D: step the zoom out (−1) or in (+1), or back to the default (0); crisp integer levels. */
  zoomBy?(delta: -1 | 0 | 1): void
  /** 2D: the zoom level changed (`level` index, `levels` count, `atDefault`). */
  onZoom?(fn: (z: { level: number; levels: number; atDefault: boolean }) => void): void
  /** 2D: the run toggle changed (R). */
  onRun?(fn: (on: boolean) => void): void
}

export interface SceneSurfaces {
  /** provider → slot contents (every wing of the provider shows the same). */
  byProvider: Map<string, ProviderSurfaces>
  /** agent id → bubble text while calling or visiting a capability. */
  bubbles: Map<string, string>
}

/** A capability as clicked in the scene (`id` is '+more' for an overflow aggregate). */
export interface CapabilityRef {
  provider: string
  id: string
}

/** Side panel for a station, book, board or notebook. */
export interface CapabilityPanelView {
  open(vm: CapabilityPanelVM): void
  render(vm: CapabilityPanelVM): void
  close(): void
  onClose(fn: () => void): void
  /** "Used by" → select that agent. */
  onSelectAgent(fn: (id: string) => void): void
  /** The "Show links" toggle. */
  onToggleLinks(fn: (on: boolean) => void): void
}

export interface PanelView {
  open(vm: PanelVM): void
  render(vm: PanelVM): void
  close(): void
  showError(message: string): void
  clearInput(): void
  onSend(fn: (text: string) => void | Promise<void>): void
  onClose(fn: () => void): void
  onSelectParent(fn: (id: string) => void): void
  onInstallHook(fn: () => void | Promise<void>): void
  /** The hint's "How to connect it →" action (non-Claude agents not reading their inbox). */
  onOpenConnect(fn: () => void): void

  // ── Managed sessions and the composer (plan §2.1–2.3). The VM arrives inside PanelVM. ──
  onSetMode(fn: (mode: PermissionMode) => void | Promise<void>): void
  onSetModel(fn: (model: string) => void | Promise<void>): void
  onInterrupt(fn: () => void | Promise<void>): void
  /** Called after the user confirmed the stop dialog. */
  onStop(fn: () => void | Promise<void>): void
  onAnswer(fn: (requestId: string, decision: PermissionDecision) => void | Promise<void>): void
  onPickContext(fn: (kind: 'files' | 'folder') => void | Promise<void>): void
  onRemoveChip(fn: (key: string) => void): void
  /** Opening the Use… menu asks for its entries; picking one toggles it. */
  onOpenUse(fn: () => UseMenuVM): void
  onToggleUse(fn: (id: string) => void): void
  /** Text typed so far (kept per agent as a draft). */
  onDraft(fn: (text: string) => void): void
  /** A "Skills & rules used" / "Connections used" chip was clicked. */
  onPickCapability(fn: (ref: CapabilityRef) => void): void
}

/** The new-session dialog (`<dialog id="new-session">`), plan §2.4. */
export interface NewSessionView {
  open(vm: NewSessionVM): void
  render(vm: NewSessionVM): void
  close(): void
  isOpen(): boolean
  onPickFolder(fn: () => void | Promise<void>): void
  onAddExtraFolder(fn: () => void | Promise<void>): void
  onRemoveExtraFolder(fn: (key: string) => void): void
  onPickContext(fn: (kind: 'files' | 'folder') => void | Promise<void>): void
  onRemoveChip(fn: (key: string) => void): void
  onOpenUse(fn: () => UseMenuVM): void
  onToggleUse(fn: (id: string) => void): void
  onChange(
    fn: (patch: {
      name?: string
      model?: string
      mode?: PermissionMode
      chrome?: boolean
      text?: string
      /** The provider picker (`NewSessionVM.providers`). */
      provider?: ProviderId
      /** A provider-specific mode (`ModeOptionVM.id` for non-Claude providers). */
      modeId?: string
    }) => void,
  ): void
  onStart(fn: () => void | Promise<void>): void
  onClose(fn: () => void): void
}

export interface HudView {
  render(vm: HudVM): void
  onOpenSettings(fn: () => void | Promise<void>): void
  /** The 🔌 Connect button and the "No agents right now · Connect…" hint link. */
  onConnect(fn: () => void): void
  /** Badge on the 🔌 button while nothing has been seen this session. */
  setConnectBadge(on: boolean): void
  /** The ⊕ New session button. */
  onNewSession(fn: () => void): void
  /** The 📚 Library button. */
  onLibrary(fn: () => void): void
}

/** The Library browser drawer (`<aside id="library">`), low-spec plan §B2. */
export interface LibraryView {
  open(vm: LibraryVM): void
  render(vm: LibraryVM): void
  close(): void
  isOpen(): boolean
  onClose(fn: () => void): void
  onProvider(fn: (provider: string) => void): void
  onTab(fn: (tab: LibraryTab) => void): void
  onSearch(fn: (query: string) => void): void
  onSort(fn: (sort: LibrarySort) => void): void
  onPick(fn: (ref: CapabilityRef) => void): void
}

/** Hover tooltip near the cursor (`#tooltip`). */
export interface TooltipView {
  show(text: string, x: number, y: number): void
  hide(): void
}

/** Camera view buttons (`#views`), with provider menus for Library and Adapters. */
export interface ViewBarView {
  render(views: ViewEntry[]): void
  onPick(fn: (viewId: string) => void): void
}

/** The Connect panel (`<dialog id="connect">`), plan §2.2. */
export interface ConnectView {
  open(vm: ConnectVM): void
  render(vm: ConnectVM): void
  close(): void
  isOpen(): boolean
  onClose(fn: () => void): void
  onTab(fn: (t: ConnectTab) => void): void
  onToggle(fn: (key: 'claudeAdapter' | 'mock', on: boolean) => void | Promise<void>): void
  onHookAction(fn: (action: 'install' | 'uninstall') => void | Promise<void>): void
  onPort(fn: (port: number) => void | Promise<void>): void
  onSnippetLang(fn: (lang: SnippetLang) => void): void
  onCopy(fn: (text: string, target: 'endpoint' | 'snippet') => void | Promise<void>): void
  onTest(fn: () => void | Promise<void>): void
  onGoToWing(fn: (provider: string) => void): void
  /** Actions on a provider card (Connect → Providers). */
  onProviderAction?(fn: (a: ProviderAction) => void | Promise<void>): void
  showError(message: string | null): void
  flashCopied(target: 'endpoint' | 'snippet'): void
}

/** The empty-office card (`#empty`), plan §2.1. `null` hides it. */
export interface EmptyStateView {
  render(vm: EmptyStateVM | null): void
  onTile(fn: (t: EmptyTileId) => void): void
  onDemo(fn: () => void | Promise<void>): void
  onDismiss(fn: () => void): void
}

/** Short status toast (`#toast`, role=status). */
export interface ToastView {
  show(text: string, action?: { label: string; run: () => void }): void
}

export interface SettingsView {
  open(vm: SettingsVM): void
  render(vm: SettingsVM): void
  close(): void
  isOpen(): boolean
  showError(message: string): void
  onChange(fn: (patch: SettingsPatch) => void | Promise<void>): void
  onHookAction(fn: (action: 'install' | 'uninstall') => void | Promise<void>): void
  onCheckUpdates(fn: () => void | Promise<void>): void
  onInstallUpdate(fn: () => void | Promise<void>): void
  /** "More ways to connect agents…" link in the Claude Code section. */
  onOpenConnect(fn: () => void): void
}

export interface BannerView {
  show(b: Banner | null): void
  /** The banner's action button (e.g. "Fix in Connect"). */
  onAction(fn: (action: NonNullable<Banner['action']>) => void): void
}

/** The RPG dialogue box (`#dialogue`), 2D mode only (plan §8.2). */
export interface DialogueView {
  open(vm: DialogueVM): void
  render(vm: DialogueVM): void
  close(): void
  isOpen(): boolean
  onAction(fn: (a: DialogueAction) => void): void
  onClose(fn: () => void): void
}

/** The 2D HUD: room, counts, alerts, minimap and directory (plan §9). */
export interface PixelHudView {
  show(on: boolean): void
  render(vm: PixelHudVM): void
  renderMinimap(vm: MinimapVM | null): void
  renderDirectory(vm: DirectoryVM | null): void
  onAlert(fn: (agentId: string, opensPermission: boolean) => void): void
  onMinimapPick(fn: (tx: number, ty: number, opts?: { travel?: boolean }) => void): void
  onDirectory(fn: (pick: { agentId?: string; viewId?: string; travel: boolean }) => void): void
  onDirectorySearch(fn: (q: string) => void): void
  /** The zoom control (− ⌂ +): −1 out, +1 in, 0 back to the default. */
  onZoom?(fn: (delta: -1 | 0 | 1) => void): void
  /** Reflects the scene's zoom level and the run toggle in the HUD. */
  renderZoom?(z: { level: number; levels: number; atDefault: boolean; run: boolean }): void
}

/** The `3D Office | 2D RPG` switch in #actions. */
export interface ModeToggleView {
  render(mode: ViewMode): void
  onChange(fn: (mode: ViewMode) => void): void
}

/** What a provider card can ask for (Connect → Providers; docs/provider-integrations.md). */
export type ProviderAction =
  | { kind: 'toggle'; id: ProviderId; on: boolean }
  | { kind: 'refresh'; id?: ProviderId }
  | { kind: 'hooks'; id: ProviderId; action: 'install' | 'uninstall' | 'repair' }
  /** Opens New Session with this provider preselected. */
  | { kind: 'start'; id: ProviderId }
