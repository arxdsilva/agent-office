// OpenCode as an ACP agent: `opencode acp` (https://opencode.ai/docs/acp/). Verified against 1.19.0:
// `initialize` advertises one auth method (`opencode-login`: "Run `opencode auth login` in the
// terminal"), which only prints a hint, so it is never called. A session works when the user has a
// model configured. Modes are OpenCode's primary agents (`opencode agent list`: build, plan).
//
// Safety: OpenCode's default ruleset allows edit/bash/webfetch without asking, so no permission card
// would ever show. `OPENCODE_CONFIG_CONTENT` (merged over the user's config, verified with
// `opencode agent list`) makes those three ask. Fail closed; the user's own config cannot widen it.
import { PROVIDER_DECLS } from '@agent-office/core'
import type { AcpProfile } from '../common/acp/acp-profile.ts'
import { AcpRunner, type AcpRunnerOptions } from '../common/acp/acp-runner.ts'

export const OPENCODE_ACP_PROFILE: AcpProfile = {
  provider: 'opencode',
  prefix: PROVIDER_DECLS.opencode.prefix,
  label: 'OpenCode',
  bin: 'opencode',
  args: ['acp'],
  // `opencode --help` lists `opencode acp  start ACP (Agent Client Protocol) server`.
  helpArgs: ['acp', '--help'],
  acpFlag: /Agent Client Protocol/,
  caps: [...PROVIDER_DECLS.opencode.managedCaps],
  authMethodPrefer: [],
  loginHint: 'opencode auth login',
  env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    }),
  },
  modes: [
    { id: 'build', label: 'Build' },
    { id: 'plan', label: 'Plan (read-only)' },
  ],
  defaultModeId: 'build',
}

export class OpenCodeAcpRunner extends AcpRunner {
  constructor(o: AcpRunnerOptions = {}) {
    super(OPENCODE_ACP_PROFILE, o)
  }
}
