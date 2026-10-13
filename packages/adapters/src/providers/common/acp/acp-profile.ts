// How one ACP agent (Cursor `agent acp`, Gemini `gemini --acp`, Copilot `copilot --acp`) is run and
// shown: docs/provider-integrations.md §5.2. The shared AcpRunner/AcpProbe take nothing else.
import type { ProviderId, SessionCap } from '@agent-office/shared'

/** A mode the profile offers. `native` is the agent's own id when it differs (Copilot uses URLs). */
export interface AcpMode {
  id: string
  label: string
  native?: string
  /** Widens what the agent may do without asking; needs `allowBypassPermissions`. */
  dangerous?: boolean
}

export interface AcpProfile {
  provider: ProviderId
  /** Agent id prefix, e.g. 'cu:'. */
  prefix: string
  /** Display name used in exit messages ("Cursor needs a login…"). */
  label: string
  bin: string
  args: string[]
  /** Arguments of the help call that must mention the ACP surface. Default ['--help']. */
  helpArgs?: string[]
  /** What the help text must contain. */
  acpFlag: RegExp
  caps: SessionCap[]
  /**
   * Auth method ids, in order, that reuse the CLI's existing login. Only methods the agent
   * advertises are tried; API-key and browser-login methods are never listed.
   */
  authMethodPrefer: string[]
  /** What the user runs to log in, e.g. 'agent login'. */
  loginHint: string
  /** Known modes (the core validates mode ids against these); the agent must also advertise them. */
  modes?: AcpMode[]
  defaultModeId?: string
  /**
   * Fixed environment for the CLI (merged under the caller's `env`). Only for settings that make
   * the agent ask before acting, never credentials.
   */
  env?: Record<string, string>
  /** Overrides of the default ACP tool kind → tool name map. */
  toolKindMap?: Partial<Record<string, string>>
}

/** The agent's id for a profile mode (undefined: not a profile mode). */
export function nativeModeId(profile: Pick<AcpProfile, 'modes'>, id: string): string | undefined {
  const m = profile.modes?.find((x) => x.id === id)
  return m ? (m.native ?? m.id) : undefined
}
