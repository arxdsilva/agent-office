// goose as an ACP agent: `goose acp` (stdio). Verified against 1.54.0: `initialize` advertises one
// auth method (`goose-provider`: "Run `goose configure`"), which is a terminal setup step, so it is
// never called; a configured provider is enough for `session/new`. goose's permission modes are
// auto / approve / smart_approve / chat.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const GOOSE_PROFILE: AcpProfile = {
  provider: 'goose',
  prefix: PROVIDER_DECLS.goose.prefix,
  label: 'goose',
  bin: 'goose',
  args: ['acp'],
  helpArgs: ['acp', '--help'],
  // `goose acp --help`: "Run goose as an ACP agent server on stdio".
  acpFlag: /ACP agent server/,
  caps: [...PROVIDER_DECLS.goose.managedCaps],
  authMethodPrefer: [],
  loginHint: 'goose configure',
  // With no provider set up, 1.54.0 answers session/new with -32603 "Internal error" and data
  // "Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER".
  setupError: /Failed to resolve provider|Configuration value not found: GOOSE_(PROVIDER|MODEL)/,
  authMessage:
    'goose has no AI provider set up. Run `goose configure` in a terminal, then start the session again.',
  modes: [
    { id: 'approve', label: 'Ask before tools' },
    { id: 'smart_approve', label: 'Ask only for risky tools', dangerous: true },
    { id: 'auto', label: 'Auto-approve everything', dangerous: true },
    { id: 'chat', label: 'Chat only (no tools)' },
  ],
  defaultModeId: 'approve',
}

export class GooseAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(GOOSE_PROFILE, o)
  }
}
