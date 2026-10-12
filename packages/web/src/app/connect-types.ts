// Contract for the Connect panel and the empty state (plan §2–§4). Pure data, no DOM.
// Owned by the lead; view-models.ts implements the functions that produce these shapes.

export type ConnectTab = 'claude' | 'http' | 'demo' | 'connected'
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

export interface HookActionVM {
  label: string
  action: 'install' | 'uninstall'
  button: string
}

export type EmptyPhase = 'loading' | 'first-run' | 'active' | 'empty-again' | 'dismissed'
export type EmptyTileId = 'claude' | 'http' | 'demo'

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
