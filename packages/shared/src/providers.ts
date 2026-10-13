// Provider integrations (plan "multi-provider platform" §1; docs/provider-integrations.md).
// One provider = one agent runtime (Claude Code, Codex, Cursor, Gemini CLI, Copilot CLI, ChatGPT,
// and the open-source runtimes: OpenCode, goose, Kilo Code, Qwen Code, Cline, Aider, Continue,
// OpenHands, Roo Code). The runtime is not the model vendor: an OpenCode session stays an OpenCode
// agent whatever model it runs (`Agent.modelProvider`).
// What a session can do is declared as capabilities; the UI gates every control on them.
// Additive only: these types travel over IPC and appear in public docs.
import { z } from 'zod'

/** Install state of a hook (Claude Code's inbox hook and the providers' observation hooks). */
export type HookStatus = 'installed' | 'outdated' | 'not-installed'

export const PROVIDER_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'chatgpt',
  'opencode',
  'goose',
  'kilo',
  'qwen',
  'cline',
  'aider',
  'continue',
  'openhands',
  'roo',
] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export const ProviderIdSchema = z.enum(PROVIDER_IDS)

/** What one session can do. Observed and managed sessions of a provider usually differ. */
export const SESSION_CAPS = [
  'observe',
  'launch',
  'send-message',
  'interrupt',
  'stop',
  'approve-tools',
  'select-model',
  'change-mode',
  'attach-context',
  'chrome',
  'resume',
  /** Each message runs one task (CLI task mode); there is no live conversation. */
  'one-shot',
  /** Past sessions can be listed and read through the provider's documented interface. */
  'history',
  /** Sessions started outside agent-office can be discovered (read-only). */
  'discover-sessions',
] as const
export type SessionCap = (typeof SESSION_CAPS)[number]

/** Connection state of a provider, as shown on its Connect card (precedence: core `providerState`). */
export const PROVIDER_STATES = [
  'disabled',
  'not-installed',
  'error',
  'unsupported-version',
  'needs-auth',
  'needs-setup',
  'connected',
  'observe-only',
  'managed-available',
  'installed',
  'disconnected',
] as const
export type ProviderState = (typeof PROVIDER_STATES)[number]

/** Closed set of copy keys for a card's hint line: never a path, never raw error or stderr text. */
export const PROVIDER_HINTS = [
  'login-required',
  'install-cli',
  'update-cli',
  'hooks-invalid-config',
  'hooks-outdated',
  'hooks-need-enable',
  'probe-timeout',
  'probe-failed',
  'opt-in-tunnel',
  'no-observation-surface',
  /** The integration is planned: nothing is advertised until it is verified. */
  'planned',
  /** No supported, documented interface exists (e.g. an IDE-only extension). */
  'not-supported',
] as const
export type ProviderHint = (typeof PROVIDER_HINTS)[number]

/** A provider-specific mode (Codex presets, ACP session modes). Claude keeps `PermissionMode`. */
export interface ModeOption {
  id: string
  label: string
  /** Widens what the agent may do without asking; needs `allowBypassPermissions`. */
  dangerous?: boolean
}
export const ModeIdSchema = z.string().min(1).max(60)

export type ManagedIntegration = 'agent-sdk' | 'app-server' | 'acp' | 'http' | 'sdk' | 'cli-task'
export type ObserveIntegration = 'transcripts' | 'hooks'

export interface ProviderStatus {
  id: ProviderId
  label: string
  state: ProviderState
  enabled: boolean
  /** Installed CLI version (from `--version`), when installed. */
  version?: string
  /** The version agent-office was verified against. */
  testedVersion?: string
  /** What sessions started by agent-office can do (empty: no managed runtime). */
  managedCaps: SessionCap[]
  /** What externally started sessions can do (empty: not observable). */
  observedCaps: SessionCap[]
  integration: { managed?: ManagedIntegration; observe?: ObserveIntegration }
  /** Observation hooks, for hook-based providers. */
  hooks?: HookStatus
  modes?: ModeOption[]
  /** Live agents of this provider in the office. */
  activeSessions: number
  hint?: ProviderHint
}
