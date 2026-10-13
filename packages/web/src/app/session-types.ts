// Contract for managed sessions, the composer and permission cards (plan §2, §4). Pure data.
// Owned by the lead; view-models.ts produces these shapes, DOM adapters render them.
import type {
  ContextChip,
  ContextRef,
  ModelOption,
  PermissionMode,
  PermissionRequestVM,
  ProviderId,
} from '@agent-office/shared'
import type { Pill } from './connect-types.ts'

export interface ModeOptionVM {
  /** A Claude `PermissionMode`, or a provider mode id (`ModeOption.id`) for other providers. */
  id: PermissionMode | (string & {})
  /** Provider modes that widen what the agent may do (needs `allowBypassPermissions`). */
  dangerous?: boolean
  /** Shown but not selectable (dangerous modes while `allowBypassPermissions` is off). */
  disabled?: boolean
  icon: string
  label: string
  desc: string
  checked: boolean
}

/** Mode/model pills plus session controls in the panel header (plan §2.1). */
export interface SessionHeaderVM {
  managed: boolean
  mode: Pill
  model: Pill
  /** Managed sessions only (bypass omitted unless allowed in Settings). */
  modes: ModeOptionVM[]
  models: (ModelOption & { checked: boolean })[]
  /** Terminal sessions: why the pills are read-only. */
  readOnlyNote?: string
  canInterrupt: boolean
  canStop: boolean
}

/** One chip in the composer (before sending). */
export interface ComposerChipVM {
  kind: 'file' | 'folder' | 'capability'
  /** Context ref (`ctx_…`) or capability id. */
  key: string
  label: string
  hint?: string
  /** e.g. "Chrome isn't enabled for this session". */
  warn?: string
}

export interface ComposerVM {
  chips: ComposerChipVM[]
  disabled: boolean
  placeholder: string
  canAddContext: boolean
  canAddUse: boolean
}

export interface UseEntryVM {
  id: string
  label: string
  /** Declared or observed for this provider. */
  seen: boolean
  selected: boolean
}

export interface UseMenuVM {
  groups: { id: 'browser' | 'mcp' | 'builtin' | 'skill'; label: string; entries: UseEntryVM[] }[]
}

export interface PermissionCardVM {
  request: PermissionRequestVM
  /** "1 of 2". */
  counter?: string
  allowSessionLabel: string
}

/** What the composer holds for an agent until sent (kept per agent while switching). */
export interface Draft {
  text: string
  context: ContextRef[]
  use: string[]
}

export interface NewSessionForm {
  /** Which runtime starts the session (default 'claude-code'). */
  provider: ProviderId
  /** Provider-specific mode (non-Claude providers); Claude uses `mode`. */
  modeId?: string
  /** The project the new session belongs to (preselected when started from a project). */
  projectId?: string
  folder?: ContextRef
  name: string
  model?: string
  mode: PermissionMode
  extraFolders: ContextRef[]
  chrome: boolean
  text: string
  context: ContextRef[]
  use: string[]
}

export interface NewSessionVM {
  /** Dialog heading, e.g. "New Codex session". */
  title: string
  /** The project picker (`#ns-project`), first; absent when there are no projects. */
  projects?: { id: string; label: string; selected: boolean }[]
  /** Providers that can start a session now (enabled, `launch` cap, ready); the form's is selected. */
  providers: { id: ProviderId; label: string; selected: boolean }[]
  /** Attach files/folders (the provider's `attach-context` cap). */
  attachAvailable: boolean
  folder?: { label: string; hint: string }
  name: string
  namePlaceholder: string
  models: (ModelOption & { selected: boolean })[]
  modes: ModeOptionVM[]
  extraFolders: { key: string; label: string; hint: string }[]
  chrome: { checked: boolean; available: boolean }
  text: string
  composer: ComposerVM
  canStart: boolean
  starting: boolean
  error?: string
  /** "Stop a session first (6 running)". */
  limit?: string
}

export type { ContextChip }

/** At most this many managed sessions run at once. */
export const MAX_MANAGED = 6
/** Capability id of Claude in Chrome (pinned in the Use… menu for claude-code). */
export const CHROME_ID = 'mcp:claude-in-chrome'
