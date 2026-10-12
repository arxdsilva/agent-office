// Contract for the Connect panel and the empty state (plan §2–§4). Pure data, no DOM.
// Owned by the lead; view-models.ts implements the functions that produce these shapes.
import type { ProviderId } from '@agent-office/shared'

export type ConnectTab = 'claude' | 'providers' | 'http' | 'demo' | 'connected'
export type SnippetLang = 'curl' | 'python' | 'js'
export type Tone = 'ok' | 'warn' | 'off' | 'error' | 'pending'

/** A status chip: always text plus tone (never color alone). */
export interface Pill {
  text: string
  tone: Tone
}

export interface ConnectVM {
  tab: ConnectTab
  tabs: { id: ConnectTab; label: string; tone: Tone }[]
  claude: {
    pill: Pill
    toggle: { on: boolean; disabledNote?: string }
    folder: { ok: boolean; text: string }
    hook: HookActionVM
    /** "✓ Verified: …" or "○ Not verified yet: …"; absent when the hook isn't installed. */
    verified?: Pill
    /** Sessions found but no claude-code agent present. */
    idleNote?: string
  }
  http: {
    pill: Pill
    endpoint: string
    tokenFile: string
    lang: SnippetLang
    snippet: string
    /** Extra line under the snippet (e.g. the PowerShell note on Windows). */
    snippetNote?: string
    /** Present only when the port is busy: the inline port form starts from this value. */
    portBusy?: { port: number }
    live: Pill
  }
  demo: { pill: Pill; toggle: { on: boolean; disabledNote?: string } }
  /** One card per provider integration (docs/provider-integrations.md). */
  providers: { cards: ProviderCardVM[] }
  connected: {
    rows: {
      provider: string
      count: number
      /** Status colors, one per agent (STATUS_COLORS). */
      dots: string[]
      via: string
      lastSeen: string
    }[]
  }
}

/** A provider's Connect card. Every string is display copy (never a path or raw error text). */
export interface ProviderCardVM {
  id: ProviderId
  label: string
  /** State dot + label, e.g. "● Connected", "○ Needs login". */
  pill: Pill
  /** "v0.162.1 · tested 0.162.1"; absent when not installed. */
  version?: string
  /** "Managed: app-server · Observed: hooks". */
  integration: string
  /** "2 active sessions"; absent when 0. */
  sessions?: string
  /** Capability chips, managed and observed, as short labels ("Send", "Approve tools", …). */
  managedCaps: string[]
  observedCaps: string[]
  /** One help line from the hint (e.g. "Run `codex login` in a terminal, then Check again"). */
  hint?: string
  /** Enable/Disable switch; absent for providers that can't be enabled (ChatGPT). */
  toggle?: { on: boolean }
  /** Hooks row for hook-based providers. */
  hooks?: { status: Pill; action: 'install' | 'uninstall' | 'repair'; button: string }
  /** "Start agent" opens New Session with this provider preselected. */
  canStart: boolean
  docsUrl: string
}

export interface HookActionVM {
  label: string
  action: 'install' | 'uninstall'
  button: string
}

export type EmptyPhase = 'loading' | 'first-run' | 'active' | 'empty-again' | 'dismissed'
export type EmptyTileId = 'claude' | 'http' | 'demo' | 'providers'

export interface EmptyStateVM {
  tiles: {
    id: EmptyTileId
    title: string
    pill: Pill
    body: string
    button: string
    busy?: boolean
  }[]
  /** The pulsing line at the bottom ("◌ Listening for agents…"). */
  listening: string
}

/** Wait this long after `ready()` for the first connection push before showing the empty card. */
export const EMPTY_GRACE_MS = 2_000
/** "Try the demo" gives up waiting for mock agents after this long. */
export const DEMO_START_TIMEOUT_MS = 8_000
/** Fly the camera to a newly connected wing only if the user left the camera alone this long. */
export const FLY_TO_IDLE_MS = 10_000
/** The test agent's id and provider (excluded from first-arrival toasts). */
export const TEST_AGENT_ID = 'agent-office-test'
