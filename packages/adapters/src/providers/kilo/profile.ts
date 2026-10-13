// Kilo Code CLI as an ACP agent: `kilo acp` (binary `kilo`, also installed as `kilocode`). Verified
// against 7.8.8, an OpenCode fork: one auth method (`kilo-login`: "Run `kilo auth login` in the
// terminal"), a hint only, so never called. Modes are Kilo's primary agents (`kilo agent list`: ask,
// code, debug, orchestrator, plan).
//
// Safety: Kilo's default ruleset asks for most shell commands but allows edits and web fetches
// without asking. `KILO_CONFIG_CONTENT` (verified with `kilo agent list`) makes those ask.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const KILO_PROFILE: AcpProfile = {
  provider: 'kilo',
  prefix: PROVIDER_DECLS.kilo.prefix,
  label: 'Kilo Code',
  bin: 'kilo',
  args: ['acp'],
  helpArgs: ['acp', '--help'],
  acpFlag: /Agent Client Protocol/,
  caps: [...PROVIDER_DECLS.kilo.managedCaps],
  authMethodPrefer: [],
  loginHint: 'kilo auth login',
  env: {
    KILO_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', webfetch: 'ask' } }),
  },
  modes: [
    { id: 'code', label: 'Code' },
    { id: 'ask', label: 'Ask (read-only)' },
    { id: 'plan', label: 'Plan (read-only)' },
    { id: 'debug', label: 'Debug' },
    { id: 'orchestrator', label: 'Orchestrator' },
  ],
  defaultModeId: 'code',
}

export class KiloAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(KILO_PROFILE, o)
  }
}
