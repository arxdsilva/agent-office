// Provider declarations, connection state and session capabilities (docs/provider-integrations.md
// §2–§4). Pure: the registry is data, the state is a function of the probe and the settings.
import type {
  HookStatus,
  ManagedIntegration,
  ObserveIntegration,
  ProviderHint,
  ProviderId,
  ProviderState,
  SessionCap,
} from '@agent-office/shared'
import type { ProbeResult } from '../ports/driven.ts'

export interface ProviderDecl {
  id: ProviderId
  label: string
  /** Agent id prefix (`cc:`, `cx:`, …); '' for providers without sessions (ChatGPT). */
  prefix: string
  /** Caps of a running session agent-office started. */
  managedCaps: readonly SessionCap[]
  /** Caps of a session the user started elsewhere. */
  observedCaps: readonly SessionCap[]
  integration: { managed?: ManagedIntegration; observe?: ObserveIntegration }
  docsUrl: string
  testedVersion?: string
  /** The CLI's own login command, shown as copy next to `login-required` (never run by us). */
  loginHint?: string
  /** Shown when no state-specific hint applies. */
  hint?: ProviderHint
}

const ACP_CAPS: readonly SessionCap[] = [
  'launch',
  'send-message',
  'interrupt',
  'stop',
  'approve-tools',
  'select-model',
  'change-mode',
  'attach-context',
]

export const PROVIDER_DECLS: Readonly<Record<ProviderId, ProviderDecl>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    prefix: 'cc:',
    managedCaps: [
      'launch',
      'send-message',
      'interrupt',
      'stop',
      'approve-tools',
      'select-model',
      'change-mode',
      'attach-context',
      'chrome',
    ],
    // `send-message` through the inbox hook when interactive; the UI keeps the legacy rules.
    observedCaps: ['observe', 'send-message'],
    integration: { managed: 'agent-sdk', observe: 'transcripts' },
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    testedVersion: '2.1.270',
    loginHint: 'claude /login',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    prefix: 'cx:',
    managedCaps: [
      'launch',
      'send-message',
      'interrupt',
      'stop',
      'approve-tools',
      'select-model',
      'change-mode',
      'attach-context',
    ],
    observedCaps: [],
    integration: { managed: 'app-server' },
    docsUrl: 'https://learn.chatgpt.com/docs/app-server',
    testedVersion: '0.162.1',
    loginHint: 'codex login',
    hint: 'no-observation-surface',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    prefix: 'cu:',
    managedCaps: ACP_CAPS,
    observedCaps: ['observe'],
    integration: { managed: 'acp', observe: 'hooks' },
    docsUrl: 'https://cursor.com/docs/cli/acp',
    testedVersion: '2026.10.01-e373342',
    loginHint: 'agent login',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    prefix: 'gm:',
    managedCaps: ACP_CAPS,
    observedCaps: ['observe'],
    integration: { managed: 'acp', observe: 'hooks' },
    docsUrl: 'https://geminicli.com/docs/cli/acp-mode/',
    testedVersion: '0.63.0',
    loginHint: 'gemini',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    prefix: 'gh:',
    managedCaps: ACP_CAPS,
    observedCaps: ['observe'],
    integration: { managed: 'acp', observe: 'hooks' },
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli',
    testedVersion: '1.0.96',
    loginHint: 'copilot login',
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    prefix: '',
    managedCaps: [],
    observedCaps: [],
    integration: {},
    docsUrl: 'https://platform.openai.com/docs/mcp',
    hint: 'opt-in-tunnel',
  },
}

export function prefixOf(provider: ProviderId): string | undefined {
  return PROVIDER_DECLS[provider].prefix || undefined
}

export function providerOfAgentId(agentId: string): ProviderId | undefined {
  return Object.values(PROVIDER_DECLS).find((d) => d.prefix && agentId.startsWith(d.prefix))?.id
}

export interface ProviderStateInput {
  enabled: boolean
  /** Live (not done) agents of this provider in the office. */
  liveSessions: number
  /** Observation hooks; 'invalid' = the provider's config file could not be parsed. */
  hooks?: HookStatus | 'invalid'
  /** A managed runtime is wired for this provider. */
  hasRuntime: boolean
}

export interface ProviderStateResult {
  state: ProviderState
  hint?: ProviderHint
}

/** First match wins (docs §4). A provider without a probe counts as installed when it has a runtime. */
export function providerState(
  decl: ProviderDecl,
  probe: ProbeResult | undefined,
  o: ProviderStateInput,
): ProviderStateResult {
  const r = decide(probe, o)
  const hint = r.hint ?? decl.hint
  return hint ? { state: r.state, hint } : { state: r.state }
}

function decide(probe: ProbeResult | undefined, o: ProviderStateInput): ProviderStateResult {
  if (!o.enabled) return { state: 'disabled' }
  const cli = probe ? probe.installed : o.hasRuntime
  const hooksPresent = o.hooks !== undefined && o.hooks !== 'not-installed'
  if (!cli && !hooksPresent) return { state: 'not-installed', hint: 'install-cli' }
  if (probe?.error)
    return { state: 'error', hint: probe.error === 'timeout' ? 'probe-timeout' : 'probe-failed' }
  if (cli && probe && !probe.flagsOk) return { state: 'unsupported-version', hint: 'update-cli' }
  if (cli && probe?.auth === 'needed') return { state: 'needs-auth', hint: 'login-required' }
  if (o.hooks === 'invalid') return { state: 'needs-setup', hint: 'hooks-invalid-config' }
  if (o.hooks === 'outdated') return { state: 'needs-setup', hint: 'hooks-outdated' }
  if (o.liveSessions > 0) return { state: 'connected' }
  const runtime = cli && o.hasRuntime
  if (o.hooks === 'installed' && !runtime) return { state: 'observe-only' }
  if (runtime) return { state: 'managed-available' }
  return { state: 'installed' }
}

/** What an ended managed session keeps: watching it and retiring it. */
export const ENDED_CAPS: readonly SessionCap[] = ['observe', 'stop']

export function sessionCaps(
  decl: Pick<ProviderDecl, 'managedCaps' | 'observedCaps'>,
  o: { managed: boolean; phase?: 'starting' | 'running' | 'ended' },
): SessionCap[] {
  if (!o.managed) return [...decl.observedCaps]
  return o.phase === 'ended' ? [...ENDED_CAPS] : [...decl.managedCaps]
}
