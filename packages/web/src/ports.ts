// Renderer ports: the controller talks to the app (gateway) and to the views only through these.
import type { AgentOfficeApi, Banner, GraphicsQuality, SettingsPatch } from '@agent-office/shared'
import type { Manifest } from './app/manifest.ts'
import type { AgentPlan, BuildingLayout, ClipName } from './app/office-types.ts'
import type { HudVM, PanelVM, SettingsVM } from './app/view-models.ts'

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
  /** Highlights an agent and keeps the camera on it while it walks (null clears). */
  select(id: string | null): void
  /** Apply a render quality preset live (`auto` lets the scene's FPS governor pick). */
  setQuality(q: GraphicsQuality): void
  /** The user clicked an agent (id) or empty space (null). */
  onPick(fn: (id: string | null) => void): void
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
}

export interface HudView {
  render(vm: HudVM): void
  onOpenSettings(fn: () => void | Promise<void>): void
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
}

export interface BannerView {
  show(b: Banner | null): void
}
